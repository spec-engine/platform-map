// detect(): the cheap shape probe. It is a pure, path-parameterized function
// that never calls itself and never loops over its own siblings/units; a
// constituent that is itself a monorepo reports mode "monorepo" by calling
// detect() on that constituent's own path. No git subprocess runs here and
// sibling I/O is directory listing plus `.git` existence checks only, so
// every `Detection.siblings[].ref` is `null`. `Detection.workspaceGlobs` is
// the RAW glob strings, never expanded. Resolution is always relative to the
// caller-supplied `root`; no `import.meta.url`/`__dirname`.

import * as fs from "node:fs";
import * as path from "node:path";
import { RootNotFoundError } from "./errors.js";
import { scanSiblings } from "./internal/scan.js";
import { parsePnpmWorkspacePackages } from "./internal/yaml-subset.js";
import type { Detection, DetectOptions } from "./types.js";

type Flavor = NonNullable<Detection["flavor"]>;

interface ManifestProbe {
  flavor: Flavor;
  globs: string[];
}

function exists(p: string): boolean {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function readFile(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

function readJsonObject(p: string): Record<string, unknown> | null {
  const text = readFile(p);
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
    ) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null; // degrades silently: detect() has no diagnostics channel
  }
}

/**
 * Probe order is normative: pnpm-workspace.yaml > package.json "workspaces"
 * (yarn vs npm disambiguated by lockfile/config presence) > lerna.json.
 * turbo.json/nx.json are an orchestrator overlay and never gate flavor.
 */
function probeWorkspaceManifest(root: string): ManifestProbe | null {
  const pnpmYamlText = readFile(path.join(root, "pnpm-workspace.yaml"));
  if (pnpmYamlText !== null) {
    const { globs } = parsePnpmWorkspacePackages(pnpmYamlText);
    return { flavor: "pnpm", globs };
  }

  const pkgJson = readJsonObject(path.join(root, "package.json"));
  const workspaces = pkgJson?.workspaces;
  if (workspaces !== undefined) {
    const globs = Array.isArray(workspaces)
      ? (workspaces as string[])
      : ((workspaces as { packages?: string[] } | null)?.packages ?? []);
    // "workspaces" is used by BOTH Yarn and npm; disambiguate by
    // lockfile/config presence, not the field itself. Yarn Berry ships no
    // yarn.lock by default, hence the .yarnrc.yml check.
    const isYarn =
      exists(path.join(root, ".yarnrc.yml")) ||
      exists(path.join(root, "yarn.lock"));
    return { flavor: isYarn ? "yarn-workspaces" : "npm-workspaces", globs };
  }

  const lernaJson = readJsonObject(path.join(root, "lerna.json"));
  if (lernaJson !== null) {
    const globs = Array.isArray(lernaJson.packages)
      ? (lernaJson.packages as string[])
      : ["packages/*"];
    return { flavor: "lerna", globs };
  }

  return null;
}

/** Informational overlay only; never gates flavor. */
function probeOrchestrator(root: string): Detection["orchestrator"] {
  if (exists(path.join(root, "turbo.json"))) return "turbo";
  if (exists(path.join(root, "nx.json"))) return "nx";
  return null;
}

function assertRootExists(root: string): void {
  if (!exists(root)) {
    // Never an absolute path in the thrown message; basename identifies the
    // missing root, with a fixed placeholder when basename is empty (e.g. "/").
    throw new RootNotFoundError(path.basename(root) || "(root)");
  }
}

/**
 * Classifies `root` as `"monorepo"` (a workspace manifest is present),
 * `"multi-repo"` (no manifest, but sibling `.git` repos are found alongside
 * `root`), or `"single-repo"` (neither).
 */
export function detect(root: string, opts: DetectOptions = {}): Detection {
  assertRootExists(root);

  const manifest = probeWorkspaceManifest(root);
  const orchestrator = probeOrchestrator(root);

  if (manifest) {
    return {
      mode: "monorepo",
      workspaceGlobs: manifest.globs,
      flavor: manifest.flavor,
      orchestrator,
    };
  }

  // scanSiblings() diagnostics are intentionally discarded: Detection carries
  // no diagnostics field of its own.
  const { siblings } = scanSiblings(root, opts.scanRoot ?? "..", opts.ignore);
  if (siblings.length > 0) {
    return { mode: "multi-repo", siblings, orchestrator };
  }

  return { mode: "single-repo", orchestrator };
}
