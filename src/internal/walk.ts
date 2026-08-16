// [PRIM-04] A symlink-safe, depth/entry-capped directory walker: the bounded
// file-census primitive. `dirent.isSymbolicLink()` is checked for EVERY entry
// at EVERY recursion depth, BEFORE deciding whether to recurse; symlinked
// entries are skipped entirely (never realpath-followed, never in output),
// which alone terminates any symlink cycle. Hitting maxDepth or maxEntries
// appends a CENSUS_TRUNCATED diagnostic (never a silent partial result) and
// halts further descent. `readdir` is a test-only seam (directory-listing
// order is not guaranteed across platforms); production callers never pass it.

import * as fs from "node:fs";
import * as path from "node:path";
import type { Diagnostic } from "../types.js";

export interface WalkDirent {
  name: string;
  isSymbolicLink(): boolean;
  isDirectory(): boolean;
}

export interface WalkOptions {
  maxDepth: number;
  maxEntries: number;
  /** TEST-ONLY seam; production callers never override this. */
  readdir?: (dir: string) => WalkDirent[];
}

export interface WalkResult {
  entries: string[];
  diagnostics: Diagnostic[];
}

function defaultReaddir(dir: string): WalkDirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function compareCodeUnit(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function prunedDir(name: string): boolean {
  return name === "node_modules" || name.startsWith(".");
}

function truncated(locus: string, reason: string): Diagnostic {
  return {
    code: "CENSUS_TRUNCATED",
    severity: "warning",
    path: locus,
    message: `CENSUS_TRUNCATED: ${reason} at ${locus}`,
  };
}

/**
 * Walks `root` and returns every non-symlinked file/directory entry as a
 * root-relative POSIX path in plain code-unit sort order, identical
 * regardless of underlying directory-listing order. Never follows symlinks
 * (checked at every depth); halts and emits a single CENSUS_TRUNCATED
 * diagnostic the first time `maxDepth` or `maxEntries` would be exceeded.
 */
export function walk(root: string, opts: WalkOptions): WalkResult {
  const { maxDepth, maxEntries } = opts;
  const readdir = opts.readdir ?? defaultReaddir;

  const entries: string[] = [];
  const diagnostics: Diagnostic[] = [];
  let entryCount = 0;
  let capped = false;

  function recurse(absDir: string, relDir: string, depth: number): void {
    if (capped) return;

    const dirents = [...readdir(absDir)].sort((a, b) =>
      compareCodeUnit(a.name, b.name),
    );

    for (const dirent of dirents) {
      if (capped) return;

      if (dirent.isSymbolicLink()) continue; // never followed, never included
      if (dirent.isDirectory() && prunedDir(dirent.name)) continue;

      if (entryCount >= maxEntries) {
        diagnostics.push(truncated(relDir, "maxEntries exceeded"));
        capped = true;
        return;
      }

      const relPath = relDir === "." ? dirent.name : `${relDir}/${dirent.name}`;
      entries.push(relPath);
      entryCount++;

      if (dirent.isDirectory()) {
        if (depth + 1 > maxDepth) {
          diagnostics.push(truncated(relPath, "maxDepth exceeded"));
          capped = true;
          return;
        }
        recurse(path.join(absDir, dirent.name), relPath, depth + 1);
      }
    }
  }

  recurse(root, ".", 0);
  entries.sort(compareCodeUnit);

  return { entries, diagnostics };
}
