# Principles

The pillars of platform-map's architecture. Each pillar is a promise; a promise
is only listed here if it is either (a) enforced by requirements and tests, or
(b) explicitly marked as a gap with a tracking ticket and a statement of what
exists instead. Marketing claims with no verification path do not belong in
this file.

Requirement IDs (`PMAP-nnn`) refer to the requirement catalog (landing in-repo
via the verification pass, RED-96). Test files live in `test/`.

---

## 1. One vocabulary

A platform is **units**, **edges**, and **diagnostics**; every node has a mode:
`single-repo | multi-repo | monorepo`, recursively (a multi-repo platform's
member can itself be a monorepo).

*Prior divergence:* Dark Factory said "constituent" (`inline / standalone /
monorepo-package`), Spec Engine said "member / sub-member" (adoption rungs),
Clarity Audit said "repo in scope." Three private languages for one thing.

*Convergence:* the types in `src/types.ts` ARE the API — changing their shape
is semver-major. Tools keep their old words only at their own seams, via
trivial mappings.

*Verified by:* the exported type contract; `publint` + `attw --profile node16`
packaging gates; `serialize.test.js`, `canonical.test.js`.
**Status: real.**

## 2. Facts, not opinions

The core reports observable signals. Judgments (`role`) are derived views with
documented rules, recomputable by anyone via the exported `deriveRole()`, and
overridable by config.

*Prior divergence:* DF baked deployability judgments into its model; Clarity
Audit asserted classifications by agent judgment.

*Convergence:* consumers may trust the derived field or re-derive from the same
facts — no tool has to accept another tool's opinion.

*Verified by:* PMAP-002/003; `role.test.js`, `role-parity.test.js`,
`signals.test.js`. Known limit: the documented role rules hold against
synthetic fixtures, not yet against every live repo (flagged, deferred).
**Status: real.**

## 3. Detection proposes, config disposes

Zero-config detection produces candidates; explicit config is truth and always
wins; conflicts become diagnostics, never silent overrides.

*Prior divergence:* this is THE conflict platform-map exists to reconcile — DF
chose ecosystem-native zero-config, SE chose explicit opt-in, so the same repo
could be "a monorepo" to one tool and invisible to the other.

*Convergence:* both instincts are layers of one precedence chain
(canonical config > tool adapters > workspace manifests > sibling scan).

*Verified by:* PMAP-004 (partially); `merge.test.js` (promotion gate),
`siblings.test.js`, `parity.test.js`.
**Status: real.**

## 4. Honest about unknowns

Absence means "not determined," never "false." Nothing is silently dropped —
every quiet failure path has an enumerated diagnostic code, including bounded
scans (`CENSUS_TRUNCATED`) and ambiguity (no guessing).

*Prior divergence:* Clarity Audit held this as prompt-level ethos; DF and SE
each dropped some cases silently.

*Convergence:* promoted from ethos to a typed library contract.

*Verified by:* PMAP-004; diagnostic-code tests across the suite
(`map.test.js`, `glob.test.js`, `walk.test.js`, `signals.test.js`).
**Status: real.**

## 5. Deterministic to the byte

Same tree in → byte-identical JSON out. No timestamps, no absolute paths, one
sort seam (`serialize.ts`), no locale-dependent comparisons.

*Prior divergence:* SE had partial discipline (learned the hard way); DF's
discovery was not byte-stable; Clarity Audit's agent output was never
reproducible.

*Verified by:* PMAP-001; double-run and shuffle tests in `canonical.test.js`,
`serialize.test.js`, `parity.test.js`, `adversarial-e2e.test.js`.
**Status: real** — the strongest-tested property in the suite.

## 6. Safe to run anywhere

Read-only core; exactly one writer (`platform-map init`, confirm-gated,
refuse-if-exists); zero runtime dependencies; no network; no git mutation;
bounded I/O; path-traversal and symlink guards; package-name validation.

*Prior divergence:* Clarity Audit explored with unbounded agent judgment; DF
shelled out liberally.

*Verified by:* PMAP-005/006/007/008; `path-guard.test.js`, `walk.test.js`,
`exec.test.js`, `package-name.test.js`, `yaml-subset.test.js`, `cli.test.js`;
dual-runtime CI (Node 20/22 + Bun) and cold-install smoke.
**Status: real.**

## 7. The platform is self-describing on disk

Platform knowledge lives in files, not in meetings or Slack. Progressive
disclosure: a single repo needs only its own `platform-map.json`; a monorepo
the same (opt-in to more); a multi-repo platform gets a small platform repo
holding the **canonical membership definition** (checked in), while **disk
locations stay per-user** (local config, defaulting to the members-as-child-dirs
convention). Each member carries a committed marker (`platform` name + root
hint) so any engineer or agent cloning it knows where it belongs. Running
platform-map anywhere in the platform yields the same map.

*Prior art:* DF's pointer roundtrip (PLATFORM-04) proved the mechanics; SE's
adoption rungs proved the progressive-disclosure shape. platform-map
generalizes both into a tool-neutral form.

*Verified by (target):* PMAP-010/011/012.
**Status: GAP — tracked in RED-97.** What exists instead today: an in-repo
`platform-map.json` (rungs 1–2 work now) and a one-level sibling scan; running
at a platform root does not yet find member children, and members are not yet
self-aware. This pillar is launch-blocking and this paragraph must be updated
when RED-97 lands.

---

## Roadmap honesty

- **Cross-repo dependency edges** (PMAP-013, RED-98): today edges exist only
  inside a single workspace (`via: "workspace-dependency"`); separate repos are
  mapped together but not yet *related* by dependency edges. Deliberately out
  of initial launch scope. What exists instead: per-workspace edges, cycle
  detection, and honest absence — no fabricated cross-repo edges.

## Requirement traceability

| Pillar | Requirements | Status |
|---|---|---|
| 1 One vocabulary | catalog anchor, PMAP-007, PMAP-008 | real |
| 2 Facts, not opinions | PMAP-002, PMAP-003 | real |
| 3 Detection proposes, config disposes | PMAP-004 (gate), merge precedence | real |
| 4 Honest about unknowns | PMAP-004 | real |
| 5 Deterministic to the byte | PMAP-001 | real |
| 6 Safe to run anywhere | PMAP-005, PMAP-006, PMAP-007, PMAP-008 | real |
| 7 Self-describing on disk | PMAP-010, PMAP-011, PMAP-012 | gap → RED-97 |
| (roadmap) Cross-repo edges | PMAP-013 | gap → RED-98 |
