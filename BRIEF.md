# platform-map — Project Brief (Draft)

**Status:** draft for review · **Date:** 2026-07-11 · **License:** MIT · **Org:** spec-engine (public)

`platform-map` is a small, zero-dependency utility that answers one question deterministically: **"What is this platform made of?"** — which repos and workspace units exist, how they relate, and what each one is. It exists so Dark Factory, Spec Engine, Clarity Audit, agents, and humans all share one mental model of platform topology instead of four private ones.

---

## 1. Decisions needed

These are the calls to make before (or during) Phase 0 of the plan. Each has a recommendation; none is settled until you say so.

| # | Decision | Recommendation | Notes |
|---|----------|----------------|-------|
| **D1** | npm package name | `@spec-engine/platform-map` | Scoped name avoids squatting risk on the bare `platform-map` name (which may be taken — verify at scaffold time). CLI binary is still `platform-map`. |
| **D2** | Canonical config filename | `platform-map.json` at the platform root | Self-naming (a human seeing the file knows which tool owns it), no collision with SE's existing `spec-engine.platform.json` or generic `platform.json`. Per-unit override file allowed but optional. |
| **D3** | Package vs. app: hard type or derived? | **Signals, not an enum.** The library reports facts per unit (`private: true`, has `exports`/`main`, has `start` script, has Dockerfile/deploy config, in-degree in the workspace graph) plus a *derived* `role: "library" \| "app" \| "unknown"` convenience field computed from those signals. Consumers may trust `role` or re-derive from signals. | Keeps the shared package honest. Deployability matters to DF (ship/verify) but not to SE (every unit gets a coverage column regardless). A baked-in enum invites cross-tool drift; a derived field is cheap to add, expensive to remove. |
| **D4** | MCP server in v1? | **No — defer.** Ship library + CLI. Any agent with a shell calls `platform-map --json`; DF and SE already have their own agent surfaces (`df-tools query`, `spec` MCP). An MCP wrapper is a later ~50-line add if a shell-less agent context appears. | See §6 for the lib/CLI/MCP distinction. |
| **D5** | Runtime floor & packaging | TypeScript source; dual ESM + CJS build; zero runtime dependencies; Node ≥ 20 and Bun both supported and CI-tested. | Bun consumes npm packages natively — no issue there. The constraint runs the other way: DF is CommonJS, so the package must be `require()`-able. Zero deps means no zod (hand-rolled validation of one small schema) and no `Bun.Glob` (own minimal glob/walk). |
| **D6** | Integration order | **Clarity Audit → Dark Factory → Spec Engine.** | Clarity Audit is greenfield (its mapper is an agent prompt, not code) — lowest-risk first consumer that validates the API. DF then replaces `platform-discovery.cjs` behind its existing `df-tools query platform.*` routes (contract unchanged). SE last: its `discover.ts` carries the most tool-specific semantics (pins, three-bucket diagnostics) and needs the most careful seam. |
| **D7** | Who writes files? | Library core is **read-only**. The CLI gets exactly one writer: `platform-map init`, which detects, confirms, and writes the canonical `platform-map.json`. Tools never write it implicitly. | Mirrors DF's detect → surface → confirm/override UX, generalized. |
| **D8** | Does `platform-map.json` become required by DF/SE? | No. Adapters make it optional forever (see §5). The canonical file is the *convergence target*, not a gate. A repo with only a pnpm workspace file, or only DF/SE configs, still maps. | This is what makes adoption zero-migration. |
| **D9** | Zero runtime deps vs. DF's `monorepo-discovery.cjs` using `@npmcli/map-workspaces` + `glob` | Hold the zero-dep line; implement the minimal workspace-glob subset with `UNMATCHED_PATTERN` diagnostics. Vendoring is the fallback, not a dependency. | Surfaced by DESIGN.md — see its §9. |
| **D10** | Canonical monorepo-flavor probe order | Adopt DF's verbatim: pnpm > yarn-workspaces > npm-workspaces > lerna; turbo/nx recorded as overlay only. | Surfaced by DESIGN.md — see its §9. |

Full unit model, API signatures, and per-tool migration tables live in **DESIGN.md**.

---

## 2. Why this exists (the problem)

Three tools in the redhook ecosystem independently answer "what is this platform?", each with its own code, config format, and vocabulary:

| Concern | Dark Factory | Spec Engine | Clarity Audit |
|---|---|---|---|
| **Implementation** | `dark-factory/bin/lib/platform-discovery.cjs` (+ `monorepo-wave-planner.cjs`, `docs.cjs` workspace detection) | `packages/engine/src/indexer/discover.ts` (sibling classification + 2.7 workspace expansion) | `plugin/agents/platform-mapper.md` — an LLM agent prompt that re-derives topology by filesystem exploration on every audit |
| **Unit vocabulary** | "constituent" | "member" / "sub-member" | "repo in scope" / "service" |
| **Mode vocabulary** | `inline` / `standalone` / `monorepo-package` | adoption rungs 1–3 | single-repo vs. platform vs. "monorepo mode" |
| **Monorepo detection** | Ecosystem manifests: `pnpm-workspace.yaml`, `package.json` workspaces, `lerna.json` (zero-config) | Explicit opt-in: `members` glob in `spec-engine.member.json` (deterministic) | Agent judgment: "conventional workspace boundaries (`packages/*`, `apps/*`, `services/*`)" |
| **Linkage config** | Pointer-only `df-config.json` (`platform.factoryDir`) | `spec-engine.member.json` per member + `spec-engine.platform.json` manifest | `CLIENT.md` / `ACCESS.md` prose |
| **Dependency order** | Kahn topo-sort into waves (`monorepo-wave-planner.cjs`) | none (units are independent coverage columns) | narrative "which repos call which" |

The costs of this triplication:

1. **Divergent semantics.** DF and SE made *opposite* detection choices (ecosystem-native zero-config vs. explicit opt-in) for good local reasons — but a repo can now be "a monorepo" to one tool and invisible to the other.
2. **Setup twice (soon three times).** An operator onboarding a platform to both DF and SE describes the same repos in two unrelated config formats. Neither tool can read the other's answer.
3. **No shared mental model.** An agent (or human) asking "where am I, what's around me, who depends on whom, what's deployable?" gets a different answer — or no answer — depending on which tool it asks. Clarity Audit burns LLM tokens re-deriving facts the other two tools already computed deterministically.
4. **Duplicated maintenance.** Workspace-manifest parsing, sibling scanning, git-ref probing, and classification logic are each maintained in two places and about to be needed in a third.

## 3. The solution

One small MIT-licensed library + CLI, published as `@spec-engine/platform-map`, owning exactly three concerns:

1. **Detect** — `detect(cwd)` → what shape is this place? `single-repo` | `multi-repo` | `monorepo` — and *recursively*: a multi-repo platform's constituents can themselves be monorepos, so mode is a property of each node in the tree, not a single enum at the root.
2. **Enumerate** — normalize DF's constituents, SE's members/sub-members, and workspace packages into one unit model: name, path, git ref, collected signals, config provenance.
3. **Graph** — dependency edges between units (from workspace `dependencies` intersection, DF-style), with topo-sorted waves and in-degree available as derived views.

Fed by a **canonical config + adapters** (decision D2/D8): the library reads `platform-map.json` when present, and otherwise assembles the same picture from what already exists — DF configs, SE configs, pnpm/npm/lerna workspace manifests, and a sibling git-repo scan. Detection proposes; config disposes.

Dark Factory, Spec Engine, and Clarity Audit then **delete their own detection/enumeration code and depend on this package**. Tool-specific semantics (DF pointer resolution, SE version pins, audit narrative) stay in the tools, layered on top of the shared model.

## 4. Design principles

1. **Facts, not opinions.** The core model reports observable signals. Derived judgments (`role`, waves) are clearly-labeled computed views over those facts, and consumers can always recompute their own.
2. **Detection proposes, config disposes.** Ecosystem detection (workspace manifests, sibling scan) produces *candidates*. Explicit config (`platform-map.json`, or a tool's existing config via adapter) is *truth* and always wins. This reconciles DF's zero-config instinct with SE's determinism instinct instead of picking a side.
3. **Read-only core, one writer.** The library never touches disk except to read. `platform-map init` is the single, explicit, operator-confirmed writer.
4. **Zero runtime dependencies.** It's a substrate other tools trust; its dependency surface should be `node:fs` and `node:path`.
5. **Deterministic output.** Sorted units, sorted edges, stable JSON key order, no timestamps in the model. Same tree in, byte-identical map out. (SE's discovery code learned this lesson — Bun.Glob iteration order, lex-sorted `skipped[]` — and the shared lib inherits it as a contract, not a comment.)
6. **One mental model for tools and humans.** The JSON a tool consumes and the diagram a human draws must be the same shape: a tree of units with edges. If the JSON can't be read aloud as a sensible sentence, the model is wrong.
7. **Recursive, not modal.** "Multi-repo of monorepos" is a first-class shape, not an edge case.
8. **Don't absorb tool semantics.** No version pins, no pointer resolution, no coverage columns, no audit layers. The moment a field only one tool understands lands in the core model, it moves back out to that tool.
9. **Honest about unknowns.** Unknowable facts are reported as `unknown`/absent, never guessed (Clarity Audit's "a flagged unknown is more useful than a confident guess" rule, promoted to a library contract).

## 5. The model

### Shape

```jsonc
// Platform — the root object returned by map()
{
  "name": "acme",                    // from config, or basename of root
  "root": ".",                       // all paths platform-root-relative
  "mode": "multi-repo",              // single-repo | multi-repo | monorepo
  "units": [
    {
      "name": "svc-api",             // unique within the platform
      "path": "svc-api",             // relative path
      "kind": "repo",                // repo | workspace-package
      "mode": "monorepo",            // a constituent can itself be a monorepo
      "ref": "main",                 // resolved default branch (origin/HEAD probe, DF-style)
      "units": [                     // recursive: this repo's workspace packages
        { "name": "svc-api/packages/core", "kind": "workspace-package", "role": "library", ... },
        { "name": "svc-api/apps/web",      "kind": "workspace-package", "role": "app", ... }
      ],
      "signals": {                   // facts (D3) — extensible, all optional
        "private": true,
        "hasExports": true,
        "hasStartScript": false,
        "hasDockerfile": false,
        "workspaceInDegree": 3,
        "packageManager": "pnpm",
        "languages": ["ts"]
      },
      "role": "library",             // derived from signals: library | app | unknown
      "sources": ["platform-map.json", "pnpm-workspace.yaml"]  // provenance
    }
  ],
  "edges": [                         // unit dependency edges (forward: from depends on to)
    { "from": "apps/web", "to": "packages/core", "via": "workspace-dependency" }
  ],
  "diagnostics": [                   // SE-style: never silently drop a sibling
    { "code": "UNCONFIGURED_SIBLING", "path": "../legacy-svc", "severity": "info" }
  ]
}
```

Naming follows SE's convention: a nested unit's name is its platform-relative path (`packages/engine`), so paths in any tool's output resolve naturally against the map.

### Canonical config (`platform-map.json`)

Minimal by design — most fields are detectable, so the config only pins what detection can't know or gets wrong:

```jsonc
{
  "name": "acme",
  "units": [
    { "name": "svc-api", "path": "../svc-api" },
    { "name": "svc-worker", "path": "../svc-worker", "ref": "develop" }
  ],
  "ignore": ["../scratch", "../archive-*"],
  "overrides": {
    "svc-api/apps/admin": { "role": "app" }   // when signal-derivation is wrong
  }
}
```

### Adapters (read-only, keep working forever — D8)

| Adapter | Reads | Maps to |
|---|---|---|
| `canonical` | `platform-map.json` | everything, authoritative |
| `dark-factory` | `platform.repos[]` in DF config; pointer `df-config.json` detection | units + ignore list; pointer presence becomes a signal |
| `spec-engine` | `spec-engine.member.json` (incl. `members` glob + `ignore`), `spec-engine.platform.json` | units + sub-unit expansion; pins are *ignored* (tool semantics, principle 8) |
| `workspace` | `pnpm-workspace.yaml`, `package.json` workspaces, `lerna.json` | monorepo mode + workspace-package units + dep edges |
| `siblings` | git-repo scan of the parent dir (DF's D-20 scan, incl. origin/HEAD ref probe with fallback) | *candidate* units only — surfaced via diagnostics until confirmed by config |

Precedence: canonical > tool adapters > workspace manifests > sibling scan. Conflicts surface as diagnostics, never as silent overrides.

## 6. Surfaces: library, CLI, MCP

Same engine, different doors:

- **Library API** (`import { detect, map, graph } from "@spec-engine/platform-map"`) — for code. DF's `df-tools`, SE's indexer, and Clarity Audit tooling call this in-process. Typed, returns the model above.
- **CLI** (`platform-map [--json]`, `platform-map detect`, `platform-map graph --waves`, `platform-map init`) — a thin (~100-line) wrapper over the library for shells. This is the human surface *and* the default agent surface: any agent with Bash gets full topology context from one command, no integration work. Human-readable tree output by default, `--json` for machines.
- **MCP server** — deferred (D4). It would expose the same queries as MCP tools for agent runtimes *without* shell access. Nothing about the design blocks adding it later; it's a wrapper, not a layer.

## 7. How each consumer uses it

**Dark Factory** deletes `platform-discovery.cjs` (~165 lines) and the workspace-detection half of `docs.cjs`, and re-implements `df-tools query platform.detect-mode` / `platform.discover-siblings` / `monorepo waves` as calls into the library. The pinned `df-tools query` invocation surface — which workflow markdown depends on — does not change; only what's behind it does. DF's mode names (`inline`/`standalone`/`monorepo-package`) map 1:1 onto the shared model's mode (`single-repo`/`multi-repo`/`monorepo`) at that seam. Pointer files, the Kahn wave-planner, and wave execution all stay DF's. (**Decided 2026-07-11:** the wave planner is tool-agnostic and *could* move into `graph()` someday, but pulling it in now is scope creep — platform-map v1 stays purely descriptive. `graph()` provides units + edges; DF computes waves from them. Revisit if a second consumer needs wave ordering.)

**Spec Engine** replaces the enumeration half of `discover.ts` — sibling classification, `expandWorkspaceMembers`, the three-bucket logic — with a `map()` call plus a thin overlay that attaches pins from `spec-engine.member.json` files to units. SE keeps: pin extraction/inheritance, `NO_SPEC_CONFIG` diagnostics policy (derived from the lib's `UNCONFIGURED_SIBLING` diagnostic), canonical-manifest reading. SE's `members` glob keeps working via the adapter; new platforms can use `platform-map.json` instead.

**Clarity Audit** (closed-source; consumes the public package) runs `platform-map --json` as the first step of `platform-mapper`, then spends its agent budget only on what the library can't compute: data flow, deploy topology narrative, operational boundaries. The deterministic half of the audit map becomes reproducible and free.

**Humans and agents** run the CLI. `platform-map` prints the tree; `platform-map --json` feeds any script or agent context window. The canonical config is small enough to write by hand and read in one glance — that's the shared mental model made literal.

## 8. Non-goals

- Not a build orchestrator, task runner, or deploy tool — it maps; others act.
- Not a config-migration tool for DF/SE internals (each tool owns its own migration).
- No network calls, no git mutations, no writes outside `init`.
- Not a general dependency analyzer (no source-level import parsing in v1; edges come from workspace manifests. Source-level edge detection is a possible v2 signal.)
- Ecosystems beyond JS/TS (cargo, go workspaces, gradle) are out of scope for v1 but the adapter seam is where they'd land.

## 9. Prior art consolidated (source inventory)

| Behavior to port | Source |
|---|---|
| Mode detection precedence, sibling scan, ignore-before-I/O, origin/HEAD probe + fallback, pointer/conflict detection | `dark-factory/dark-factory/bin/lib/platform-discovery.cjs` |
| Workspace manifest parsing (pnpm/npm/lerna) | `dark-factory/dark-factory/bin/lib/docs.cjs` (`detectMonorepoWorkspaces`) |
| Kahn wave planning — **not ported** (stays in DF; platform-map's edges feed it) | `dark-factory/dark-factory/bin/lib/monorepo-wave-planner.cjs` |
| Three-bucket sibling classification (member / skipped / ignored), repo-root heuristic, glob expansion of workspace sub-members, platform-relative naming, sort-for-determinism | `spec-engine/packages/engine/src/indexer/discover.ts` |
| Config validation shape (`members` glob, `ignore` semantics) | `spec-engine/packages/shared/src/config.ts` |
| Evidence-over-assertion + open-questions-as-output ethos; the narrative layers that stay agent-driven | `clarity-audit/plugin/agents/platform-mapper.md` |

Test fixtures come from the same three codebases: DF's platform-discovery tests, SE's discovery/cold-rebuild tests, and a synthetic multi-repo-of-monorepos fixture none of the three currently covers.
