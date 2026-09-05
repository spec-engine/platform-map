// Determinism harness: proves toJSON(pm) is byte-identical
// regardless of the input array ordering, and that the serialized output
// never leaks absolute paths or timestamps. Plain ESM .js importing the
// already-built dist/ — runs unmodified under `node --test` and
// `bun test`.

import assert from "node:assert/strict";
import { test } from "node:test";
import { toJSON } from "../dist/index.mjs";

/** Build a representative PlatformMap literal: >=3 units (one nested
 *  units[]), >=2 edges, >=3 diagnostics spanning all three severities. */
function buildPlatformMap() {
  return {
    name: "acme-platform",
    root: ".",
    mode: "monorepo",
    schemaVersion: 1,
    units: [
      {
        name: "packages/webapp",
        path: "packages/webapp",
        kind: "workspace-package",
        mode: "single-repo",
        ref: null,
        units: [],
        signals: { hasDeployConfig: true, hasStartScript: true },
        role: "app",
        sources: ["pnpm-workspace.yaml"],
      },
      {
        name: "packages/engine",
        path: "packages/engine",
        kind: "workspace-package",
        mode: "single-repo",
        ref: null,
        units: [],
        signals: { hasExports: true, private: false },
        role: "library",
        sources: ["pnpm-workspace.yaml"],
      },
      {
        name: "svc-api",
        path: "svc-api",
        kind: "repo",
        mode: "monorepo",
        ref: "main",
        units: [
          {
            name: "svc-api/packages/shared",
            path: "svc-api/packages/shared",
            kind: "workspace-package",
            mode: "single-repo",
            ref: null,
            units: [],
            signals: { hasExports: true },
            role: "library",
            sources: ["pnpm-workspace.yaml"],
          },
          {
            name: "svc-api/apps/tracker",
            path: "svc-api/apps/tracker",
            kind: "workspace-package",
            mode: "single-repo",
            ref: null,
            units: [],
            signals: { hasStartScript: true },
            role: "app",
            sources: ["pnpm-workspace.yaml"],
          },
        ],
        signals: { hasDockerfile: true },
        role: "unknown",
        sources: ["siblings"],
      },
    ],
    edges: [
      {
        from: "packages/webapp",
        to: "packages/engine",
        via: "workspace-dependency",
      },
      {
        from: "svc-api/apps/tracker",
        to: "svc-api/packages/shared",
        via: "workspace-dependency",
      },
    ],
    diagnostics: [
      {
        code: "UNMATCHED_PATTERN",
        severity: "warning",
        path: "packages/*-unused",
        message: "UNMATCHED_PATTERN: pattern matched nothing",
      },
      {
        code: "UNIT_PATH_ESCAPE",
        severity: "error",
        path: "../outside-root",
        message: "UNIT_PATH_ESCAPE: resolved path escapes platform root",
      },
      {
        code: "CENSUS_TRUNCATED",
        severity: "info",
        path: "svc-api",
        message: "CENSUS_TRUNCATED: file census hit its entry cap",
      },
      {
        code: "CONFIG_CONFLICT",
        severity: "error",
        path: "svc-api",
        message: "CONFIG_CONFLICT: two sources disagree",
      },
    ],
  };
}

/** Fisher-Yates shuffle, seeded so the test is reproducible. */
function shuffle(arr, seed) {
  const a = arr.slice();
  let s = seed;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Produce a reordered (reversed AND shuffled) copy of a PlatformMap:
 *  top-level units/edges/diagnostics reversed+shuffled, and nested units[]
 *  reversed too — proving no un-sorted intermediate step exists three
 *  functions upstream of serialize.ts (Pitfall 3). */
function reorder(pm) {
  return {
    ...pm,
    units: shuffle(pm.units.slice().reverse(), 7).map((u) => ({
      ...u,
      units: u.units.slice().reverse(),
    })),
    edges: shuffle(pm.edges.slice().reverse(), 13),
    diagnostics: shuffle(pm.diagnostics.slice().reverse(), 21),
  };
}

test("toJSON is byte-identical for shuffled/reversed input", () => {
  const original = buildPlatformMap();
  const reordered = reorder(original);

  // Sanity check the fixtures actually differ in input order, so this test
  // can't pass by coincidence.
  assert.notDeepEqual(
    original.diagnostics.map((d) => d.code),
    reordered.diagnostics.map((d) => d.code),
  );

  const a = toJSON(original);
  const b = toJSON(reordered);
  assert.equal(
    a,
    b,
    "byte-identical toJSON output required regardless of input order",
  );
});

test("serialized output contains no absolute filesystem paths", () => {
  const json = toJSON(buildPlatformMap());
  assert.doesNotMatch(
    json,
    /"\/[^"]*"/,
    "must not contain a leading-slash absolute path",
  );
  assert.doesNotMatch(json, /C:\\/, "must not contain a Windows absolute path");
  assert.doesNotMatch(json, /\/Users\//, "must not contain a /Users/ path");
});

test("serialized output contains no ISO-8601 timestamps", () => {
  const json = toJSON(buildPlatformMap());
  assert.doesNotMatch(
    json,
    /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
    "must not contain an ISO-8601 timestamp",
  );
});

test("diagnostics are ordered error > warning > info, then code, then path", () => {
  const json = toJSON(buildPlatformMap());
  const parsed = JSON.parse(json);
  const severities = parsed.diagnostics.map((d) => d.severity);
  assert.deepEqual(severities, ["error", "error", "warning", "info"]);
  // Both errors: CONFIG_CONFLICT and UNIT_PATH_ESCAPE, sorted by code.
  assert.deepEqual(
    parsed.diagnostics.slice(0, 2).map((d) => d.code),
    ["CONFIG_CONFLICT", "UNIT_PATH_ESCAPE"],
  );
});

test("Unit.sources and UnitSignals.languages are sorted defensively", () => {
  const pm = buildPlatformMap();
  pm.units[0].sources = ["spec-engine.member.json", "df-config.json"];
  pm.units[0].signals = {
    ...pm.units[0].signals,
    languages: ["ts", "py", "js"],
  };

  const json = toJSON(pm);
  const parsed = JSON.parse(json);
  const webapp = parsed.units.find((u) => u.name === "packages/webapp");
  assert.deepEqual(webapp.sources, [
    "df-config.json",
    "spec-engine.member.json",
  ]);
  assert.deepEqual(webapp.signals.languages, ["js", "py", "ts"]);
});

test("nested units[] are sorted recursively by name", () => {
  const json = toJSON(buildPlatformMap());
  const parsed = JSON.parse(json);
  const topNames = parsed.units.map((u) => u.name);
  assert.deepEqual(topNames, ["packages/engine", "packages/webapp", "svc-api"]);
  const svcApi = parsed.units.find((u) => u.name === "svc-api");
  const nestedNames = svcApi.units.map((u) => u.name);
  assert.deepEqual(nestedNames, [
    "svc-api/apps/tracker",
    "svc-api/packages/shared",
  ]);
});
