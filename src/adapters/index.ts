// The adapter registry: the ONE place adapter precedence is declared (CFG-03,
// CFG-09). Each adapter is a pure `(root, ctx) => AdapterResult` function that
// reads exactly one source of truth and NEVER calls another adapter — all
// cross-source reconciliation happens later, in merge.ts, not here
// (ARCHITECTURE.md Anti-Pattern 1). This module deliberately does NOT:
//   - run adapters (map() drives the fold),
//   - resolve/merge/sort anything (merge.ts + serialize.ts own that),
//   - perform any I/O (it is pure config/dispatch metadata).
//
// PRECEDENCE is the single source of truth for source ranking. `"caller"`
// (MapOptions.units) sits between canonical and dark-factory but has no
// adapter function — map() injects it directly, so selectAdapters() skips it.
// The ADAPTERS registry starts empty; later Phase-2 plans register real
// adapter functions into it with no change to this contract.

import type {
  AdapterName,
  Detection,
  Diagnostic,
  Edge,
  MapOptions,
  Mode,
  UnitSignals,
} from "../types.js";
import { workspaceAdapter } from "./workspace.js";

/** Everything an adapter needs, computed once by map() and shared read-only.
 *  Adapters never re-run detect() (A5) and never recurse (only map() does). */
export interface AdapterContext {
  detection: Detection;
  ignore: string[];
  options: MapOptions;
}

/** A single source's contribution toward one unit, BEFORE merge/precedence
 *  resolution. `path` is as-declared — map() applies resolveWithinRoot (SEC-02)
 *  at the merge/assembly seam, not inside adapters. `signals` carries ONLY the
 *  owning adapter's linkage signals (hasDfPointer/hasSpecEngineConfig, …); the
 *  filesystem census is map()-owned (CONTEXT signal-ownership split). */
export interface PartialUnit {
  name: string;
  path: string;
  kind: "repo" | "workspace-package";
  mode?: Mode;
  signals?: Partial<UnitSignals>;
  source: AdapterName | "caller";
  ref?: string;
  /** Siblings adapter marks candidates provisional; merge()'s promotion gate
   *  decides real-unit vs UNCONFIGURED_SIBLING (Pattern 3). */
  provisional?: boolean;
}

/** An adapter's full output. `edges` is always [] in Phase 2 (edges are
 *  Phase 3, GRAPH-01). Parse/read failures degrade to MALFORMED_CONFIG
 *  diagnostics here — only canonical (config.ts) and RootNotFoundError throw. */
export interface AdapterResult {
  partialUnits: PartialUnit[];
  edges: Edge[];
  diagnostics: Diagnostic[];
}

/** Pure source reader. May be sync or async (siblings runs a bounded ref
 *  probe); map() awaits either uniformly. */
export type Adapter = (
  root: string,
  ctx: AdapterContext,
) => Promise<AdapterResult> | AdapterResult;

/** The fixed precedence, high → low. The single place order is declared
 *  (mirrors detect()'s DET-03 probe-order idiom). `"caller"` has no adapter
 *  function — map() injects MapOptions.units at this rank directly. */
export const PRECEDENCE: Array<AdapterName | "caller"> = [
  "canonical",
  "caller",
  "dark-factory",
  "spec-engine",
  "workspace",
  "siblings",
];

/** Registered adapter functions. The workspace adapter (CFG-06) is wired here
 *  in plan 02-02; canonical/dark-factory/spec-engine/siblings arrive in later
 *  Phase-2 plans with no change to this contract. */
const ADAPTERS: Partial<Record<AdapterName, Adapter>> = {
  workspace: workspaceAdapter,
};

/**
 * Returns the enabled adapters in precedence order. Walks PRECEDENCE, skips
 * `"caller"` (map() handles injected units), and includes a name only when a
 * function is registered for it AND the caller has not disabled it via
 * `options.adapters[name] === false` (CFG-09). Order-preserving and pure.
 */
export function selectAdapters(
  options: MapOptions,
): Array<{ source: AdapterName; adapter: Adapter }> {
  const selected: Array<{ source: AdapterName; adapter: Adapter }> = [];
  for (const name of PRECEDENCE) {
    if (name === "caller") continue;
    const adapter = ADAPTERS[name];
    if (adapter === undefined) continue;
    if (options.adapters?.[name] === false) continue;
    selected.push({ source: name, adapter });
  }
  return selected;
}
