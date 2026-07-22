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
