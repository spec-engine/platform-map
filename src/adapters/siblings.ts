// CFG-07: the siblings adapter — promotes zero-config sibling git repos into
// provisional PartialUnits for the merge promotion gate. It REUSES the base
// scanSiblings scan (ignore-before-I/O, dotfile filter, `.git` gate,
// resolveWithinRoot, self-exclusion, sort-by-name — scan.ts) rather than
// re-implementing any of it, and layers on DF-pointer detection at the correct
// `.factory/df-config.json` STATE_DIR path (Pitfall 6).
//
// Deliberately NOT here:
//  - the MODEL-06 ref probe. Ref resolution is owned by map()'s per-unit loop
//    so it applies UNIFORMLY to every kind:"repo" unit (siblings,
//    canonical-declared, DF-declared), not just siblings. This module never
//    imports or calls the ref probe, and every emitted unit carries NO declared
//    ref — map()'s loop fills it (declared refs from other sources win).
//  - sorting (serialize.ts is the sole sort site) and edges (Phase 3 / GRAPH-01,
//    always []).
//
// Siblings are emitted `provisional:true` — merge()'s promotion gate decides
// real-unit vs UNCONFIGURED_SIBLING ("config disposes"). This adapter never
// throws: a failed scan or unreadable df-config.json degrades to omitted signals,
// never an exception (T-02-13).

import * as path from "node:path";
import { classifyDfConfig } from "../internal/df-pointer.js";
import { scanSiblings } from "../internal/scan.js";
import type { Diagnostic, UnitSignals } from "../types.js";
import type { AdapterContext, AdapterResult, PartialUnit } from "./index.js";

/**
 * Classifies `<siblingAbs>/.factory/df-config.json` into signals:
 *  - absent        -> {} (absence is omitted, never asserted false)
 *  - pointer-only  -> { hasDfPointer: true }
 *  - anything else -> { dfConfigConflict: true }
 */
function detectDfPointer(siblingAbs: string): Partial<UnitSignals> {
  switch (classifyDfConfig(siblingAbs)) {
    case "absent":
      return {};
    case "pointer":
      return { hasDfPointer: true };
    default:
      return { dfConfigConflict: true };
  }
}

/**
 * Enumerates candidate sibling repos as provisional PartialUnits. Reuses
 * `ctx.detection.siblings` when the detection already scanned them (multi-repo
 * mode); otherwise runs the base scan itself. Each sibling becomes a
 * `kind:"repo"` provisional unit with DF-pointer signals but NO declared ref
 * (map()'s per-unit loop owns the MODEL-06 probe). Returns `edges:[]` and never
 * sorts (serialize.ts is the sole sort site).
 */
export async function siblingsAdapter(
  root: string,
  ctx: AdapterContext,
): Promise<AdapterResult> {
  const diagnostics: Diagnostic[] = [];

  let siblings: NonNullable<AdapterContext["detection"]["siblings"]>;
  if (ctx.detection.siblings !== undefined) {
    siblings = ctx.detection.siblings;
  } else {
    const scan = scanSiblings(root, ctx.options.scanRoot ?? "..", ctx.ignore);
    siblings = scan.siblings;
    for (const d of scan.diagnostics) diagnostics.push(d);
  }

  const partialUnits: PartialUnit[] = [];
  for (const sib of siblings) {
    // sib.path is root-relative POSIX (may legitimately climb via ".." — CR-01);
    // resolve it back to an absolute path to probe the DF pointer.
    const siblingAbs = path.resolve(root, sib.path);
    partialUnits.push({
      name: sib.name,
      path: sib.path,
      kind: "repo",
      signals: detectDfPointer(siblingAbs),
      source: "siblings",
      provisional: true,
      // no `ref` — siblings never declare one; map()'s loop probes it.
    });
  }

  return { partialUnits, edges: [], diagnostics };
}
