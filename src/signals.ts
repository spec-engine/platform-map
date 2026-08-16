// The map-owned per-unit filesystem + package.json signal census (CONTEXT
// signal-ownership split: adapters carry ONLY their own linkage signals; the
// filesystem/package.json census belongs to map(), which calls this once per
// resolved unit). Analog of internal/scan.ts: a FACTS-ONLY bounded scan using
// try/catch existence helpers, emitting MODEL-02-honest absence.
//
// MODEL-02 (unknown-honesty): every absent fact is OMITTED — a field is NEVER
// set to a literal `false`/`null`. The returned UnitSignals is a partial object
// carrying only the facts actually determined. serialize.ts owns key order and
// defensively re-sorts `languages`, so this module returns natural order.
//
// Deliberately NOT here:
//  - graph-derived signals (workspaceInDegree/workspaceOutDegree) — Phase 3,
//  - linkage signals (hasDfPointer/hasSpecEngineConfig) — the owning adapters,
//  - any write/network/subprocess (SEC-05) — pure reads only.
//
// GRAPH-01 (Phase 3): the census ALSO returns `workspaceDepNames` — the union of
// the four dep-field key-sets — purely so map() can feed edges.ts. These dep
// NAMES are NEVER entered into UnitSignals (a dep list is not a signal); they
// travel in a map()-local side-table and are only ever used as Map keys
// downstream (edges.ts), so the prototype-pollution discipline below extends to
// them: each dep field is read by KNOWN KEYS ONLY and guarded as a plain object
// before Object.keys, and no untrusted dep-name key is ever assigned into a
// plain object.
//
// Prototype-pollution guard (T-02-09): the parsed package.json is read by
// KNOWN KEYS ONLY (never spread), so no untrusted key ever reaches the model.

import * as fs from "node:fs";
import * as path from "node:path";
import { validatePackageName } from "./internal/package-name.js";
import { walk } from "./internal/walk.js";
import type { Diagnostic, UnitSignals } from "./types.js";

// Bounded caps for the language census walk — a hostile/huge/symlink-cyclic
// unit tree must never hang (T-02-07). walk() emits CENSUS_TRUNCATED on a cap.
const CENSUS_MAX_DEPTH = 16;
const CENSUS_MAX_ENTRIES = 5000;

// Coarse file-extension -> language map. Intentionally broad-strokes: the
// signal is "what languages appear", not a precise line count.
const EXTENSION_LANGUAGE: Record<string, string> = {
  ".ts": "ts",
  ".tsx": "ts",
  ".mts": "ts",
  ".cts": "ts",
  ".js": "js",
  ".jsx": "js",
  ".mjs": "js",
  ".cjs": "js",
  ".py": "py",
  ".rb": "rb",
  ".go": "go",
  ".rs": "rs",
  ".java": "java",
  ".kt": "kt",
  ".swift": "swift",
  ".php": "php",
  ".cs": "cs",
  ".c": "c",
  ".h": "c",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".hpp": "cpp",
};

// Lockfile -> package-manager map, probed in a fixed order.
const LOCKFILE_PACKAGE_MANAGER: Array<[string, UnitSignals["packageManager"]]> =
  [
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["package-lock.json", "npm"],
    ["bun.lockb", "bun"],
  ];

// Filesystem markers that indicate deployment configuration (types.ts list).
const DEPLOY_MARKERS = [
  "vercel.json",
  "fly.toml",
  "serverless.yml",
  "k8s",
  ".platform",
];

function existsAt(dir: string, name: string): boolean {
  try {
    fs.statSync(path.join(dir, name));
    return true;
  } catch {
    return false;
  }
}

/** Reads `<dir>/package.json` once. Returns null on any failure (never throws)
 *  and only for a plain JSON object (arrays/primitives -> null). */
function readPackageJson(dir: string): Record<string, unknown> | null {
  let text: string;
  try {
    text = fs.readFileSync(path.join(dir, "package.json"), "utf8");
  } catch {
    return null;
  }
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
    return null;
  }
}

// The four package.json dep fields whose KEYS are workspace-dependency-edge
// candidates (T-03-01: read by known keys only, never Object.keys(whole manifest)).
// This is the documented CONTEXT superset of DF's three fields (adds
// optionalDependencies) — edges may therefore differ from DF's live buildDepGraph
// on optional deps, deliberately.
const DEP_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

/** Collects the union of the four dep fields' KEYS from a parsed package.json,
 *  guarding each field is a plain object before Object.keys (T-03-01). Dep names
 *  are only ever surfaced as Map keys downstream (edges.ts), never assigned into
 *  a plain object, so a `__proto__`/`constructor` dep key cannot pollute. */
function collectWorkspaceDepNames(
  pkg: Record<string, unknown> | null,
): string[] {
  if (pkg === null) return [];
  const names = new Set<string>();
  for (const field of DEP_FIELDS) {
    const value = pkg[field];
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      for (const key of Object.keys(value as Record<string, unknown>)) {
        names.add(key);
      }
    }
  }
  return [...names];
}

function probePackageManager(dir: string): UnitSignals["packageManager"] {
  for (const [lockfile, manager] of LOCKFILE_PACKAGE_MANAGER) {
    if (existsAt(dir, lockfile)) return manager;
  }
  return undefined;
}

function censusLanguages(dir: string): {
  languages: string[] | undefined;
  diagnostics: Diagnostic[];
} {
  const { entries, diagnostics } = walk(dir, {
    maxDepth: CENSUS_MAX_DEPTH,
    maxEntries: CENSUS_MAX_ENTRIES,
  });
  const languages = new Set<string>();
  for (const rel of entries) {
    const language = EXTENSION_LANGUAGE[path.extname(rel).toLowerCase()];
    if (language !== undefined) languages.add(language);
  }
  return {
    languages: languages.size > 0 ? [...languages] : undefined,
    diagnostics,
  };
}

/**
 * Runs the map-owned census over `absUnitDir`: reads package.json facts
 * (private/hasExports/hasBin/hasStartScript/packageName), probes filesystem
 * markers (hasDockerfile/hasDeployConfig), maps the lockfile to a
 * packageManager, and runs a bounded language-extension census. Every absent
 * fact is OMITTED (MODEL-02) — the result is a partial UnitSignals. An invalid
 * package name drops only the packageName field and emits a MALFORMED_CONFIG
 * diagnostic while every other signal is still returned (SEC-03). Never throws.
 *
 * `locus` (WR-01) is the unit's platform-relative path; it is stamped onto any
 * MALFORMED_CONFIG diagnostic this census emits so the failure reports which
 * unit produced it and the diagnostic sort key stays total. map() always passes
 * it; standalone callers may omit it.
 */
export function censusSignals(
  absUnitDir: string,
  locus?: string,
): {
  signals: UnitSignals;
  diagnostics: Diagnostic[];
  workspaceDepNames: string[];
} {
  const signals: UnitSignals = {};
  const diagnostics: Diagnostic[] = [];

  const pkg = readPackageJson(absUnitDir);
  const workspaceDepNames = collectWorkspaceDepNames(pkg);
  if (pkg !== null) {
    // An explicit `"private": false` is a determined fact, not absence — it is
    // what makes deriveRole rule 3's `private !== false` clause decidable.
    if (typeof pkg.private === "boolean") signals.private = pkg.private;
    if (pkg.exports !== undefined || pkg.main !== undefined) {
      signals.hasExports = true;
    }
    if (pkg.bin !== undefined) signals.hasBin = true;
    const scripts = pkg.scripts;
    if (
      scripts !== null &&
      typeof scripts === "object" &&
      !Array.isArray(scripts) &&
      (scripts as Record<string, unknown>).start !== undefined
    ) {
      signals.hasStartScript = true;
    }
    const name = pkg.name;
    if (typeof name === "string") {
      const result = validatePackageName(name, locus);
      if (result.ok) signals.packageName = result.name;
      else diagnostics.push(result.diagnostic);
    }
  }

  if (existsAt(absUnitDir, "Dockerfile")) signals.hasDockerfile = true;
  if (DEPLOY_MARKERS.some((marker) => existsAt(absUnitDir, marker))) {
    signals.hasDeployConfig = true;
  }

  const packageManager = probePackageManager(absUnitDir);
  if (packageManager !== undefined) signals.packageManager = packageManager;

  const languageCensus = censusLanguages(absUnitDir);
  if (languageCensus.languages !== undefined) {
    signals.languages = languageCensus.languages;
  }
  for (const d of languageCensus.diagnostics) diagnostics.push(d);

  return { signals, diagnostics, workspaceDepNames };
}
