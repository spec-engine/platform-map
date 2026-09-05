// describeRepo(): the facts about one repository: which ecosystem describes
// it, single repo or monorepo, its package name and package manager, its
// workspace packages, and the dependency names each manifest declares.
// `dependsOn` is computed later by map(), once every package name in the
// platform is known.

import * as path from "node:path";
import { probeWorkspaces, readText, type WorkspaceProbe } from "./detect.ts";
import {
  ECOSYSTEMS,
  type Ecosystem,
  ecosystem,
  type ManifestRead,
} from "./ecosystems.ts";
import { exists } from "./files.ts";
import { matchGlob } from "./internal/glob.ts";
import { walk } from "./internal/walk.ts";
import type { Diagnostic, EcosystemName, PackageManager } from "./types.ts";

const MAX_DEPTH = 16;
const MAX_ENTRIES = 10000;

export interface PackageFacts {
  path: string;
  ecosystem: EcosystemName;
  packageName?: string;
  deps: string[];
}

export interface RepoFacts {
  mode: "single-repo" | "monorepo";
  ecosystem?: EcosystemName;
  packageName?: string;
  packageManager?: PackageManager;
  deps: string[];
  packages: PackageFacts[];
  diagnostics: Diagnostic[];
}

/** Reads the ecosystem's manifest in `dir`; null when there is none. */
function readManifest(
  dir: string,
  eco: Ecosystem,
  subject: string,
  diagnostics: Diagnostic[],
): ManifestRead | null {
  const text = readText(path.join(dir, eco.manifest));
  if (text === null) return null;
  const read = eco.readManifest(text);
  if (read.problem !== undefined) {
    diagnostics.push({
      code: "MALFORMED_FILE",
      severity: "warning",
      subject,
      message: `${subject}/${eco.manifest}: ${read.problem}`,
    });
  }
  return read;
}

function packageManager(
  dir: string,
  eco: Ecosystem,
): PackageManager | undefined {
  for (const [file, manager] of eco.lockfiles) {
    if (exists(path.join(dir, file))) return manager;
  }
  return eco.defaultPackageManager;
}

/** The ecosystem that describes `dir`: the one whose workspace manifest is
 *  present, else the first in table order whose package manifest is. */
function chooseEcosystem(
  dir: string,
  subject: string,
  diagnostics: Diagnostic[],
): { eco: Ecosystem; workspace: WorkspaceProbe | null } | null {
  const workspaces = probeWorkspaces(dir);
  const withManifest = ECOSYSTEMS.filter(
    (e) =>
      exists(path.join(dir, e.manifest)) ||
      workspaces.some((w) => w.ecosystem === e.name),
  );
  const candidates =
    workspaces.length > 0
      ? workspaces.map((w) => w.ecosystem)
      : withManifest.map((e) => e.name);
  const chosen = candidates[0];
  if (chosen === undefined) return null;
  if (candidates.length > 1) {
    diagnostics.push({
      code: "AMBIGUOUS_ECOSYSTEM",
      severity: "info",
      subject,
      message: `"${subject}" has manifests for ${candidates.join(" and ")}; reporting ${chosen}`,
    });
  }
  return {
    eco: ecosystem(chosen),
    workspace: workspaces.find((w) => w.ecosystem === chosen) ?? null,
  };
}

export function describeRepo(dir: string, subject: string): RepoFacts {
  const diagnostics: Diagnostic[] = [];
  const facts: RepoFacts = {
    mode: "single-repo",
    deps: [],
    packages: [],
    diagnostics,
  };
  const choice = chooseEcosystem(dir, subject, diagnostics);
  if (choice === null) return facts;
  const { eco, workspace: ws } = choice;
  facts.ecosystem = eco.name;

  const root = readManifest(dir, eco, subject, diagnostics);
  if (root !== null) {
    facts.deps = root.deps;
    if (root.packageName !== undefined) facts.packageName = root.packageName;
  }
  const pm = packageManager(dir, eco);
  if (pm !== undefined) facts.packageManager = pm;

  if (ws === null) return facts;
  facts.mode = "monorepo";
  for (const d of ws.diagnostics)
    diagnostics.push({ ...d, subject: `${subject}/${d.subject}` });

  const walked = walk(dir, { maxDepth: MAX_DEPTH, maxEntries: MAX_ENTRIES });
  for (const d of walked.diagnostics)
    diagnostics.push({ ...d, subject: `${subject}/${d.subject}` });
  const matched = matchGlob(ws.globs, walked.entries);
  for (const d of matched.diagnostics)
    diagnostics.push({ ...d, subject: `${subject}: ${d.subject}` });

  for (const rel of matched.matched) {
    if (rel.split("/").includes("..")) continue;
    const pkg = readManifest(
      path.join(dir, rel),
      eco,
      `${subject}/${rel}`,
      diagnostics,
    );
    if (pkg === null) continue;
    const entry: PackageFacts = {
      path: rel,
      ecosystem: eco.name,
      deps: pkg.deps,
    };
    if (pkg.packageName !== undefined) entry.packageName = pkg.packageName;
    facts.packages.push(entry);
  }
  return facts;
}
