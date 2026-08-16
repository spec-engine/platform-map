// The adapter registry: the ONE place adapter precedence is declared. Each
// adapter is a pure `(root, ctx) => AdapterResult` reader of exactly one
// source of truth and NEVER calls another adapter; cross-source reconciliation
// happens later, in merge.ts. No I/O here: pure config/dispatch metadata.

import type {
  AdapterName,
  Detection,
  Diagnostic,
  Edge,
  MapOptions,
  Mode,
  Role,
  UnitSignals,
} from "../types.js";
import { canonicalAdapter } from "./canonical.js";
import { darkFactoryAdapter } from "./dark-factory.js";
import { siblingsAdapter } from "./siblings.js";
import { specEngineAdapter } from "./spec-engine.js";
import { workspaceAdapter } from "./workspace.js";

/** Everything an adapter needs, computed once by map() and shared read-only.
 *  Adapters never re-run detect() and never recurse. */
export interface AdapterContext {
  detection: Detection;
  ignore: string[];
  options: MapOptions;
}

/** A single source's contribution toward one unit, BEFORE merge/precedence
 *  resolution. `path` is as-declared; map() applies resolveWithinRoot at the
 *  assembly seam, not inside adapters. `signals` carries ONLY the owning
 *  adapter's linkage signals; the filesystem census is map()-owned. */
export interface PartialUnit {
  name: string;
  path: string;
  kind: "repo" | "workspace-package";
  mode?: Mode;
  signals?: Partial<UnitSignals>;
  source: AdapterName | "caller";
  ref?: string;
  /** Siblings adapter marks candidates provisional; merge()'s promotion gate
   *  decides real-unit vs UNCONFIGURED_SIBLING. */
  provisional?: boolean;
}

/** Config-level facts the CANONICAL adapter alone surfaces back to map():
 *  the promotion-gate flag plus name/ignore/overrides. */
export interface CanonicalSideChannel {
  /** Overrides PlatformMap.name when present (else basename(root)). */
  name?: string;
  /** Additional ignore globs to merge with adapter-supplied ignores. */
  ignore?: string[];
  /** Per-unit role overrides; validity-vs-assembled-units is checked in map(). */
  overrides?: Record<string, { role?: Role }>;
  /** The promotion gate: true iff config declared a non-empty units[], which
   *  turns unconfirmed siblings into UNCONFIGURED_SIBLING. */
  declaredUnits: boolean;
}

/** An adapter's full output. Parse/read failures degrade to MALFORMED_CONFIG
 *  diagnostics; only canonical (config.ts) and RootNotFoundError throw. */
export interface AdapterResult {
  partialUnits: PartialUnit[];
  edges: Edge[];
  diagnostics: Diagnostic[];
  canonical?: CanonicalSideChannel;
}

/** Pure source reader. May be sync or async (siblings runs a bounded ref
 *  probe); map() awaits either uniformly. */
export type Adapter = (
  root: string,
  ctx: AdapterContext,
) => Promise<AdapterResult> | AdapterResult;

/** The fixed precedence, high to low; the single place source ranking is
 *  declared. `"caller"` has no adapter function; map() injects
 *  MapOptions.units at this rank directly. */
export const PRECEDENCE: Array<AdapterName | "caller"> = [
  "canonical",
  "caller",
  "dark-factory",
  "spec-engine",
  "workspace",
  "siblings",
];

/** Listed in PRECEDENCE order for readability; PRECEDENCE is authoritative. */
const ADAPTERS: Partial<Record<AdapterName, Adapter>> = {
  canonical: canonicalAdapter,
  "dark-factory": darkFactoryAdapter,
  "spec-engine": specEngineAdapter,
  workspace: workspaceAdapter,
  siblings: siblingsAdapter,
};

/** Returns the enabled adapters in precedence order: skips `"caller"` and any
 *  name unregistered or disabled via `options.adapters[name] === false`.
 *  Order-preserving and pure. */
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
