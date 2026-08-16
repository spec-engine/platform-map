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
// enriched with censusSignals(), and any resolved unit — a workspace-package OR
// a promoted kind:"repo" constituent (WR-03) — that detect() reports as its own
// monorepo has its units[] expanded via the workspace adapter ONLY (never the
// root-level canonical/DF/SE/siblings adapters).
//
// Plan 03-01 (GRAPH-01) makes pm.edges real: the per-unit census also yields
// workspaceDepNames, stashed per-unit in a map()-local depSideTable, and after
// the census loop buildEdges() translates those dep NAMES into workspace-package
// edges (from/to are Unit.name PATHs).
//
// Plan 03-03 completes Phase 3 at the assembly layer: after buildEdges the map()
// tail runs the GRAPH-05 STRICT ORDER — populateDegrees (writes
// workspaceInDegree/OutDegree, 0 included) -> cycle detection (emits one
// CYCLE_SUSPECTED warning per cycle via the shared scc.ts, never throws, GRAPH-04)
// -> applyRoles (stamps deriveRole()'s classification at all depths, canonical
// overrides win, MODEL-03/04). Degrees are written BEFORE roles so deriveRole's
// degree-sensitive rules never read undefined.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  Adapter,
  AdapterContext,
  AdapterResult,
  CanonicalSideChannel,
  PartialUnit,
} from "./adapters/index.js";
import { PRECEDENCE, selectAdapters } from "./adapters/index.js";
import { MEMBER_CONFIG, specEnginePlatform } from "./adapters/spec-engine.js";
import { workspaceAdapter } from "./adapters/workspace.js";
import { readLocalConfig, readPlatformFile } from "./config.js";
import { detect } from "./detect.js";
import { buildEdges, populateDegrees } from "./edges.js";
import { MalformedConfigError, RootNotFoundError } from "./errors.js";
import { matchGlob } from "./internal/glob.js";
import { resolveWithinRoot } from "./internal/path-guard.js";
import {
  isPhysicallyInsideBoundary,
  resolvePlatformContext,
  sniffPlatformFile,
} from "./internal/platform-root.js";
import { probeRef } from "./internal/ref-probe.js";
import { looksLikeRepoRoot, scanSiblings } from "./internal/scan.js";
import { canonicalCycles } from "./internal/scc.js";
import { serialize } from "./internal/serialize.js";
import { merge } from "./merge.js";
import { applyRoles } from "./role.js";
import { censusSignals } from "./signals.js";
import type {
  AdapterName,
  Diagnostic,
  Edge,
  MapOptions,
  PlatformDefinition,
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

/** WR-04: an unexpected throw from the post-merge signal census / monorepo
 *  recursion degrades to a MALFORMED_CONFIG diagnostic (never escapes map()),
 *  mirroring the adapter loop's SEC-01 discipline. RootNotFoundError and
 *  MalformedConfigError are re-thrown by the caller — only those two ever
 *  leave map(). The `path` locus is the unit whose enrichment failed. */
function censusFailureDiagnostic(unitPath: string, error: unknown): Diagnostic {
  const reason = error instanceof Error ? error.message : String(error);
  return {
    code: "MALFORMED_CONFIG",
    severity: "warning",
    path: unitPath,
    message: `MALFORMED_CONFIG: signal census failed for unit "${unitPath}": ${reason}`,
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

/** Collects every kind:"workspace-package" unit name at all depths — the node
 *  set fed to canonicalCycles (edges only ever form between workspace-packages,
 *  so kind:"repo" containers are never cycle members). */
function collectWorkspacePackageNames(units: Unit[], into: string[]): void {
  for (const u of units) {
    if (u.kind === "workspace-package") into.push(u.name);
    if (u.units.length > 0) collectWorkspacePackageNames(u.units, into);
  }
}

/** GRAPH-04: a suspected workspace dependency cycle surfaces as an additive
 *  CYCLE_SUSPECTED diagnostic — severity "warning" (NOT "error", which would
 *  prematurely trip the Phase-4 CLI exit-code-2 path), path = the
 *  lexically-smallest cycle member (cycle[0], since canonicalCycles sorts each
 *  member list). map() NEVER throws on a cycle; mapping still succeeds. The same
 *  scc.ts canonicalCycles backs graph().cycles(), so the two agree byte-for-byte. */
function cycleSuspectedDiagnostic(cycle: string[]): Diagnostic {
  return {
    code: "CYCLE_SUSPECTED",
    severity: "warning",
    path: cycle[0],
    message: `CYCLE_SUSPECTED: workspace dependency cycle among ${cycle.join(", ")}`,
  };
}

// ── RED-97 (IP-5/IP-7): platform drift diagnostics — stable message prefixes
// per sub-case, member names and root-relative paths only, never machine/
// absolute paths (D-02). ────────────────────────────────────────────────────

function danglingOverrideDiagnostic(memberName: string): Diagnostic {
  return {
    code: "PLATFORM_DRIFT",
    severity: "warning",
    path: "platform-map.local.json",
    message: `PLATFORM_DRIFT: dangling local override: platform-map.local.json names "${memberName}" which is not a listed member`,
  };
}

/** A local override escaping the resolution boundary reuses UNIT_PATH_ESCAPE
 *  with the "escapes resolution boundary" message (IP-5). Carries the member
 *  NAME only — the override value may be an absolute machine path and must
 *  never appear in output (D-02). */
function overrideEscapeDiagnostic(memberName: string): Diagnostic {
  return {
    code: "UNIT_PATH_ESCAPE",
    severity: "warning",
    path: memberName,
    message: `UNIT_PATH_ESCAPE: local location override for member "${memberName}" escapes resolution boundary`,
  };
}

function missingMemberDiagnostic(
  memberName: string,
  conventionalPath: string,
): Diagnostic {
  return {
    code: "PLATFORM_DRIFT",
    severity: "warning",
    path: conventionalPath,
    message: `PLATFORM_DRIFT: listed member missing: "${memberName}" not found at "${conventionalPath}"`,
  };
}

function markerNameMismatchDiagnostic(
  memberName: string,
  conventionalPath: string,
  found: string,
  expected: string,
): Diagnostic {
  return {
    code: "PLATFORM_DRIFT",
    severity: "warning",
    path: conventionalPath,
    message: `PLATFORM_DRIFT: marker platform-name mismatch: member "${memberName}" marker names "${found}" but the definition names "${expected}"`,
  };
}

function markerRootHintMismatchDiagnostic(
  memberName: string,
  conventionalPath: string,
  hint: string,
): Diagnostic {
  return {
    code: "PLATFORM_DRIFT",
    severity: "warning",
    path: conventionalPath,
    message: `PLATFORM_DRIFT: marker root-hint mismatch: member "${memberName}" root hint "${hint}" does not resolve to the platform root`,
  };
}

/** D-04: a platform-root child dir that is neither a git repo nor a listed
 *  member is surfaced (info), never silent. */
function nonRepoChildDiagnostic(entryName: string): Diagnostic {
  return {
    code: "PLATFORM_DRIFT",
    severity: "info",
    path: entryName,
    message: `PLATFORM_DRIFT: non-repo child: "${entryName}" at the platform root is neither a git repo nor a listed member`,
  };
}

/** WR-04-style degrade for the assembly drift-check block: an unexpected throw
 *  becomes a diagnostic, never escapes map() (SEC-01). */
function driftCheckFailureDiagnostic(error: unknown): Diagnostic {
  const reason = error instanceof Error ? error.message : String(error);
  return {
    code: "MALFORMED_CONFIG",
    severity: "warning",
    path: "platform-map.json",
    message: `MALFORMED_CONFIG: platform drift check failed: ${reason}`,
  };
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
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
 * directory, then — for ANY resolved unit (a workspace-package OR a promoted
 * kind:"repo" constituent, WR-03) that detect() reports as its own monorepo —
 * expands ONLY its workspace-package children (the workspace adapter + census,
 * never the root-level canonical/DF/SE/siblings adapters) into unit.units[] and
 * corrects unit.mode to "monorepo". This is DET-02 composability ("a multi-repo
 * constituent that is itself a monorepo is reported as mode:monorepo at its own
 * node"), bounded by the recursion depth. All diagnostics (census + nested
 * expansion) are threaded into `diagnostics`.
 */
function enrichUnit(
  root: string,
  unit: Unit,
  depth: number,
  diagnostics: Diagnostic[],
  depSideTable: Map<string, string[]>,
  absDirOverride?: string,
): void {
  // RED-97 (IP-6): a local disk-location override changes WHERE the member is
  // read from (census, nested workspace expansion) — never unit.path in
  // output. Only map()'s top-level loop supplies an override; recursion below
  // stays conventional relative to the (possibly overridden) parent dir.
  const absDir = absDirOverride ?? path.join(root, unit.path);

  // WR-01: pass the unit's platform-relative path as the census locus so an
  // invalid-package-name MALFORMED_CONFIG diagnostic reports which unit it came
  // from and stays deterministically ordered.
  const census = censusSignals(absDir, unit.path);
  applyCensusSignals(unit, census.signals);
  for (const d of census.diagnostics) diagnostics.push(d);

  // GRAPH-01: stash this unit's raw workspace dep-NAME candidates keyed by
  // Unit.name (all depths, so nested-monorepo children are covered) for
  // buildEdges below. Deps never enter the public model — they live only here.
  depSideTable.set(unit.name, census.workspaceDepNames);

  if (depth >= MAX_MONOREPO_RECURSION_DEPTH) return;

  // WR-03: DET-02 composability applies to a promoted kind:"repo" constituent
  // that is itself a monorepo (the headline multi-repo→monorepo case), not just
  // to workspace-package children — so BOTH kinds run the detect() probe below.
  // Recursion stays workspace-expansion-only (workspaceAdapter, never the
  // root-level registry) regardless of the parent's kind, and a non-monorepo
  // unit early-returns before its mode/units are touched.

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
    child.name = `${unit.name}/${child.name}`;
    enrichUnit(absDir, child, depth + 1, diagnostics, depSideTable);
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
  const canonicalEnabled = opts.adapters?.canonical !== false;

  // Adapter-failure + injected-path-escape + platform-resolution diagnostics
  // live outside the adapter results; threaded into the final map below.
  const extraDiagnostics: Diagnostic[] = [];

  // RED-97 (IP-3): pre-detect platform resolution — an adapter cannot
  // re-anchor the map root, so the bounded upward walk (IP-8) runs BEFORE
  // detect(). Gated on the canonical toggle (CFG-09: disabled => never read
  // platform-map.json files) and on the root existing (a nonexistent root must
  // still reach detect()'s RootNotFoundError throw, SEC-01). When resolution
  // yields null, everything platform-shaped below is skipped and this function
  // is byte-for-byte the pre-RED-97 map() — the rung-1/2 firewall.
  const boundary = opts.boundary ?? os.homedir();
  let effectiveRoot = root;
  let definition: PlatformDefinition | null = null;
  if (canonicalEnabled && fs.existsSync(root)) {
    const resolution = resolvePlatformContext(root, boundary);
    for (const d of resolution.diagnostics) extraDiagnostics.push(d);
    if (resolution.root !== null && resolution.definition !== undefined) {
      definition = resolution.definition;
      // Re-anchor ONLY when the resolved root is a different directory —
      // pm.root stays the caller's own string otherwise (byte-compat). When
      // re-anchored, pm.root becomes the resolved platform root: the
      // documented caller-anchor exception (IP-7), which is exactly what makes
      // map()-from-inside byte-identical to map()-at-root (PMAP-010).
      if (path.resolve(root) !== resolution.root) {
        effectiveRoot = resolution.root;
      }
    }
  }

  // SEC-01 hard-error #2: a PRESENT-but-malformed platform-map.json throws
  // MalformedConfigError before detection/adapters run — now possibly for the
  // file at the RESOLVED root. This pre-read exists so the config's `ignore`
  // can be threaded into detect()'s sibling scan (the pre-detection
  // chicken-and-egg) AND is guarded by the canonical adapter's CFG-09 disable
  // toggle (disabled => never read the file). The canonical adapter re-reads
  // the (now-known-valid) file in the fold to produce its units +
  // side-channel; the two reads always agree (no writes, same process). When
  // the resolver already delivered the definition, it is threaded directly —
  // no re-read (IP-3).
  const preFile =
    canonicalEnabled && definition === null
      ? readPlatformFile(effectiveRoot)
      : null;
  if (preFile !== null && preFile.kind === "definition") {
    // WR-03: a definition AT the invoked root is ALWAYS honored — the caller
    // explicitly pointed map() here, the same trust as today's canonical
    // config. The boundary governs the UPWARD WALK and marker/local-override
    // follow-targets only, never a definition the caller aimed at directly —
    // so a platform checked out at /tmp, /app, or a CI workspace outside
    // $HOME gets full rung-3 semantics (mode forcing, scanRoot ".", member
    // filtering, drift checks, local overrides), not a half-applied hybrid.
    definition = preFile.definition;
  }
  const preConfig =
    preFile !== null && (preFile.kind === "config" || preFile.kind === "marker")
      ? preFile.config
      : null;
  const effectiveIgnore = [
    ...(opts.ignore ?? []),
    ...(definition !== null
      ? (definition.ignore ?? [])
      : (preConfig?.ignore ?? [])),
  ];

  // RED-108: SE-platform discovery mode. A directory carrying a canonical
  // `spec-engine/` dir — and NO platform-map.json of any shape at the
  // (possibly re-anchored) root — is a platform by Spec Engine's own
  // declaration (SE's assertSpecPlatform contract), so map() classifies its
  // CHILDREN: the spec-engine adapter is swapped for its per-child variant,
  // the sibling scan runs at "." with RUNG1-02 repo-root parity, and the
  // merge promotion gate treats per-child member configs as the confirming
  // config. A platform-map.json always wins (canonical over convention); a
  // disabled canonical adapter never reads the file (CFG-09), so preConfig
  // is null and the convention may fire — consistent with that toggle. No
  // upward walk happens for SE mode: SE's own contract points at the
  // platform dir explicitly.
  const sePlatform =
    opts.adapters?.["spec-engine"] !== false &&
    definition === null &&
    preConfig === null &&
    isDirectory(path.join(effectiveRoot, "spec-engine"));

  // detect() is the throwing gate: it performs the nonexistent-root check and
  // throws RootNotFoundError (SEC-01) before any adapter runs. With a
  // definition at the (possibly re-anchored) root, scanRoot is forced to "."
  // so the platform root's own children become detection.siblings, flowing
  // through the untouched siblings adapter + merge promotion gate — unlisted
  // .git children come out as UNCONFIGURED_SIBLING with zero merge changes
  // (D-04, IP-3).
  const detection = detect(effectiveRoot, {
    scanRoot: definition !== null || sePlatform ? "." : opts.scanRoot,
    ignore: effectiveIgnore,
  });

  // Listed members are canonical-declared IDENTITIES, not sibling candidates:
  // drop them from the child scan so a member's physical presence (or local
  // relocation, IP-6) never changes its unit's sources/signals — this is what
  // keeps output byte-identical with and without an equivalent local override.
  // Unlisted children stay, feeding the D-04 promotion gate above. The array
  // is ALWAYS materialized (even empty) so the siblings adapter reuses the
  // "."-rooted child scan and never falls back to its own ".." parent scan.
  if (definition !== null) {
    const memberPaths = new Set(
      definition.members.map((m) => m.path ?? m.name),
    );
    detection.siblings = (detection.siblings ?? []).filter(
      (s) => !memberPaths.has(s.path),
    );
  }

  // RED-108: SE mode re-runs the child scan with the WIDENED candidate gate
  // (looksLikeRepoRoot: .git dir-or-file OR package.json — RUNG1-02 parity),
  // replacing detect()'s .git-only list. Config-carrying children are
  // confirmed member IDENTITIES, not candidates — dropped here exactly like
  // definition-mode listed members above, so only unconfigured repo-root
  // children reach the promotion gate (-> UNCONFIGURED_SIBLING, SE's
  // NO_SPEC_CONFIG bucket). The `spec-engine` dir itself is excluded
  // defensively (it can never be a member). The array is ALWAYS materialized
  // (even empty) so the siblings adapter reuses this scan and never falls
  // back to its own ".." parent scan. Scan diagnostics are dropped, same as
  // detect()'s own treatment of them (they only arise from a hostile
  // injected readdir seam, impossible with the real fs).
  if (sePlatform) {
    const { siblings } = scanSiblings(
      effectiveRoot,
      ".",
      effectiveIgnore,
      undefined,
      looksLikeRepoRoot,
    );
    detection.siblings = siblings.filter(
      (s) =>
        s.name !== "spec-engine" &&
        !fs.existsSync(path.join(effectiveRoot, s.path, MEMBER_CONFIG)),
    );
  }

  const ctx: AdapterContext = {
    detection,
    ignore: effectiveIgnore,
    options: opts,
  };

  const selected = selectAdapters(opts);
  const adapterByName = new Map<AdapterName, Adapter>(
    selected.map((s): [AdapterName, Adapter] => [s.source, s.adapter]),
  );
  // RED-108: in SE-platform mode the per-child variant runs at the SAME
  // spec-engine precedence rank (the registry itself never selects it). The
  // gate already required the adapter to be enabled.
  if (sePlatform) {
    adapterByName.set("spec-engine", specEnginePlatform);
  }

  const results: Array<{
    source: AdapterName | "caller";
    result: AdapterResult;
  }> = [];

  for (const name of PRECEDENCE) {
    if (name === "caller") {
      if (opts.units && opts.units.length > 0) {
        const partialUnits: PartialUnit[] = [];
        for (const u of opts.units) {
          // T-02-01: an injected path escaping root is dropped + diagnosed,
          // never followed.
          const guard = resolveWithinRoot(effectiveRoot, u.path);
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
      const result = await adapter(effectiveRoot, ctx);
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
  // turns unconfirmed siblings into UNCONFIGURED_SIBLING diagnostics. In SE
  // mode the disposing config is per-child member.json presence (RED-108,
  // AC3) — never a fake side-channel, which would also hijack pm.name.
  const merged = merge(results, canonicalSide?.declaredUnits ?? sePlatform);

  // RED-97 (IP-6, D-02): per-user local disk-location overrides. Read ONLY
  // when a definition is present at the resolved root — rungs 1/2 never touch
  // the file. The table redirects WHERE a member is read from disk (census,
  // ref probe, nested workspace expansion) — never the unit's `path` in
  // output. `null` marks a member forcibly missing (its override escaped the
  // boundary — the dir is NOT read, not even at the conventional location).
  const diskDirByName = new Map<string, string | null>();
  if (definition !== null) {
    const local = readLocalConfig(effectiveRoot);
    if (local !== null) {
      if (!local.ok) {
        // Malformed per-user machine state must never brick the map (IP-1).
        extraDiagnostics.push(local.diagnostic);
      } else if (local.config.locations !== undefined) {
        const memberNames = new Set(definition.members.map((m) => m.name));
        const locations = local.config.locations;
        for (const key of Object.keys(locations)) {
          const value = locations[key];
          if (value === undefined) continue;
          if (!memberNames.has(key)) {
            extraDiagnostics.push(danglingOverrideDiagnostic(key));
            continue;
          }
          // Relative to the platform root, or absolute — but never outside
          // the resolution boundary (D-06): an escape is diagnosed and the
          // member treated as missing, never followed. WR-02: the check is
          // PHYSICAL (realpath both sides) — a symlink inside the boundary
          // must not alias a directory outside it, and an unresolvable
          // target is an escape.
          const target = path.resolve(effectiveRoot, value);
          if (!isPhysicallyInsideBoundary(path.resolve(boundary), target)) {
            extraDiagnostics.push(overrideEscapeDiagnostic(key));
            diskDirByName.set(key, null);
            continue;
          }
          diskDirByName.set(key, target);
        }
      }
    }
  }

  /** The disk directory a top-level unit is read from: the local-override
   *  table by unit name (null = forcibly missing), else the conventional
   *  path under the (possibly re-anchored) root. */
  const unitDiskDir = (unit: Unit): string | null =>
    diskDirByName.has(unit.name)
      ? (diskDirByName.get(unit.name) as string | null)
      : path.join(effectiveRoot, unit.path);

  // map() owns the per-unit fs signal census + DET-02 monorepo recursion
  // (CONTEXT signal-ownership split). Census diagnostics join the map's.
  // WR-04: this loop runs under the SAME SEC-01 discipline as the adapter fold
  // above — only RootNotFoundError and MalformedConfigError may escape map();
  // any other unexpected throw from censusSignals/workspaceAdapter/merge (or the
  // nested recursion) degrades to a diagnostic instead of leaking out. Guarded
  // per-unit so one unit's failure never aborts the rest.
  // GRAPH-01: per-unit workspace dep-NAME candidates, keyed by Unit.name, filled
  // by enrichUnit at every depth; consumed by buildEdges after the loop.
  const depSideTable = new Map<string, string[]>();
  for (const unit of merged.units) {
    const dir = unitDiskDir(unit);
    // A forcibly-missing member (escaped override) is never read: the unit is
    // still emitted (identity exists) with empty signals (IP-5).
    if (dir === null) continue;
    try {
      enrichUnit(effectiveRoot, unit, 0, extraDiagnostics, depSideTable, dir);
    } catch (error) {
      if (
        error instanceof RootNotFoundError ||
        error instanceof MalformedConfigError
      ) {
        throw error;
      }
      extraDiagnostics.push(censusFailureDiagnostic(unit.path, error));
    }
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
  const probeCandidates =
    opts.refProbe === false
      ? []
      : merged.units.filter(
          (unit) => unit.kind === "repo" && unit.ref === null,
        );
  await Promise.all(
    probeCandidates.map(async (unit) => {
      // RED-97 (IP-6): probe at the member's actual disk location (local
      // override honored); a forcibly-missing member keeps ref:null.
      const dir = unitDiskDir(unit);
      if (dir === null) return;
      unit.ref = await probeRef(dir);
    }),
  );

  // RED-97 (IP-5/IP-7, D-04): assembly-time drift checks. Emitted at ASSEMBLY
  // — not resolution — so map()-from-inside-a-member and map()-at-root produce
  // identical diagnostic sets (PMAP-010 byte-equivalence holds even for
  // drifted platforms). Runs under the SEC-01 try/degrade discipline.
  if (definition !== null) {
    try {
      const resolvedPlatformRoot = path.resolve(effectiveRoot);
      for (const member of definition.members) {
        const conventionalPath = member.path ?? member.name;
        const dir = diskDirByName.has(member.name)
          ? (diskDirByName.get(member.name) as string | null)
          : path.join(effectiveRoot, conventionalPath);
        if (dir === null || !isDirectory(dir)) {
          // Listed-but-missing (conventional or overridden): the unit is
          // still emitted — identity exists, location doesn't (IP-5).
          extraDiagnostics.push(
            missingMemberDiagnostic(member.name, conventionalPath),
          );
          continue;
        }
        const sniff = sniffPlatformFile(dir);
        if (sniff.kind === "marker") {
          if (sniff.marker.platform !== definition.name) {
            extraDiagnostics.push(
              markerNameMismatchDiagnostic(
                member.name,
                conventionalPath,
                sniff.marker.platform,
                definition.name,
              ),
            );
          }
          // The root hint is evaluated against the member's CONVENTIONAL
          // path (pure path math) — a local relocation never changes the
          // drift verdict, preserving IP-6 byte-identity.
          const hint = sniff.marker.root ?? "..";
          if (
            path.resolve(resolvedPlatformRoot, conventionalPath, hint) !==
            resolvedPlatformRoot
          ) {
            extraDiagnostics.push(
              markerRootHintMismatchDiagnostic(
                member.name,
                conventionalPath,
                hint,
              ),
            );
          }
        }
        // No marker -> silent: absence is never a negative assertion
        // (MODEL-02); a definition/config/malformed member file is that
        // member's own standalone concern.
      }

      // D-04: enumerate platform-root child entries ONCE — a directory that
      // is not a member path, honors no ignore glob, and holds no .git is
      // surfaced as an info diagnostic (never silent). Dotdirs skipped;
      // symlinks not followed (Dirent.isDirectory() is false for symlinks).
      const memberTopSegments = new Set(
        definition.members.map((m) => (m.path ?? m.name).split("/")[0]),
      );
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(effectiveRoot, { withFileTypes: true });
      } catch {
        entries = [];
      }
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        if (!entry.isDirectory()) continue;
        if (memberTopSegments.has(entry.name)) continue;
        if (
          effectiveIgnore.length > 0 &&
          matchGlob(effectiveIgnore, [entry.name]).matched.length > 0
        ) {
          continue;
        }
        if (fs.existsSync(path.join(effectiveRoot, entry.name, ".git"))) {
          continue; // a .git child is the promotion gate's territory (D-04)
        }
        extraDiagnostics.push(nonRepoChildDiagnostic(entry.name));
      }
    } catch (error) {
      if (
        error instanceof RootNotFoundError ||
        error instanceof MalformedConfigError
      ) {
        throw error;
      }
      extraDiagnostics.push(driftCheckFailureDiagnostic(error));
    }
  }

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

  // GRAPH-01: translate each unit's raw dep NAMES into workspace-package edges
  // via the per-sibling-set packageName->Unit.name index. buildEdges returns
  // natural order; serialize() below is the sole sort site (sorts by (from,to)).
  const built = buildEdges(merged.units, (u) => depSideTable.get(u.name) ?? []);
  const edges = built.edges;
  for (const d of built.diagnostics) extraDiagnostics.push(d);

  // GRAPH-05 STRICT ORDER (03-03): degrees -> cycles -> roles, in exactly this
  // sequence. Degrees MUST be written before applyRoles or deriveRole's rules 2/4
  // read `undefined` and misclassify libraries as unknown.
  //
  // (1) Populate workspaceInDegree/workspaceOutDegree (0 written explicitly) onto
  //     every workspace-package unit from the flat edge list.
  populateDegrees(merged.units, edges);

  // (2) GRAPH-04: detect cycles over the workspace-package node set + edge
  //     adjacency and emit ONE CYCLE_SUSPECTED diagnostic per cycle (additive,
  //     never throws). Reuses the SAME scc.ts canonicalCycles as graph().cycles(),
  //     so the diagnostic and the query view agree byte-for-byte.
  const cycleNodes: string[] = [];
  collectWorkspacePackageNames(merged.units, cycleNodes);
  const adjacency = new Map<string, Set<string>>();
  for (const e of edges as Edge[]) {
    let outs = adjacency.get(e.from);
    if (outs === undefined) {
      outs = new Set<string>();
      adjacency.set(e.from, outs);
    }
    outs.add(e.to);
  }
  for (const cycle of canonicalCycles(cycleNodes, adjacency)) {
    extraDiagnostics.push(cycleSuspectedDiagnostic(cycle));
  }

  // (3) MODEL-03/04: stamp derived roles onto every unit at all depths; a
  //     canonical overrides[name].role beats derivation. Runs AFTER degrees so
  //     the degree-sensitive rules see populated values.
  //
  // ROADMAP-OWNER FLAG (deferred to Phase 5): the DESIGN §4 role anchor holds
  // against a SYNTHETIC spec-engine-shaped fixture but does NOT hold against the
  // LIVE ../spec-engine repo (there webapp derives to "library" and engine<->webapp
  // is a real 2-cycle). Live-repo parity is out of scope here and flagged for the
  // roadmap owner — do NOT test deriveRole against the live repo.
  applyRoles(merged.units, canonicalSide?.overrides);

  const pm: PlatformMap = {
    // config.name is authoritative when present (CFG-01) — for a platform
    // definition that is the definition's name regardless of invocation dir
    // (PMAP-010); else basename(root), which never leaks an absolute path —
    // fall back to a fixed placeholder (never raw root) when basename is
    // empty (errors.ts discipline).
    name:
      canonicalSide?.name ??
      (path.basename(path.resolve(effectiveRoot)) || "(root)"),
    // The (possibly re-anchored) root: the documented caller-anchor exception
    // — equals the caller's own string whenever no re-anchor happened (IP-7).
    root: effectiveRoot,
    // A definition at the resolved root forces the platform shape (D-01):
    // a platform root is multi-repo by declaration, not by sibling census.
    // An SE platform is likewise multi-repo by declaration — the canonical
    // spec-engine/ dir IS the declaration (RED-108).
    mode: definition !== null || sePlatform ? "multi-repo" : detection.mode,
    units: merged.units,
    edges,
    diagnostics: [...merged.diagnostics, ...extraDiagnostics],
    schemaVersion: 1,
  };

  return serialize(pm);
}
