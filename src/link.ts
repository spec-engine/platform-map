// link: record, in the per-user file, where a platform and its members live
// on this machine when the checkout does not follow the child-directory
// convention. planLink decides; applyLink writes.

import * as path from "node:path";
import { assertDirectory } from "./detect.ts";
import {
  isDirectory,
  readPlatformFile,
  readUserConfig,
  userConfigPath,
  writeUserConfig,
} from "./files.ts";
import { findStart } from "./resolve.ts";
import type { LinkPlan, Options, WriteResult } from "./types.ts";

function platformNamed(root: string, name: string): boolean {
  if (!isDirectory(root)) return false;
  const read = readPlatformFile(root);
  return read.kind === "platform" && read.file.name === name;
}

export function planLink(dir: string, options: Options = {}): LinkPlan {
  assertDirectory(dir);
  const here = findStart(dir);
  const read = readPlatformFile(here);
  const userFile = userConfigPath(options);

  if (read.kind === "platform") {
    return { platformName: read.file.name, root: here, members: {}, userFile };
  }
  if (read.kind !== "marker") {
    return {
      platformName: path.basename(here),
      root: null,
      members: {},
      userFile,
      problem:
        read.kind === "invalid"
          ? read.diagnostic.message
          : "no platform-map.json here; run `platform-map init` in the platform directory first",
    };
  }

  const name = read.marker.platform;
  const parent = path.dirname(here);
  const known = readUserConfig(options).config[name]?.root;
  const root =
    options.root !== undefined && platformNamed(options.root, name)
      ? path.resolve(options.root)
      : platformNamed(parent, name)
        ? parent
        : known !== undefined && platformNamed(known, name)
          ? path.resolve(known)
          : null;

  if (root === null) {
    return {
      platformName: name,
      root: null,
      members: {},
      userFile,
      problem:
        options.root !== undefined
          ? `no platform file named "${name}" at ${options.root}`
          : `platform "${name}" is not located on this machine; pass --root <platform-dir>`,
    };
  }

  const memberName = read.marker.member ?? path.basename(here);
  const members: Record<string, string> = {};
  if (path.join(root, memberName) !== here) members[memberName] = here;
  return { platformName: name, root, members, userFile };
}

export function applyLink(plan: LinkPlan, options: Options = {}): WriteResult {
  if (plan.root === null) return { written: [], skipped: [] };
  const { config } = readUserConfig(options);
  const entry = config[plan.platformName] ?? { root: plan.root };
  entry.root = plan.root;
  if (Object.keys(plan.members).length > 0) {
    entry.members = { ...(entry.members ?? {}), ...plan.members };
  }
  config[plan.platformName] = entry;
  return { written: [writeUserConfig(config, options)], skipped: [] };
}
