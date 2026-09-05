# Test fixtures

Committed directory trees used by the detection and package tests. They
contain only config files: no `.git` directories, because git does not track
nested repositories. Tests that need a `.git` entry, a symlink, or a whole
platform build one in a temp directory at run time (see `test/helpers.ts`).

| Fixture | What it is |
|---|---|
| `single-repo/` | a plain package.json, no workspaces |
| `monorepo-pnpm/` | `pnpm-workspace.yaml` with a block list, including a `!` pattern |
| `monorepo-npm-ws/` | `package.json` `workspaces` with `package-lock.json` |
| `monorepo-yarn-ws/` | `package.json` `workspaces` with `yarn.lock` |
| `monorepo-lerna/` | `lerna.json` |
| `monorepo-edges/` | three packages that depend on each other, for `dependsOn` |
| `adversarial-glob/` | hostile glob patterns, to prove the matcher never backtracks |
