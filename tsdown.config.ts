import { readFileSync } from "node:fs";
import { defineConfig } from "tsdown";

const pkgVersion = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
).version;

export default defineConfig([
  {
    // Library: ESM + CJS with per-format type declarations.
    entry: ["src/index.ts"],
    format: ["esm", "cjs"],
    dts: true,
    publint: { level: "error" },
    attw: { profile: "node16", level: "error" },
    clean: true,
    sourcemap: false, // no absolute paths in shipped files
  },
  {
    // CLI: ESM only. The version is baked in so it never reads package.json at runtime.
    entry: ["bin/platform-map.ts"],
    format: ["esm"],
    platform: "node",
    dts: false,
    clean: false,
    define: { __CLI_VERSION__: JSON.stringify(pkgVersion) },
  },
]);
