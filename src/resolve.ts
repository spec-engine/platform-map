// Finding the platform from wherever the command was run. First walk up to
// the nearest repo (a directory holding platform-map.json or .git), stopping
// at the home directory or the filesystem root. Then: a platform file here
// means this is the root; a marker means the root is the parent directory
// (the convention) or wherever the user file says it is.

import * as os from "node:os";
import * as path from "node:path";
import {
  exists,
  isDirectory,
  PLATFORM_FILE,
  readPlatformFile,
  readUserConfig,
} from "./files.ts";
import type { Diagnostic, Options, PlatformFile } from "./types.ts";

export type Resolution =
  | {
      kind: "platform";
      root: string;
      file: PlatformFile;
      diagnostics: Diagnostic[];
    }
  | {
      kind: "unlocated";
      dir: string;
      platform: string;
      diagnostics: Diagnostic[];
    }
  | { kind: "lone"; dir: string; diagnostics: Diagnostic[] };

/** The nearest directory at or above `dir` that holds platform-map.json or a
 *  .git entry. Stops at $HOME or the filesystem root; never follows symlinks.
 *  Falls back to `dir` itself. */
export function findStart(dir: string): string {
  const home = os.homedir();
  let current = path.resolve(dir);
  for (;;) {
    if (
      exists(path.join(current, PLATFORM_FILE)) ||
      exists(path.join(current, ".git"))
    ) {
      return current;
    }
    const parent = path.dirname(current);
    if (current === home || parent === current) return path.resolve(dir);
    current = parent;
  }
}

function notLocated(platform: string, detail: string): Diagnostic {
  return {
    code: "PLATFORM_NOT_LOCATED",
    severity: "warning",
    subject: platform,
    message: `platform "${platform}" is not located on this machine (${detail}); run \`platform-map link --root <platform-dir>\` here`,
  };
}

/** Reads the platform file at `root` and checks that it names `platform`. */
function platformAt(root: string, platform: string): PlatformFile | null {
  if (!isDirectory(root)) return null;
  const read = readPlatformFile(root);
  return read.kind === "platform" && read.file.name === platform
    ? read.file
    : null;
}

export function resolvePlatform(
  start: string,
  options: Options = {},
): Resolution {
  const here = readPlatformFile(start);
  if (here.kind === "platform") {
    return { kind: "platform", root: start, file: here.file, diagnostics: [] };
  }
  if (here.kind === "invalid") {
    return { kind: "lone", dir: start, diagnostics: [here.diagnostic] };
  }
  if (here.kind === "absent") {
    return { kind: "lone", dir: start, diagnostics: [] };
  }

  const platform = here.marker.platform;
  const parent = path.dirname(start);
  const byConvention = platformAt(parent, platform);
  if (byConvention !== null) {
    return {
      kind: "platform",
      root: parent,
      file: byConvention,
      diagnostics: [],
    };
  }

  const user = readUserConfig(options);
  const diagnostics: Diagnostic[] = user.diagnostic ? [user.diagnostic] : [];
  const entry = user.config[platform];
  if (entry === undefined) {
    diagnostics.push(
      notLocated(
        platform,
        "not in the user file and the parent directory is not its root",
      ),
    );
    return { kind: "unlocated", dir: start, platform, diagnostics };
  }
  const byUserFile = platformAt(entry.root, platform);
  if (byUserFile === null) {
    diagnostics.push(
      notLocated(
        platform,
        `the user file points at "${entry.root}" but no platform file named "${platform}" is there`,
      ),
    );
    return { kind: "unlocated", dir: start, platform, diagnostics };
  }
  return {
    kind: "platform",
    root: path.resolve(entry.root),
    file: byUserFile,
    diagnostics,
  };
}

/** Where a member lives on this machine: the user file's override, else the
 *  child directory named after it. */
export function memberDir(
  root: string,
  name: string,
  platform: string,
  options: Options = {},
): { dir: string; overridden: boolean } {
  const override = readUserConfig(options).config[platform]?.members?.[name];
  if (override !== undefined)
    return { dir: path.resolve(override), overridden: true };
  return { dir: path.join(root, name), overridden: false };
}
