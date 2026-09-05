// map(): the main read. Finds the platform, describes every member, computes
// dependsOn across the whole platform, reports what disagrees with disk, and
// sorts everything so the same files and disk always give the same JSON.
// locate() is the per-machine companion (absolute paths); check() is map()
// reduced to pass/fail.

import * as fs from "node:fs";
import * as path from "node:path";
import { assertDirectory } from "./detect.ts";
import { discover } from "./discover.ts";
import { ecosystem } from "./ecosystems.ts";
import { readPlatformFile } from "./files.ts";
import { describeRepo, type RepoFacts } from "./packages.ts";
import { findStart, memberDir, resolvePlatform } from "./resolve.ts";
import type {
  Diagnostic,
  EcosystemName,
  Locations,
  Options,
  Package,
  PlatformMap,
  Repo,
} from "./types.ts";

const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 } as const;

function compare(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function sortDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
  return [...diagnostics].sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      compare(a.code, b.code) ||
      compare(a.subject, b.subject) ||
      compare(a.message, b.message),
  );
}

/** A Repo with `dependsOn` still holding raw dependency names. */
interface DraftRepo extends Repo {
  packageDeps: string[][];
}

function draftRepo(
  name: string,
  facts: RepoFacts,
  present: boolean,
  marker: Repo["marker"],
): DraftRepo {
  const repo: DraftRepo = {
    name,
    mode: facts.mode,
    dependsOn: facts.deps,
    packages: facts.packages.map((p): Package => {
      const pkg: Package = {
        path: p.path,
        ecosystem: p.ecosystem,
        dependsOn: [],
      };
      if (p.packageName !== undefined) pkg.packageName = p.packageName;
      return pkg;
    }),
    present,
    marker,
    packageDeps: facts.packages.map((p) => p.deps),
  };
  if (facts.ecosystem !== undefined) repo.ecosystem = facts.ecosystem;
  if (facts.packageName !== undefined) repo.packageName = facts.packageName;
  if (facts.packageManager !== undefined)
    repo.packageManager = facts.packageManager;
  return repo;
}

function absentRepo(name: string): DraftRepo {
  return {
    name,
    mode: "single-repo",
    dependsOn: [],
    packages: [],
    present: false,
    marker: "unknown",
    packageDeps: [],
  };
}

/** Replaces raw dependency names with the platform's own package names in
 *  the same ecosystem, and puts the optional keys in a fixed order so JSON
 *  output is stable. */
function finalize(drafts: DraftRepo[]): Repo[] {
  const key = (eco: EcosystemName, name: string): string =>
    `${eco}\0${ecosystem(eco).canonical(name)}`;
  const known = new Map<string, string>();
  for (const r of drafts) {
    if (r.ecosystem !== undefined && r.packageName !== undefined)
      known.set(key(r.ecosystem, r.packageName), r.packageName);
    for (const p of r.packages)
      if (p.packageName !== undefined)
        known.set(key(p.ecosystem, p.packageName), p.packageName);
  }
  const own = (
    eco: EcosystemName | undefined,
    deps: string[],
    self: string | undefined,
  ): string[] => {
    if (eco === undefined) return [];
    const names = new Set<string>();
    for (const d of deps) {
      const found = known.get(key(eco, d));
      if (found !== undefined && found !== self) names.add(found);
    }
    return [...names].sort(compare);
  };

  return drafts
    .sort((a, b) => compare(a.name, b.name))
    .map((r): Repo => {
      const repo: Repo = { name: r.name, mode: r.mode } as Repo;
      if (r.ecosystem !== undefined) repo.ecosystem = r.ecosystem;
      if (r.packageName !== undefined) repo.packageName = r.packageName;
      if (r.packageManager !== undefined)
        repo.packageManager = r.packageManager;
      repo.dependsOn = own(r.ecosystem, r.dependsOn, r.packageName);
      repo.packages = r.packages
        .map((p, i): Package => {
          const pkg = { path: p.path, ecosystem: p.ecosystem } as Package;
          if (p.packageName !== undefined) pkg.packageName = p.packageName;
          pkg.dependsOn = own(
            p.ecosystem,
            r.packageDeps[i] ?? [],
            p.packageName,
          );
          return pkg;
        })
        .sort((a, b) => compare(a.path, b.path));
      repo.present = r.present;
      repo.marker = r.marker;
      return repo;
    });
}

function markerState(
  dir: string,
  platform: string,
): { state: Repo["marker"]; diagnostic?: Diagnostic } {
  const read = readPlatformFile(dir);
  if (read.kind === "marker") {
    return read.marker.platform === platform
      ? { state: "ok" }
      : { state: "mismatch" };
  }
  return { state: "missing" };
}

function build(
  name: string,
  mode: PlatformMap["mode"],
  declared: boolean,
  repos: DraftRepo[],
  diagnostics: Diagnostic[],
): PlatformMap {
  return {
    name,
    mode,
    declared,
    repos: finalize(repos),
    diagnostics: sortDiagnostics(diagnostics),
    schemaVersion: 2,
  };
}

export function map(dir: string, options: Options = {}): PlatformMap {
  assertDirectory(dir);
  const start = findStart(dir);
  const resolved = resolvePlatform(start, options);
  const diagnostics = [...resolved.diagnostics];

  if (resolved.kind === "platform") {
    const { root, file } = resolved;
    const repos: DraftRepo[] = [];
    for (const member of file.members) {
      const { dir: memberPath } = memberDir(root, member, file.name, options);
      if (!isDir(memberPath)) {
        diagnostics.push({
          code: "MEMBER_MISSING",
          severity: "warning",
          subject: member,
          message: `member "${member}" is listed but not found on this machine (expected at ${path.relative(root, memberPath) || "."}; run \`platform-map link\` in its checkout if it lives elsewhere)`,
        });
        repos.push(absentRepo(member));
        continue;
      }
      const facts = describeRepo(memberPath, member);
      diagnostics.push(...facts.diagnostics);
      const marker = markerState(memberPath, file.name);
      if (marker.state === "missing") {
        diagnostics.push({
          code: "MARKER_MISSING",
          severity: "warning",
          subject: member,
          message: `member "${member}" has no platform-map.json marker; run \`platform-map init\` to add it`,
        });
      } else if (marker.state === "mismatch") {
        diagnostics.push({
          code: "MARKER_MISMATCH",
          severity: "error",
          subject: member,
          message: `member "${member}" carries a marker for a different platform`,
        });
      }
      repos.push(draftRepo(member, facts, true, marker.state));
    }
    for (const c of discover(root, {
      ...options,
      ignore: [...(options.ignore ?? []), ...(file.ignore ?? [])],
    })) {
      if (!c.listed) {
        diagnostics.push({
          code: "UNLISTED_REPO",
          severity: "info",
          subject: c.name,
          message: `"${c.name}" is a repository in the platform folder but not a member; run \`platform-map init\` to add it`,
        });
      }
    }
    return build(file.name, "multi-repo", true, repos, diagnostics);
  }

  const here = resolved.dir;
  const name = path.basename(here);

  if (resolved.kind === "lone" && resolved.diagnostics.length === 0) {
    const candidates = discover(here, options);
    if (candidates.length >= 2) {
      const repos = candidates.map((c) => {
        const facts = describeRepo(path.join(here, c.name), c.name);
        diagnostics.push(...facts.diagnostics);
        const marker: Repo["marker"] =
          c.marker === undefined
            ? "missing"
            : c.marker === name
              ? "ok"
              : "mismatch";
        return draftRepo(c.name, facts, true, marker);
      });
      diagnostics.push({
        code: "UNDECLARED_PLATFORM",
        severity: "info",
        subject: name,
        message: `no platform-map.json here yet; run \`platform-map init\` to declare these ${candidates.length} repositories as members of "${name}"`,
      });
      return build(name, "multi-repo", false, repos, diagnostics);
    }
  }

  const facts = describeRepo(here, name);
  diagnostics.push(...facts.diagnostics);
  const marker: Repo["marker"] =
    resolved.kind === "unlocated" ? "ok" : "unknown";
  return build(
    name,
    facts.mode,
    true,
    [draftRepo(name, facts, true, marker)],
    diagnostics,
  );
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function locate(dir: string, options: Options = {}): Locations {
  assertDirectory(dir);
  const start = findStart(dir);
  const resolved = resolvePlatform(start, options);
  if (resolved.kind !== "platform") {
    return { root: path.resolve(start), repos: {}, overridden: [] };
  }
  const repos: Record<string, string> = {};
  const overridden: string[] = [];
  for (const member of resolved.file.members) {
    const { dir: memberPath, overridden: o } = memberDir(
      resolved.root,
      member,
      resolved.file.name,
      options,
    );
    if (!isDir(memberPath)) continue;
    repos[member] = memberPath;
    if (o) overridden.push(member);
  }
  return { root: path.resolve(resolved.root), repos, overridden };
}

export function check(
  dir: string,
  options: Options = {},
): { ok: boolean; problems: Diagnostic[] } {
  const problems = map(dir, options).diagnostics.filter(
    (d) => d.severity !== "info",
  );
  return { ok: problems.length === 0, problems };
}
