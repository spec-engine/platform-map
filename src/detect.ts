// detect(): what shape is this directory? A platform file makes it a
// multi-repo platform; a workspace manifest makes it a monorepo; otherwise it
// is a single repo. Reads at most four files.

import * as fs from "node:fs";
import * as path from "node:path";
import { DirectoryNotFoundError } from "./errors.ts";
import {
  exists,
  isDirectory,
  readJsonObject,
  readPlatformFile,
} from "./files.ts";
import { parsePnpmWorkspacePackages } from "./internal/yaml-subset.ts";
import type { Detection, Diagnostic } from "./types.ts";

export interface WorkspaceProbe {
  manifest: NonNullable<Detection["manifest"]>;
  globs: string[];
  diagnostics: Diagnostic[];
}

function strings(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((g): g is string => typeof g === "string")
    : [];
}

/** Which workspace manifest, if any, declares packages in `dir`. Probe order:
 *  pnpm-workspace.yaml, package.json "workspaces" (yarn if a yarn lockfile or
 *  .yarnrc.yml is present, else npm), lerna.json. */
export function probeWorkspace(dir: string): WorkspaceProbe | null {
  const pnpm = path.join(dir, "pnpm-workspace.yaml");
  if (exists(pnpm)) {
    let text = "";
    try {
      text = fs.readFileSync(pnpm, "utf8");
    } catch {
      /* unreadable: treat as empty */
    }
    const parsed = parsePnpmWorkspacePackages(text);
    return {
      manifest: "pnpm-workspace",
      globs: parsed.globs,
      diagnostics: parsed.diagnostics,
    };
  }

  const pkg = readJsonObject(path.join(dir, "package.json"));
  if (pkg?.ok && pkg.value.workspaces !== undefined) {
    const ws = pkg.value.workspaces;
    const globs = Array.isArray(ws)
      ? strings(ws)
      : strings((ws as { packages?: unknown } | null)?.packages);
    const isYarn =
      exists(path.join(dir, "yarn.lock")) ||
      exists(path.join(dir, ".yarnrc.yml"));
    return {
      manifest: isYarn ? "yarn-workspaces" : "npm-workspaces",
      globs,
      diagnostics: [],
    };
  }

  const lerna = readJsonObject(path.join(dir, "lerna.json"));
  if (lerna?.ok) {
    const globs = Array.isArray(lerna.value.packages)
      ? strings(lerna.value.packages)
      : ["packages/*"];
    return { manifest: "lerna", globs, diagnostics: [] };
  }

  return null;
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
      workspaceGlobs: ws.globs,
    };
  return { mode: "single-repo" };
}
