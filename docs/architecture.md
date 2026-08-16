# Architecture

platform-map owns three concerns (BRIEF §3): **detect** (what shape is this
place), **enumerate** (normalize every config surface into one unit model),
and **graph** (dependency edges and views over them). Everything else is a
door onto the same engine: library API, CLI, someday MCP.

The engine is a pipeline of pure stages around one impure edge. Source
adapters read config surfaces; a precedence fold reconciles them (detection
proposes, config disposes); one serialize seam makes output byte-identical.
Exactly two errors escape `map()`: nonexistent root and malformed canonical
config. Every other failure becomes a diagnostic in the map itself.

## The map() pipeline

```mermaid
flowchart TD
  CLI["CLI<br/>bin/platform-map.ts"] --> MAP
  LIB["library caller<br/>(DF, SE, Clarity Audit)"] --> MAP

  MAP["map()<br/>src/map.ts"] --> PR["platform resolution (pre-detect)<br/>internal/platform-root.ts<br/>definition at root > marker upward walk > none<br/>bounded by MapOptions.boundary"]
  PR --> DET["detect()  src/detect.ts<br/>manifest probe: pnpm > yarn > npm > lerna<br/>else sibling scan (internal/scan.ts)"]

  DET --> FOLD["adapter fold<br/>adapters/index.ts PRECEDENCE"]

  subgraph SOURCES ["source adapters: canonical > caller > tool adapters > workspace > siblings"]
    A1["canonical<br/>platform-map.json"]
    A2["caller<br/>MapOptions.units"]
    A3["dark-factory<br/>.factory/df-config.json"]
    A4["spec-engine<br/>spec-engine.member.json"]
    A5["workspace<br/>glob-expanded packages"]
    A6["siblings<br/>provisional .git candidates"]
  end

  FOLD --> A1 --> MRG
  FOLD --> A2 --> MRG
  FOLD --> A3 --> MRG
  FOLD --> A4 --> MRG
  FOLD --> A5 --> MRG
  FOLD --> A6 --> MRG

  MRG["merge()  src/merge.ts<br/>detection proposes, config disposes:<br/>first writer wins, CONFIG_CONFLICT on disagreement,<br/>unconfirmed siblings become UNCONFIGURED_SIBLING"]

  MRG --> ENR["enrich (map.ts)<br/>censusSignals: package.json + fs facts<br/>nested-monorepo recursion (workspace adapter only)<br/>ref probe: git origin/HEAD via bounded exec"]

  ENR --> GRP["graph pass<br/>buildEdges (edges.ts), degrees,<br/>cycles (internal/scc.ts), applyRoles (role.ts)"]

  GRP --> SER["serialize.ts<br/>the sole sort site"]
  SER --> PM["PlatformMap<br/>units + edges + diagnostics<br/>byte-identical JSON"]

  PM --> GV["graph(pm)  src/graph.ts<br/>pure views; toDepGraph() feeds<br/>Dark Factory's planWaves unchanged"]
  PM --> REN["cli-render.ts<br/>tree | --json | DOT | graph projection"]
```

Signals are facts; `role` is a derived view any consumer can recompute via
the exported `deriveRole()`, and canonical `overrides` beat derivation.
Tool semantics (DF pointer resolution, SE pins, wave planning) stay in the
tools; adapters carry only linkage signals.

Primitives under `src/internal/`: `walk` (bounded, symlink-safe), `glob`
(ReDoS-safe subset), `yaml-subset` (pnpm `packages:` only), `path-guard`
(escape checks), `exec`/`ref-probe` (the one subprocess), `df-pointer` (the
DF pointer-only predicate, shared by the scan and two adapters), `scc`
(Tarjan, shared by the CYCLE_SUSPECTED diagnostic and `graph().cycles()`).

## How each platform shape is reached

```mermaid
flowchart TD
  S["invoked directory"] --> Q1{"platform definition?<br/>at the root, found by the<br/>upward walk, or via a member marker"}
  Q1 -->|yes| MR1["multi-repo, declared<br/>members are canonical units;<br/>unlisted .git children flag<br/>UNCONFIGURED_SIBLING"]
  Q1 -->|no| Q2{"spec-engine/ dir<br/>at the root?"}
  Q2 -->|yes| MR2["multi-repo, SE convention<br/>children carrying spec-engine.member.json<br/>are confirmed members"]
  Q2 -->|no| Q3{"workspace manifest?"}
  Q3 -->|yes| MONO["monorepo<br/>workspace-package units,<br/>workspace-dependency edges"]
  Q3 -->|no| Q4{"sibling .git repos<br/>in the parent dir?"}
  Q4 -->|yes| MR3["multi-repo, zero-config<br/>siblings promoted to repo units"]
  Q4 -->|no| SINGLE["single-repo<br/>one unit"]

  MR1 --> NEST["recursive, not modal: any repo unit that itself<br/>detects a workspace manifest reports mode monorepo<br/>and gets its packages expanded at its own node"]
  MR2 --> NEST
  MR3 --> NEST
```

Two invariants hold on every path: absence of a signal is never asserted as
false, and every dropped or ambiguous thing becomes a diagnostic, never a
silent skip.
