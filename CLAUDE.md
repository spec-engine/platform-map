<!-- DF:project-start source:PROJECT.md -->

## Project

**platform-map**

`platform-map` is a small, zero-dependency TypeScript library + CLI that answers one question deterministically: **"What is this platform made of?"** — it maps a platform of repos and monorepos into the services or packages they represent, so that human developers, teams, and agents all share the same mental model of the platforms they maintain. A platform can be a single repo, multiple repos, a monorepo, or a mix of both. Dark Factory, Spec Engine, and Clarity Audit are its first consumers. Published as `@spec-engine/platform-map` (MIT, public).

**Core Value:** Given any directory tree, produce one deterministic, honest topology map (units + edges + diagnostics) that any developer, team, tool, or agent can trust and re-derive — one consistent way to map and connect otherwise non-relational repos, so changes can be made platform-wide instead of per repo only.

### Constraints

- **Tech stack**: TypeScript source; dual ESM + CJS build (tsup or two-config tsc, dev-dep only) — DF is CommonJS so the package must be `require()`-able.
- **Dependencies**: Zero runtime dependencies. No zod (hand-rolled validation), no `Bun.Glob` (own minimal glob/walk), no YAML lib (regex subset). Vendoring is the fallback, never a runtime dep (D9).
- **Runtime floor**: Node ≥ 20 and Bun, both CI-tested. Bun consumes npm packages natively.
- **Determinism**: Same tree in → byte-identical JSON out. No timestamps, no absolute paths in output.
- **Security**: No network, no git mutations, no writes except CLI `init`. Path-traversal guard, no symlink-following, bounded I/O, package-name validation.
- **License / publish**: MIT, public, npm scope `@spec-engine/platform-map`, CLI binary `platform-map`.

<!-- DF:project-end -->

<!-- DF:stack-start source:research/STACK.md -->

## Technology Stack

## Recommended Stack

### Core Technologies

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|------------------|
| **tsdown** | `0.22.7` (devDep) | Dual ESM+CJS bundler + `.d.ts`/`.d.mts`/`.d.cts` generator | **tsup is no longer actively maintained** — confirmed by the tsup maintainer directly on a GitHub issue and independently by a prominent Vite-ecosystem voice; last publish 2025-11-12, ~8 months stale as of this research. tsdown is its explicit spiritual successor from the Rolldown/VoidZero team, built specifically to be a drop-in replacement (`npx tsdown-migrate` rewrites tsup configs automatically). It auto-generates the `exports` map, generates per-format declaration files, preserves/chmods CLI shebangs, and ships built-in `publint` + `attw` (Are The Types Wrong) validation as first-class config flags — exactly the guardrails a zero-dep substrate package needs. |
| **TypeScript** | `7.0.2` | Source language, type-checking, isolated-declaration emit | Current major; use in `strict` mode. Verified live from npm registry. |
| **Node.js** | `>=20` (consumer floor) / `22` (CI build-runner floor — see pitfall below) | Runtime floor per hard constraint (D5/BRIEF) | Note: Node 20 reached EOL 2026-04-30 (confirmed via endoflife.date) — the floor is still `>=20` because that's the decided hard constraint, but flag this to whoever owns the roadmap: it's an EOL floor, not a currently-supported one. Current lines are Node 26 (Current), 24 (Active LTS), 22 (Maintenance LTS). |
| **Bun** | `1.x` latest (`oven-sh/setup-bun@v2`, `bun-version: latest`) | Second required runtime (D5) | Bun consumes npm packages natively; no special packaging needed beyond correct `exports`. |

### Supporting Libraries (devDependencies only — zero runtime deps preserved)

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `publint` | `0.3.21` | Lints the published package shape (exports map vs. actual files on disk) | Run via `tsdown --publint` on every build; fails CI on mismatch. |
| `@arethetypeswrong/cli` | `0.18.5` | Validates `.d.ts`/`.d.mts`/`.d.cts` resolve correctly under `node10`/`node16`/`bundler` resolution — catches "FalseCJS"/"FalseESM" | Run via `tsdown --attw --attw-profile node16` (or standalone `attw --pack`) in CI; this is the deterministic gate that replaces "someone eyeballing the exports map." |
| `@types/node` | pin to `^20.x` (latest 20.x patch, e.g. `20.19.x`), **not** the newest `26.x` | Type-checking against the floor runtime, not the newest one | Pinning to the floor major prevents source code from accidentally typing against Node-22/24/26-only APIs that would break on the Node 20 CI job. This is a common footgun in floor-vs-latest mismatches — verify deliberately, don't default to `npm install -D @types/node` (which installs latest). |
| `publint` + `attw` invoked from `tsdown.config.ts` | — | Single source of truth for packaging correctness | See exact config below. |

### Development Tools

| Tool | Purpose | Notes |
|------|---------|-------|
| `node:test` + `node:assert/strict` | Test runner (see full rationale in dedicated section below) | Zero additional dependency; both Node and Bun execute it. |
| Biome (`@biomejs/biome@2.5.3`) *or* ESLint+Prettier | Lint/format | Biome recommended for a ~500-800 LOC package: single zero-config binary, no plugin graph to maintain, matches the "small utility" scope of this project. ESLint (`10.x`) + Prettier remains fine if the redhook org standardizes on it elsewhere — not a strong opinion either way, unlike the build-tool and test-runner calls. |

## Installation

# Dev dependencies only — zero runtime dependencies

# Optional lint/format

## 1. Build tooling — dual ESM+CJS from TS source

| Option | Verdict | Why |
|---|---|---|
| **tsdown** ✅ | **Use this** | Successor to tsup (same author lineage, Rolldown/Oxc-powered, VoidZero-backed). Auto-generates `exports`, emits format-correct declaration files, built-in `publint`/`attw` gates, preserves+chmods CLI shebangs, `defineConfig([...])` array supports one config for the library entry and a separate one for the CLI entry. Migration from tsup is a one-command `npx tsdown-migrate`. |
| tsup | Don't start new projects on it | **Not actively maintained** as of this research (confirmed: GitHub issue #1391 on `egoist/tsup` where the maintainer himself flags maintenance status; independently corroborated; last npm publish 2025-11-12). It still works today and migration is trivial, so this isn't an emergency for an already-shipped package, but starting greenfield on it in mid-2026 is starting on a tool whose successor already exists with a frictionless migration path. |
| Plain two-config `tsc` (`tsc -p tsconfig.esm.json && tsc -p tsconfig.cjs.json`) | Viable but not recommended here | Zero extra devDep beyond `typescript` itself — genuinely "zero-dep enough." But you hand-maintain: the `exports` map, the `.d.mts`/`.d.cts` pairing, CLI shebang preservation + `chmod +x`, and you get no `publint`/`attw` validation for free. For an ~500-800 LOC package this is 30 minutes of setup traded for an indefinite maintenance tax and a much easier way to accidentally reintroduce the dual-package hazard. Only reconsider this if `tsdown`'s Node ≥22.18 build-time requirement (see Pitfall below) is a hard blocker for your CI/runner environment. |
| unbuild | Reasonable alternative, not the pick | UnJS-ecosystem default (Nuxt world), esbuild/rollup-based, has a nice "stub mode" for dev-time iteration without rebuilding. Its automatic `exports`-map inference and packaging validation are less integrated/first-class than tsdown's built-in `publint`+`attw` flags. Reasonable fallback if the team is already standardized on UnJS tooling elsewhere in the org — not the case here. |

### `tsdown.config.ts`

### Exact `package.json` fields

## 2. Test runner

| Option | Verdict | Why |
|---|---|---|
| **`node:test`** ✅ | **Use this** | Zero additional dependency (matches the project's own zero-dep instinct extending to the dev-toolchain philosophy). Verified directly against Bun's own source (`test/js/node/test_runner/node-test.test.ts` in `oven-sh/bun`): Bun's test harness spawns `bun test` against fixtures written with `require("node:test")`/`test()`/`describe()`/hooks/`t.assert` and asserts `0 fail` — **basic `node:test` usage runs unmodified and fully under `bun test`.** Bun's own compat-matrix docs list the *only* gaps as `mock.module`, `mock.timers`, and snapshot testing — none of which this project needs (it's pure functions over fixture directories, asserted with plain deep-equal comparisons for byte-identical JSON output; no timers, no module mocking, no snapshots). |
| Vitest | Don't use | Excellent tool, wrong shape for this package: it's a Vite-powered framework aimed at richer DX (watch/UI/component testing) that this ~500-800 LOC fixture-diffing library doesn't need, and it's one more devDep + config surface for a package whose whole ethos is "substrate, not a framework." |
| `bun:test`-only API (`import { test } from "bun:test"`) | Don't use as the primary API | Locks the test suite to Bun; Node would need a second, separately-written suite. Defeats "run one test suite across both runtimes." |

### Running one suite on both runtimes

- **No TS-in-test-runner problem to solve.** Node 20 has no built-in TypeScript stripping (that lands later, Node ≥22.6 experimental / ≥23 by default) and `tsdown` itself can't run on Node 20 either — so any scheme that requires compiling `.ts` test files on the Node-20 CI job reintroduces exactly the toolchain gap the build tool already has. Plain `.js` test files that only call the compiled public API and use `node:assert` sidestep the problem entirely: nothing needs compiling to execute them, on either runtime, on any supported Node major.
- **Tests exercise the actual shipped artifact**, catching exports-map/dual-build mistakes as a side effect (this is directly aligned with the project's own "byte-identical, deterministic" ethos in DESIGN.md §5 — testing the real `dist/` output is stronger evidence than testing source).
- Run identically:

## 3. CLI packaging

- `bin` field: `"bin": { "platform-map": "./dist/cli.js" }` — a single string is also valid npm syntax (`"bin": "./dist/cli.js"`) when the binary name matches the package's unscoped name, but for a scoped package (`@spec-engine/platform-map`) the object form naming the bin explicitly `platform-map` is required (npm does not auto-derive the bin name from a scoped package name).
- Shebang: `#!/usr/bin/env node` as the first line of `src/cli.ts`. Both tsup and (by direct inheritance/feature-parity) tsdown detect a hashbang in an entry file and (a) preserve it verbatim in the output and (b) `chmod +x` the emitted file automatically — no manual `chmod` step needed in the build script. Confidence: **MEDIUM** for tsdown specifically (verified for tsup directly; tsdown's docs describe CLI/`platform: "node"` support but I did not find an explicit tsdown doc sentence re-confirming the auto-chmod behavior). **Mitigation:** add a CI smoke-test assertion (`test -x dist/cli.js`) as a deterministic gate rather than trusting this by inspection — cheap insurance either way.
- **Dual-format avoidance for the CLI specifically:** the CLI entry is never `require()`'d or `import`'d by another package — it's only ever spawned as a process (`node dist/cli.js`, or directly via the shebang once installed as a `bin` symlink). That means it does **not** need a `.cjs`/`.mjs` pair, does not appear in the `exports` map at all, and can be built as ESM-only (`format: ["esm"]`), matching the package's `"type": "module"`. This is the direct mechanism by which "the CLI entry avoids bundling issues in dual-format packages": it's simply not part of the dual-format contract in the first place. Keep it in its own `tsdown.config.ts` entry (see §1) so a future change to the library's build formats can never accidentally couple to the CLI's.
- Smoke test: after build, run `node dist/cli.js --json` and `dist/cli.js --json` (post-`npm link`/post-install, exercising the shebang path) against a tiny fixture, asserting valid JSON on stdout and exit code 0 — this belongs in the CI test matrix, not just local dev.

## 4. TypeScript configuration

- **`target: ES2022`** — Node 20 (the floor) fully supports ES2022; this avoids any Node-20.0.0-vs-later subversion gap that a more aggressive `ES2023`/`ESNext` target could theoretically hit for syntax (not just library) features. `lib: ["ES2023"]` is set separately to get typings for newer array methods (`toSorted`, `toReversed`, etc. — available since Node 20) that are genuinely useful for this library's determinism-via-sorting requirements, without changing the emitted-syntax target.
- **`module`/`moduleResolution: NodeNext`** — the correct pairing for a package that ships real conditional `exports` and needs `tsc`'s own type-checking (not tsdown's bundling) to resolve imports the same way Node's runtime resolver will. (Note: this is the tsconfig used for `tsc --noEmit` type-checking in CI, separate from tsdown's own internal resolution during the actual build — they don't need to be the same tool.)
- **`isolatedDeclarations: true` + `verbatimModuleSyntax: true`** — this pair is what unlocks tsdown's fast Oxc-based `.d.ts` emission path (confirmed: tsdown docs state it falls back to the slower-but-reliable full `tsc` emit path if `isolatedDeclarations` is unset). It also forces every exported function/interface to carry explicit type annotations — which DESIGN.md's public contract (`detect`, `map`, `graph`, `deriveRole`, the `Unit`/`Edge`/`Diagnostic`/`PlatformMap` interfaces) already does in full, so this isn't a burden imposed on the code, it's a forcing function that keeps the "these types ARE the API" contract (DESIGN.md §2) honest at the compiler level.
- **`declaration: true`** here drives a separate `tsc --noEmit`-style full type-check job in CI (catching type errors tsdown's faster Oxc path might not surface); the actual shipped `.d.ts`/`.d.mts`/`.d.cts` files come from tsdown's own build, not from this tsconfig's emit.
- No `esModuleInterop`/`allowSyntheticDefaultImports` needed — zero runtime deps means there's nothing to interop with, and the package itself has no default export to worry about on the way out either.

## 5. CI matrix (GitHub Actions)

- **Node/Bun matrix** covers exactly the D5 floor (Node ≥20, Bun) plus one newer LTS (Node 22) to catch forward-compat regressions early — matching the plan's "Node 20/22 and Bun" instruction, while the `build`/`publish`/`lint-typecheck` jobs run on Node 22 to satisfy tsdown's own engine requirement.
- **`npm publish --dry-run`** runs on every PR in the `build` job (per PLAN.md Phase 0 exit criterion: "packaging breakage is caught pre-release").
- **`npm publish --provenance`** is effectively obsolete as a manual flag: **npm trusted publishing via GitHub Actions OIDC went GA July 2025** — configure the trusted publisher once on npmjs.com (org/repo/workflow-filename/environment), add `permissions: { id-token: write }` to the publish job, and `npm publish` alone generates and attaches a provenance attestation automatically, with no `NPM_TOKEN` secret in the repo at all. Requires npm CLI ≥11.5.1 and Node ≥22.14.0 in the runner — already satisfied by pinning the publish job to Node 22. If the org's npm registry/CLI setup can't yet support trusted publishing, `publishConfig.provenance: true` + a classic automation token + `npm publish --provenance` is the documented fallback, but trusted publishing is the current best practice and should be the default target.

## 6. npm scoped-package publish specifics

- **Public access:** scoped packages (`@spec-engine/...`) default to *private* on publish. Either `"publishConfig": { "access": "public" }` in `package.json` (recommended — makes the intent durable and CI-invocation-independent) or `npm publish --access public` on the command line. Since this package is meant to be `npm i`-able cold by three other tools (PLAN.md Phase 5 exit criterion), bake `publishConfig.access` into the manifest rather than relying on remembering the CLI flag.
- **Org/scope existence:** D1/PLAN.md Phase 0 already flags "verify the `spec-engine` npm org scope exists and D-Rea has publish rights" — do this before wiring the trusted-publisher config on npmjs.com, since trusted publishing registration happens per-package/per-org and needs the scope to exist first.
- **Provenance/attestation from CI:** see §5 — trusted publishing (OIDC) is the 2026 default; it removes long-lived `NPM_TOKEN` secrets from the repo entirely (a real security win for a substrate package three other tools will `npm install`) and attaches a Sigstore-backed provenance attestation automatically, visible on the npm package page as a "Provenance" badge with a link back to the exact GitHub Actions run and commit that produced the tarball.
- **`files`/`.npmignore`:** use `"files": ["dist"]` in `package.json` rather than `.npmignore` — an explicit allow-list is safer for a package whose repo also contains `BRIEF.md`/`DESIGN.md`/`PLAN.md`/fixtures/etc. that shouldn't ship in the tarball.

## Alternatives Considered

| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|--------------------------|
| tsdown | tsup | Only if pinning to an already-working tsup setup elsewhere in the org and avoiding any new tool for consistency reasons; accept that it's unmaintained upstream. |
| tsdown | Plain two-config `tsc` | If `tsdown`'s Node ≥22.18 build requirement is genuinely unworkable in your build environment (e.g., a CI runner image frozen on Node 20) and you're willing to hand-maintain the exports map. |
| tsdown | unbuild | If the org standardizes on UnJS tooling elsewhere, or "stub mode" (no-rebuild dev iteration) is valuable enough to trade for less-integrated packaging validation. |
| `node:test` | Vitest | If test-authoring DX (watch UI, snapshots, richer mocking) becomes a real pain point later — layer it in for test *authoring* without abandoning the "one suite, both runtimes" property, since Vitest can also run under both via its Node execution model (though not natively under `bun test`). |
| Biome | ESLint + Prettier | If the redhook org already has a shared ESLint config used by Dark Factory/Spec Engine and consistency across repos outweighs the lighter Biome setup. |
| npm trusted publishing (OIDC) | Classic automation token + `--provenance` flag | If npm CLI/Node version in the publishing environment can't yet meet the ≥11.5.1/≥22.14.0 requirement, or the org's registry tooling doesn't support configuring a trusted publisher yet. |

## What NOT to Use

| Avoid | Why | Use Instead |
|-------|-----|--------------|
| `tsup` for a new project starting mid-2026 | Confirmed not actively maintained (maintainer-acknowledged, last publish Nov 2025) | `tsdown` |
| A shared/flat `"types": "./dist/index.d.ts"` across both `import` and `require` conditions | Classic FalseCJS trap — TypeScript treats the shared file's module kind based on the package's `"type"` field regardless of which condition resolved to it, producing a type/runtime mismatch for CJS consumers under `node16`/`nodenext` resolution (exactly Dark Factory's consumption mode) | Nested `import.types`/`require.types` pointing at distinct `.d.mts`/`.d.cts`, validated by `attw --profile node16` |
| A default export anywhere in the public API | Reintroduces CJS/ESM default-interop ambiguity (`require(pkg).default` vs `require(pkg)`) for no benefit | Named exports only (already DESIGN.md's shape — keep it that way) |
| Building `.ts` test files that need on-the-fly compilation to run on the Node-20 CI lane | Node 20 has no built-in TS stripping, and the build tool (tsdown) can't run on Node 20 either — you'd need a third toolchain just for tests | Plain `.js` test files using `node:test`/`node:assert`, importing the already-built `dist/` |
| `NPM_TOKEN` long-lived secrets for publishing | Long-lived credentials in repo secrets are exactly the risk trusted publishing was built to eliminate, and this package will be depended on by three other tools — supply-chain hygiene matters disproportionately here | npm trusted publishing via GitHub Actions OIDC (`id-token: write`, no stored token) |
| `.npmignore`-based exclusion for a repo with lots of non-package markdown/fixtures | Denylist drift risk (a new doc file ships accidentally) | `"files": ["dist"]` allow-list in `package.json` |

## Stack Patterns by Variant

- Move to `tsdown`'s workspace mode (it has first-class monorepo support) rather than per-package ad hoc configs.
- Because — consistent `exports`/`publint`/`attw` validation across all packages for free, and it dogfoods the very tool this package's own domain (`platform-map`) is built to describe.
- Use tsdown's `exe: true` (Node.js Single Executable Applications) to produce a standalone binary.
- Because — it's a documented, low-effort tsdown feature (`entry: ['src/cli.ts'], exe: true`), not a new toolchain; defer until an actual consumer asks (matches BRIEF's "don't build until a second consumer needs it" pattern already applied to the wave planner and MCP server).

## Version Compatibility

| Package A | Compatible With | Notes |
|-----------|------------------|-------|
| `tsdown@0.22.7` | Node `^22.18.0 \|\| >=24.11.0` (to *run* the bundler) | Does **not** run on Node 20 — build-time-only constraint, does not affect the Node ≥20 consumer floor of the shipped package. |
| `tsdown@0.22.7` | `typescript@7.0.2` | Needs TypeScript installed as a devDependency for its (fallback) `.d.ts` generation path and for `tsc --noEmit` type-checking; `isolatedDeclarations: true` in `tsconfig.json` switches tsdown to its faster Oxc-based emission path. |
| npm trusted publishing (OIDC) | npm CLI `>=11.5.1`, Node `>=22.14.0` in the publishing job | Both already satisfied by pinning the `publish` job to Node 22, consistent with the `build` job's tsdown requirement — no separate Node version needed just for publishing. |
| `@types/node@^20.x` | Source targeting Node ≥20 floor | Deliberately *not* the newest `@types/node@26.x`, to avoid the source accidentally typing against APIs unavailable on the Node 20 CI lane. |

## Sources

- `/rolldown/tsdown` (Context7) — build config, `exports`/`dts`/`publint`/`attw`/`exe`/`shims` options, migration-from-tsup mechanics, `isolatedDeclarations` behavior. HIGH confidence (official docs + source-repo snapshots).
- `/oven-sh/bun` (Context7) — `node:test` compatibility confirmed directly from Bun's own test harness/fixtures (`test/js/node/test_runner/node-test.test.ts`), and the documented compat gaps (`mock.module`, `mock.timers`, snapshots). HIGH confidence.
- [github.com/egoist/tsup issue #1391](https://github.com/egoist/tsup/issues/1391) — tsup maintenance-status acknowledgment. HIGH confidence.
- [tsdown.dev/guide/migrate-from-tsup](https://tsdown.dev/guide/migrate-from-tsup) — migration tooling, default-format/validation feature overview. HIGH confidence.
- [docs.npmjs.com/trusted-publishers](https://docs.npmjs.com/trusted-publishers/) — OIDC trusted-publishing setup, npm CLI/Node version requirements. HIGH confidence.
- [github.blog/changelog npm trusted publishing GA (2025-07-31)](https://github.blog/changelog/2025-07-31-npm-trusted-publishing-with-oidc-is-generally-available/) — GA date/status. HIGH confidence.
- [nodejs.org/api/packages.html#dual-commonjses-module-packages](https://nodejs.org/api/packages.html) — canonical dual-package `exports` guidance (types-condition-first rule). HIGH confidence, cross-checked against the FalseCJS-specific nested-condition guidance from arethetypeswrong's own docs.
- [github.com/arethetypeswrong/arethetypeswrong.github.io/blob/main/docs/problems/FalseCJS.md](https://github.com/arethetypeswrong/arethetypeswrong.github.io/blob/main/docs/problems/FalseCJS.md) — FalseCJS mechanism and fix pattern. MEDIUM-HIGH (WebSearch-sourced summary of an official docs page, not directly fetched in full).
- [endoflife.date/nodejs](https://endoflife.date/nodejs) — Node.js 20 EOL date (2026-04-30) and current LTS lines. HIGH confidence.
- Live `npm view` against the npm registry for exact current versions of `tsdown`, `typescript`, `@types/node`, `publint`, `@arethetypeswrong/cli`, `@biomejs/biome`, `eslint`, `tsup` (including `tsup`'s last-publish timestamp). HIGH confidence — primary source, not training data.
- [oven-sh/setup-bun](https://github.com/oven-sh/setup-bun) — GitHub Actions Bun setup, current `@v2`. MEDIUM-HIGH (WebSearch-sourced).

<!-- DF:stack-end -->

<!-- DF:conventions-start source:CONVENTIONS.md -->

## Conventions

Conventions not yet established. Will populate as patterns emerge during development.
<!-- DF:conventions-end -->

<!-- DF:architecture-start source:ARCHITECTURE.md -->

## Architecture

Architecture not yet mapped. Follow existing patterns found in the codebase.
<!-- DF:architecture-end -->

<!-- DF:skills-start source:skills/ -->

## Project Skills

No project skills found. Add skills to any of: `.claude/skills/`, `.agents/skills/`, `.cursor/skills/`, `.github/skills/`, or `.codex/skills/` with a `SKILL.md` index file.
<!-- DF:skills-end -->

<!-- DF:workflow-start source:DF defaults -->

## DF Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a DF command so planning artifacts and execution context stay in sync.

Use these entry points:

- `/df:quick` for small fixes, doc updates, and ad-hoc tasks
- `/df:debug` for investigation and bug fixing
- `/df:execute-phase` for planned phase work

Do not make direct repo edits outside a DF workflow unless the user explicitly asks to bypass it.
<!-- DF:workflow-end -->

<!-- DF:profile-start -->

## Developer Profile

> Profile not yet configured. Run `/df:profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- DF:profile-end -->
