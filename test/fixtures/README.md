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
| `monorepo-uv/` | `pyproject.toml` with `[tool.uv.workspace]`, `uv.lock`, two packages, one depending on the other (spelled `acme-core` for a package declared `acme_core`) |
| `monorepo-cargo/` | `Cargo.toml` `[workspace]` with `exclude`, `Cargo.lock`, two crates plus an excluded one, a renamed dependency, and a per-target table |
| `monorepo-go/` | `go.work` with a `use` block, `go.sum`, two modules, one requiring the other |
| `adversarial-glob/` | hostile glob patterns, to prove the matcher never backtracks |
