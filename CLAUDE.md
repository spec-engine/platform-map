<!-- DF:project-start source:PROJECT.md -->
## Project

**platform-map** (`@spec-engine/platform-map`, MIT, public). Documents which
repositories make up a platform, discovers the ones sitting next to each
other so you can confirm them, and maps what is inside every repo and
monorepo. Two committed `platform-map.json` shapes (platform file with
`name` + `members`; leaf marker with `platform` + `member`), members as
child directories of the platform repo, and one per-user
`~/.config/platform-map/platforms.json` for other layouts. The map carries
`ecosystem` (node, python, rust, go), `packageName`, `packageManager`,
workspace `packages`, and `dependsOn` across the platform, matched within an
ecosystem. Design: `docs/spec.md`. Public docs: `README.md`.

Constraints: zero runtime dependencies; Node >= 24 and Bun; deterministic
JSON (sorted, no machine paths, byte-identical from root, member, or
subdirectory); no subprocess, no network; only `applyInit` and `applyLink`
write, and `applyInit` never overwrites a marker; the CLI is a thin wrapper
over library functions.
<!-- DF:project-end -->

<!-- DF:stack-start source:research/STACK.md -->
## Technology Stack

TypeScript (strict, `isolatedDeclarations`), built by tsdown into ESM + CJS
for the library and ESM for the CLI. Biome for lint and format. Tests are
TypeScript run directly by `node --test`. Convention: every test sits next
to the file it tests and is named after it (`src/map.test.ts` tests
`src/map.ts`; `bin/platform-map.test.ts` drives the built CLI end to end
against `dist/`). `test/` holds only shared fixtures and helpers;
`npm run lint:tests` enforces this. The Bun smoke in `test-bun/` is the one
package-level test (Bun cannot run the node:test files).
Scripts: `build`, `test`, `test:bun`, `typecheck`, `lint`, `lint:docs`,
`lint:tests`. Run all seven before pushing. `docs:ecosystems` regenerates the README's
"Supported ecosystems" table from `src/ecosystems.ts`; a test fails when
they drift.
<!-- DF:stack-end -->

<!-- DF:conventions-start source:CONVENTIONS.md -->
## Conventions

- Never commit a machine path. Per-user state lives in the user file.
- Problems are diagnostics, not throws; `DirectoryNotFoundError` is the only exception.
- Do not infer judgments like app-vs-library; declare them or ask.
- No adapters for specific tools. No bare DF/SE/CA abbreviations or private ticket ids in public files (`npm run lint:docs` enforces this).
- Everything that knows a manifest by name lives in `src/ecosystems.ts`. Manifests are read by the built-in parsers in `src/internal/` (no parser dependencies); an unsupported shape is a `MALFORMED_FILE` diagnostic.
- Comments: one short header per file, plus only what the code cannot say.
- Anything that writes is split into `planX` (pure) and `applyX`.
- CI: snapshot-poll checks, never `--watch`. The build job uses `npm pack --dry-run`, not `npm publish --dry-run` (npm 11 refuses a dry run of a published version).
<!-- DF:conventions-end -->

<!-- DF:architecture-start source:ARCHITECTURE.md -->
## Architecture

See `docs/architecture.md`. `src/files.ts` reads and writes the three files;
`src/resolve.ts` finds the platform root from wherever the command ran;
`src/map.ts` (`map`, `locate`, `check`) uses `src/detect.ts`,
`src/discover.ts`, and `src/packages.ts`, which read the ecosystem table in
`src/ecosystems.ts`; `src/init.ts` and `src/link.ts` are the two writers;
`src/render.ts` produces the tree, JSON, and Mermaid. `src/internal/` holds
the glob matcher, the bounded walk, the pnpm YAML subset, the TOML subset,
and the go.mod / go.work reader.
<!-- DF:architecture-end -->

<!-- DF:skills-start source:skills/ -->
## Project Skills

None.
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
