// Public entry point for @spec-engine/platform-map.
// Re-exports the full public type contract, the deterministic serializer,
// detect(), map(), graph(), and deriveRole() (the standalone, replayable role
// classifier — MODEL-03).

export { detect } from "./detect.js";
export { MalformedConfigError, RootNotFoundError } from "./errors.js";
export { graph } from "./graph.js";
// toJSON/serialize are an intentional additive public extension beyond
// DESIGN.md's original §4 function list — see README's "Determinism" section.
// They give the dual ESM+CJS build a real runtime export to validate (not
// just types), and are the single sort/stringify seam every consumer can rely
// on for byte-identical output.
export { serialize, toJSON } from "./internal/serialize.js";
export { map } from "./map.js";
export { deriveRole } from "./role.js";
// RED-97: PlatformDefinition/MemberMarker/PlatformLocalConfig are public types
// (these types ARE the API); resolvePlatformContext stays internal — consumers
// get the behavior via map(), tests reach dist/internal/ like serialize does.
export type {
  AdapterName,
  Detection,
  DetectOptions,
  Diagnostic,
  Edge,
  MapOptions,
  MemberMarker,
  Mode,
  PlatformDefinition,
  PlatformGraph,
  PlatformLocalConfig,
  PlatformMap,
  PlatformMapConfig,
  Role,
  Unit,
  UnitSignals,
} from "./types.js";
