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

function isIgnored(name: string, ignore: string[] | undefined): boolean {
  return ignore !== undefined && ignore.includes(name);
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
 * (CR-02). Only entries with a `.git` directory or file are kept. Returned
 * siblings are always sorted by `name` (sort-at-construction) so output is
 * identical regardless of the underlying directory-listing order.
 */
export function scanSiblings(
  platformRoot: string,
  scanRoot: string,
  ignore: string[] | undefined,
  readdir: (dir: string) => string[] = defaultReaddir,
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

    if (!existsAt(absoluteEntryPath, ".git")) continue;

    siblings.push({
      name,
      path: path
        .relative(resolvedPlatformRoot, absoluteEntryPath)
        .split(path.sep)
        .join("/"),
      ref: null, // DET-05: no git subprocess here — populated by Phase 2's siblings adapter
      hasDfPointer: existsAt(absoluteEntryPath, "df-config.json"),
      conflict: null,
    });
  }

  siblings.sort(compareByName);

  return { siblings, diagnostics };
}
