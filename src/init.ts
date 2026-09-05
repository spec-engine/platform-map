// init: turn a folder of repositories into a declared platform. planInit
// decides what would be written; applyInit writes the confirmed subset. A
// marker that already exists is never overwritten.

import * as path from "node:path";
import { assertDirectory } from "./detect.ts";
import { discover } from "./discover.ts";
import { exists, PLATFORM_FILE, readPlatformFile, writeJson } from "./files.ts";
import type {
  InitPlan,
  LeafMarker,
  Options,
  PlatformFile,
  WriteResult,
} from "./types.ts";

function compare(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function markerPath(name: string): string {
  return `${name}/${PLATFORM_FILE}`;
}

export function planInit(dir: string, options: Options = {}): InitPlan {
  assertDirectory(dir);
  let root = path.resolve(dir);
  let read = readPlatformFile(root);

  // Run from inside a member: plan for the platform directory above it.
  if (
    read.kind === "marker" &&
    readPlatformFile(path.dirname(root)).kind === "platform"
  ) {
    root = path.dirname(root);
    read = readPlatformFile(root);
  }

  const platformName =
    read.kind === "platform" ? read.file.name : path.basename(root);
  const members = read.kind === "platform" ? read.file.members : [];
  const candidates = discover(root, options);
  const plan: InitPlan = {
    root,
    platformName,
    members,
    candidates,
    writes: {},
    skipped: [],
  };

  if (read.kind === "invalid") {
    plan.problem = read.diagnostic.message;
    return plan;
  }
  if (read.kind === "marker") {
    plan.problem = `${PLATFORM_FILE} here is a leaf marker for "${read.marker.platform}", and the parent directory is not that platform; run init in the platform directory`;
    return plan;
  }

  const eligible = candidates.filter(
    (c) => c.marker === undefined || c.marker === platformName,
  );
  const proposed = [
    ...new Set([
      ...members,
      ...eligible.filter((c) => !c.listed).map((c) => c.name),
    ]),
  ].sort(compare);
  const file: PlatformFile = { name: platformName, members: proposed };
  if (read.kind === "platform" && read.file.ignore !== undefined)
    file.ignore = read.file.ignore;
  plan.writes[PLATFORM_FILE] = file;

  for (const c of eligible) {
    if (exists(path.join(root, c.name, PLATFORM_FILE)))
      plan.skipped.push(markerPath(c.name));
    else
      plan.writes[markerPath(c.name)] = {
        platform: platformName,
        member: c.name,
      };
  }
  return plan;
}

/** Writes the platform file with `include` added to the members, and a marker
 *  in every included or already-listed candidate that lacks one. `include`
 *  is limited to names that appear in `plan.candidates`. */
export function applyInit(
  plan: InitPlan,
  include: string[],
  _options: Options = {},
): WriteResult {
  const written: string[] = [];
  const skipped: string[] = [];
  if (plan.problem !== undefined) return { written, skipped };

  const byName = new Map(plan.candidates.map((c) => [c.name, c]));
  const accepted = include.filter((n) => {
    const c = byName.get(n);
    return (
      c !== undefined &&
      (c.marker === undefined || c.marker === plan.platformName)
    );
  });
  const members = [...new Set([...plan.members, ...accepted])].sort(compare);

  const platformPath = path.join(plan.root, PLATFORM_FILE);
  const existing = plan.writes[PLATFORM_FILE] as PlatformFile | undefined;
  const file: PlatformFile = { name: plan.platformName, members };
  if (existing?.ignore !== undefined) file.ignore = existing.ignore;
  const unchanged =
    plan.members.length === members.length && exists(platformPath);
  if (unchanged) skipped.push(platformPath);
  else {
    writeJson(platformPath, file);
    written.push(platformPath);
  }

  const needMarker = new Set([
    ...accepted,
    ...plan.members.filter((m) => byName.has(m)),
  ]);
  for (const name of [...needMarker].sort(compare)) {
    const target = path.join(plan.root, name, PLATFORM_FILE);
    if (exists(target)) {
      skipped.push(target);
      continue;
    }
    const marker: LeafMarker = { platform: plan.platformName, member: name };
    writeJson(target, marker);
    written.push(target);
  }
  return { written, skipped };
}
