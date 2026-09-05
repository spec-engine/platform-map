// PMAP-009 gap test: the MIXED platform shape — a plain single-repo
// sibling and a monorepo sibling promoted together in one map. Every other
// topology row (single, monorepo flavors, multi-repo, multi-repo-of-monorepos)
// already has end-to-end coverage; this file closes the last row of the
// PMAP-009 topology table.
//
// Plain ESM .js importing the already-built dist/ — runs unmodified
// under `node --test`. NEVER src/, NEVER .ts (Node 20 has no TS
// stripping and tsdown can't run on Node 20).

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { map } from "../dist/index.mjs";
import { toJSON } from "../dist/internal/serialize.mjs";

// NOTE (Pitfall 3): dist/internal/serialize.mjs is imported here only because
// the node:test lane runs against the full dist/. It is NOT shipped in the
// tarball — the cold-install smoke exercises the public exports only.

test("map() maps a mixed platform (plain single-repo sibling + monorepo sibling) in one pass (PMAP-009)", async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "platform-map-mixed-"));
  try {
    // plain-svc: a single-repo sibling with a start script and a dependency on
    // the monorepo sibling's internal package (deliberate — see edge assertion).
    const plainSvc = path.join(parent, "plain-svc");
    fs.mkdirSync(path.join(plainSvc, ".git"), { recursive: true });
    fs.writeFileSync(
      path.join(plainSvc, "package.json"),
      JSON.stringify({
        name: "plain-svc",
        scripts: { start: "node ." },
        dependencies: { "@mono/core": "^1.0.0" },
      }),
    );

    // mono-lib: a pnpm-workspace monorepo sibling with a lib + start-scripted app.
    const monoLib = path.join(parent, "mono-lib");
    fs.mkdirSync(path.join(monoLib, ".git"), { recursive: true });
    fs.writeFileSync(
      path.join(monoLib, "pnpm-workspace.yaml"),
      "packages:\n  - 'packages/*'\n",
    );
    const coreDir = path.join(monoLib, "packages", "core");
    fs.mkdirSync(coreDir, { recursive: true });
    fs.writeFileSync(
      path.join(coreDir, "package.json"),
      JSON.stringify({
        name: "@mono/core",
        private: true,
        exports: { ".": "./index.js" },
      }),
    );
    const appDir = path.join(monoLib, "packages", "app");
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(
      path.join(appDir, "package.json"),
      JSON.stringify({
        name: "@mono/app",
        dependencies: { "@mono/core": "workspace:*" },
        scripts: { start: "node ." },
      }),
    );

    // workdir: a plain non-repo dir map() is pointed at, so both siblings are
    // discovered via the sibling scan.
    const workdir = path.join(parent, "workdir");
    fs.mkdirSync(workdir);

    const pm = await map(workdir);

    // Mixed shape: both siblings promoted into one multi-repo map.
    assert.equal(pm.mode, "multi-repo");
    const repos = pm.units.filter((u) => u.kind === "repo");
    assert.deepEqual(repos.map((u) => u.name).sort(), [
      "mono-lib",
      "plain-svc",
    ]);

    // The monorepo sibling: kind:repo, mode:monorepo, workspace children expanded.
    const mono = repos.find((u) => u.name === "mono-lib");
    assert.equal(mono.kind, "repo");
    assert.equal(mono.mode, "monorepo");
    assert.deepEqual(
      mono.units.map((u) => u.name),
      ["mono-lib/packages/app", "mono-lib/packages/core"],
    );
    for (const child of mono.units) {
      assert.equal(child.kind, "workspace-package");
    }

    // The plain single-repo sibling: kind:repo, mode:single-repo, no children.
    const plain = repos.find((u) => u.name === "plain-svc");
    assert.equal(plain.kind, "repo");
    assert.equal(plain.mode, "single-repo");
    assert.deepEqual(plain.units, []);

    // Both siblings were discovered via the sibling scan.
    for (const sib of repos) {
      assert.ok(sib.sources.includes("siblings"));
    }

    // Roles: the depended-on lib is a library; the start-scripted units are
    // apps (deriveRole rule 1).
    const roleByName = {};
    for (const child of mono.units) roleByName[child.name] = child.role;
    assert.equal(roleByName["mono-lib/packages/core"], "library");
    assert.equal(roleByName["mono-lib/packages/app"], "app");
    assert.equal(plain.role, "app");

    // Edges: EXACTLY the one workspace edge inside mono-lib. This
    // simultaneously proves the workspace edge AND pins that plain-svc's
    // dependency on @mono/core creates NO cross-repo edge — edges are
    // deliberately scoped per sibling set in v0.1.0. PMAP-013 must
    // consciously break this assertion when cross-repo edges land.
    assert.deepEqual(pm.edges, [
      {
        from: "mono-lib/packages/app",
        to: "mono-lib/packages/core",
        via: "workspace-dependency",
      },
    ]);

    // byte-identical across two invocations of the same temp tree.
    assert.equal(toJSON(await map(workdir)), toJSON(await map(workdir)));
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});
