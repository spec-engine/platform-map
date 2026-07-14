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
// This plan (02-01) ships the integration-neutral core: no adapters are
// registered yet (ADAPTERS is empty), so on a single-repo tree map() returns a
// real, deterministic PlatformMap with just the caller-injected units, if any.
// Deliberately NOT here yet: the per-unit fs signal census + monorepo recursion
// (plan 02) and edges (Phase 3) — edges is [] and every unit's role is
// "unknown" (seeded by merge()).

import * as path from "node:path";
import type {
  Adapter,
  AdapterContext,
  AdapterResult,
  PartialUnit,
} from "./adapters/index.js";
import { PRECEDENCE, selectAdapters } from "./adapters/index.js";
import { detect } from "./detect.js";
import { RootNotFoundError } from "./errors.js";
import { resolveWithinRoot } from "./internal/path-guard.js";
import { serialize } from "./internal/serialize.js";
import { merge } from "./merge.js";
import type {
  AdapterName,
  Diagnostic,
  MapOptions,
  PlatformMap,
} from "./types.js";

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

/**
 * Maps a directory tree into a deterministic PlatformMap. Runs detect() (the
 * only nonexistent-root throw), folds enabled adapters + caller-injected units
 * in precedence order through the pure merge() reducer, assembles the map, and
 * returns it through serialize() for byte-identical output.
 */
export async function map(
  root: string,
  opts: MapOptions = {},
): Promise<PlatformMap> {
  // detect() is the throwing gate: it performs the nonexistent-root check and
  // throws RootNotFoundError (SEC-01) before any adapter runs.
  const detection = detect(root, {
    scanRoot: opts.scanRoot,
    ignore: opts.ignore,
  });

  const ctx: AdapterContext = {
    detection,
    ignore: opts.ignore ?? [],
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
      // SEC-01: RootNotFoundError propagates (the malformed-canonical rethrow
      // branch is added in plan 04); every other adapter failure degrades.
      if (error instanceof RootNotFoundError) throw error;
      extraDiagnostics.push(malformedConfigDiagnostic(name, error));
    }
  }

  // canonicalDeclaredUnits is false until plan 04 wires the canonical adapter.
  const merged = merge(results, false);

  const pm: PlatformMap = {
    // basename() never leaks an absolute path; fall back to a fixed placeholder
    // (never raw root) when basename is empty (errors.ts discipline).
    name: path.basename(root) || "(root)",
    root,
    mode: detection.mode,
    units: merged.units,
    edges: [],
    diagnostics: [...merged.diagnostics, ...extraDiagnostics],
    schemaVersion: 1,
  };

  return serialize(pm);
}
