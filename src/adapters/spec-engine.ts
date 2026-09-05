// the spec-engine adapter reads <root>/spec-engine.member.json and
// expands its `members` glob (zero-dep, ReDoS-safe matchGlob over a bounded,
// non-symlink-following walk) into platform-relative sub-member units. All
// other Spec Engine tool semantics (the `specs` pin, `ignore`, any platform manifest)
// are discarded. Sub-members carry ONLY the hasSpecEngineConfig linkage
// signal: map()'s fs census owns every other signal, so adapters never
// re-scan the tree.
// Normative: the member config's `ignore` belongs to Spec Engine's own scanner and NEVER
// filters `members`-glob expansion (the Spec Engine member expander takes no
// ignore parameter); the caller-level `opts.ignore` filters child enumeration only.
// Never-throw: an absent config yields an empty result; an unparseable or
// non-object config degrades to MALFORMED_CONFIG. Untrusted parsed objects
// are read by explicit known keys only, never spread.

import * as fs from "node:fs";
import * as path from "node:path";
import { matchGlob } from "../internal/glob.js";
import { resolveWithinRoot } from "../internal/path-guard.js";
import { walk } from "../internal/walk.js";
import type { Diagnostic, UnitSignals } from "../types.js";
import type { AdapterContext, AdapterResult, PartialUnit } from "./index.js";

/** The Spec Engine member-config filename; map()'s spec-engine platform sibling filter reuses
 *  it so "config-carrying" means the same file on both sides. */
export const MEMBER_CONFIG = "spec-engine.member.json";
const SE_MAX_DEPTH = 16;
const SE_MAX_ENTRIES = 10000;

/** Test-only injectable seam; production callers never pass it. `readdir`
 *  feeds specEnginePlatform's child enumeration only. */
export interface SpecEngineAdapterDeps {
  walk?: (dir: string) => { entries: string[]; diagnostics: Diagnostic[] };
  isDir?: (absPath: string) => boolean;
  readdir?: (dir: string) => string[];
}

function defaultWalk(dir: string): {
  entries: string[];
  diagnostics: Diagnostic[];
} {
  return walk(dir, { maxDepth: SE_MAX_DEPTH, maxEntries: SE_MAX_ENTRIES });
}

function defaultIsDir(absPath: string): boolean {
  try {
    return fs.statSync(absPath).isDirectory();
  } catch {
    return false;
  }
}

function malformedDiagnostic(reason: string): Diagnostic {
  return {
    code: "MALFORMED_CONFIG",
    severity: "warning",
    path: MEMBER_CONFIG,
    message: `MALFORMED_CONFIG: ${MEMBER_CONFIG} failed to parse as JSON: ${reason}`,
  };
}

/** Reads the `members` glob (a single string) from a validated member config. */
function readMembersGlob(config: Record<string, unknown>): string | null {
  const raw = config.members;
  return typeof raw === "string" ? raw : null;
}

/** Expands the member config's `members` glob into sub-member units; the root
 *  member itself becomes a `hasSpecEngineConfig:true` unit. */
export function specEngineAdapter(
  root: string,
  _ctx: AdapterContext,
  deps: SpecEngineAdapterDeps = {},
): AdapterResult {
  const configPath = path.join(root, MEMBER_CONFIG);

  let text: string;
  try {
    text = fs.readFileSync(configPath, "utf8");
  } catch {
    // Absent (or unreadable) member config is fine: the file is optional.
    return { partialUnits: [], edges: [], diagnostics: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      partialUnits: [],
      edges: [],
      diagnostics: [malformedDiagnostic(reason)],
    };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      partialUnits: [],
      edges: [],
      diagnostics: [malformedDiagnostic("member config is not a JSON object")],
    };
  }
  const config = parsed as Record<string, unknown>;

  const memberSignals: Partial<UnitSignals> = { hasSpecEngineConfig: true };
  const parentName = path.basename(path.resolve(root)) || "(root)";

  // The root dir carries the config, so it is itself a member unit.
  const partialUnits: PartialUnit[] = [
    {
      name: parentName,
      path: ".",
      kind: "workspace-package",
      signals: memberSignals,
      source: "spec-engine",
    },
  ];
  const diagnostics: Diagnostic[] = [];

  const membersGlob = readMembersGlob(config);
  if (membersGlob === null) {
    return { partialUnits, edges: [], diagnostics };
  }

  const walkFn = deps.walk ?? defaultWalk;
  const isDir = deps.isDir ?? defaultIsDir;

  const walkResult = walkFn(root);
  for (const d of walkResult.diagnostics) diagnostics.push(d);

  const { matched, diagnostics: globDiagnostics } = matchGlob(
    [membersGlob],
    walkResult.entries,
  );
  for (const d of globDiagnostics) diagnostics.push(d);

  for (const rel of matched) {
    const subAbs = path.join(root, rel);
    // A glob can match files; only directories are sub-members.
    if (!isDir(subAbs)) continue;
    // A basename `spec-engine` dir never shadows the canonical row.
    if (path.basename(rel) === "spec-engine") continue;
    // `ignore` is deliberately not applied here (see header); a sub-member
    // path escaping the root is dropped.
    const guard = resolveWithinRoot(root, rel);
    if (!guard.ok) {
      diagnostics.push(guard.diagnostic);
      continue;
    }
    partialUnits.push({
      // Platform-relative naming, Spec Engine's native convention.
      name: `${parentName}/${guard.relative}`,
      path: guard.relative,
      kind: "workspace-package",
      signals: { hasSpecEngineConfig: true },
      source: "spec-engine",
    });
  }

  return { partialUnits, edges: [], diagnostics };
}

function defaultReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** `.git` present as a directory (plain clone) OR a file (gitlink). */
function hasGitEntry(absDir: string): boolean {
  try {
    fs.statSync(path.join(absDir, ".git"));
    return true;
  } catch {
    return false;
  }
}

/**
 * The spec-engine platform variant: per-child classification for a platform dir
 * carrying a canonical `spec-engine/` dir instead of a platform-map.json;
 * map() swaps it in directly, never the registry. Each config-carrying child
 * runs through specEngineAdapter at its root and is re-anchored to the
 * platform. Child kind is "repo" iff a `.git` entry exists; otherwise the
 * child stays "workspace-package" so map()'s ref probe never runs git in a
 * non-repo dir (git would ascend and leak an environment-dependent ref).
 * Config PRESENCE confirms membership: a malformed member config is still
 * config-carrying (re-anchored MALFORMED_CONFIG diagnostic, no unit), never
 * falling through to the sibling promotion gate; unconfigured children are
 * map()'s sibling-scan job. `ctx.ignore` filters child enumeration only.
 */
export function specEnginePlatform(
  root: string,
  ctx: AdapterContext,
  deps: SpecEngineAdapterDeps = {},
): AdapterResult {
  const readdir = deps.readdir ?? defaultReaddir;
  const isDir = deps.isDir ?? defaultIsDir;

  const partialUnits: PartialUnit[] = [];
  const diagnostics: Diagnostic[] = [];

  for (const name of readdir(root)) {
    if (name.startsWith(".")) continue;
    // A basename `spec-engine` dir never shadows the canonical row.
    if (name === "spec-engine") continue;
    if (
      ctx.ignore.length > 0 &&
      matchGlob(ctx.ignore, [name]).matched.length > 0
    ) {
      continue;
    }
    // Defense in depth against a hostile readdir seam smuggling ".." segments
    // (a real fs.readdirSync entry is always a bare basename).
    const guard = resolveWithinRoot(root, name);
    if (!guard.ok) {
      diagnostics.push(guard.diagnostic);
      continue;
    }
    const childAbs = path.join(root, name);
    if (!isDir(childAbs)) continue;
    // Presence must be probed here: the adapter treats absent as empty.
    if (!fs.existsSync(path.join(childAbs, MEMBER_CONFIG))) continue;

    const childKind: PartialUnit["kind"] = hasGitEntry(childAbs)
      ? "repo"
      : "workspace-package";
    const child = specEngineAdapter(childAbs, ctx, deps);

    for (const u of child.partialUnits) {
      if (u.path === ".") {
        partialUnits.push({
          ...u,
          name: guard.relative,
          path: guard.relative,
          kind: childKind,
        });
      } else {
        partialUnits.push({
          ...u,
          path: `${guard.relative}/${u.path}`,
        });
      }
    }
    for (const d of child.diagnostics) {
      // Re-anchor a child-relative locus to the platform root.
      diagnostics.push(
        d.path !== undefined && !path.isAbsolute(d.path)
          ? { ...d, path: `${guard.relative}/${d.path}` }
          : d,
      );
    }
  }

  return { partialUnits, edges: [], diagnostics };
}
