// Shallow sibling scanner: lists a single directory (`scanRoot`, resolved
// relative to `platformRoot`) and returns candidate sibling repos. Facts only:
// candidates are not units, `ref` is always `null`, and nothing here launches
// a subprocess of any kind. `readdir` is an injectable seam PURELY for
// determinism testing (`fs.readdirSync` order is not guaranteed across
// platforms); production callers never pass it.

import * as fs from "node:fs";
import * as path from "node:path";
import type { Detection, Diagnostic } from "../types.js";
import { classifyDfConfig } from "./df-pointer.js";
import { matchGlob } from "./glob.js";
import { resolveWithinRoot } from "./path-guard.js";

type Sibling = NonNullable<Detection["siblings"]>[number];

function defaultReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function existsAt(entryPath: string, name: string): boolean {
  try {
    fs.statSync(path.join(entryPath, name));
    return true;
  } catch {
    return false;
  }
}

/** The default sibling-candidate gate: a `.git` directory or file (a plain
 *  clone, or a submodule/worktree gitlink). */
function hasGitEntry(absEntryPath: string): boolean {
  return existsAt(absEntryPath, ".git");
}

/**
 * Repo-root signal: `.git` (dir or file) OR `package.json`; deliberately this
 * small so a platform root's plain folders (src/, docs/) never qualify. Used
 * only by map()'s SE-platform child scan; the default parent-oriented scan
 * stays `.git`-only.
 */
export function looksLikeRepoRoot(absDir: string): boolean {
  return existsAt(absDir, ".git") || existsAt(absDir, "package.json");
}

// `ignore` entries are GLOBS via matchGlob; a bare literal still matches
// itself. UNMATCHED_PATTERN diagnostics are discarded: matching nothing here
// is normal, not an error.
function isIgnored(name: string, ignore: string[] | undefined): boolean {
  if (ignore === undefined || ignore.length === 0) return false;
  return matchGlob(ignore, [name]).matched.length > 0;
}

function compareByName(a: Sibling, b: Sibling): number {
  if (a.name < b.name) return -1;
  if (a.name > b.name) return 1;
  return 0;
}

/**
 * Scans `scanRoot` (relative to `platformRoot`, typically "..") for candidate
 * sibling repos. Dotfiles and `ignore`d entries are filtered BEFORE any
 * per-entry filesystem check; entry names are guarded against the *resolved
 * scan directory*, not `platformRoot` (siblings legitimately live outside the
 * platform root), and escapers are dropped with UNIT_PATH_ESCAPE. The default
 * `isCandidate` gate is `.git`-dir-or-file; map()'s SE-platform child scan
 * passes `looksLikeRepoRoot`. Siblings are sorted by `name`, independent of
 * directory-listing order.
 */
export function scanSiblings(
  platformRoot: string,
  scanRoot: string,
  ignore: string[] | undefined,
  readdir: (dir: string) => string[] = defaultReaddir,
  isCandidate: (absEntryPath: string) => boolean = hasGitEntry,
): { siblings: Sibling[]; diagnostics: Diagnostic[] } {
  const resolvedScanRoot = path.resolve(platformRoot, scanRoot);
  const resolvedPlatformRoot = path.resolve(platformRoot);

  let entries: string[];
  try {
    entries = readdir(resolvedScanRoot);
  } catch {
    entries = [];
  }

  const diagnostics: Diagnostic[] = [];
  const siblings: Sibling[] = [];

  for (const name of entries) {
    if (name.startsWith(".")) continue;
    if (isIgnored(name, ignore)) continue;

    const guard = resolveWithinRoot(resolvedScanRoot, name);
    if (!guard.ok) {
      diagnostics.push(guard.diagnostic);
      continue;
    }

    const absoluteEntryPath = path.join(resolvedScanRoot, name);

    // Never list the platform root itself as its own sibling: with the default
    // scanRoot "..", the listing necessarily includes root's own basename.
    if (absoluteEntryPath === resolvedPlatformRoot) continue;

    if (!isCandidate(absoluteEntryPath)) continue;

    const dfConfig = classifyDfConfig(absoluteEntryPath);
    siblings.push({
      name,
      path: path
        .relative(resolvedPlatformRoot, absoluteEntryPath)
        .split(path.sep)
        .join("/"),
      ref: null, // map()'s per-unit loop runs the ref probe
      hasDfPointer: dfConfig === "pointer",
      conflict:
        dfConfig === "full"
          ? "df-config.json is a full config, not a pointer"
          : dfConfig === "malformed"
            ? "df-config.json failed to parse"
            : null,
    });
  }

  siblings.sort(compareByName);

  return { siblings, diagnostics };
}
