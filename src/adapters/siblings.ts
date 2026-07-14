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

import * as fs from "node:fs";
import * as path from "node:path";
import { scanSiblings } from "../internal/scan.js";
import type { Diagnostic, UnitSignals } from "../types.js";
import type { AdapterContext, AdapterResult, PartialUnit } from "./index.js";

/**
 * The DF pointer-only predicate (02-RESEARCH.md L418-426): a df-config.json is a
 * bare STATE_DIR pointer iff it is a plain object with exactly one top-level key
 * `platform`, itself a plain object with exactly one key `factoryDir` holding a
 * string. Anything else present-but-shaped-differently is a full/non-pointer
 * config. Uses explicit key-count + typeof checks (never spreads the untrusted
 * parsed object — prototype-pollution safe by construction).
 */
function isPointerOnly(parsed: unknown): boolean {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return false;
  }
  const obj = parsed as Record<string, unknown>;
  if (Object.keys(obj).length !== 1) return false;
  const platform = obj.platform;
  if (
    platform === null ||
    typeof platform !== "object" ||
    Array.isArray(platform)
  ) {
    return false;
  }
  const p = platform as Record<string, unknown>;
  return Object.keys(p).length === 1 && typeof p.factoryDir === "string";
}

/**
 * Reads `<siblingAbs>/.factory/df-config.json` and classifies it (T-02-13):
 *  - absent           -> {} (omit both signals; MODEL-02 absence-omission)
 *  - pointer-only     -> { hasDfPointer: true }
 *  - present, non-ptr -> { dfConfigConflict: true }
 *  - present, unparse -> { dfConfigConflict: true }
 * Never throws — an unreadable file is treated as absent.
 */
function detectDfPointer(siblingAbs: string): Partial<UnitSignals> {
  const p = path.join(siblingAbs, ".factory", "df-config.json");
  let text: string;
  try {
    text = fs.readFileSync(p, "utf8");
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { dfConfigConflict: true };
  }
  return isPointerOnly(parsed)
    ? { hasDfPointer: true }
    : { dfConfigConflict: true };
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
