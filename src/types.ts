// Public type contract for @spec-engine/platform-map. These types ARE the
// API: once 1.0 ships, a change to any shape here is semver-major. Zero
// imports, zero logic; the shared contract every module and consumer binds to.

// ── Modes ────────────────────────────────────────────────────────────────
/** Shape of a node in the topology tree. Recursive: a multi-repo
 *  platform's constituent repo can itself be a monorepo. */
export type Mode = "single-repo" | "multi-repo" | "monorepo";

// ── Signals (observed; role derivation reads these) ───────────────────────
/** Every field optional; absent means "not determined", never "false".
 *  Absence is never a negative assertion. */
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

  // linkage-derived from .factory/df-config.json (dark-factory adapter)
  hasDfPointer?: boolean; // pointer-only df-config.json present
  dfConfigConflict?: boolean; // non-pointer df-config.json present

  // linkage-derived from spec-engine.member.json (spec-engine adapter)
  hasSpecEngineConfig?: boolean; // spec-engine.member.json present
}

// ── Role (derived view, not a stored fact) ───────────────────────────────
export type Role = "library" | "app" | "unknown";

// ── Unit ─────────────────────────────────────────────────────────────────
export interface Unit {
  /** Platform-relative path used as identity (e.g. "packages/engine",
   *  "svc-api/apps/web"). Unique within a PlatformMap. */
  name: string;
  /** Relative path from the containing unit's root. May equal name; may
   *  differ when a canonical config aliases a unit
   *  ("svc-api" -> "../acme-service-api"). */
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
  /** Adapters that contributed to this unit, in precedence order. */
  sources: string[];
}

// ── Edges ────────────────────────────────────────────────────────────────
export interface Edge {
  from: string; // Unit.name (the dependent)
  to: string; // Unit.name (the dependency)
  via: "workspace-dependency"; // v1 has exactly one edge kind; the field
  // exists so v2 source-import edges are additive
}

// ── PlatformGraph (pure view over a PlatformMap) ──────────────────────────
/** The pure query view returned by graph(pm). Operates only on pm.edges +
 *  pm.units; no I/O. All array results are lexically sorted (plain `<`/`>`,
 *  never localeCompare, whose order is environment-dependent). */
export interface PlatformGraph {
  /** Dependency graph keyed by dependent (Edge.from). Every workspace-package
   *  name is a key (empty Set for leaves). */
  toDepGraph(): Map<string, Set<string>>;
  /** Transitive dependency-closure of `name`, lexically sorted. */
  dependenciesOf(name: string): string[];
  /** Transitive dependent-closure of `name`, lexically sorted. */
  dependentsOf(name: string): string[];
  /** Names with in-degree 0 (app-shaped sinks), sorted. */
  roots(): string[];
  /** Names with out-degree 0 (foundation libraries), sorted. */
  leaves(): string[];
  /** [] when acyclic; else each cycle as lexically-sorted SCC membership. */
  cycles(): string[][];
}

// ── Diagnostics (never silently drop anything) ───────────────────────────
export interface Diagnostic {
  code:
    | "UNCONFIGURED_SIBLING" // repo-root without any config
    | "CONFIG_CONFLICT" // two sources disagree; precedence applied, both reported
    | "MALFORMED_CONFIG" // JSON/shape error in a source file (file + reason)
    | "UNMATCHED_PATTERN" // workspace/ignore glob matched nothing (zero-dep glob honesty)
    | "CYCLE_SUSPECTED" // edges contain a cycle (reported, not thrown; mapping still succeeds)
    | "UNIT_PATH_ESCAPE" // resolved unit path escapes platform root
    | "CENSUS_TRUNCATED" // depth/entry-cap hit during file census
    | "PLATFORM_DRIFT"; // definition/marker/local-override disagreement
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
  /** Which manifest owned the package list. Probe order: pnpm-workspace.yaml
   *  > yarn workspaces > npm workspaces > lerna.json. */
  flavor?: "pnpm" | "yarn-workspaces" | "npm-workspaces" | "lerna" | null;
  /** turbo/nx overlay if present; informational only. */
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

// ── map() contract ────────────────────────────────────────────────────────
/** The five source adapters, in fixed precedence order. `"caller"` (injected
 *  MapOptions.units) ranks between canonical and dark-factory but has no
 *  adapter function, so it is deliberately excluded from this union. */
export type AdapterName =
  | "canonical"
  | "dark-factory"
  | "spec-engine"
  | "workspace"
  | "siblings";

// ── Platform-root convention ──────────────────────────────────────────────
/** The checked-in platform definition: the `members`-keyed shape of
 *  `platform-map.json` at a platform root. Identity only; machine paths never
 *  appear here (per-user disk locations live in `platform-map.local.json`). */
export interface PlatformDefinition {
  /** Becomes PlatformMap.name regardless of the invocation directory. */
  name: string;
  /** Explicit membership. `path` is relative to the platform root and
   *  defaults to `name` (the child-dir convention). */
  members: Array<{ name: string; path?: string }>;
  /** Additional ignore globs, threaded into the platform root's child scan. */
  ignore?: string[];
}

/** The committed per-member marker: the `platform`-keyed shape inside a
 *  member repo. Identity + root hint only; no sibling lists, no machine
 *  paths. */
export interface MemberMarker {
  /** The platform this member belongs to. */
  platform: string;
  /** Relative hint from the member to its platform root. Default "..". */
  root?: string;
}

/** The per-user, never-committed `platform-map.local.json`: disk-location
 *  overrides naming where members actually live on THIS machine. Read only
 *  when a definition is present at the resolved root; never reflected in map
 *  output (unit paths stay conventional). */
export interface PlatformLocalConfig {
  locations?: Record<string, string>;
}

/** The optional, authoritative unit-level canonical config; config is
 *  optional forever. Unknown top-level keys are ignored (forward-compat);
 *  known-key shapes are validated strictly. */
export interface PlatformMapConfig {
  /** Overrides PlatformMap.name (else basename(root)). */
  name?: string;
  /** Explicit unit declarations. A non-empty array gates sibling promotion
   *  ("config disposes"): unconfirmed siblings become UNCONFIGURED_SIBLING. */
  units?: Array<{ name: string; path: string; ref?: string }>;
  /** Additional ignore globs, merged with adapter-supplied ignores. */
  ignore?: string[];
  /** Per-unit role overrides, applied when deriveRole() runs. */
  overrides?: Record<string, { role?: Role }>;
}

/** Options for map(), extending DetectOptions. */
export interface MapOptions extends DetectOptions {
  /** Disable a named adapter by setting it to false; omitted/true = enabled. */
  adapters?: Partial<Record<AdapterName, boolean>>;
  /** Units injected by the caller; ranked below canonical, above dark-factory. */
  units?: Array<{ name: string; path: string; ref?: string }>;
  /** The directory above which upward platform resolution never ascends and
   *  outside which marker root-hint / local-override resolution is never
   *  followed. Default: os.homedir(). An escaping resolution becomes a
   *  diagnostic, never a followed path. */
  boundary?: string;
  /** Set to false to skip the git origin/HEAD ref probe; every probed ref
   *  stays null. The probe is timeout-bounded, so a loaded machine can
   *  otherwise yield ref:null where a fast one yields a branch name; callers
   *  needing load-independent output disable it. */
  refProbe?: false;
}
