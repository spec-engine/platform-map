// Public entry point for @spec-engine/platform-map.

export { detect } from "./detect.js";
export { MalformedConfigError, RootNotFoundError } from "./errors.js";
export { graph } from "./graph.js";
// serialize/toJSON: deliberate public extension; see README "Determinism".
export { serialize, toJSON } from "./internal/serialize.js";
export { map } from "./map.js";
export { deriveRole } from "./role.js";
// resolvePlatformContext stays internal; consumers get its behavior via map().
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
