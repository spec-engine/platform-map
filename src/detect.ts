// detect(): the cheap, recursive-composable shape probe (DET-01..03).
//
// COMPOSABILITY, NOT SELF-RECURSION (DET-02, 01-RESEARCH.md Pattern 1):
// detect() never calls itself and never loops over its own siblings/units.
// It is a pure, path-parameterized function — DET-02's "a multi-repo
// constituent that is itself a monorepo reports mode:'monorepo' at its own
// node" is satisfied by calling detect() again on that constituent's own
// path, which future callers (map()'s Phase-2 orchestrator, or a test) do
// explicitly. Proving this here would mean detect() reimplementing
// map()'s recursion budget, which is out of this phase's scope.
//
// DET-05 BOUNDARY: this module performs NO git subprocess and no sibling
// git I/O beyond directory listing + `.git` existence checks (delegated to
// internal/scan.ts). Every `Detection.siblings[].ref` is always `null` —
// the bounded origin/HEAD probe that would resolve it is Phase 2's siblings
// adapter. Only `node:fs` existence/read + `node:path` are used; no
// `import.meta.url`/`__dirname` (D-04) — resolution is always relative to
// the caller-supplied `root` argument.
//
// `Detection.workspaceGlobs` is the RAW glob strings only — no expansion
// into real paths happens here (that's Phase 2's workspace adapter).

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
    return null; // malformed JSON in an adapter source degrades silently here —
    // detect() has no diagnostics channel of its own (DESIGN.md's Detection
    // shape carries none); Phase 2's map() surfaces MALFORMED_CONFIG for
    // package.json/lerna.json parse failures.
  }
}

/**
 * Probe order (DET-03): pnpm-workspace.yaml > package.json "workspaces"
 * (yarn vs npm disambiguated by lockfile/config presence — RESEARCH.md
 * Pattern 2 / Assumptions Log A1) > lerna.json. turbo.json/nx.json are
 * checked separately as an orchestrator overlay and never gate flavor.
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
    // A1 (RESEARCH.md Pattern 2, Assumptions Log): "workspaces" in
    // package.json is used by BOTH Yarn and npm. Disambiguate by
    // lockfile/config presence, not the field itself — Yarn Berry ships no
    // yarn.lock by default, hence the .yarnrc.yml check. This heuristic is
    // a reconstruction flagged [ASSUMED] in 01-RESEARCH.md (not
    // independently re-verified against Dark Factory's actual source in
    // this repo — see 01-RESEARCH.md Open Question 1 / Assumptions Log A1).
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

/** turbo.json/nx.json — overlay only, informational, never gates flavor. */
function probeOrchestrator(root: string): Detection["orchestrator"] {
  if (exists(path.join(root, "turbo.json"))) return "turbo";
  if (exists(path.join(root, "nx.json"))) return "nx";
  return null;
}

function assertRootExists(root: string): void {
  if (!exists(root)) {
    // Never an absolute path in the thrown message (errors.ts contract) —
    // basename is enough to identify which root was missing.
    throw new RootNotFoundError(path.basename(root) || root);
  }
}

/**
 * Cheap shape probe: no sibling git I/O beyond directory listing + `.git`
 * checks (DET-05). Classifies `root` as `"monorepo"` (a workspace manifest
 * is present), `"multi-repo"` (no manifest, but sibling `.git` repos are
 * found alongside `root`), or `"single-repo"` (neither).
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

  const { siblings } = scanSiblings(root, opts.scanRoot ?? "..", opts.ignore);
  if (siblings.length > 0) {
    return { mode: "multi-repo", siblings, orchestrator };
  }

  return { mode: "single-repo", orchestrator };
}
