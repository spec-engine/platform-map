// Shallow sibling scanner (DET-04/05): lists a single directory (`scanRoot`,
// resolved relative to `platformRoot`) and returns candidate sibling repos —
// entries that have a `.git` directory or file. This is a FACTS-ONLY scan:
// candidates are not units, `ref` is always `null` (the git origin/HEAD
// probe that would populate it is Phase 2's siblings adapter, DET-05), and
// nothing here launches a subprocess of any kind.
//
// `readdir` is an injectable seam PURELY for determinism testing (Pitfall
// 3/DETR-02: `fs.readdirSync` order is not guaranteed across platforms) —
// production callers never pass it. Only `node:fs` + `node:path` +
// path-guard are imported here — no subprocess module of any kind.

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
 *  clone, or a submodule/worktree gitlink). This is the 0.1.0 behavior and
 *  stays the default for every scan that does not opt into a wider signal. */
function hasGitEntry(absEntryPath: string): boolean {
  return existsAt(absEntryPath, ".git");
}

/**
 * RED-108: repo-root signal with Spec Engine RUNG1-02 parity — `.git` (dir or
 * file) OR `package.json`. The marker set is deliberately this small so a
 * platform root's plain folders (src/, docs/, notes/) never qualify as
 * candidates. Used only by map()'s SE-platform child scan; the default
 * parent-oriented scan stays `.git`-only.
 */
export function looksLikeRepoRoot(absDir: string): boolean {
  return existsAt(absDir, ".git") || existsAt(absDir, "package.json");
}

// WR-02: `ignore` is documented as GLOBS (types.ts), so match each candidate
// through the zero-dep, ReDoS-safe `matchGlob` rather than exact-string
// `includes`. A literal with no wildcard chars still matches itself, so exact
// names remain a strict subset of the glob behavior. matchGlob's throwaway
// UNMATCHED_PATTERN diagnostics are discarded here — an ignore glob that
// matches nothing for a given entry is normal, not a reportable error.
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
 * Scans `scanRoot` (a path relative to `platformRoot`, typically ".." — the
 * parent of the repo detect() was called on) for candidate sibling repos.
 * Dotfiles and `ignore`-listed entries are filtered BEFORE any per-entry
 * filesystem check (ignore-before-I/O). Every resolved entry name is checked
 * with `resolveWithinRoot` against the *resolved scan directory* — this
 * guards against a crafted entry name smuggling extra `..` segments beyond
 * the scan directory (defense in depth against a hostile readdir seam), NOT
 * against the expected single-level climb that `scanRoot: ".."` itself
 * represents relative to `platformRoot` (CR-01: siblings legitimately live
 * outside the platform root — validating them against `platformRoot` itself
 * would reject every real sibling by construction). An escaping entry is
 * dropped with a UNIT_PATH_ESCAPE diagnostic and never entered (SEC-02).
 * The platform root's own entry is excluded from its own sibling list
 * (CR-02). Only entries passing `isCandidate` are kept — the default is the
 * `.git`-dir-or-file gate (0.1.0 behavior); map()'s SE-platform child scan
 * passes `looksLikeRepoRoot` for RUNG1-02 parity (RED-108). Returned
 * siblings are always sorted by `name` (sort-at-construction) so output is
 * identical regardless of the underlying directory-listing order.
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

    // Guards against a crafted entry name escaping the scan directory
    // itself, not against the expected ".." (CR-01).
    const guard = resolveWithinRoot(resolvedScanRoot, name);
    if (!guard.ok) {
      diagnostics.push(guard.diagnostic);
      continue;
    }

    const absoluteEntryPath = path.join(resolvedScanRoot, name);

    // Never list the platform root itself as its own sibling — with the
    // default scanRoot "..", resolvedScanRoot's listing necessarily
    // includes root's own basename (CR-02).
    if (absoluteEntryPath === resolvedPlatformRoot) continue;

    if (!isCandidate(absoluteEntryPath)) continue;

    const dfConfig = classifyDfConfig(absoluteEntryPath);
    siblings.push({
      name,
      path: path
        .relative(resolvedPlatformRoot, absoluteEntryPath)
        .split(path.sep)
        .join("/"),
      ref: null, // no git subprocess here — map()'s per-unit loop runs the ref probe
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
