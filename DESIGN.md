# platform-map — Unit Model & API Design (Draft)

**Status:** draft for review · **Companion:** BRIEF.md (decisions D1–D8), PLAN.md
**Scope:** the public contract — types, functions, CLI — checked against what Dark Factory, Spec Engine, and Clarity Audit would each need to migrate onto it. Two new decisions (D9, D10) surfaced while writing this; they're appended to the decision register at the bottom and mirrored into BRIEF.md.

---

## 1. Design stance (recap from BRIEF)

Facts, not opinions. The library reports observable signals per unit and exposes derived views (`role`, graph queries) that any consumer can recompute. Detection proposes, config disposes. Read-only core. Deterministic output. The wave planner stays in Dark Factory (decided 2026-07-11) — `graph()` here stops at edges and simple views.

## 2. Types (the public contract)

These types ARE the API. Once 1.0 ships, a change to these shapes is semver-major.

```ts
// ── Modes ────────────────────────────────────────────────────────────────
/** Shape of a node in the topology tree. Recursive: a multi-repo
 *  platform's constituent repo can itself be a monorepo. */
export type Mode = "single-repo" | "multi-repo" | "monorepo";

// ── Signals (D3: facts, never judgments) ─────────────────────────────────
/** Every field optional; absent means "not determined", never "false".
 *  (Principle 9: honest about unknowns — absence ≠ negation.) */
export interface UnitSignals {
  // package.json-derived
  private?: boolean;              // "private": true
  hasExports?: boolean;           // "exports" or "main" present
  hasBin?: boolean;               // "bin" present (CLI-shaped)
  hasStartScript?: boolean;       // scripts.start present
  packageName?: string;           // "name" field, validated (see §6)

  // filesystem-derived
  hasDockerfile?: boolean;
  hasDeployConfig?: boolean;      // vercel.json, fly.toml, serverless.yml, k8s/, .platform/ …
  languages?: string[];           // coarse: ["ts","js","py"…] from file-extension census (bounded scan)
  packageManager?: "pnpm" | "yarn" | "npm" | "bun" | null;

  // graph-derived (filled by graph(), not by adapters)
  workspaceInDegree?: number;     // how many sibling units depend on this one
  workspaceOutDegree?: number;    // how many sibling units this one depends on

  // linkage-derived (DF adapter)
  hasDfPointer?: boolean;         // pointer-only df-config.json present
  dfConfigConflict?: boolean;     // non-pointer df-config.json present (DF's T-03.05-03)

  // linkage-derived (SE adapter)
  hasSpecEngineConfig?: boolean;  // spec-engine.member.json present
}

// ── Role (derived view, not a stored fact) ───────────────────────────────
export type Role = "library" | "app" | "unknown";

// ── Unit ─────────────────────────────────────────────────────────────────
export interface Unit {
  /** Platform-relative path used as identity (SE convention: "packages/engine",
   *  "svc-api/apps/web"). Unique within a PlatformMap. */
  name: string;
  /** Relative path from platform root. May equal name; may differ when a
   *  canonical config aliases a unit ("svc-api" → "../acme-service-api"). */
  path: string;
  kind: "repo" | "workspace-package";
  /** This unit's own shape. "monorepo" ⇒ units[] is populated. */
  mode: Mode;
  /** Resolved default branch (origin/HEAD probe with fallback, DF D-21).
   *  Only meaningful for kind:"repo"; null when probe failed/not applicable. */
  ref: string | null;
  /** Recursive children (workspace packages of a monorepo unit). Empty for leaves. */
  units: Unit[];
  signals: UnitSignals;
  /** Derived from signals via deriveRole() (§4); config overrides win. */
  role: Role;
  /** Which adapters contributed to this unit, in precedence order,
   *  e.g. ["platform-map.json", "pnpm-workspace.yaml"]. */
  sources: string[];
}

// ── Edges ────────────────────────────────────────────────────────────────
export interface Edge {
  from: string;                   // Unit.name (the dependent)
  to: string;                     // Unit.name (the dependency)
  via: "workspace-dependency";    // v1 has exactly one edge kind; the field
                                  // exists so v2 source-import edges are additive
}

// ── Diagnostics (never silently drop anything) ───────────────────────────
export interface Diagnostic {
  code:
    | "UNCONFIGURED_SIBLING"      // repo-root without any config (SE bucket 2 → NO_SPEC_CONFIG upstreamable)
    | "CONFIG_CONFLICT"           // two sources disagree; precedence applied, both reported
    | "MALFORMED_CONFIG"          // JSON/shape error in a source file (file + reason)
    | "UNMATCHED_PATTERN"         // workspace/ignore glob matched nothing (zero-dep glob honesty, PLAN risk 4)
    | "CYCLE_SUSPECTED"           // edges contain a cycle (reported, not thrown — mapping still succeeds)
    | "UNIT_PATH_ESCAPE";         // resolved unit path escapes platform root (DF T-04.01-01 guard)
  severity: "info" | "warning" | "error";
  path?: string;                  // platform-relative locus
  message: string;                // human-readable, stable prefix per code
}

// ── The root object ──────────────────────────────────────────────────────
export interface PlatformMap {
  name: string;                   // config name, else basename(root)
  root: string;                   // as given to map(); all other paths relative to it
  mode: Mode;
  units: Unit[];                  // sorted by name (determinism contract)
  edges: Edge[];                  // sorted by (from, to)
  diagnostics: Diagnostic[];      // sorted by (severity desc, code, path)
  /** Schema version of THIS shape, for consumers persisting maps. */
  schemaVersion: 1;
}
```

**Deliberately absent** (principle 8 — tool semantics stay out): version pins (SE), pointer *resolution* (DF resolves; we only report `hasDfPointer`), contracts/waves (DF), coverage (SE), audit narrative (Clarity Audit), timestamps (determinism).

## 3. Canonical config types

```ts
export interface PlatformMapConfig {
  name?: string;
  /** Explicit units. When present, sibling-scan results become diagnostics
   *  (UNCONFIGURED_SIBLING), never silent additions. */
  units?: Array<{ name: string; path: string; ref?: string }>;
  /** Paths/globs to exclude from detection. Consulted before per-unit I/O (DF D-19). */
  ignore?: string[];
  /** Per-unit corrections when signal-derivation is wrong. Keyed by Unit.name. */
  overrides?: Record<string, { role?: Role }>;
}
```

Validation is hand-rolled (zero deps), with SE's three-layer error style: read, parse, and validate failures each throw a distinct, location-tagged message (`platform-map.json at <path> failed validation: <reason>`). A malformed canonical config is a hard error; malformed *adapter* sources degrade to `MALFORMED_CONFIG` diagnostics (the canonical file is authored intent; adapter files belong to other tools and must not brick the map).

## 4. Functions

```ts
/** Cheap shape probe. No sibling git I/O beyond directory listing + .git checks.
 *  This is DF's detectPlatformMode generalized. */
export function detect(root: string, opts?: DetectOptions): Detection;

export interface DetectOptions {
  /** Sibling scan root, relative to `root`. Default ".." (DF D-20). */
  scanRoot?: string;
  ignore?: string[];
}
export interface Detection {
  mode: Mode;
  /** Present when mode === "monorepo": the raw workspace globs found. */
  workspaceGlobs?: string[];
  /** Which manifest owned the package list (DF flavor detection, D10):
   *  probe order pnpm-workspace.yaml > yarn workspaces > npm workspaces > lerna.json. */
  flavor?: "pnpm" | "yarn-workspaces" | "npm-workspaces" | "lerna" | null;
  /** turbo/nx overlay if present — informational only. */
  orchestrator?: "turbo" | "nx" | null;
  /** Present when mode === "multi-repo": candidate sibling repos (facts only;
   *  candidates are not units until config confirms — principle 2). */
  siblings?: Array<{ name: string; path: string; ref: string | null;
                     hasDfPointer: boolean; conflict: string | null }>;
}

/** The main entry point: full assembly. Runs detect, applies adapters in
 *  precedence order (canonical > dark-factory > spec-engine > workspace >
 *  siblings), recurses into monorepo units, collects signals, builds edges,
 *  derives roles. Async (bounded git probes). */
export function map(root: string, opts?: MapOptions): Promise<PlatformMap>;

export interface MapOptions extends DetectOptions {
  /** Skip named adapters, e.g. { adapters: { siblings: false } } for tools
   *  that supply their own unit list. */
  adapters?: Partial<Record<AdapterName, boolean>>;
  /** Inject units directly (Clarity Audit's CLIENT.md scope; DF's platform.repos[]
   *  when the tool prefers to pass config rather than have us read it).
   *  Injected units are source:"caller" and rank just below canonical. */
  units?: Array<{ name: string; path: string; ref?: string }>;
}
export type AdapterName = "canonical" | "dark-factory" | "spec-engine" | "workspace" | "siblings";

/** Pure graph views over a PlatformMap. No I/O. NOT a wave planner —
 *  DF's planWaves(repos, depGraph) consumes toDepGraph() output unchanged. */
export function graph(pm: PlatformMap): PlatformGraph;

export interface PlatformGraph {
  /** DF-compatible: Map<unitName, Set<dependencyName>> — the exact shape
   *  monorepo-wave-planner.cjs's planWaves takes today. */
  toDepGraph(): Map<string, Set<string>>;
  dependenciesOf(name: string): string[];   // transitive, sorted
  dependentsOf(name: string): string[];     // transitive, sorted ("what breaks if I touch this")
  roots(): string[];                        // in-degree 0 (app-shaped sinks)
  leaves(): string[];                       // out-degree 0 (foundation libraries)
  cycles(): string[][];                     // [] when acyclic; mirrors CYCLE_SUSPECTED diagnostics
}

/** Exposed so consumers can recompute or audit the classification (D3). */
export function deriveRole(signals: UnitSignals): Role;
```

### deriveRole — the exact rules (v1)

Evaluated top-down; first match wins. Absent signal = no vote (unknown-honesty).

1. `hasDockerfile` or `hasDeployConfig` or `hasStartScript` → **app**
2. `workspaceInDegree > 0` → **library** (someone imports it)
3. `hasExports && private !== false … && !hasStartScript` → **library**
4. `workspaceInDegree === 0 && workspaceOutDegree > 0 && !hasExports` → **app** (pure sink)
5. otherwise → **unknown**

Config `overrides` beat all rules. The rules are documented in the README verbatim — the derivation must never be folklore. Sanity anchor: on spec-engine's own monorepo this yields engine/shared/tracker → library, webapp → app.

## 5. Determinism & error contract

- Same tree in → byte-identical JSON out. Sorted units/edges/diagnostics, stable key order via a single serializer (`toJSON()` on PlatformMap), no timestamps, no absolute paths in output (root-relative only).
- `map()` throws only for: nonexistent root, malformed *canonical* config. Everything else — unreadable sibling, bad adapter file, glob matching nothing, cycles — degrades to diagnostics. (A mapping tool that dies on the messy platforms that most need mapping is useless; SE's never-fail-non-git ethos, generalized.)
- Bounded I/O: git ref probes use DF's timeout-bounded exec pattern (T-03.05-04 — one hostile sibling must never hang the map); file-census scans have a depth/count cap, reported when hit (no silent truncation).

## 6. Security posture (inherited from DF, kept as contracts)

- No YAML library: pnpm-workspace.yaml parsed with the DF regex subset (T-04.01-02, YAML-gadget avoidance).
- Path-traversal guard: every resolved unit path must not escape the platform root → `UNIT_PATH_ESCAPE` diagnostic and the unit is dropped (T-04.01-01).
- Symlinks not followed during workspace walks (T-04.01-04).
- Package names validated against DF's `/^@?[a-z0-9][a-z0-9._/-]*$/i` before entering the model (T-04.01-03).
- No network, no git mutations, no writes (except CLI `init`).

## 7. CLI surface (thin mapping onto §4)

| Command | Calls | Output |
|---|---|---|
| `platform-map` | `map(".")` | human tree view; diagnostics to stderr |
| `platform-map --json` | `map(".")` | the PlatformMap JSON to stdout; diagnostics embedded |
| `platform-map detect` | `detect(".")` | Detection JSON |
| `platform-map graph [--dot]` | `graph(map("."))` | edges / DOT for rendering |
| `platform-map init [--yes]` | `detect` → proposal → confirm → write | the one writer (D7) |

Exit codes: 0 ok, 1 usage/hard error, 2 ok-with-error-severity-diagnostics (greppable by CI).

## 8. Migration check — what each codebase actually swaps

### Dark Factory

| Today (file / route) | After | Notes |
|---|---|---|
| `platform-discovery.cjs` → `detectPlatformMode()` | `detect(cwd)` + a 5-line mode-name mapping at the route (`monorepo`→`monorepo-package`, `multi-repo`→`standalone`, `single-repo`→`inline`) | Route `df-tools query platform.detect-mode` output unchanged. |
| `platform-discovery.cjs` → `discoverSiblingRepos()` | `detect(cwd).siblings` | Same fields (name/path/ref/hasPointer→hasDfPointer/conflict); route reshapes trivially. ignore-before-I/O and bounded-probe semantics preserved by contract (§5, §6). |
| `docs.cjs` → `detectMonorepoWorkspaces()` | `detect(cwd).workspaceGlobs` | docs-init keeps its route shape. |
| `monorepo-discovery.cjs` → `discoverMonorepo()` (flavor, orchestrator, repos, depGraph) | `map(cwd)` + `graph(pm).toDepGraph()` | `toDepGraph()` returns the exact `Map<string,Set<string>>` shape `planWaves()` consumes — the wave planner runs unmodified (decided 2026-07-11). Flavor/orchestrator come from `Detection`. **This is the file that currently pulls `@npmcli/map-workspaces` + `glob` — see D9.** |
| `monorepo-wave-planner.cjs` | **stays** | Consumes platform-map edges; nothing else changes. |
| `platform-workspace.cjs` composition, pointer *resolution* (`project-root.cjs`), contracts, cross-repo-gaps | **stays** | Tool semantics. `platform workspace`'s repos[] can be fed via `MapOptions.units` from `platform.repos[]` config, or keep its own path — integrator's choice. |

Deleted after integration: `platform-discovery.cjs`, `monorepo-discovery.cjs`, the workspace-detection half of `docs.cjs` (~450 lines + their direct tests, which port to platform-map as fixtures).

### Spec Engine

| Today (`discover.ts`) | After | Notes |
|---|---|---|
| `classifySibling()` three buckets | `map(platformDir, { adapters: { "dark-factory": false } })`; bucket 2 = `UNCONFIGURED_SIBLING` diagnostics → `NO_SPEC_CONFIG`; bucket 3 = units absent | `looksLikeRepoRoot` heuristic moves into the siblings adapter. The `spec-engine` dir special-case ("never shadow the canonical row") stays SE-side as an ignore entry. |
| `expandWorkspaceMembers()` (members glob → sub-members) | workspace recursion in `map()`, with the `members` glob honored via the spec-engine adapter | Platform-relative naming (`packages/engine`) is the lib's native Unit.name convention — chosen *from* SE. |
| Pin extraction / inheritance / nested-config override | **stays** — a thin overlay: walk `pm.units`, read `spec-engine.member.json` where `signals.hasSpecEngineConfig`, attach pins to SE's own `Repo` records | Pins never enter the shared model (principle 8). |
| `readCanonicalManifest`, `NotASpecPlatformError`, determinism sorts | **stays** / subsumed | Lib's determinism contract (§5) is strictly stronger than the lex-sort comments it replaces. |
| `Bun.Glob` usage in discovery | gone with the replaced code | SE keeps Bun everywhere else; the lib is runtime-neutral. |

### Clarity Audit (private consumer)

No code swap — a prompt swap. `platform-mapper` step 1 becomes `platform-map --json`; the agent's five inspection passes shrink to the three the lib can't do (data flow, deploy/runtime narrative, operational boundaries). `CLIENT.md` scope can be passed via `--` unit injection or a generated `platform-map.json` in the audit workspace. Diagnostics land directly in the map's "Open questions" section — the lib's honesty contract feeding the audit's.

## 9. New decisions surfaced by this design

| # | Decision | Recommendation |
|---|---|---|
| **D9** | Zero runtime deps vs. DF's current use of `@npmcli/map-workspaces` + `glob` in monorepo discovery | **Hold the zero-dep line.** Implement a minimal workspace walker: the glob subset actually used by workspace manifests (`*`, `**`, literal dirs, `!negation` for pnpm) over a symlink-safe, traversal-guarded directory walk. `UNMATCHED_PATTERN` diagnostics keep us honest where the subset falls short. Escape hatch if this proves painful in Phase 1: vendoring `@npmcli/map-workspaces` is the fallback, not adding it as a dependency. |
| **D10** | Adopt DF's flavor probe order (pnpm > yarn > npm > lerna, with Yarn-Berry lockfile caveat) as the canonical detection order? | **Yes, verbatim** — it's researched, tested, and encodes real pitfalls (Yarn Berry has no yarn.lock by default; turbo/nx are overlays, never package-list owners). Document it in the README as normative. |

---

*Review request: the two seams most worth a skeptical read are the DF `monorepo discover` route replacement (row 4 of the DF table — richest existing behavior, most fixture-porting) and the SE pin-overlay sketch (does a units-walk overlay actually reach everything `discover.ts` returns today, including `skipped[]` ordering guarantees?).*
