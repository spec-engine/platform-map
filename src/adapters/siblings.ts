// [CFG-07] The siblings adapter: promotes zero-config sibling git repos into
// provisional PartialUnits for merge()'s promotion gate ("config disposes"),
// reusing the base scanSiblings scan and layering on DF-pointer detection at
// `.factory/df-config.json`. Ref resolution is deliberately not here: map()'s
// per-unit loop probes refs uniformly for every kind:"repo" unit, so emitted
// units carry no declared ref. Emits edges:[] and never sorts; a failed scan
// or unreadable df-config.json degrades to omitted signals.

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
 * mode); otherwise runs the base scan itself.
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
    // sib.path is root-relative POSIX and may legitimately climb via "..";
    // resolve it back to an absolute path to probe the DF pointer.
    const siblingAbs = path.resolve(root, sib.path);
    partialUnits.push({
      name: sib.name,
      path: sib.path,
      kind: "repo",
      signals: detectDfPointer(siblingAbs),
      source: "siblings",
      provisional: true,
      // no `ref`: siblings never declare one; map()'s loop probes it.
    });
  }

  return { partialUnits, edges: [], diagnostics };
}
