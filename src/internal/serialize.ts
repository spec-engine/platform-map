// The single sort/stringify seam: serialize.ts is the SOLE sort site in the
// library. Every other producer is expected to emit pre-sorted output already;
// serialize() re-sorts defensively so the contract holds regardless, and
// toJSON() is the only place JSON key order is decided. Same tree in,
// byte-identical JSON out: sorted units/edges/diagnostics (nested units[]
// recursively), fixed key order per object type. Every comparison uses plain
// `<`/`>` on strings/numbers, never a locale-aware method: locale/ICU sort
// order is not guaranteed stable across Node versions/ICU data. No timestamps
// or absolute paths; callers enforce that (this module has no filesystem
// access).

import type {
  Diagnostic,
  Edge,
  PlatformMap,
  Unit,
  UnitSignals,
} from "../types.js";

function compare(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function compareUnits(a: Unit, b: Unit): number {
  return compare(a.name, b.name);
}

function compareEdges(a: Edge, b: Edge): number {
  const byFrom = compare(a.from, b.from);
  if (byFrom !== 0) return byFrom;
  return compare(a.to, b.to);
}

const SEVERITY_RANK: Record<Diagnostic["severity"], number> = {
  error: 0,
  warning: 1,
  info: 2,
};

function compareDiagnostics(a: Diagnostic, b: Diagnostic): number {
  const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
  if (bySeverity !== 0) return bySeverity;
  const byCode = compare(a.code, b.code);
  if (byCode !== 0) return byCode;
  // path undefined sorts last
  if (a.path === undefined && b.path === undefined) return 0;
  if (a.path === undefined) return 1;
  if (b.path === undefined) return -1;
  return compare(a.path, b.path);
}

function sortUnit(unit: Unit): Unit {
  return {
    ...unit,
    units: unit.units.map(sortUnit).sort(compareUnits),
  };
}

/**
 * Returns a NEW PlatformMap with units (recursively), edges, and diagnostics
 * sorted into the canonical order, regardless of upstream ordering. Does not
 * mutate its input.
 */
export function serialize(pm: PlatformMap): PlatformMap {
  return {
    ...pm,
    units: pm.units.map(sortUnit).sort(compareUnits),
    edges: pm.edges.slice().sort(compareEdges),
    diagnostics: pm.diagnostics.slice().sort(compareDiagnostics),
  };
}

function orderedSignals(signals: UnitSignals): Record<string, unknown> {
  return {
    private: signals.private,
    hasExports: signals.hasExports,
    hasBin: signals.hasBin,
    hasStartScript: signals.hasStartScript,
    packageName: signals.packageName,
    hasDockerfile: signals.hasDockerfile,
    hasDeployConfig: signals.hasDeployConfig,
    // Defensively re-sorted: a producer could derive this from Set iteration
    // order or similar non-deterministic sources.
    languages: signals.languages
      ? [...signals.languages].sort(compare)
      : signals.languages,
    packageManager: signals.packageManager,
    workspaceInDegree: signals.workspaceInDegree,
    workspaceOutDegree: signals.workspaceOutDegree,
    hasDfPointer: signals.hasDfPointer,
    dfConfigConflict: signals.dfConfigConflict,
    hasSpecEngineConfig: signals.hasSpecEngineConfig,
  };
}

function orderedUnit(unit: Unit): Record<string, unknown> {
  return {
    name: unit.name,
    path: unit.path,
    kind: unit.kind,
    mode: unit.mode,
    ref: unit.ref,
    units: unit.units.map(orderedUnit),
    signals: orderedSignals(unit.signals),
    role: unit.role,
    // Defensively re-sorted, like `languages` above.
    sources: [...unit.sources].sort(compare),
  };
}

function orderedEdge(edge: Edge): Record<string, unknown> {
  return {
    from: edge.from,
    to: edge.to,
    via: edge.via,
  };
}

function orderedDiagnostic(diagnostic: Diagnostic): Record<string, unknown> {
  return {
    code: diagnostic.code,
    severity: diagnostic.severity,
    path: diagnostic.path,
    message: diagnostic.message,
  };
}

function orderedPlatformMap(pm: PlatformMap): Record<string, unknown> {
  return {
    name: pm.name,
    root: pm.root,
    mode: pm.mode,
    units: pm.units.map(orderedUnit),
    edges: pm.edges.map(orderedEdge),
    diagnostics: pm.diagnostics.map(orderedDiagnostic),
    schemaVersion: pm.schemaVersion,
  };
}

/**
 * Serializes a PlatformMap to a deterministic JSON string: sorted arrays
 * (recursively for nested units), fixed key order per object type, 2-space
 * indent. The same logical map, regardless of input array ordering, MUST
 * produce the identical string.
 */
export function toJSON(pm: PlatformMap): string {
  const sorted = serialize(pm);
  return JSON.stringify(orderedPlatformMap(sorted), null, 2);
}
