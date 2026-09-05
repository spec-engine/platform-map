// The dark-factory adapter: reads <root>/.factory/df-config.json and reports
// linkage facts only; it never follows the pointer, never reads anything else
// under `.factory/`, and never turns `dependsOn[]` into edges. Classification:
// pointer-only (exactly `{ platform: { factoryDir: string } }`) -> a root unit
// carrying `hasDfPointer: true`, no repo units; a full config's
// `platform.repos[]` -> one kind:"repo" unit per entry; any other present
// shape -> a root unit carrying `dfConfigConflict: true`. An unparseable file
// degrades to a MALFORMED_CONFIG diagnostic, never a throw. Untrusted parsed
// objects are read by EXPLICIT known keys only, never spread.

import * as fs from "node:fs";
import * as path from "node:path";
import { isPointerOnly } from "../internal/df-pointer.js";
import { resolveWithinRoot } from "../internal/path-guard.js";
import type { Diagnostic, UnitSignals } from "../types.js";
import type { AdapterContext, AdapterResult, PartialUnit } from "./index.js";

const STATE_DIR = ".factory";
const DF_CONFIG = "df-config.json";

/** Extracts `platform.repos` as an array when the config is a full config;
 *  null for any other shape. Explicit key reads only, never a spread. */
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

/** The root PartialUnit carrying a linkage signal when the config is
 *  pointer-only or conflicting (there are no repos[] to attach it to): path
 *  ".", basename-or-"(root)" name, so no absolute path ever leaks. */
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
 * Reads `<root>/.factory/df-config.json` per the classification in the
 * header; absent file -> empty result. A declared repo `ref` is carried
 * through untouched; a repo without one is left ref-less for map()'s uniform
 * per-unit probe. Returns edges:[] and never sorts.
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
    // Absent (or unreadable) df-config.json is fine; the file is optional.
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

  // Pointer-only: report the linkage signal, emit NO repo units.
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
      // A declared repo path escaping the platform root is dropped.
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
      // Declared ref wins; dependsOn[] is ignored (edge data).
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
