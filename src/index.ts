// Public entry point for @spec-engine/platform-map.
// Re-exports the full public type contract, the deterministic serializer,
// and detect(). `map`/`graph`/`deriveRole` land in later phases.

export { detect } from "./detect.js";
export { MalformedConfigError, RootNotFoundError } from "./errors.js";
// toJSON/serialize are an intentional additive public extension beyond
// DESIGN.md's original §4 function list — see README's "Determinism" section.
// They give the dual ESM+CJS build a real runtime export to validate (not
// just types), and are the single sort/stringify seam every consumer can rely
// on for byte-identical output.
export { serialize, toJSON } from "./internal/serialize.js";
export { map } from "./map.js";
export type {
  AdapterName,
  Detection,
  DetectOptions,
  Diagnostic,
  Edge,
  MapOptions,
  Mode,
  PlatformMap,
  PlatformMapConfig,
  Role,
  Unit,
  UnitSignals,
} from "./types.js";
