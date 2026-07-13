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
]);
