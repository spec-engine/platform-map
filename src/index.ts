// Public entry point for @spec-engine/platform-map.

export { detect } from "./detect.ts";
export { discover } from "./discover.ts";
export { DirectoryNotFoundError } from "./errors.ts";
export { applyInit, planInit } from "./init.ts";
export { applyLink, planLink } from "./link.ts";
export { check, locate, map } from "./map.ts";
export { formatDiagnostics, render, toJSON, toMermaid } from "./render.ts";
export type {
  Candidate,
  Detection,
  Diagnostic,
  DiagnosticCode,
  EcosystemName,
  InitPlan,
  LeafMarker,
  LinkPlan,
  Locations,
  Mode,
  Options,
  Package,
  PackageManager,
  PlatformFile,
  PlatformMap,
  Repo,
  UserConfig,
  WorkspaceManifest,
  WriteResult,
} from "./types.ts";
