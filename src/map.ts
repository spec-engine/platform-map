// map(): the full-assembly orchestrator — detect -> adapters -> merge ->
// assemble -> serialize (CFG-09). It is detect() one tier up: same
// assertRootExists gate (delegated to detect()), same compose-primitives-then-
// return-a-typed-result idiom, same only-throw discipline.
//
// SEC-01 throw contract: the ONLY things that propagate out of map() are
// RootNotFoundError (from detect(), for a nonexistent root) and — once plan 04
// wires the canonical adapter — MalformedConfigError for a present-but-broken
// platform-map.json. EVERY other failure (an adapter throwing, an injected
// path escaping root, a malformed adapter source) degrades to a diagnostic.
//
// Plan 02-01 shipped the integration-neutral core (detect -> adapters ->
// merge -> serialize). Plan 02-02 adds the map-owned per-unit fs signal census
// and DET-02 monorepo recursion on top: after merge(), every resolved unit is
// enriched with censusSignals(), and a workspace-package that detect() reports
// as its own monorepo has its units[] expanded via the workspace adapter ONLY
// (never the root-level canonical/DF/SE/siblings adapters). Still deliberately
// NOT here: edges (Phase 3, edges is []) and role (Phase 3, seeded "unknown").

import * as path from "node:path";
import type {
  Adapter,
  AdapterContext,
  AdapterResult,
  CanonicalSideChannel,
  PartialUnit,
} from "./adapters/index.js";
import { PRECEDENCE, selectAdapters } from "./adapters/index.js";
import { workspaceAdapter } from "./adapters/workspace.js";
import { readCanonicalConfig } from "./config.js";
import { detect } from "./detect.js";
import { MalformedConfigError, RootNotFoundError } from "./errors.js";
import { resolveWithinRoot } from "./internal/path-guard.js";
import { probeRef } from "./internal/ref-probe.js";
import { serialize } from "./internal/serialize.js";
import { merge } from "./merge.js";
import { censusSignals } from "./signals.js";
import type {
  AdapterName,
  Diagnostic,
  MapOptions,
  PlatformMap,
  Unit,
  UnitSignals,
} from "./types.js";

// DET-02 recursion budget: a workspace-package that is itself a monorepo has
// its own units[] expanded, bounded so a pathological deeply-nested tree can
// never blow the stack (walk()'s own caps bound each level's I/O).
const MAX_MONOREPO_RECURSION_DEPTH = 8;

function malformedConfigDiagnostic(
  source: AdapterName,
  error: unknown,
): Diagnostic {
  const reason = error instanceof Error ? error.message : String(error);
  return {
    code: "MALFORMED_CONFIG",
    severity: "warning",
    path: source,
    message: `MALFORMED_CONFIG: ${source} adapter failed: ${reason}`,
  };
}

/** A canonical `overrides` key that matches no assembled unit is a stale/honest
 *  mistake: surface a warning (never a throw) and ignore the override. Reuses
 *  the MALFORMED_CONFIG code (config-shaped honesty), severity "warning". */
function staleOverrideDiagnostic(unitName: string): Diagnostic {
  return {
    code: "MALFORMED_CONFIG",
    severity: "warning",
    path: unitName,
    message: `MALFORMED_CONFIG: overrides names unit "${unitName}" which does not exist — override ignored`,
  };
}

/** Collects every assembled unit name, recursing into nested monorepo units[],
 *  so the overrides-honesty check matches units at any depth. */
function collectUnitNames(units: Unit[], into: Set<string>): void {
  for (const u of units) {
    into.add(u.name);
    if (u.units.length > 0) collectUnitNames(u.units, into);
  }
}

/** Gap-fills map-owned census facts onto a unit's signals WITHOUT overwriting
 *  any key an adapter already claimed (adapter linkage signals win on the rare
 *  collision; census and linkage keys are otherwise disjoint). Only known keys
 *  present on the census object are copied — the census is map-constructed, so
 *  no untrusted key can reach here (prototype-pollution safe by construction). */
function applyCensusSignals(unit: Unit, census: UnitSignals): void {
  const target = unit.signals as unknown as Record<string, unknown>;
  const source = census as unknown as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    if (target[key] === undefined) target[key] = source[key];
  }
}

/**
 * Enriches a resolved unit in place: runs the map-owned signal census over its
 * directory, then — for a workspace-package that detect() reports as its own
 * monorepo — expands ONLY its workspace-package children (the workspace adapter
 * + census, never the root-level canonical/DF/SE/siblings adapters) into
 * unit.units[]. This is DET-02 composability, bounded by the recursion depth.
 * All diagnostics (census + nested expansion) are threaded into `diagnostics`.
 */
function enrichUnit(
  root: string,
  unit: Unit,
  depth: number,
  diagnostics: Diagnostic[],
): void {
  const absDir = path.join(root, unit.path);

  const census = censusSignals(absDir);
  applyCensusSignals(unit, census.signals);
  for (const d of census.diagnostics) diagnostics.push(d);

  if (depth >= MAX_MONOREPO_RECURSION_DEPTH) return;
  if (unit.kind !== "workspace-package") return;

  // detect() on the child's own path is DET-02 composability, not
  // self-recursion. It can only throw RootNotFoundError (a resolved unit dir
  // always exists, so it never does here); guard anyway — recursion never
  // throws.
  let childDetection: ReturnType<typeof detect>;
  try {
    childDetection = detect(absDir);
  } catch {
    return;
  }
  if (childDetection.mode !== "monorepo") return;

  unit.mode = "monorepo";
  // Workspace-expansion-only recursion: run the workspace adapter (never the
  // full registry) so a nested monorepo's units[] contains ONLY
  // source:"workspace" units — no phantom sibling/DF/SE sub-units.
  const childResult = workspaceAdapter(absDir, {
    detection: childDetection,
    ignore: [],
    options: {},
  });
  for (const d of childResult.diagnostics) diagnostics.push(d);

  const childMerged = merge(
    [{ source: "workspace", result: childResult }],
    false,
  );
  for (const d of childMerged.diagnostics) diagnostics.push(d);

  for (const child of childMerged.units) {
    enrichUnit(absDir, child, depth + 1, diagnostics);
  }
  unit.units = childMerged.units;
}

/**
 * Maps a directory tree into a deterministic PlatformMap. Runs detect() (the
 * only nonexistent-root throw), folds enabled adapters + caller-injected units
 * in precedence order through the pure merge() reducer, enriches every resolved
 * unit with the map-owned signal census, recurses into nested monorepos, and
 * returns it through serialize() for byte-identical output.
 */
export async function map(
  root: string,
  opts: MapOptions = {},
): Promise<PlatformMap> {
  // SEC-01 hard-error #2: a PRESENT-but-malformed platform-map.json throws
  // MalformedConfigError before detection/adapters run. This pre-read exists so
  // the config's `ignore` can be threaded into detect()'s sibling scan (the
  // pre-detection chicken-and-egg) AND is guarded by the canonical adapter's
  // CFG-09 disable toggle (disabled => never read the file). The canonical
  // adapter re-reads the (now-known-valid) config in the fold to produce its
  // units + side-channel; the two reads always agree (no writes, same process).
  const canonicalEnabled = opts.adapters?.canonical !== false;
  const preConfig = canonicalEnabled ? readCanonicalConfig(root) : null;
  const effectiveIgnore = [
    ...(opts.ignore ?? []),
    ...(preConfig?.ignore ?? []),
  ];

  // detect() is the throwing gate: it performs the nonexistent-root check and
  // throws RootNotFoundError (SEC-01) before any adapter runs.
  const detection = detect(root, {
    scanRoot: opts.scanRoot,
    ignore: effectiveIgnore,
  });

  const ctx: AdapterContext = {
    detection,
    ignore: effectiveIgnore,
    options: opts,
  };

  const selected = selectAdapters(opts);
  const adapterByName = new Map<AdapterName, Adapter>(
    selected.map((s): [AdapterName, Adapter] => [s.source, s.adapter]),
  );

  const results: Array<{
    source: AdapterName | "caller";
    result: AdapterResult;
  }> = [];
  // Adapter-failure + injected-path-escape diagnostics live outside the
  // adapter results, so thread them into the final map alongside merge()'s.
  const extraDiagnostics: Diagnostic[] = [];

  for (const name of PRECEDENCE) {
    if (name === "caller") {
      if (opts.units && opts.units.length > 0) {
        const partialUnits: PartialUnit[] = [];
        for (const u of opts.units) {
          // T-02-01: an injected path escaping root is dropped + diagnosed,
          // never followed.
          const guard = resolveWithinRoot(root, u.path);
          if (!guard.ok) {
            extraDiagnostics.push(guard.diagnostic);
            continue;
          }
          partialUnits.push({
            name: u.name,
            path: guard.relative,
            kind: "repo",
            source: "caller",
            ref: u.ref,
          });
        }
        results.push({
          source: "caller",
          result: { partialUnits, edges: [], diagnostics: [] },
        });
      }
      continue;
    }

    const adapter = adapterByName.get(name);
    if (adapter === undefined) continue;
    try {
      // Adapters may be sync or async; await handles both.
      const result = await adapter(root, ctx);
      results.push({ source: name, result });
    } catch (error) {
      // SEC-01: the TWO hard-error classes propagate — RootNotFoundError and
      // MalformedConfigError (a present-but-broken canonical config). EVERY
      // other adapter failure degrades to a MALFORMED_CONFIG diagnostic; that
      // canonical-vs-adapter asymmetry is the core of SEC-01.
      if (
        error instanceof RootNotFoundError ||
        error instanceof MalformedConfigError
      ) {
        throw error;
      }
      extraDiagnostics.push(malformedConfigDiagnostic(name, error));
    }
  }

  // The canonical adapter surfaces the promotion-gate flag + name/overrides via
  // its typed side-channel; every other adapter leaves it undefined.
  let canonicalSide: CanonicalSideChannel | undefined;
  for (const r of results) {
    if (r.source === "canonical" && r.result.canonical !== undefined) {
      canonicalSide = r.result.canonical;
    }
  }

  // Promotion gate ("detection proposes, config disposes"): declared units[]
  // turns unconfirmed siblings into UNCONFIGURED_SIBLING diagnostics.
  const merged = merge(results, canonicalSide?.declaredUnits ?? false);

  // map() owns the per-unit fs signal census + DET-02 monorepo recursion
  // (CONTEXT signal-ownership split). Census diagnostics join the map's.
  for (const unit of merged.units) {
    enrichUnit(root, unit, 0, extraDiagnostics);
  }

  // MODEL-06: map()'s per-unit loop — NOT the siblings adapter — owns the
  // default-branch ref probe, so it applies UNIFORMLY to every resolved
  // kind:"repo" unit (siblings, canonical-declared, DF-declared). A ref a
  // source authoritatively declared is left untouched (declared ref wins); only
  // units still at ref:null after merge are probed. Probes run CONCURRENTLY,
  // each bounded by probeRef's own timeout, so one hostile/slow repo degrades
  // to ref:null and never stalls the batch (T-02-10). probeRef never rejects
  // (it collapses every failure to null), so Promise.all is safe.
  // kind:"workspace-package" units are NEVER probed.
  await Promise.all(
    merged.units
      .filter((unit) => unit.kind === "repo" && unit.ref === null)
      .map(async (unit) => {
        unit.ref = await probeRef(path.join(root, unit.path));
      }),
  );

  // Overrides-honesty check (Assumption A3): an overrides key naming no
  // assembled unit is a stale mistake — warn + ignore (never throw). Valid
  // overrides are left on the config for Phase-3 role derivation; role stays
  // "unknown" this phase. Dangerous keys were already stripped by config.ts.
  if (canonicalSide?.overrides !== undefined) {
    const unitNames = new Set<string>();
    collectUnitNames(merged.units, unitNames);
    for (const key of Object.keys(canonicalSide.overrides)) {
      if (!unitNames.has(key)) {
        extraDiagnostics.push(staleOverrideDiagnostic(key));
      }
    }
  }

  const pm: PlatformMap = {
    // config.name is authoritative when present (CFG-01); else basename(root),
    // which never leaks an absolute path — fall back to a fixed placeholder
    // (never raw root) when basename is empty (errors.ts discipline).
    name: canonicalSide?.name ?? (path.basename(root) || "(root)"),
    root,
    mode: detection.mode,
    units: merged.units,
    edges: [],
    diagnostics: [...merged.diagnostics, ...extraDiagnostics],
    schemaVersion: 1,
  };

  return serialize(pm);
}
