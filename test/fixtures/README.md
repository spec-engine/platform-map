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
