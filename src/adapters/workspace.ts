// CFG-06: the workspace-package enumerator. Analog of probeWorkspaceManifest
// in detect.ts (L81-116) — it REUSES the Detection already on ctx
// (flavor + workspaceGlobs from detect()); it NEVER re-probes a manifest (A5)
// and NEVER recurses (map() owns DET-02 recursion). For a monorepo root it
// expands the workspace globs against a bounded walk() of the tree, and every
// matched directory holding a readable package.json becomes a
// kind:"workspace-package" PartialUnit.
//
// Security posture:
//  - SEC-02: resolveWithinRoot(root, dir) on every candidate — an escaping
//    path is DROPPED with UNIT_PATH_ESCAPE, never followed (T-02-05).
//  - T-02-06: reuses matchGlob (segment two-pointer, no RegExp) — no ReDoS.
//  - T-02-07: walk()'s maxDepth/maxEntries caps + never-follow-symlinks.
//
// Deliberately NOT here:
//  - the fs signal census (map() owns it, CONTEXT signal-ownership split),
//  - dependency edges (Phase 3 / GRAPH-01) — returns edges:[] ALWAYS,
//  - sorting (serialize.ts is the sole sort site) — natural order out.
//
// The `deps` parameter is an injectable seam PURELY for unit tests (mirrors the
// walk/scan readdir seams) so the SEC-02-drop and UNMATCHED_PATTERN branches
// are reachable without materializing a hostile tree. Production callers never
// pass it — it defaults to the real walk + fs probe.

import * as fs from "node:fs";
import * as path from "node:path";
import { matchGlob } from "../internal/glob.js";
import { resolveWithinRoot } from "../internal/path-guard.js";
import { walk } from "../internal/walk.js";
import type { Diagnostic } from "../types.js";
import type { AdapterContext, AdapterResult, PartialUnit } from "./index.js";

const WORKSPACE_MAX_DEPTH = 16;
const WORKSPACE_MAX_ENTRIES = 10000;

/** TEST-ONLY injectable seam (see header). */
export interface WorkspaceAdapterDeps {
  walk?: (root: string) => { entries: string[]; diagnostics: Diagnostic[] };
  hasPackageJson?: (absDir: string) => boolean;
}

function defaultWalk(root: string): {
  entries: string[];
  diagnostics: Diagnostic[];
} {
  return walk(root, {
    maxDepth: WORKSPACE_MAX_DEPTH,
    maxEntries: WORKSPACE_MAX_ENTRIES,
  });
}

function defaultHasPackageJson(absDir: string): boolean {
  try {
    fs.statSync(path.join(absDir, "package.json"));
    return true;
  } catch {
    return false;
  }
}

/**
 * Enumerates workspace-package units for a monorepo `root`. No-op (empty
 * result) unless `ctx.detection.mode === "monorepo"`. Expands
 * `ctx.detection.workspaceGlobs` over a bounded walk of `root`; each matched
 * directory with a readable package.json becomes a PartialUnit
 * (kind:"workspace-package", source:"workspace") whose name/path is the
 * root-relative POSIX path. Returns edges:[] (Phase 3) and never sorts.
 */
export function workspaceAdapter(
  root: string,
  ctx: AdapterContext,
  deps: WorkspaceAdapterDeps = {},
): AdapterResult {
  const { detection } = ctx;
  if (detection.mode !== "monorepo") {
    return { partialUnits: [], edges: [], diagnostics: [] };
  }

  const globs = detection.workspaceGlobs ?? [];
  const walkFn = deps.walk ?? defaultWalk;
  const hasPackageJson = deps.hasPackageJson ?? defaultHasPackageJson;

  const diagnostics: Diagnostic[] = [];
  const partialUnits: PartialUnit[] = [];

  const walkResult = walkFn(root);
  for (const d of walkResult.diagnostics) diagnostics.push(d);

  const { matched, diagnostics: globDiagnostics } = matchGlob(
    globs,
    walkResult.entries,
  );
  for (const d of globDiagnostics) diagnostics.push(d);

  for (const relative of matched) {
    if (!hasPackageJson(path.join(root, relative))) continue;
    // SEC-02: a candidate resolving outside root is dropped + diagnosed
    // (defense in depth — walk never emits an escaping path itself).
    const guard = resolveWithinRoot(root, relative);
    if (!guard.ok) {
      diagnostics.push(guard.diagnostic);
      continue;
    }
    partialUnits.push({
      name: guard.relative,
      path: guard.relative,
      kind: "workspace-package",
      source: "workspace",
    });
  }

  return { partialUnits, edges: [], diagnostics };
}
