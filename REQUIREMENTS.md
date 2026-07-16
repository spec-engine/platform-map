# Requirements — @spec-engine/platform-map

The PMAP requirement catalog: the testable statements behind the promises in
[PRINCIPLES.md](./PRINCIPLES.md). Every requirement is either **verified**
(with named tests), **verified with notes** (true, with documented limits), or
**unimplemented** (tracked by a ticket — the promise is not made publicly
until it lands). Domain key: `PMAP` per `standards/spec-keys.md`.

## Catalog

### PMAP-001 — Determinism
Same input tree produces byte-identical JSON output across runs and runtimes.
No timestamps and no absolute paths in output.
**Status: verified.**
Evidence: `test/serialize.test.js` (shuffle byte-identity DETR-02; no
absolute paths; no ISO-8601 timestamps), `test/map.test.js` (double-run
byte-identity: single-repo, monorepo-pnpm), `test/verification.test.js`
(double-run sweep over EVERY committed fixture, readdir-driven — new fixtures
are auto-covered), order-independence in `edges/map-graph/merge/detect/walk/
scc/cli-render` tests, DETR sweeps in `adversarial-e2e/parity/role-parity`.
Note: cross-runtime (Node-vs-Bun) byte-comparison of the same tree is not yet
asserted in CI; each runtime independently proves order-independence.

### PMAP-002 — Completeness
Every unit present in the mapped tree appears exactly once in `units`; none
invented, none dropped.
**Status: verified with notes.**
Evidence: exact unit-set assertions per topology (`test/map.test.js`,
`test/parity.test.js`, `test/adversarial-e2e.test.js`), dedupe-by-name cases
(`test/merge.test.js`), and a global exactly-once invariant — unit names
unique at all depths across every committed fixture
(`test/verification.test.js`). Note: "none dropped" is proven pointwise per
fixture, not as a universal invariant.

### PMAP-003 — Edge fidelity
Every edge corresponds to a declared workspace dependency; external deps and
self-edges are dropped; no fabricated edges.
**Status: verified.**
Evidence: `test/edges.test.js` (name→path translation, external filtered,
self-edge dropped, per-sibling-set index scoping), `test/map.test.js` e2e over
`monorepo-edges`, degree wiring in `test/graph.test.js`/`test/map-graph.test.js`.

### PMAP-004 — Honesty
Ambiguous or unrecognizable structures produce diagnostics, never silent
guesses or omissions. All seven diagnostic codes are exercised.
**Status: verified.**
Evidence per code — UNCONFIGURED_SIBLING: `merge/map/parity` tests;
CONFIG_CONFLICT: `merge/map/serialize`; MALFORMED_CONFIG:
`package-name/yaml-subset/dark-factory/spec-engine/map/signals/parity`;
UNMATCHED_PATTERN: `glob/workspace/map/adversarial-e2e`; CYCLE_SUSPECTED:
`map-graph/scc`; UNIT_PATH_ESCAPE: `path-guard/map/dark-factory/spec-engine/
canonical/workspace/detect/adversarial-e2e/serialize`; CENSUS_TRUNCATED:
`walk/workspace/serialize`.

### PMAP-005 — Safety
No network. No filesystem writes except CLI `init`. Path-traversal guarded.
Symlinks never followed. I/O and subprocesses bounded. Package names
validated.
**Status: verified.**
Evidence: traversal — `test/path-guard.test.js`; symlinks —
`test/walk.test.js`, `test/adversarial-e2e.test.js` (T-05-05); bounded exec —
`test/exec.test.js` (SIGTERM/SIGKILL escalation, 64KB cap),
`test/ref-probe.test.js`; package names — `test/package-name.test.js`
(SEC-03 matrix); **no-write** — `test/verification.test.js` (full
before/after filesystem snapshot around `map()`; plus `init` refusal in
`test/cli.test.js`); **no-network** — `test/verification.test.js` (static
audit: built artifacts contain no network-module references; the only
subprocess use is the bounded git ref probe).

### PMAP-006 — Dual-runtime
The suite passes on Node 20, Node 22, and Bun against the built `dist/`.
**Status: verified with notes.**
Evidence: CI matrix `[node20, node22, bun]` in `.github/workflows/ci.yml`;
Node lanes run the full `node --test` suite; Bun lane runs
`test-bun/smoke.bun.spec.mjs` (ESM detect over three topologies, CJS require,
order-independence). Note: the Bun lane is a deliberate smoke subset —
`bun test` cannot host the nested `node:test` suites (oven-sh/bun#5090);
rationale documented in `test-bun/` and `ci.yml`.

### PMAP-007 — Dual-format
The package is `require()`-able (CJS) and `import`-able (ESM) with correct
types under node16 resolution.
**Status: verified.**
Evidence: `test-bun/` (CJS require + ESM import of dist),
`scripts/cold-install-smoke.mjs` (packed tarball installed into cold Node-CJS
and Bun scratch projects, installed bin executed), CI `build` job:
`attw --pack --profile node16`, `publint`, `npm publish --dry-run`,
`test -x dist/platform-map.mjs`.

### PMAP-008 — CLI contract
The CLI emits valid JSON on stdout in `--json` mode, keeps diagnostics off
stdout, and exits 0 (ok) / 1 (usage or hard error) / 2 (error-severity
diagnostics).
**Status: verified with notes.**
Evidence: `test/cli.test.js` (JSON validity, pipe-drain completeness,
stdout/stderr separation, exit 0 and 1 spawn cases),
`test/cli-render.test.js` (severity→exit-code mapping). Note: exit code 2 is
white-box only — no shipped diagnostic currently carries `error` severity, so
the path is unreachable black-box in v0.1.0. If a future error-severity
diagnostic ships, add a black-box spawn test then.

### PMAP-009 — Topology coverage
All four platform shapes map correctly: single repo, monorepo (all detected
flavors), multiple single repos, and mixed (single repos and monorepos side
by side), each backed by at least one test.
**Status: verified.**
Evidence: single — `test/map.test.js`; monorepo flavors pnpm/npm/yarn/lerna/
turbo(+edges) — `test/map.test.js`, `test/detect.test.js`,
`test/parity.test.js`, `test/edges.test.js`; multi-repo —
`test/map.test.js` (zero-config sibling promotion); multi-repo-of-monorepos —
`test/map.test.js`, `test/parity.test.js`; **mixed** —
`test/mixed-topology.test.js` (a plain single-repo sibling and a monorepo
sibling promoted together in one map).

### PMAP-010 — Execution anywhere
**Status: unimplemented — RED-97.** Running at the platform root or from
inside any member yields the same map (modulo root anchor). Today only the
one-level sibling scan exists.

### PMAP-011 — Platform definition file
**Status: unimplemented — RED-97.** Canonical checked-in membership at the
platform root (progressive disclosure: in-repo → monorepo → platform repo);
per-user local config for disk locations, defaulting to the
members-as-child-dirs convention.

### PMAP-012 — Member self-awareness
**Status: unimplemented — RED-97.** A committed per-member marker (platform
name + root hint) lets any member resolve its platform without heuristics.

### PMAP-013 — Cross-repo edges
**Status: unimplemented — RED-98.** Dependency edges across repo boundaries
with name-collision honesty. Today edges are deliberately scoped per sibling
set; `test/mixed-topology.test.js` pins the current suppression behavior so
RED-98 must consciously change it.

## Traceability matrix

| Requirement | Status | Primary tests | Known limits |
|---|---|---|---|
| PMAP-001 | verified | verification (all-fixtures sweep), serialize, map, DETR sweeps | no Node↔Bun byte-compare in CI |
| PMAP-002 | verified* | verification (global uniqueness), map, merge, parity | "none dropped" pointwise only |
| PMAP-003 | verified | edges, map (monorepo-edges) | — |
| PMAP-004 | verified | all 7 codes, see catalog | — |
| PMAP-005 | verified | path-guard, walk, exec, ref-probe, package-name, verification (no-write, no-network) | no-network is a static audit |
| PMAP-006 | verified* | ci.yml matrix, test-bun smoke | Bun lane is a smoke subset |
| PMAP-007 | verified | cold-install smoke, attw/publint, test-bun | — |
| PMAP-008 | verified* | cli, cli-render | exit 2 unreachable black-box |
| PMAP-009 | verified | mixed-topology, map, parity, detect | — |
| PMAP-010..012 | unimplemented | — | RED-97 |
| PMAP-013 | unimplemented | mixed-topology pins current suppression | RED-98 |

`verified*` = verified with notes (see catalog entry).
