// PRIM-04, D-10/D-11: a symlink-safe, depth/entry-capped directory walker.
// This is the bounded file-census primitive Phase 2's adapters will use to
// expand workspace globs and derive language signals — a hostile/huge/
// symlink-cyclic target-repo tree must never hang or escape the walk
// (DESIGN.md §6, T-03-SYM/T-03-RES).
//
// Two structural bounds enforce this, never aspirational conventions:
//   - `dirent.isSymbolicLink()` is checked for EVERY entry at EVERY
//     recursion depth, BEFORE deciding whether to recurse — symlinked
//     entries are skipped entirely (never `fs.realpath`-followed, never
//     included in the output). This alone terminates any symlink cycle.
//   - `maxDepth`/`maxEntries` are threaded through the recursion; hitting
//     either cap appends a CENSUS_TRUNCATED diagnostic (never a silent
//     partial result) and halts further descent.
//
// `readdir` is an injectable seam PURELY for determinism testing (Pitfall
// 3/DETR-02: directory-listing order is not guaranteed across platforms) —
// production callers never pass it, defaulting to
// `fs.readdirSync(dir, { withFileTypes: true })`. Only `node:fs`/`node:path`
// are imported — no `import.meta.url`/`__dirname` (D-04).

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
  /** TEST-ONLY seam (Pitfall 3) — production callers never override this. */
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
 * root-relative POSIX path (sort-at-construction — final order is plain
 * code-unit sort, identical regardless of underlying directory-listing
 * order, DETR-02). Never follows symlinks (checked at every depth); halts
 * and emits a single CENSUS_TRUNCATED diagnostic the first time `maxDepth`
 * or `maxEntries` would be exceeded — never a silent partial result, never
 * a hang (PRIM-04).
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

      if (dirent.isSymbolicLink()) continue; // never followed, never included (Pitfall 5/6)

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
