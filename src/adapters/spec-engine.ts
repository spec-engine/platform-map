// CFG-05: the spec-engine adapter — reads <root>/spec-engine.member.json and
// expands its `members` glob into platform-relative sub-member units. It
// discards SE tool semantics entirely: the required `specs` pin, the member
// config's `ignore` array, and any `spec-engine.platform.json` manifest never
// enter the model (principle 8). It keeps exactly one config fact — `members`
// (the sub-member glob) — and surfaces one linkage signal, `hasSpecEngineConfig`.
//
// RED-108 (AC4) ignore-under-expansion semantics, the normative statement SE's
// swap ticket (RED-95) conforms to: the member config's `ignore` is a TAG-SCAN
// hint (SE tool semantic — dirs excluded from SE's own tag/doc scans) and
// NEVER filters `members`-glob expansion. This matches SE's engine exactly
// (expandWorkspaceMembers takes no ignore parameter), reversing 0.1.0's WR-02
// filter which invented a membership semantic SE never had. platform-map's
// caller-level `opts.ignore` filters CHILD ENUMERATION only (sibling scan +
// SE-platform per-child classification), never expansion inside a member.
//
// Members-glob expansion is ported OFF SE's Bun glob matcher onto the zero-dep,
// ReDoS-safe `matchGlob` + bounded `walk` primitives (T-02-21/T-02-23): a
// crafted glob can never catastrophically backtrack and a hostile/cyclic tree
// is depth/entry-capped and never symlink-followed. Every matched entry must be
// a DIRECTORY, must not be a basename `spec-engine` dir (never shadow the
// canonical row), and must pass resolveWithinRoot (T-02-22) before it becomes a
// unit.
//
// Deliberately NOT here:
//  - SE's `skipped[]`/self-member/three-bucket NO_SPEC_CONFIG logic (that is the
//    siblings adapter's UNCONFIGURED_SIBLING equivalent, not this adapter's job),
//  - per-member pin extraction/inheritance (discarded — SE tool semantic),
//  - the fs signal census incl. SEC-03 packageName validation (map()-owned —
//    every sub-member flows through map()'s census, which already drops an
//    invalid package.json `name` with a MALFORMED_CONFIG diagnostic and keeps
//    the unit; adapters emit ONLY their linkage signal, never re-scan fs),
//  - sorting (serialize.ts is the sole sort site) and edges (Phase 3, always []).
//
// Never-throw contract (SEC-01): an absent file is fine (empty result); an
// unparseable/non-object config degrades to a MALFORMED_CONFIG diagnostic — only
// canonical (config.ts) and RootNotFoundError throw. Untrusted parsed objects
// are read by EXPLICIT known keys only, never spread (T-02-25).

import * as fs from "node:fs";
import * as path from "node:path";
import { matchGlob } from "../internal/glob.js";
import { resolveWithinRoot } from "../internal/path-guard.js";
import { walk } from "../internal/walk.js";
import type { Diagnostic, UnitSignals } from "../types.js";
import type { AdapterContext, AdapterResult, PartialUnit } from "./index.js";

/** The SE member-config filename — map()'s SE-platform sibling filter reuses
 *  it so "config-carrying" means the same file on both sides (RED-108). */
export const MEMBER_CONFIG = "spec-engine.member.json";
const SE_MAX_DEPTH = 16;
const SE_MAX_ENTRIES = 10000;

/** TEST-ONLY injectable seam (mirrors the workspace adapter's `deps`): lets the
 *  file-skip, spec-engine-skip, SEC-02-drop, and child-enumeration branches be
 *  exercised without materializing a hostile tree. Production callers never
 *  pass it. `readdir` feeds specEnginePlatform's child enumeration only. */
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

/**
 * Reads `<root>/spec-engine.member.json` and, when a `members` glob is present,
 * expands it (via matchGlob over a bounded walk) into platform-relative
 * sub-member units. The root member itself becomes a `hasSpecEngineConfig:true`
 * unit. Absent file -> empty result; unparseable/non-object -> MALFORMED_CONFIG
 * diagnostic. Returns edges:[] and never sorts. `specs`/pins and `ignore` are
 * discarded (RED-108 AC4: ignore is scan-only, never a membership filter).
 */
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
    // Absent (or unreadable) member config is fine — SE members are optional.
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
    // Present but not a JSON object -> degrade, never throw.
    return {
      partialUnits: [],
      edges: [],
      diagnostics: [malformedDiagnostic("member config is not a JSON object")],
    };
  }
  const config = parsed as Record<string, unknown>;

  const memberSignals: Partial<UnitSignals> = { hasSpecEngineConfig: true };
  const parentName = path.basename(path.resolve(root)) || "(root)";

  // The root dir carries spec-engine.member.json -> it is itself a member unit.
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
    // A glob can match files — only DIRECTORIES are sub-members.
    if (!isDir(subAbs)) continue;
    // Never shadow the canonical row: a basename `spec-engine` dir is skipped.
    if (path.basename(rel) === "spec-engine") continue;
    // RED-108 (AC4): the member config's `ignore` is deliberately NOT applied
    // here — it is an SE tag-scan hint, never a membership filter (see header).
    // T-02-22: an expanded sub-member path escaping the root is dropped.
    const guard = resolveWithinRoot(root, rel);
    if (!guard.ok) {
      diagnostics.push(guard.diagnostic);
      continue;
    }
    partialUnits.push({
      // Platform-relative naming: "<parentName>/<rel>" (SE's native convention).
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
 * RED-108: the SE-platform variant — per-CHILD classification for a platform
 * directory that carries a canonical `spec-engine/` dir instead of a
 * platform-map.json. map() swaps this in at the spec-engine precedence rank
 * when SE-platform mode fires; it is never selected by the registry.
 *
 * Each child directory carrying `<child>/spec-engine.member.json` is run
 * through specEngineAdapter at the child root and re-anchored to the platform:
 * the child's root unit becomes `{ name: <child>, path: <child> }` and each
 * expanded sub-member keeps its `<child>/<rel>` name with the path re-anchored
 * to match. Child kind is "repo" iff the child has a `.git` entry (dir or
 * file); a config-carrying child with neither `.git` nor package.json is still
 * a confirmed member (SE fixture shape) — as "workspace-package", so map()'s
 * ref probe never runs git in a non-repo dir (git would ascend to an enclosing
 * repo and leak an environment-dependent ref).
 *
 * Config PRESENCE is what confirms membership: a child whose member config
 * exists but is malformed is still config-carrying — it gets the adapter's
 * MALFORMED_CONFIG diagnostic (re-anchored to `<child>/spec-engine.member.json`,
 * no unit, matching the adapter's own root behavior) and never falls through
 * to the sibling promotion gate.
 * Unconfigured children are NOT this function's job: map()'s widened sibling
 * scan feeds them to the merge promotion gate as UNCONFIGURED_SIBLING.
 *
 * Enumeration is dotdir-skipped, basename-`spec-engine`-skipped, and
 * `ctx.ignore`-filtered (child-enumeration filtering — never expansion, AC4).
 * Never throws (SEC-01); never sorts (serialize.ts is the sole sort site, so
 * readdir order can never leak into output).
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
    // Never shadow the canonical row (same rule as expansion).
    if (name === "spec-engine") continue;
    if (
      ctx.ignore.length > 0 &&
      matchGlob(ctx.ignore, [name]).matched.length > 0
    ) {
      continue;
    }
    // Defense in depth against a hostile readdir seam smuggling ".." segments
    // (a real fs.readdirSync entry is always a bare basename) — SEC-02.
    const guard = resolveWithinRoot(root, name);
    if (!guard.ok) {
      diagnostics.push(guard.diagnostic);
      continue;
    }
    const childAbs = path.join(root, name);
    if (!isDir(childAbs)) continue;
    // Config PRESENCE confirms membership; readability is the adapter's own
    // concern (absent -> empty result, so presence must be probed here).
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
      // Re-anchor a child-relative locus to the platform root; absolute paths
      // never occur here (the adapter emits only relative loci).
      diagnostics.push(
        d.path !== undefined && !path.isAbsolute(d.path)
          ? { ...d, path: `${guard.relative}/${d.path}` }
          : d,
      );
    }
  }

  return { partialUnits, edges: [], diagnostics };
}
