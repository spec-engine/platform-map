# platform-map — Build & Publish Plan (Draft)

**Status:** draft for review · **Companion:** BRIEF.md (decisions D1–D8 gate Phase 0)

Scope framing: this is a *little utility* — the plan is sized in days, not weeks. Phases are sequential but small; each ends with something shippable or verifiable. The library is ~500–800 lines of source plus tests; most of the effort is porting behavior faithfully and building the fixture suite that proves it.

## Phase 0 — Decisions & scaffold (½ day)

- Sign off (or amend) BRIEF.md decisions D1–D8.
- Verify npm name availability for `@spec-engine/platform-map`; confirm the spec-engine npm org scope exists and D-Rea has publish rights (create the org scope on npmjs.com if not).
- Create the public GitHub repo under the spec-engine org: `spec-engine/platform-map`, MIT LICENSE, README stub pointing at BRIEF.md content.
- Scaffold: TypeScript, dual ESM+CJS build (`tsup` or plain `tsc` two-config build — dev dependency only; zero *runtime* deps stands), `bun test`-and-`node --test`-compatible test runner choice (recommend vitest as devDep, or plain node:test to keep even devDeps thin).
- CI (GitHub Actions): lint, typecheck, test matrix on Node 20/22 **and** Bun, `npm publish --dry-run` on every PR so packaging breakage is caught pre-release.

**Exit:** empty package builds, tests run green on both runtimes, dry-run publish passes.

## Phase 1 — Core model + detection (1 day)

- Define the `Platform` / `Unit` / `Edge` / `Diagnostic` types (BRIEF §5) as the package's public contract.
- Port `detectPlatformMode` from DF (workspace manifests → monorepo; sibling git repos → multi-repo; else single-repo), made recursive per unit.
- Port `detectMonorepoWorkspaces` (pnpm-workspace.yaml, package.json workspaces, lerna.json) from DF `docs.cjs`.
- Implement the zero-dep glob/walk needed for workspace-member expansion (replaces `Bun.Glob`; scope: `*`, `**`, and literal segments — the subset the three codebases actually use).
- Determinism contract in tests from day one: sorted units/edges, stable serialization, fixture-in → byte-identical JSON out.

**Exit:** `detect(cwd)` and workspace enumeration pass a fixture suite ported from DF's platform-discovery tests + SE's discovery tests + the new multi-repo-of-monorepos fixture.

## Phase 2 — Adapters + canonical config (1 day)

- Canonical `platform-map.json` schema + hand-rolled validator with location-tagged errors (SE's readCanonicalManifest error style: read / parse / validate each wrapped and named).
- Adapters per BRIEF §5: canonical, dark-factory, spec-engine, workspace, siblings — each a pure function `(root) → partial model + diagnostics`, merged under the documented precedence.
- Sibling scan port from DF: ignore-before-I/O, dotfile/dir filtering, `.git` gate, bounded origin/HEAD probe with fallback, pointer/conflict detection surfaced as signals + diagnostics.
- SE three-bucket classification becomes the `UNCONFIGURED_SIBLING` / ignored-plain-folder logic in the siblings adapter.

**Exit:** pointing `map()` at real checkouts of dark-factory, spec-engine, and a DF-managed platform produces correct maps with zero config, and precedence/conflict cases are fixture-tested.

## Phase 3 — Graph + signals (½–1 day)

- Workspace dependency edges (deps ∩ workspace-name-set, DF-style; external deps filtered).
- **Not** the Kahn wave planner — decided 2026-07-11 that it stays in DF (`monorepo-wave-planner.cjs`) to keep platform-map purely descriptive. The lib guarantees the edges it emits are sufficient input for DF's existing `planWaves(repos, depGraph)` signature; a fixture test proves DF's planner runs unmodified on platform-map edge output.
- Per-unit signal collection (BRIEF D3 list) + `role` derivation, with an `overrides` escape hatch from canonical config.

**Exit:** edge output feeds DF's wave planner unchanged on shared fixtures; `role` derivation validated against spec-engine's own monorepo (engine/shared/tracker → library, webapp → app).

## Phase 4 — CLI (½ day)

- `platform-map` (tree view), `--json`, `detect`, `graph [--waves]`, `init` (the one writer: detect → print proposal → confirm → write canonical config; `--yes` for non-interactive).
- Exit codes and stderr/stdout discipline suitable for agent consumption (JSON always to stdout, diagnostics to stderr in human mode, embedded in JSON in `--json` mode).

**Exit:** CLI smoke tests; README usage section written from real command output.

## Phase 5 — Publish v0.1.0 (½ day)

- README finalized (problem, model, CLI examples, adapter table, "who uses this" section naming Dark Factory and Spec Engine).
- CHANGELOG, versioning policy (semver; the JSON model shape is the API — model changes are semver-major once 1.0 lands).
- Publish `@spec-engine/platform-map@0.1.0` (public, MIT). Tag, GitHub release.
- Optional: provenance/attestation via `npm publish --provenance` from CI (recommended — free trust signal for a substrate package).

**Exit:** `npm i @spec-engine/platform-map` works cold in both a Node CJS project and a Bun project.

## Phase 6 — Integrations (order per D6; ~½–1 day each, in the consuming repos)

1. **Clarity Audit** (private): `platform-mapper` agent prompt updated to run `platform-map --json` first and build narrative layers on top; deletes its instruction to re-derive repo inventory by exploration. Validates the CLI as an agent surface.
2. **Dark Factory:** replace `platform-discovery.cjs` and `detectMonorepoWorkspaces` with library calls behind the unchanged `df-tools query platform.*` routes; the wave planner stays DF-owned and now consumes platform-map's edges. DF's mode-name mapping (`inline`/`standalone`/`monorepo-package`) lives at this seam. Golden-file tests assert route output is byte-identical pre/post swap; then delete the superseded lib files.
3. **Spec Engine:** `discover.ts` enumeration replaced by `map()` + a pin-overlay; `members` glob honored via the spec-engine adapter; `NO_SPEC_CONFIG` derived from `UNCONFIGURED_SIBLING`. SE's cold-rebuild determinism tests are the acceptance gate.

**Exit per integration:** the tool's own test suite green with its detection code deleted; each repo's docs updated to point at platform-map as the topology source.

## Phase 7 — v0.2 and beyond (backlog, not scheduled)

- `init` ergonomics: adopt-existing mode ("found DF/SE config — generate the equivalent platform-map.json?").
- MCP server wrapper (D4 revisit) if a shell-less agent consumer materializes.
- Source-level dependency edges as an additional signal (import scanning).
- Non-JS ecosystem adapters (cargo workspaces, go.work, gradle) as demand appears.
- Promote DF's Kahn wave planner into `graph().waves()` if a second consumer ever needs wave ordering (parked 2026-07-11 as scope creep for v1).
- 1.0 once all three consumers have shipped on it and the model has survived a quarter without breaking changes.

## Verification strategy (cross-phase)

- **Fixture parity:** every behavior ported from DF/SE lands with its originating test ported alongside it — the fixture suite is the contract that the consolidation didn't change semantics.
- **Golden-file seams:** DF's `df-tools query` routes and SE's index output are compared byte-for-byte before/after integration.
- **Dogfood target:** the spec-engine monorepo itself (and the redhook multi-repo folder) are standing integration fixtures — `platform-map` must map its own home correctly at every release.

## Risks

| Risk | Mitigation |
|---|---|
| Adapter semantics drift from the tools' own readers over time | The point of Phase 6 is that the tools *delete* their own readers — there's nothing left to drift. Until then, golden-file tests pin equivalence. |
| SE integration disturbs its determinism/provenance contracts | SE goes last; its cold-rebuild test suite is the acceptance gate; the lib's determinism contract (Phase 1) is designed to be strictly stronger. |
| `role` derivation is wrong for odd packages | It's a derived convenience with a config `overrides` escape hatch and full signals exposed — wrong derivation is annoying, never blocking. |
| Zero-dep glob subset too narrow for some workspace config in the wild | Diagnostics report unmatchable patterns loudly; widen the subset as cases appear rather than shipping a full glob engine up front. |
| npm scope/name unavailable | D1 verification is the first Phase 0 task; fallbacks: `@specengine/platform-map` or `@spec-engine/pmap`. |

## Rough total

~4–5 focused days for library + CLI + publish (Phases 0–5), plus ~2 days of integration work spread across the three consuming repos. All phases are independently pausable — nothing before Phase 6 touches the existing tools.
