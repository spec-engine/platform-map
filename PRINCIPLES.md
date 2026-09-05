# Principles

The pillars of platform-map's architecture. Each pillar is a promise; a promise
is only listed here if it is either (a) enforced by requirements and tests, or
(b) explicitly marked as a gap with a statement of what exists instead.
Marketing claims with no verification path do not belong in this file.

Requirement IDs (`PMAP-nnn`) refer to the catalog in
[REQUIREMENTS.md](./REQUIREMENTS.md). Test files live in `test/`.

---

## 1. One vocabulary

A platform is **units**, **edges**, and **diagnostics**; every node has a mode:
`single-repo | multi-repo | monorepo`, recursively (a multi-repo platform's
member can itself be a monorepo).

Tools that map repos tend to each invent a private vocabulary for the same
thing ("constituent", "member", "repo in scope"). platform-map fixes one: the
types in `src/types.ts` ARE the API, and changing their shape is semver-major.
Consumers keep their own words only at their own seams, via trivial mappings.

*Verified by:* the exported type contract; `publint` + `attw --profile node16`
packaging gates; `serialize.test.js`, `canonical.test.js`.
**Status: real.**

## 2. Observed signals, derived roles

The core reports observable signals. Judgments (`role`) are derived views with
documented rules, recomputable by anyone via the exported `deriveRole()`, and
overridable by config. Consumers may trust the derived field or re-derive from
the same facts; no tool has to accept another tool's opinion.

*Verified by:* PMAP-002/003; `role.test.js`, `role-parity.test.js`,
`signals.test.js`. Known limit: the documented role rules hold against
synthetic fixtures, not yet against every live repo (flagged, deferred).
**Status: real.**

## 3. Detection proposes, config disposes

Zero-config detection produces candidates; explicit config is truth and always
wins; conflicts become diagnostics, never silent overrides.

This is the conflict platform-map exists to reconcile: some tools want
ecosystem-native zero-config detection, others want explicit opt-in, so the
same repo can be "a monorepo" to one and invisible to the other. Both instincts
are layers of one precedence chain (canonical config > integration adapters >
workspace manifests > sibling scan).

*Verified by:* PMAP-004 (partially); `merge.test.js` (promotion gate),
`siblings.test.js`, `parity.test.js`.
**Status: real.**

## 4. Honest about unknowns

Absence means "not determined," never "false." Nothing is silently dropped:
every quiet failure path has an enumerated diagnostic code, including bounded
scans (`CENSUS_TRUNCATED`) and ambiguity (no guessing). This is a typed library
contract, not an ethos.

*Verified by:* PMAP-004; diagnostic-code tests across the suite
(`map.test.js`, `glob.test.js`, `walk.test.js`, `signals.test.js`).
**Status: real.**

## 5. Deterministic to the byte

Same tree in → byte-identical JSON out. No timestamps, no absolute paths, one
sort seam (`serialize.ts`), no locale-dependent comparisons.

*Verified by:* PMAP-001; double-run and shuffle tests in `canonical.test.js`,
`serialize.test.js`, `parity.test.js`, `adversarial-e2e.test.js`.
**Status: real.** The strongest-tested property in the suite.

## 6. Safe to run anywhere

Read-only core; exactly one writer (`platform-map init`, confirm-gated,
refuse-if-exists); zero runtime dependencies; no network; no git mutation;
bounded I/O; path-traversal and symlink guards; package-name validation.

*Verified by:* PMAP-005/006/007/008; `path-guard.test.js`, `walk.test.js`,
`exec.test.js`, `package-name.test.js`, `yaml-subset.test.js`, `cli.test.js`;
dual-runtime CI (Node 20/22 + Bun) and cold-install smoke.
**Status: real.**

## 7. The platform is self-describing on disk

Platform knowledge lives in files, not in meetings or chat. Progressive
disclosure: a single repo needs only its own `platform-map.json`; a monorepo
the same (opt-in to more); a multi-repo platform gets a small platform repo
holding the **canonical membership definition** (checked in), while **disk
locations stay per-user** (local config, defaulting to the members-as-child-dirs
convention). Each member carries a committed marker (`platform` name + root
hint) so any engineer or agent cloning it knows where it belongs. Running
platform-map anywhere in the platform yields the same map.

*Verified by:* PMAP-010/011/012 — `test/platform-root.test.js`
(discriminated schemas, bounded upward walk, containment),
`test/platform-convention.test.js` (platform assembly, the PMAP-010
byte-equivalence matrix across root/member/nested-subdir, local-override
relocation with byte-identical output, drift diagnostics),
`test/cli-init-platform.test.js` (the `init` platform bootstrap round-trip).
**Status: real.** Running `map()` at the platform root, a member root, or any
nested member subdir yields byte-identical JSON; members carry committed
markers; disk locations are per-user (`platform-map.local.json`, gitignored)
and never appear in output.

---

## Roadmap honesty

- **Cross-repo dependency edges** (PMAP-013): today edges exist only inside a
  single workspace (`via: "workspace-dependency"`); separate repos are mapped
  together but not yet *related* by dependency edges. Deliberately out of
  initial launch scope. What exists instead: per-workspace edges, cycle
  detection, and honest absence (no fabricated cross-repo edges).

## Requirement traceability

| Pillar | Requirements | Status |
|---|---|---|
| 1 One vocabulary | catalog anchor, PMAP-007, PMAP-008 | real |
| 2 Observed signals, derived roles | PMAP-002, PMAP-003 | real |
| 3 Detection proposes, config disposes | PMAP-004 (gate), merge precedence | real |
| 4 Honest about unknowns | PMAP-004 | real |
| 5 Deterministic to the byte | PMAP-001 | real |
| 6 Safe to run anywhere | PMAP-005, PMAP-006, PMAP-007, PMAP-008 | real |
| 7 Self-describing on disk | PMAP-010, PMAP-011, PMAP-012 | real |
| (roadmap) Cross-repo edges | PMAP-013 | planned, not yet implemented |
