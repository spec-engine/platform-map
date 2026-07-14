import { defineConfig } from "tsdown";

export default defineConfig([
  {
    // Library entry — dual ESM+CJS, the only entry that needs the FalseCJS-safe
    // nested import.types/require.types exports shape (D-03).
    entry: ["src/index.ts"],
    format: ["esm", "cjs"],
    dts: true,
    publint: { level: "error" },
    attw: { profile: "node16", level: "error" },
    clean: true,
    sourcemap: false, // determinism: no absolute-path leakage into maps
  },
  {
    // CLI stub — ESM-only, never require()'d/import'd by another package (D-04:
    // no import.meta.url/__dirname anywhere in the library or this entry).
    // Fully implemented in Phase 4; Phase 1 ships a minimal stub.
    entry: ["bin/platform-map.ts"],
    format: ["esm"],
    platform: "node",
    dts: false,
    clean: false,
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
    // in the public `exports` map (02-RESEARCH.md build-config task).
    entry: [
      "src/merge.ts",
      "src/signals.ts",
      "src/config.ts",
      "src/edges.ts",
      "src/graph.ts",
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
    // entry is required (02-RESEARCH.md build-config task).
    entry: ["src/adapters/*.ts"],
    format: ["esm"],
    dts: false,
    outDir: "dist/adapters",
    clean: false,
  },
]);
