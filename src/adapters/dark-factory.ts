// CFG-04: the dark-factory adapter — reads <root>/.factory/df-config.json (DF's
// STATE_DIR = .factory, Pitfall 6) and REPORTS linkage facts only. It never
// resolves the DF pointer, never reads DF contracts/waves, and never turns
// `platform.repos[].dependsOn[]` into edges — those are DF tool semantics
// (principle 8) or Phase-3 graph work. This adapter surfaces exactly three
// things: the pointer-only linkage signal (hasDfPointer), the conflict linkage
// signal (dfConfigConflict), and the `platform.repos[]` units a full config
// declares.
//
// Classification of a present-and-parseable <root>/.factory/df-config.json:
//   - pointer-only (exactly `{ platform: { factoryDir: string } }`)  -> a root
//     PartialUnit carrying `hasDfPointer: true`, NO repo units (DF resolves the
//     pointer itself; we only report presence).
//   - full config carrying `platform.repos[]`                        -> one
//     kind:"repo" PartialUnit per entry (path via resolveWithinRoot; declared
//     `ref` carried through; `dependsOn[]` IGNORED — edges are Phase 3).
//   - present but neither shape                                      -> a root
//     PartialUnit carrying `dfConfigConflict: true` (DF's T-03.05-03 signal).
//
// Deliberately NOT here:
//  - the MODEL-06 ref probe. A declared repo `ref` is carried through untouched
//    (declared ref wins); a repo WITHOUT one is left ref-less for map()'s
//    per-unit loop to probe uniformly across every kind:"repo" unit.
//  - sorting (serialize.ts is the sole sort site) and edges (Phase 3, always []).
//
// Never-throw contract (SEC-01): an absent file is fine (empty result); an
// unparseable file degrades to a MALFORMED_CONFIG diagnostic — only canonical
// (config.ts) and RootNotFoundError throw. Untrusted parsed objects are read by
// EXPLICIT known keys only, never spread (prototype-pollution safe, T-02-25).

import * as fs from "node:fs";
import * as path from "node:path";
import { isPointerOnly } from "../internal/df-pointer.js";
import { resolveWithinRoot } from "../internal/path-guard.js";
import type { Diagnostic, UnitSignals } from "../types.js";
import type { AdapterContext, AdapterResult, PartialUnit } from "./index.js";

const STATE_DIR = ".factory";
const DF_CONFIG = "df-config.json";

/** Extracts `platform.repos` as an array when the config is a full config
 *  (a plain object whose `platform` is a plain object holding a `repos` array);
 *  returns null for any other shape. Explicit key reads only (never a spread). */
function readPlatformRepos(parsed: unknown): unknown[] | null {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const platform = (parsed as Record<string, unknown>).platform;
  if (
    platform === null ||
    typeof platform !== "object" ||
    Array.isArray(platform)
  ) {
    return null;
  }
  const repos = (platform as Record<string, unknown>).repos;
  return Array.isArray(repos) ? repos : null;
}

function malformedDiagnostic(reason: string): Diagnostic {
  return {
    code: "MALFORMED_CONFIG",
    severity: "warning",
    path: `${STATE_DIR}/${DF_CONFIG}`,
    message: `MALFORMED_CONFIG: ${STATE_DIR}/${DF_CONFIG} failed to parse as JSON: ${reason}`,
  };
}

/** The root/platform PartialUnit that carries a linkage signal when the config
 *  is pointer-only or conflicting (there are no repos[] to attach it to). Its
 *  identity is the platform root itself (path "."); name mirrors map()'s
 *  basename-or-"(root)" discipline so no absolute path ever leaks. */
function rootUnit(root: string, signals: Partial<UnitSignals>): PartialUnit {
  return {
    name: path.basename(path.resolve(root)) || "(root)",
    path: ".",
    kind: "repo",
    signals,
    source: "dark-factory",
  };
}

/**
 * Reads `<root>/.factory/df-config.json` and maps it per the classification in
 * the header. Absent file -> empty result; unparseable -> MALFORMED_CONFIG
 * diagnostic; pointer-only -> root unit + hasDfPointer; full config ->
 * `platform.repos[]` units (dependsOn ignored, edges []); any other present
 * shape -> root unit + dfConfigConflict. Returns edges:[] and never sorts.
 */
export function darkFactoryAdapter(
  root: string,
  _ctx: AdapterContext,
): AdapterResult {
  const configPath = path.join(root, STATE_DIR, DF_CONFIG);

  let text: string;
  try {
    text = fs.readFileSync(configPath, "utf8");
  } catch {
    // Absent (or unreadable) df-config.json is fine — DF platforms are optional.
    return { partialUnits: [], edges: [], diagnostics: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // Malformed another-tool file degrades to a diagnostic — never a throw.
    return {
      partialUnits: [],
      edges: [],
      diagnostics: [malformedDiagnostic(reason)],
    };
  }

  // Pointer-only: report the linkage signal, emit NO repo units (principle 8).
  if (isPointerOnly(parsed)) {
    return {
      partialUnits: [rootUnit(root, { hasDfPointer: true })],
      edges: [],
      diagnostics: [],
    };
  }

  // Full config: emit one kind:"repo" unit per platform.repos[] entry.
  const repos = readPlatformRepos(parsed);
  if (repos !== null) {
    const partialUnits: PartialUnit[] = [];
    const diagnostics: Diagnostic[] = [];
    for (const entry of repos) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        continue; // skip a non-object repo entry defensively
      }
      const repo = entry as Record<string, unknown>;
      const name = repo.name;
      const declaredPath = repo.path;
      if (typeof name !== "string" || typeof declaredPath !== "string") {
        continue; // a repo without a string name/path cannot become a unit
      }
      // T-02-22: a declared repo path escaping the platform root is dropped.
      const guard = resolveWithinRoot(root, declaredPath);
      if (!guard.ok) {
        diagnostics.push(guard.diagnostic);
        continue;
      }
      const pu: PartialUnit = {
        name,
        path: guard.relative,
        kind: "repo",
        source: "dark-factory",
      };
      // Declared ref wins (MODEL-06); dependsOn[] is edge data — Phase 3, ignored.
      if (typeof repo.ref === "string") pu.ref = repo.ref;
      partialUnits.push(pu);
    }
    return { partialUnits, edges: [], diagnostics };
  }

  // Present but neither pointer-only nor a full repos[] config -> conflict.
  return {
    partialUnits: [rootUnit(root, { dfConfigConflict: true })],
    edges: [],
    diagnostics: [],
  };
}
