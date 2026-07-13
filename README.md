# @spec-engine/platform-map

A small, zero-runtime-dependency TypeScript library + CLI that answers one
question deterministically: **"What is this platform made of?"** — which
repos and workspace units exist, how they relate, and what each one is.

Given any directory tree, `platform-map` produces one deterministic, honest
topology map (units + edges + diagnostics) that Dark Factory, Spec Engine,
Clarity Audit, agents, and humans can all trust and re-derive — replacing
three divergent detection implementations with one shared substrate.

> **Status:** Phase 1 (foundation scaffold). The public type contract and the
> deterministic serializer are in place; `detect()`, the adapters, `map()`,
> `graph()`, `deriveRole()`, and the CLI land in later phases. See the
> project's `PLAN.md`/`ROADMAP.md` for the full build order.

## Install

```bash
npm install @spec-engine/platform-map
```

Zero runtime dependencies. Requires Node `>=20` or Bun.

## Determinism

`toJSON(pm)` and `serialize(pm)` (exported from the package root) are the
single sort/stringify seam for a `PlatformMap`: the same logical map always
serializes to a byte-identical JSON string, regardless of the order its
`units`, `edges`, or `diagnostics` arrays were constructed in. Nested
`units[]` are sorted recursively by `name`; `edges` are sorted by
`(from, to)`; `diagnostics` are sorted by `(severity: error > warning > info,
then code, then path)`. All comparisons use plain `<`/`>` on strings — never
a locale-aware comparison — so output is stable across environments and Node
versions. Output never contains absolute filesystem paths or timestamps.

These two functions are an intentional additive extension beyond the
original design's function list: they give the dual ESM+CJS build a real
runtime export to validate (not just types), and are the seam every consumer
can rely on for byte-identical output.

## Diagnostics

Every diagnostic carries a `code`, a `severity` (`info` | `warning` |
`error`), an optional platform-relative `path`, and a human-readable
`message` with a stable prefix per code.

| Code | Meaning |
|------|---------|
| `UNCONFIGURED_SIBLING` | A candidate sibling repo has no config confirming it as a unit. |
| `CONFIG_CONFLICT` | Two sources disagree on a value; precedence was applied and both are reported. |
| `MALFORMED_CONFIG` | A JSON/shape error was found in a source file (adapter config, not canonical). |
| `UNMATCHED_PATTERN` | A workspace/ignore glob pattern matched nothing. |
| `CYCLE_SUSPECTED` | The edge graph contains a cycle; mapping still succeeds. |
| `UNIT_PATH_ESCAPE` | A resolved unit path would escape the platform root; the unit is dropped. |
| `CENSUS_TRUNCATED` | A depth or entry-count cap was hit during file census (additive code, not in the original design doc — added so bounded scans never truncate silently). |

## Detection flavor precedence

Workspace-manifest detection probes, in order: **pnpm-workspace.yaml** >
**yarn workspaces** > **npm workspaces** > **lerna.json**. `turbo.json`/
`nx.json` are recorded as an `orchestrator` overlay only — they never gate
which flavor is selected. This order is normative and ported deliberately
from prior art, not re-derived.

## License

MIT
