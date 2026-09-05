import { readFileSync } from "node:fs";
import { defineConfig } from "tsdown";

// Build-time only: reading package.json via import.meta.url is allowed HERE
// because tsdown.config.ts is never shipped. One decision governs the CLI/library
// RUNTIME — the version is baked into dist/platform-map.mjs as __CLI_VERSION__.
const pkgVersion = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
).version;

export default defineConfig([
  {
    // Library entry — dual ESM+CJS, the only entry that needs the FalseCJS-safe
    // nested import.types/require.types exports shape.
    entry: ["src/index.ts"],
    format: ["esm", "cjs"],
    dts: true,
    publint: { level: "error" },
    attw: { profile: "node16", level: "error" },
    clean: true,
    sourcemap: false, // determinism: no absolute-path leakage into maps
  },
  {
    // CLI entry — ESM-only, never require()'d/import'd by another package (
    // no import.meta.url/__dirname anywhere in the library or this entry). The
    // package version is injected at build time as the bare __CLI_VERSION__
    // identifier so `--version` needs no runtime package.json read.
    entry: ["bin/platform-map.ts"],
    format: ["esm"],
    platform: "node",
    dts: false,
    clean: false,
    define: { __CLI_VERSION__: JSON.stringify(pkgVersion) },
  },
  {
    // Internal test-build seam (SKELETON.md scaffold contract): every
    // src/internal/*.ts primitive is built to dist/internal so test/*.test.js
    // files can import built internals directly, without exposing them via the
    // public `exports` map. The glob already matches serialize.ts from Task 2,
    // so this entry is never empty; later plans add files here with no config
    // change required.
    entry: ["src/internal/*.ts"],
    format: ["esm"],
    dts: false,
    outDir: "dist/internal",
    clean: false,
  },
  {
    // Top-level pure/internal module test-build seam (Phase 2): src/merge.ts
    // and src/signals.ts (and later src/config.ts) emit to dist/*.mjs so
    // test/*.test.js can import the built artifact directly, without appearing
    // in the public `exports` map.
    entry: [
      "src/merge.ts",
      "src/signals.ts",
      "src/config.ts",
      "src/edges.ts",
      "src/graph.ts",
      "src/role.ts",
    ],
    format: ["esm"],
    dts: false,
    outDir: "dist",
    clean: false,
  },
  {
    // Adapter test-build seam (Phase 2): src/adapters/*.ts modules emit to
    // dist/adapters/*.mjs so test/*.test.js can import the built registry/
    // adapters directly, without appearing in the public `exports` map. The
    // src/internal/*.ts glob above does NOT reach this subdirectory, so this
    // entry is required.
    entry: ["src/adapters/*.ts"],
    format: ["esm"],
    dts: false,
    outDir: "dist/adapters",
    clean: false,
  },
]);
