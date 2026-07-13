// SEC-02: the path-traversal guard. Every resolved sibling/unit path is
// checked against this before it's allowed to enter a Detection/PlatformMap
// — an escaping path is dropped with a UNIT_PATH_ESCAPE diagnostic, never
// silently followed (DESIGN.md §6, T-02-PT).
//
// Pure path math only: no filesystem calls, no symlink resolution (the
// walker/caller owns symlink-following decisions, D-11). No
// `import.meta.url`/`__dirname` (D-04) — resolution is always relative to a
// caller-supplied root.

import * as path from "node:path";
import type { Diagnostic } from "../types.js";

export type ResolveWithinRootResult =
  | { ok: true; relative: string }
  | { ok: false; diagnostic: Diagnostic };

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

/**
 * Resolves `candidate` against `root` and rejects any resolution that
 * escapes `root` (an absolute candidate, or a relative candidate whose
 * resolved path climbs above `root` via `..`). On success, returns the
 * normalized root-relative path with POSIX separators (determinism —
 * DESIGN.md §5).
 */
export function resolveWithinRoot(
  root: string,
  candidate: string,
): ResolveWithinRootResult {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(root, candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);

  const escapes =
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative);

  if (escapes) {
    return {
      ok: false,
      diagnostic: {
        code: "UNIT_PATH_ESCAPE",
        severity: "warning",
        path: toPosix(candidate),
        message: `UNIT_PATH_ESCAPE: resolved path escapes platform root: ${toPosix(candidate)}`,
      },
    };
  }

  return { ok: true, relative: relative === "" ? "." : toPosix(relative) };
}
