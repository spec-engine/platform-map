// CFG-05: the spec-engine adapter — reads <root>/spec-engine.member.json and
// expands its `members` glob into platform-relative sub-member units. It
// discards SE tool semantics entirely: the required `specs` pin and any
// `spec-engine.platform.json` manifest never enter the model (principle 8). It
// keeps exactly two config facts — `ignore` (member excludes) and `members`
// (the sub-member glob) — and surfaces one linkage signal, `hasSpecEngineConfig`.
//
// Members-glob expansion is ported OFF SE's Bun glob matcher onto the zero-dep,
// ReDoS-safe `matchGlob` + bounded `walk` primitives (T-02-21/T-02-23): a
// crafted glob can never catastrophically backtrack and a hostile/cyclic tree
// is depth/entry-capped and never symlink-followed. Every matched entry must be
// a DIRECTORY, must not be a basename `spec-engine` dir (never shadow the
// canonical row), and must pass resolveWithinRoot (T-02-22) before it becomes a
// unit; a `members`-listed `ignore` entry excludes it.
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

const MEMBER_CONFIG = "spec-engine.member.json";
const SE_MAX_DEPTH = 16;
const SE_MAX_ENTRIES = 10000;

/** TEST-ONLY injectable seam (mirrors the workspace adapter's `deps`): lets the
 *  file-skip, spec-engine-skip, ignore, and SEC-02-drop branches be exercised
 *  without materializing a hostile tree. Production callers never pass it. */
export interface SpecEngineAdapterDeps {
  walk?: (dir: string) => { entries: string[]; diagnostics: Diagnostic[] };
  isDir?: (absPath: string) => boolean;
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

/** Reads the `ignore` array (string entries only) from a validated member
 *  config object — an explicit known-key read (never a spread). */
function readIgnore(config: Record<string, unknown>): string[] {
  const raw = config.ignore;
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is string => typeof x === "string");
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
 * diagnostic. Returns edges:[] and never sorts. `specs`/pins are discarded.
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
  const parentName = path.basename(root) || "(root)";

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

  // `ignore` excludes a matched sub-member by rel path or basename (SE keeps
  // ignore; pins are discarded). Explicit key read, never a spread.
  const ignore = readIgnore(config);
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
    // WR-02: `ignore` is documented as globs, so exclude by matching the
    // rel path OR the basename through the zero-dep, ReDoS-safe `matchGlob`
    // (a documented glob like "packages/*" now actually excludes; an exact
    // name/path still matches itself as a subset). matchGlob's throwaway
    // UNMATCHED_PATTERN diagnostics are discarded — an ignore glob that
    // matches nothing here is normal, not a reportable error.
    if (matchGlob(ignore, [rel, path.basename(rel)]).matched.length > 0) {
      continue;
    }
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
