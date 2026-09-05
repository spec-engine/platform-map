// detect(): what shape is this directory? A platform file makes it a
// multi-repo platform; a workspace manifest from any ecosystem makes it a
// monorepo; otherwise it is a single repo.

import * as fs from "node:fs";
import * as path from "node:path";
import { ECOSYSTEMS, type WorkspaceRead } from "./ecosystems.ts";
import { DirectoryNotFoundError } from "./errors.ts";
import { exists, isDirectory, readPlatformFile } from "./files.ts";
import type { Detection, EcosystemName } from "./types.ts";

export interface WorkspaceProbe extends WorkspaceRead {
  ecosystem: EcosystemName;
}

export function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** Every workspace declared in `dir`, one per ecosystem at most, in table
 *  order. Usually zero or one. */
export function probeWorkspaces(dir: string): WorkspaceProbe[] {
  const out: WorkspaceProbe[] = [];
  for (const eco of ECOSYSTEMS) {
    for (const kind of eco.workspaces) {
      const file = path.join(dir, kind.file);
      if (!exists(file)) continue;
      const read = kind.read(readText(file) ?? "", dir);
      if (read === null) continue;
      out.push({ ecosystem: eco.name, ...read });
      break;
    }
  }
  return out;
}

export function probeWorkspace(dir: string): WorkspaceProbe | null {
  return probeWorkspaces(dir)[0] ?? null;
}

export function assertDirectory(dir: string): void {
  if (!isDirectory(dir)) {
    throw new DirectoryNotFoundError(path.basename(path.resolve(dir)) || "/");
  }
}

export function detect(dir: string): Detection {
  assertDirectory(dir);
  if (readPlatformFile(dir).kind === "platform") return { mode: "multi-repo" };
  const ws = probeWorkspace(dir);
  if (ws !== null)
    return {
      mode: "monorepo",
      manifest: ws.manifest,
      ecosystem: ws.ecosystem,
      workspaceGlobs: ws.globs,
    };
  return { mode: "single-repo" };
}
