# Test fixtures — strategy (D-07)

`detect()` and its supporting primitives are filesystem-walking functions,
so their tests are proven against real on-disk fixture trees, not mocked
`fs` calls.

## Static vs. programmatic fixtures

- **Committed static fixtures** (this directory): plain config files that
  don't require a `.git` directory, a symlink, or anything else that isn't
  portably committable inside this outer repo (a nested `.git` directory
  inside `platform-map`'s own git repo is exactly the kind of thing that
  breaks or confuses tooling — `git` does not track nested repos as regular
  files). These fixtures cover:
  - `single-repo/package.json` — a plain package.json, no `workspaces`.
  - `monorepo-pnpm/pnpm-workspace.yaml` — pnpm's block-list `packages:` form.
  - `monorepo-npm-ws/package.json` + `package-lock.json` — npm workspaces.
  - `monorepo-yarn-ws/package.json` + `yarn.lock` — yarn workspaces.
  - `monorepo-lerna/lerna.json` — lerna's `packages` field.
  - `multi-repo-of-monorepos/sibling-b/pnpm-workspace.yaml` — a sibling that
    is itself a pnpm monorepo (the DET-02 recursive-composability proof).

- **Programmatically materialized fixtures** (`test/detect.test.js` setup):
  anything requiring a real `.git` entry (directory scanning for sibling
  candidates, DET-04/05) is built at test-run time in a temp directory
  (`fs.mkdtempSync` under the OS temp dir), typically seeded by copying one
  of the static fixture trees above (`fs.cpSync(..., { recursive: true })`)
  and then adding the `.git` marker(s) the scenario needs. This keeps the
  committed repo free of nested `.git` directories while still exercising
  the real `.git`-existence check `scanSiblings` performs. Temp directories
  are removed (`fs.rmSync(..., { recursive: true, force: true })`) after
  each test that creates one.

## Why not commit `.git` directories directly

A `.git` directory (or file, for a worktree) committed inside this repo's
own working tree would either be silently ignored by git (nested repos
aren't tracked as regular file trees) or actively confuse tooling that
walks the tree expecting exactly one repository root. Materializing it at
test time sidesteps this entirely and keeps the fixture trees themselves
simple, readable, and diffable.

## What proves what (RED-100)

Every committed fixture dir and every fixture-creating script, mapped to
the requirement(s) it proves and the test that executes it:

| Fixture / builder | Proves | Executed by |
| --- | --- | --- |
| `single-repo/` | PMAP-011 rung 1 (single-repo detection), CFG-03 map() happy path, CLI stream separation | `detect.test.js`, `map.test.js`, `cli.test.js` |
| `monorepo-pnpm/` | PMAP-002 pnpm-workspace detection + MALFORMED_CONFIG honesty, CLI-01/02 stdout/stderr split | `detect.test.js`, `cli.test.js` |
| `monorepo-npm-ws/`, `monorepo-yarn-ws/`, `monorepo-lerna/` | PMAP-002 detection flavors (npm/yarn/lerna) | `detect.test.js` |
| `monorepo-turbo/` | PMAP-002 turbo flavor + detect/map parity | `parity.test.js`, `adversarial-e2e.test.js` |
| `monorepo-edges/` | PMAP-003 workspace-dependency edges, CLI-03 `graph` / `graph --dot` | `edges.test.js`, `cli.test.js` |
| `multi-repo-of-monorepos/` | DET-02 recursive composability (a sibling that is itself a monorepo) | `detect.test.js`, `mixed-topology.test.js`, `parity.test.js` |
| `signals/` | PMAP-004 package.json + fs signal census | `signals.test.js` |
| `adversarial-glob/` | SEC glob/path-guard hardening | `glob.test.js`, `adversarial-e2e.test.js` |
| `synthetic-spec-engine/` | deriveRole against a realistic platform shape | `role-parity.test.js`, `map-graph.test.js`, `parity.test.js` |
| tmpdir builder in `detect.test.js` | DET-04/05 `.git` sibling scanning | `detect.test.js` |
| tmpdir builder in `platform-convention.test.js` (`buildPlatform`) | PMAP-010 run-anywhere equivalence, PMAP-011 rung 3, PMAP-012 drift, D-02/IP-6 local overrides | `platform-convention.test.js` |
| tmpdir builders in `mixed-topology.test.js` / `parity.test.js` | mixed rung composition, detect/map parity | `mixed-topology.test.js`, `parity.test.js` |
| **`scripts/demo-platform.mjs`** (fixture-CREATING script) | PMAP-002/003/010/011/012, role derivation, UNCONFIGURED_SIBLING honesty, local override, CLI-04 `init` — live, annotated, human-readable | `test/demo.test.js` (rot-proof) |

Humans: run `npm run demo` to watch every shape mapped live.
