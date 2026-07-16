# Launch Checklist — v0.1.0 go/no-go

Verification state per [REQUIREMENTS.md](./REQUIREMENTS.md): PMAP-001..009
verified; PMAP-010..013 unimplemented and publicly documented as gaps in
[PRINCIPLES.md](./PRINCIPLES.md). Launch messaging must not promise the
unimplemented requirements.

## Code gates (verified in-repo, re-check green at the launch commit)
- [ ] `npm run build && npm run lint && npm run typecheck && npm test` green locally
- [ ] CI matrix green: Node 20, Node 22, Bun lanes + build job (`attw`, `publint`, `npm publish --dry-run`, executable-bin check) + cold-install smoke
- [ ] All-fixtures determinism sweep green (`test/verification.test.js`)

## Operator preconditions (cannot be automated from this repo)
- [ ] `spec-engine` npm org scope exists and D. Rea has publish rights
- [ ] GitHub repo `spec-engine/platform-map` created; `origin` remote added; `main` pushed
- [ ] npm trusted publisher configured on npmjs.com (org/repo/workflow file/environment) — no NPM_TOKEN secret anywhere
- [ ] Branch protection on `main` (PRs only) once remote exists

## Ship sequence
- [ ] Tag `v0.1.0` on the reviewed launch commit; push tag → publish job runs (OIDC, Node 22, npm ≥11.5.1)
- [ ] Provenance badge visible on the npm package page, linked to the exact run
- [ ] Post-publish: cold `npm i @spec-engine/platform-map` + `npx platform-map --json` in a scratch dir on Node 20 and Bun

## Known-and-accepted at launch (documented, not blockers)
- PMAP-010..012 (platform-root convention, markers) — RED-97; PRINCIPLES.md pillar 7 declares the gap
- PMAP-013 (cross-repo edges) — RED-98; PRINCIPLES.md roadmap section declares it
- BRIEF.md §5 canonical-config example uses `../` unit paths the implementation rejects — fixed as part of RED-97's design (definition file lives at the platform root); BRIEF is a design-history doc, not shipped in the tarball
- CLI exit code 2 black-box unreachable (no error-severity diagnostic ships in v0.1.0)
- Bun CI lane is a smoke subset (bun#5090); no Node↔Bun byte-compare job yet
