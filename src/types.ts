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
  /** Relative path from the containing unit's root (the platform root for
   *  top-level units, the parent monorepo's root for nested units). May equal
   *  name; may differ when a canonical config aliases a unit
   *  ("svc-api" → "../acme-service-api"). */
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

// ── PlatformGraph (pure view over a PlatformMap) ──────────────────────────
/** The pure query view returned by graph(pm) (DESIGN.md §4 L180-189). Operates
 *  only on pm.edges + pm.units — no I/O. Its toDepGraph() is the DF-compatible
 *  seam Dark Factory's planWaves() consumes unmodified. All array results are
 *  lexically sorted (plain `<`/`>`, never localeCompare) for determinism. */
export interface PlatformGraph {
  /** DF-compatible dependency graph: Map<unitName, Set<dependencyName>>, keyed
   *  by dependent (Edge.from) → Set of dependency names (Edge.to). EVERY
   *  workspace-package name is a key (empty Set for leaves). */
  toDepGraph(): Map<string, Set<string>>;
  /** Transitive dependency-closure of `name`, lexically sorted. */
  dependenciesOf(name: string): string[];
  /** Transitive dependent-closure of `name`, lexically sorted. */
  dependentsOf(name: string): string[];
  /** Names with in-degree 0 (app-shaped sinks), sorted. */
  roots(): string[];
  /** Names with out-degree 0 (foundation libraries), sorted. */
  leaves(): string[];
  /** [] when acyclic; else each cycle as lexically-sorted SCC membership.
   *  Mirrors the CYCLE_SUSPECTED diagnostic byte-for-byte (shared scc.ts). */
  cycles(): string[][];
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
    | "CENSUS_TRUNCATED" // depth/entry-cap hit during file census (additive, D-10)
    | "PLATFORM_DRIFT"; // definition/marker/local-override disagreement (additive, RED-97 — CENSUS_TRUNCATED precedent)
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

// ── map() contract (DESIGN.md §3/§4) ──────────────────────────────────────
/** The five source adapters, in the fixed precedence identity used across the
 *  registry, merge reducer, and MapOptions toggles. `"caller"` (injected
 *  MapOptions.units) is NOT an adapter — it ranks between canonical and
 *  dark-factory but has no adapter function, so it is deliberately excluded
 *  from this union (see adapters/index.ts PRECEDENCE). */
export type AdapterName =
  | "canonical"
  | "dark-factory"
  | "spec-engine"
  | "workspace"
  | "siblings";

// ── Platform-root convention (RED-97, PMAP-010/011/012) ───────────────────
/** The checked-in canonical platform definition (D-02): the `members`-keyed
 *  shape of `platform-map.json` at a platform root. Identity only — the
 *  platform name plus the member list (name + conventional relative path);
 *  machine paths never appear here (per-user disk locations live in
 *  `platform-map.local.json`, see PlatformLocalConfig). */
export interface PlatformDefinition {
  /** The platform name (required, non-empty). Becomes PlatformMap.name
   *  regardless of which directory map() was invoked from. */
  name: string;
  /** Explicit membership (D-04): each member's `name` is required; `path` is
   *  the conventional relative path from the platform root and defaults to
   *  `name` (the child-dir convention). */
  members: Array<{ name: string; path?: string }>;
  /** Additional ignore globs, threaded into the platform root's child scan. */
  ignore?: string[];
}

/** The committed per-member marker (D-03): the `platform`-keyed shape of
 *  `platform-map.json` inside a member repo. Identity + root hint only — no
 *  sibling lists, no machine paths. */
export interface MemberMarker {
  /** The platform this member belongs to (required, non-empty). */
  platform: string;
  /** Relative hint from the member to its platform root. Default "..". */
  root?: string;
}

/** The per-user, never-committed `platform-map.local.json` at a platform root
 *  (D-02): disk-location overrides only. Values are paths (relative to the
 *  platform root, or absolute) naming where a member actually lives on THIS
 *  machine. Read only when a definition is present at the resolved root;
 *  never reflected in map output (unit paths stay conventional, IP-6). */
export interface PlatformLocalConfig {
  locations?: Record<string, string>;
}

/** Shape of an optional, authoritative `platform-map.json` canonical config
 *  (DESIGN.md §3). Every field is optional — config is optional forever (D8).
 *  Unknown top-level keys are ignored (forward-compat); known-key shapes are
 *  validated strictly by config.ts (Phase 2 plan 04). */
export interface PlatformMapConfig {
  /** Overrides PlatformMap.name (else basename(root)). */
  name?: string;
  /** Explicit unit declarations. Presence of a non-empty array gates the
   *  sibling-promotion rule ("config disposes"): declared units[] turns
   *  unconfirmed siblings into UNCONFIGURED_SIBLING diagnostics. */
  units?: Array<{ name: string; path: string; ref?: string }>;
  /** Additional ignore globs, merged with adapter-supplied ignores. */
  ignore?: string[];
  /** Per-unit role overrides, applied when deriveRole() runs (Phase 3). */
  overrides?: Record<string, { role?: Role }>;
}

/** Options for map() (DESIGN.md §4). Extends DetectOptions (scanRoot/ignore)
 *  with the two config-optional levers: per-adapter disable toggles (CFG-09)
 *  and caller-injected units that enter merge as source:"caller". */
export interface MapOptions extends DetectOptions {
  /** Disable a named adapter by setting it to false; omitted/true = enabled. */
  adapters?: Partial<Record<AdapterName, boolean>>;
  /** Units injected by the caller; ranked below canonical, above dark-factory. */
  units?: Array<{ name: string; path: string; ref?: string }>;
  /** The directory above which upward platform resolution never ascends and
   *  outside which marker root-hint / local-override resolution is never
   *  followed (D-06 containment). Default: os.homedir(). An escaping
   *  resolution becomes a diagnostic, never a followed path. */
  boundary?: string;
}
