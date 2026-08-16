// [CFG-06] The workspace-package enumerator for monorepo roots: expands the
// detection's workspace globs over a bounded walk() and turns every matched
// directory holding a readable package.json into a kind:"workspace-package"
// PartialUnit. It reuses the Detection already on ctx (never re-probes a
// manifest) and never recurses (map() owns recursion). Escaping candidate
// paths are dropped via resolveWithinRoot with UNIT_PATH_ESCAPE. No signal
// census (map() owns it), no edges (always []), no sorting. `deps` is a
// test-only injection seam; production callers never pass it.

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
 * Enumerates workspace-package units for a monorepo `root`; empty result for
 * any other mode. Each matched directory with a readable package.json becomes
 * a PartialUnit whose name/path is the root-relative POSIX path.
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
    // Defense in depth: a candidate resolving outside root is dropped and
    // diagnosed (walk never emits an escaping path itself).
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
