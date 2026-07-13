// Public type contract for @spec-engine/platform-map.
// These types ARE the API — once 1.0 ships, a change to any shape here is semver-major.
// Transcribed verbatim from DESIGN.md §2, plus the additive CENSUS_TRUNCATED diagnostic
// code (D-10). Zero imports, zero logic — this module exists purely to be the shared
// contract every other module (and every consumer) binds to.

// ── Modes ────────────────────────────────────────────────────────────────
/** Shape of a node in the topology tree. Recursive: a multi-repo
 *  platform's constituent repo can itself be a monorepo. */
export type Mode = "single-repo" | "multi-repo" | "monorepo";

// ── Signals (facts, never judgments) ──────────────────────────────────────
/** Every field optional; absent means "not determined", never "false".
 *  Absence is never a negative assertion (MODEL-02). */
export interface UnitSignals {
  // package.json-derived
  private?: boolean; // "private": true
  hasExports?: boolean; // "exports" or "main" present
  hasBin?: boolean; // "bin" present (CLI-shaped)
  hasStartScript?: boolean; // scripts.start present
  packageName?: string; // "name" field, validated

  // filesystem-derived
  hasDockerfile?: boolean;
  hasDeployConfig?: boolean; // vercel.json, fly.toml, serverless.yml, k8s/, .platform/ …
  languages?: string[]; // coarse: ["ts","js","py"…] from file-extension census (bounded scan)
  packageManager?: "pnpm" | "yarn" | "npm" | "bun" | null;

  // graph-derived (filled by graph(), not by adapters)
  workspaceInDegree?: number; // how many sibling units depend on this one
  workspaceOutDegree?: number; // how many sibling units this one depends on

  // linkage-derived (DF adapter)
  hasDfPointer?: boolean; // pointer-only df-config.json present
  dfConfigConflict?: boolean; // non-pointer df-config.json present

  // linkage-derived (SE adapter)
  hasSpecEngineConfig?: boolean; // spec-engine.member.json present
}

// ── Role (derived view, not a stored fact) ───────────────────────────────
export type Role = "library" | "app" | "unknown";

// ── Unit ─────────────────────────────────────────────────────────────────
export interface Unit {
  /** Platform-relative path used as identity (e.g. "packages/engine",
   *  "svc-api/apps/web"). Unique within a PlatformMap (MODEL-05). */
  name: string;
  /** Relative path from platform root. May equal name; may differ when a
   *  canonical config aliases a unit ("svc-api" → "../acme-service-api"). */
  path: string;
  kind: "repo" | "workspace-package";
  /** This unit's own shape. "monorepo" ⇒ units[] is populated. */
  mode: Mode;
  /** Resolved default branch (origin/HEAD probe with fallback).
   *  Only meaningful for kind:"repo"; null when probe failed/not applicable. */
  ref: string | null;
  /** Recursive children (workspace packages of a monorepo unit). Empty for leaves. */
  units: Unit[];
  signals: UnitSignals;
  /** Derived from signals via deriveRole(); config overrides win. */
  role: Role;
  /** Which adapters contributed to this unit, in precedence order,
   *  e.g. ["platform-map.json", "pnpm-workspace.yaml"]. */
  sources: string[];
}

// ── Edges ────────────────────────────────────────────────────────────────
export interface Edge {
  from: string; // Unit.name (the dependent)
  to: string; // Unit.name (the dependency)
  via: "workspace-dependency"; // v1 has exactly one edge kind; the field
  // exists so v2 source-import edges are additive
}

// ── Diagnostics (never silently drop anything) ───────────────────────────
export interface Diagnostic {
  code:
    | "UNCONFIGURED_SIBLING" // repo-root without any config
    | "CONFIG_CONFLICT" // two sources disagree; precedence applied, both reported
    | "MALFORMED_CONFIG" // JSON/shape error in a source file (file + reason)
    | "UNMATCHED_PATTERN" // workspace/ignore glob matched nothing (zero-dep glob honesty)
    | "CYCLE_SUSPECTED" // edges contain a cycle (reported, not thrown — mapping still succeeds)
    | "UNIT_PATH_ESCAPE" // resolved unit path escapes platform root
    | "CENSUS_TRUNCATED"; // depth/entry-cap hit during file census (additive, D-10)
  severity: "info" | "warning" | "error";
  path?: string; // platform-relative locus
  message: string; // human-readable, stable prefix per code
}

// ── The root object ──────────────────────────────────────────────────────
export interface PlatformMap {
  name: string; // config name, else basename(root)
  root: string; // as given to map(); all other paths relative to it
  mode: Mode;
  units: Unit[]; // sorted by name (determinism contract)
  edges: Edge[]; // sorted by (from, to)
  diagnostics: Diagnostic[]; // sorted by (severity desc, code, path)
  /** Schema version of THIS shape, for consumers persisting maps. */
  schemaVersion: 1;
}

// ── detect() contract ─────────────────────────────────────────────────────
export interface DetectOptions {
  /** Sibling scan root, relative to `root`. Default "..". */
  scanRoot?: string;
  ignore?: string[];
}

export interface Detection {
  mode: Mode;
  /** Present when mode === "monorepo": the raw workspace globs found. */
  workspaceGlobs?: string[];
  /** Which manifest owned the package list. Probe order:
   *  pnpm-workspace.yaml > yarn workspaces > npm workspaces > lerna.json. */
  flavor?: "pnpm" | "yarn-workspaces" | "npm-workspaces" | "lerna" | null;
  /** turbo/nx overlay if present — informational only. */
  orchestrator?: "turbo" | "nx" | null;
  /** Present when mode === "multi-repo": candidate sibling repos (facts only;
   *  candidates are not units until config confirms). */
  siblings?: Array<{
    name: string;
    path: string;
    ref: string | null;
    hasDfPointer: boolean;
    conflict: string | null;
  }>;
}
