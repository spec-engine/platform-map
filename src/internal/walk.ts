// A bounded directory walk. Never follows symlinks, skips node_modules and
// dot-directories, and stops with a SCAN_TRUNCATED diagnostic when the depth
// or entry cap is hit. Output order does not depend on the filesystem.

import * as fs from "node:fs";
import * as path from "node:path";
import type { Diagnostic } from "../types.ts";

export interface WalkOptions {
  maxDepth: number;
  maxEntries: number;
}

export interface WalkResult {
  /** Root-relative POSIX paths of every file and directory seen, sorted. */
  entries: string[];
  diagnostics: Diagnostic[];
}

function compare(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function readdir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function truncated(subject: string, reason: string): Diagnostic {
  return {
    code: "SCAN_TRUNCATED",
    severity: "warning",
    subject,
    message: `directory scan stopped early (${reason}) at ${subject}`,
  };
}

export function walk(root: string, opts: WalkOptions): WalkResult {
  const entries: string[] = [];
  const diagnostics: Diagnostic[] = [];
  let count = 0;
  let capped = false;

  function recurse(absDir: string, relDir: string, depth: number): void {
    const dirents = readdir(absDir).sort((a, b) => compare(a.name, b.name));
    for (const dirent of dirents) {
      if (capped) return;
      if (dirent.isSymbolicLink()) continue;
      if (
        dirent.isDirectory() &&
        (dirent.name === "node_modules" || dirent.name.startsWith("."))
      ) {
        continue;
      }
      if (count >= opts.maxEntries) {
        diagnostics.push(truncated(relDir, "too many entries"));
        capped = true;
        return;
      }
      const rel = relDir === "." ? dirent.name : `${relDir}/${dirent.name}`;
      entries.push(rel);
      count++;
      if (dirent.isDirectory()) {
        if (depth + 1 > opts.maxDepth) {
          diagnostics.push(truncated(rel, "too deep"));
          capped = true;
          return;
        }
        recurse(path.join(absDir, dirent.name), rel, depth + 1);
      }
    }
  }

  recurse(root, ".", 0);
  entries.sort(compare);
  return { entries, diagnostics };
}
