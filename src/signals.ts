// The map()-owned per-unit filesystem + package.json signal census; adapters
// carry only their own linkage signals. Every absent fact is OMITTED, never
// set to a literal false/null: the result is a partial UnitSignals carrying
// only determined facts. The parsed package.json is read by KNOWN KEYS ONLY,
// never spread, so no untrusted key reaches the model; the same discipline
// covers `workspaceDepNames` (a dep list is not a signal, so the names never
// enter UnitSignals and are only ever used as Map keys downstream).

import * as fs from "node:fs";
import * as path from "node:path";
import { validatePackageName } from "./internal/package-name.js";
import { walk } from "./internal/walk.js";
import type { Diagnostic, UnitSignals } from "./types.js";

// Bounded caps so a hostile/huge/symlink-cyclic unit tree cannot hang the
// language census; walk() emits CENSUS_TRUNCATED on a cap.
const CENSUS_MAX_DEPTH = 16;
const CENSUS_MAX_ENTRIES = 5000;

// Coarse extension -> language map; presence, not precise counts.
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

// Filesystem markers that indicate deployment configuration.
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

/** Reads `<dir>/package.json` once; null on failure or non-plain-object JSON. */
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

// Dep fields whose KEYS are workspace-dependency-edge candidates.
const DEP_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

/** Union of the four dep fields' KEYS; each field is guarded as a plain
 *  object before Object.keys, so a `__proto__` dep key cannot pollute. */
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
 * Runs the census over `absUnitDir`: package.json facts, filesystem markers,
 * lockfile -> packageManager, and a bounded language census; absent facts are
 * omitted. An invalid package name drops only the packageName field (with a
 * MALFORMED_CONFIG diagnostic); every other signal is still returned. `locus`,
 * the unit's platform-relative path, is stamped onto emitted diagnostics.
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
    // An explicit `"private": false` is a determined fact, not absence; it is
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
