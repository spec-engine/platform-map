# Launch Checklist — v0.1.0 go/no-go

**Status: complete.** `0.1.0` published 2026-07-18; `0.2.0` published
2026-07-28 (RED-108, SE-platform discovery mode). Retained as launch history
— see [Ship log](#ship-log) for what each gate actually cost.

Verification state per [REQUIREMENTS.md](./REQUIREMENTS.md): PMAP-001..009
verified; PMAP-010..013 unimplemented and publicly documented as gaps in
[PRINCIPLES.md](./PRINCIPLES.md). Launch messaging must not promise the
unimplemented requirements.

## Code gates (verified in-repo, re-check green at the launch commit)
- [x] `npm run build && npm run lint && npm run typecheck && npm test` green locally
- [x] CI matrix green: Node 20, Node 22, Bun lanes + build job (`attw`, `publint`, `npm publish --dry-run`, executable-bin check) + cold-install smoke
- [x] All-fixtures determinism sweep green (`test/verification.test.js`)

## Operator preconditions (cannot be automated from this repo)
- [x] `spec-engine` npm org scope exists and D. Rea has publish rights
- [x] GitHub repo `spec-engine/platform-map` created; `origin` remote added; `main` pushed
- [x] npm trusted publisher configured on npmjs.com (org/repo/workflow file/environment) — no NPM_TOKEN secret anywhere — *registered 2026-07-28, at v0.2.0*
- [x] Branch protection on `main` (PRs only) once remote exists

## Ship sequence
- [x] Tag `v0.1.0` on the reviewed launch commit; push tag → publish job runs (OIDC, Node 22, npm ≥11.5.1) — *v0.1.0 shipped by hand; the tagged OIDC path was first exercised at v0.2.0*
- [x] Provenance badge visible on the npm package page, linked to the exact run — *v0.2.0 only; v0.1.0 carries no attestation*
- [x] Post-publish: cold `npm i @spec-engine/platform-map` + `npx platform-map --json` in a scratch dir on Node 20 and Bun

## Ship log

### v0.1.0 — 2026-07-18
Published manually. `publishConfig.provenance` was already set, but a
hand-run `npm publish` from a logged-in local shell has no OIDC context, so
no attestation was produced and neither operator gate below was exercised.
The tagged CI path in `.github/workflows/ci.yml` went untested at this
release.

### v0.2.0 — 2026-07-28
First release through the tagged OIDC publish job. Took three attempts;
both failures were one-time operator gates that `0.1.0` had bypassed rather
than satisfied.

1. **`E404` on `PUT`** — trusted publisher not yet registered on npmjs.com.
   npm minted the OIDC token (provenance signing succeeded), found no
   trusted publisher to exchange it against, fell back to the placeholder
   `NODE_AUTH_TOKEN` that `setup-node` writes into `.npmrc`, and the
   registry rejected it. On scoped packages that rejection surfaces as
   `404 — could not be found *or you do not have permission*`, not `401`,
   which makes it read like a missing package.
2. **`E422` provenance mismatch** — `package.json` had no `repository`
   field. npm cross-checks the repository the Sigstore attestation was
   signed against with `repository.url`; absent the field the comparison
   resolves to `""` and the tarball is refused. Fixed in #2.
3. **Green.** Run
   [30321766676](https://github.com/spec-engine/platform-map/actions/runs/30321766676);
   verified against the live registry — `latest` = `0.2.0`, attestation
   present (`slsa.dev/provenance/v1`), cold install exercising CJS
   `require`, ESM `import`, and the `platform-map` bin on both Node and Bun.

**Carry forward.** `repository` in `package.json` is a hard prerequisite for
provenance, not a nicety — any future package published under this scope
needs it before its first tagged run, or it fails the same way. Both failed
attempts left orphan entries in the Sigstore transparency log (signatures
for tarballs that never landed); harmless, but expect them when a publish
fails after the signing step.

## Known-and-accepted at launch (documented, not blockers)
- PMAP-010..012 (platform-root convention, markers) — RED-97; PRINCIPLES.md pillar 7 declares the gap
- PMAP-013 (cross-repo edges) — RED-98; PRINCIPLES.md roadmap section declares it
- BRIEF.md §5 canonical-config example uses `../` unit paths the implementation rejects — fixed as part of RED-97's design (definition file lives at the platform root); BRIEF is a design-history doc, not shipped in the tarball
- CLI exit code 2 black-box unreachable (no error-severity diagnostic ships in v0.1.0)
- Bun CI lane is a smoke subset (bun#5090); no Node↔Bun byte-compare job yet
