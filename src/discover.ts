// discover(): which child directories of a folder look like repositories.
// A child counts if it has a .git entry or a package.json. Symlinks,
// node_modules, dot-directories, and ignored names are skipped.

import * as fs from "node:fs";
import * as path from "node:path";
import { assertDirectory } from "./detect.ts";
import { exists, readPlatformFile } from "./files.ts";
import type { Candidate, Options } from "./types.ts";

function compare(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export function discover(dir: string, options: Options = {}): Candidate[] {
  assertDirectory(dir);
  const platform = readPlatformFile(dir);
  const listed = new Set(
    platform.kind === "platform" ? platform.file.members : [],
  );
  const ignore = new Set([
    ...(options.ignore ?? []),
    ...(platform.kind === "platform" ? (platform.file.ignore ?? []) : []),
  ]);

  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const out: Candidate[] = [];
  for (const d of dirents) {
    if (d.isSymbolicLink() || !d.isDirectory()) continue;
    if (
      d.name === "node_modules" ||
      d.name.startsWith(".") ||
      ignore.has(d.name)
    )
      continue;
    const abs = path.join(dir, d.name);
    const hasGit = exists(path.join(abs, ".git"));
    const hasPackageJson = exists(path.join(abs, "package.json"));
    if (!hasGit && !hasPackageJson) continue;
    const candidate: Candidate = {
      name: d.name,
      hasGit,
      hasPackageJson,
      listed: listed.has(d.name),
    };
    const file = readPlatformFile(abs);
    if (file.kind === "marker") candidate.marker = file.marker.platform;
    out.push(candidate);
  }
  return out.sort((a, b) => compare(a.name, b.name));
}
