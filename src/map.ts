// map(): the full-assembly orchestrator: detect -> adapters -> merge ->
// per-unit signal census (+ nested monorepo expansion) -> edges -> degrees ->
// cycles -> roles -> serialize.
// SEC-01 throw contract: only RootNotFoundError (nonexistent root) and
// MalformedConfigError (present-but-broken platform-map.json) ever escape
// map(); every other failure degrades to a diagnostic.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  Adapter,
  AdapterContext,
  AdapterResult,
  CanonicalSideChannel,
  PartialUnit,
} from "./adapters/index.js";
import { PRECEDENCE, selectAdapters } from "./adapters/index.js";
import { MEMBER_CONFIG, specEnginePlatform } from "./adapters/spec-engine.js";
import { workspaceAdapter } from "./adapters/workspace.js";
import { readLocalConfig, readPlatformFile } from "./config.js";
import { detect } from "./detect.js";
import { buildEdges, populateDegrees } from "./edges.js";
import { MalformedConfigError, RootNotFoundError } from "./errors.js";
import { matchGlob } from "./internal/glob.js";
import { resolveWithinRoot } from "./internal/path-guard.js";
import {
  isPhysicallyInsideBoundary,
  resolvePlatformContext,
  sniffPlatformFile,
} from "./internal/platform-root.js";
import { probeRef } from "./internal/ref-probe.js";
import { looksLikeRepoRoot, scanSiblings } from "./internal/scan.js";
import { canonicalCycles } from "./internal/scc.js";
import { serialize } from "./internal/serialize.js";
import {
  claim,
  enforceUniqueUnitNames,
  joinLocation,
  nameCollisionDiagnostic,
  type UnitNameRegistry,
} from "./internal/unique-names.js";
import { merge } from "./merge.js";
import { applyRoles } from "./role.js";
import { censusSignals } from "./signals.js";
import type {
  AdapterName,
  Diagnostic,
  Edge,
  MapOptions,
  PlatformDefinition,
  PlatformMap,
  Unit,
  UnitSignals,
} from "./types.js";

// Bounds nested-monorepo expansion so deep trees can never blow the stack.
const MAX_MONOREPO_RECURSION_DEPTH = 8;

function malformedConfigDiagnostic(
  source: AdapterName,
  error: unknown,
): Diagnostic {
  const reason = error instanceof Error ? error.message : String(error);
  return {
    code: "MALFORMED_CONFIG",
    severity: "warning",
    path: source,
    message: `MALFORMED_CONFIG: ${source} adapter failed: ${reason}`,
  };
}

/** An unexpected throw from the census / monorepo recursion degrades to a
 *  MALFORMED_CONFIG diagnostic; `path` is the name of the unit whose
 *  enrichment failed. */
function censusFailureDiagnostic(unitName: string, error: unknown): Diagnostic {
  const reason = error instanceof Error ? error.message : String(error);
  return {
    code: "MALFORMED_CONFIG",
    severity: "warning",
    path: unitName,
    message: `MALFORMED_CONFIG: signal census failed for unit "${unitName}": ${reason}`,
  };
}

/** An `overrides` key matching no assembled unit: warn and ignore, never throw. */
function staleOverrideDiagnostic(unitName: string): Diagnostic {
  return {
    code: "MALFORMED_CONFIG",
    severity: "warning",
    path: unitName,
    message: `MALFORMED_CONFIG: overrides names unit "${unitName}" which does not exist — override ignored`,
  };
}

function collectUnitNames(units: Unit[], into: Set<string>): void {
  for (const u of units) {
    into.add(u.name);
    if (u.units.length > 0) collectUnitNames(u.units, into);
  }
}

/** Workspace-package names at all depths: the cycle-detection node set. */
function collectWorkspacePackageNames(units: Unit[], into: string[]): void {
  for (const u of units) {
    if (u.kind === "workspace-package") into.push(u.name);
    if (u.units.length > 0) collectWorkspacePackageNames(u.units, into);
  }
}

/** "warning", not "error" (which would trip the CLI exit-code-2 path); path
 *  is the lexically-smallest cycle member. Mapping still succeeds. */
function cycleSuspectedDiagnostic(cycle: string[]): Diagnostic {
  return {
    code: "CYCLE_SUSPECTED",
    severity: "warning",
    path: cycle[0],
    message: `CYCLE_SUSPECTED: workspace dependency cycle among ${cycle.join(", ")}`,
  };
}

// Platform drift diagnostics: stable message prefixes per sub-case, member
// names and root-relative paths only, never machine/absolute paths.

function danglingOverrideDiagnostic(memberName: string): Diagnostic {
  return {
    code: "PLATFORM_DRIFT",
    severity: "warning",
    path: "platform-map.local.json",
    message: `PLATFORM_DRIFT: dangling local override: platform-map.local.json names "${memberName}" which is not a listed member`,
  };
}

/** Carries the member NAME only: the override value may be an absolute
 *  machine path and must never appear in output. */
function overrideEscapeDiagnostic(memberName: string): Diagnostic {
  return {
    code: "UNIT_PATH_ESCAPE",
    severity: "warning",
    path: memberName,
    message: `UNIT_PATH_ESCAPE: local location override for member "${memberName}" escapes resolution boundary`,
  };
}

function missingMemberDiagnostic(
  memberName: string,
  conventionalPath: string,
): Diagnostic {
  return {
    code: "PLATFORM_DRIFT",
    severity: "warning",
    path: conventionalPath,
    message: `PLATFORM_DRIFT: listed member missing: "${memberName}" not found at "${conventionalPath}"`,
  };
}

function markerNameMismatchDiagnostic(
  memberName: string,
  conventionalPath: string,
  found: string,
  expected: string,
): Diagnostic {
  return {
    code: "PLATFORM_DRIFT",
    severity: "warning",
    path: conventionalPath,
    message: `PLATFORM_DRIFT: marker platform-name mismatch: member "${memberName}" marker names "${found}" but the definition names "${expected}"`,
  };
}

function markerRootHintMismatchDiagnostic(
  memberName: string,
  conventionalPath: string,
  hint: string,
): Diagnostic {
  return {
    code: "PLATFORM_DRIFT",
    severity: "warning",
    path: conventionalPath,
    message: `PLATFORM_DRIFT: marker root-hint mismatch: member "${memberName}" root hint "${hint}" does not resolve to the platform root`,
  };
}

/** A platform-root child dir that is neither a git repo nor a listed member
 *  is surfaced (info), never silent. */
function nonRepoChildDiagnostic(entryName: string): Diagnostic {
  return {
    code: "PLATFORM_DRIFT",
    severity: "info",
    path: entryName,
    message: `PLATFORM_DRIFT: non-repo child: "${entryName}" at the platform root is neither a git repo nor a listed member`,
  };
}

function driftCheckFailureDiagnostic(error: unknown): Diagnostic {
  const reason = error instanceof Error ? error.message : String(error);
  return {
    code: "MALFORMED_CONFIG",
    severity: "warning",
    path: "platform-map.json",
    message: `MALFORMED_CONFIG: platform drift check failed: ${reason}`,
  };
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Gap-fills census facts onto a unit's signals without overwriting any key
 *  an adapter already claimed (adapter linkage signals win on collision). */
function applyCensusSignals(unit: Unit, census: UnitSignals): void {
  const target = unit.signals as unknown as Record<string, unknown>;
  const source = census as unknown as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    if (target[key] === undefined) target[key] = source[key];
  }
}

/** Enriches a resolved unit in place: signal census, then, for any unit that
 *  is itself a monorepo (workspace-package or promoted kind:"repo"), expands
 *  children via the workspace adapter ONLY (the root-level adapters would
 *  fabricate phantom sub-units) and sets mode:"monorepo". Depth-bounded.
 *  A qualified child whose name is already registered is never attached:
 *  a same-location twin (e.g. an SE sub-member re-found by the workspace
 *  expansion) is dropped silently, a different-location collision is dropped
 *  with CONFIG_CONFLICT. `platformPath` is this unit's platform-relative
 *  location, the base the children's registry locations are joined under. */
function enrichUnit(
  root: string,
  unit: Unit,
  depth: number,
  diagnostics: Diagnostic[],
  depSideTable: Map<string, string[]>,
  registry: UnitNameRegistry,
  platformPath: string,
  absDirOverride?: string,
): void {
  // A local override changes WHERE the member is read from, never unit.path
  // in output; recursion stays conventional under the overridden parent dir.
  const absDir = absDirOverride ?? path.join(root, unit.path);

  const census = censusSignals(absDir, unit.name);
  applyCensusSignals(unit, census.signals);
  for (const d of census.diagnostics) diagnostics.push(d);

  // Stash raw workspace dep names (all depths) for buildEdges; deps never
  // enter the public model.
  depSideTable.set(unit.name, census.workspaceDepNames);

  if (depth >= MAX_MONOREPO_RECURSION_DEPTH) return;

  // detect() on the child can only throw RootNotFoundError (the dir always
  // exists here); guard anyway so recursion never throws.
  let childDetection: ReturnType<typeof detect>;
  try {
    childDetection = detect(absDir);
  } catch {
    return;
  }
  if (childDetection.mode !== "monorepo") return;

  unit.mode = "monorepo";
  const childResult = workspaceAdapter(absDir, {
    detection: childDetection,
    ignore: [],
    options: {},
  });
  for (const d of childResult.diagnostics) diagnostics.push(d);

  const childMerged = merge(
    [{ source: "workspace", result: childResult }],
    false,
  );
  for (const d of childMerged.diagnostics) diagnostics.push(d);

  const kept: Unit[] = [];
  for (const child of childMerged.units) {
    child.name = `${unit.name}/${child.name}`;
    const childLocation = joinLocation(platformPath, child.path);
    const outcome = claim(registry, child.name, childLocation);
    // A same-location twin is dropped WITHOUT recursing: the first-precedence
    // unit already owns the identity and its census, and recursing would
    // overwrite its depSideTable entry.
    if (outcome === "duplicate-same-location") continue;
    if (outcome === "duplicate-different-location") {
      diagnostics.push(
        nameCollisionDiagnostic(
          child.name,
          registry.get(child.name) as string,
          childLocation,
        ),
      );
      continue;
    }
    enrichUnit(
      absDir,
      child,
      depth + 1,
      diagnostics,
      depSideTable,
      registry,
      childLocation,
    );
    kept.push(child);
  }
  unit.units = kept;
}

/** Maps a directory tree into a deterministic PlatformMap: detect() (the
 *  only nonexistent-root throw), enabled adapters + caller-injected units
 *  folded in precedence order through merge(), per-unit signal census,
 *  nested-monorepo expansion, and serialize() for byte-identical output. */
export async function map(
  root: string,
  opts: MapOptions = {},
): Promise<PlatformMap> {
  const canonicalEnabled = opts.adapters?.canonical !== false;

  const extraDiagnostics: Diagnostic[] = [];

  // Platform resolution (a bounded upward walk) runs BEFORE detect() so an
  // adapter can never re-anchor the map root; gated on the canonical toggle
  // (disabled => never read platform-map.json) and on the root existing (a
  // nonexistent root must still reach detect()'s throw).
  const boundary = opts.boundary ?? os.homedir();
  let effectiveRoot = root;
  let definition: PlatformDefinition | null = null;
  if (canonicalEnabled && fs.existsSync(root)) {
    const resolution = resolvePlatformContext(root, boundary);
    for (const d of resolution.diagnostics) extraDiagnostics.push(d);
    if (resolution.root !== null && resolution.definition !== undefined) {
      definition = resolution.definition;
      // Re-anchor ONLY when the resolved root differs; this is what makes
      // map()-from-inside byte-identical to map()-at-root.
      if (path.resolve(root) !== resolution.root) {
        effectiveRoot = resolution.root;
      }
    }
  }

  // SEC-01 hard-error #2: a PRESENT-but-malformed platform-map.json throws
  // MalformedConfigError before detection/adapters run. The pre-read lets the
  // config's `ignore` thread into detect()'s sibling scan; the canonical
  // adapter's later re-read always agrees (same process, no writes).
  const preFile =
    canonicalEnabled && definition === null
      ? readPlatformFile(effectiveRoot)
      : null;
  if (preFile !== null && preFile.kind === "definition") {
    // A definition AT the invoked root is ALWAYS honored: the boundary
    // governs only the upward walk and marker/local-override follow-targets,
    // so a platform checked out outside $HOME gets full definition semantics.
    definition = preFile.definition;
  }
  const preConfig =
    preFile !== null && (preFile.kind === "config" || preFile.kind === "marker")
      ? preFile.config
      : null;
  const effectiveIgnore = [
    ...(opts.ignore ?? []),
    ...(definition !== null
      ? (definition.ignore ?? [])
      : (preConfig?.ignore ?? [])),
  ];

  // SE-platform discovery: a canonical `spec-engine/` dir with NO
  // platform-map.json at the root is a platform by Spec Engine's own
  // declaration; the per-child SE adapter variant runs, the sibling scan runs
  // at ".", and per-child member configs confirm promotion. No upward walk.
  const sePlatform =
    opts.adapters?.["spec-engine"] !== false &&
    definition === null &&
    preConfig === null &&
    isDirectory(path.join(effectiveRoot, "spec-engine"));

  // detect() throws RootNotFoundError for a nonexistent root before any
  // adapter runs. With a definition (or SE platform) scanRoot is forced to
  // "." so the root's own children become detection.siblings.
  const detection = detect(effectiveRoot, {
    scanRoot: definition !== null || sePlatform ? "." : opts.scanRoot,
    ignore: effectiveIgnore,
  });

  // Listed members are declared IDENTITIES, not sibling candidates: dropping
  // them keeps output byte-identical with and without a local override. The
  // array is ALWAYS materialized so the siblings adapter never parent-scans.
  if (definition !== null) {
    const memberPaths = new Set(
      definition.members.map((m) => m.path ?? m.name),
    );
    detection.siblings = (detection.siblings ?? []).filter(
      (s) => !memberPaths.has(s.path),
    );
  }

  // SE mode re-scans with the widened candidate gate (.git dir-or-file OR
  // package.json); config-carrying children are confirmed members, dropped
  // like listed members above. Always materialized; scan diagnostics dropped.
  if (sePlatform) {
    const { siblings } = scanSiblings(
      effectiveRoot,
      ".",
      effectiveIgnore,
      undefined,
      looksLikeRepoRoot,
    );
    detection.siblings = siblings.filter(
      (s) =>
        s.name !== "spec-engine" &&
        !fs.existsSync(path.join(effectiveRoot, s.path, MEMBER_CONFIG)),
    );
  }

  const ctx: AdapterContext = {
    detection,
    ignore: effectiveIgnore,
    options: opts,
  };

  const selected = selectAdapters(opts);
  const adapterByName = new Map<AdapterName, Adapter>(
    selected.map((s): [AdapterName, Adapter] => [s.source, s.adapter]),
  );
  // The registry never selects the per-child variant; same precedence rank.
  if (sePlatform) {
    adapterByName.set("spec-engine", specEnginePlatform);
  }

  const results: Array<{
    source: AdapterName | "caller";
    result: AdapterResult;
  }> = [];

  for (const name of PRECEDENCE) {
    if (name === "caller") {
      if (opts.units && opts.units.length > 0) {
        const partialUnits: PartialUnit[] = [];
        for (const u of opts.units) {
          // A path escaping root is dropped and diagnosed, never followed.
          const guard = resolveWithinRoot(effectiveRoot, u.path);
          if (!guard.ok) {
            extraDiagnostics.push(guard.diagnostic);
            continue;
          }
          partialUnits.push({
            name: u.name,
            path: guard.relative,
            kind: "repo",
            source: "caller",
            ref: u.ref,
          });
        }
        results.push({
          source: "caller",
          result: { partialUnits, edges: [], diagnostics: [] },
        });
      }
      continue;
    }

    const adapter = adapterByName.get(name);
    if (adapter === undefined) continue;
    try {
      // Adapters may be sync or async; await handles both.
      const result = await adapter(effectiveRoot, ctx);
      results.push({ source: name, result });
    } catch (error) {
      // SEC-01: only RootNotFoundError and MalformedConfigError propagate;
      // every other adapter failure degrades to a diagnostic.
      if (
        error instanceof RootNotFoundError ||
        error instanceof MalformedConfigError
      ) {
        throw error;
      }
      extraDiagnostics.push(malformedConfigDiagnostic(name, error));
    }
  }

  // Only the canonical adapter populates the typed side-channel.
  let canonicalSide: CanonicalSideChannel | undefined;
  for (const r of results) {
    if (r.source === "canonical" && r.result.canonical !== undefined) {
      canonicalSide = r.result.canonical;
    }
  }

  // Promotion gate ("detection proposes, config disposes"); in SE mode the
  // disposing config is per-child member config presence.
  const merged = merge(results, canonicalSide?.declaredUnits ?? sePlatform);

  // Per-user local overrides (definition mode only) redirect WHERE a member
  // is read from disk, never its `path` in output. `null` marks a member
  // forcibly missing: its override escaped the boundary; the dir is not read.
  const diskDirByName = new Map<string, string | null>();
  if (definition !== null) {
    const local = readLocalConfig(effectiveRoot);
    if (local !== null) {
      if (!local.ok) {
        // Malformed per-user machine state must never brick the map.
        extraDiagnostics.push(local.diagnostic);
      } else if (local.config.locations !== undefined) {
        const memberNames = new Set(definition.members.map((m) => m.name));
        const locations = local.config.locations;
        for (const key of Object.keys(locations)) {
          const value = locations[key];
          if (value === undefined) continue;
          if (!memberNames.has(key)) {
            extraDiagnostics.push(danglingOverrideDiagnostic(key));
            continue;
          }
          // An escape of the resolution boundary is diagnosed; the member is
          // treated as missing, never followed. The check is PHYSICAL
          // (realpath both sides) so a symlink cannot alias a dir outside
          // the boundary; an unresolvable target is an escape.
          const target = path.resolve(effectiveRoot, value);
          if (!isPhysicallyInsideBoundary(path.resolve(boundary), target)) {
            extraDiagnostics.push(overrideEscapeDiagnostic(key));
            diskDirByName.set(key, null);
            continue;
          }
          diskDirByName.set(key, target);
        }
      }
    }
  }

  /** Disk dir a top-level unit is read from: the override table (null =
   *  forcibly missing), else the conventional path under the root. */
  const unitDiskDir = (unit: Unit): string | null =>
    diskDirByName.has(unit.name)
      ? (diskDirByName.get(unit.name) as string | null)
      : path.join(effectiveRoot, unit.path);

  // Same SEC-01 discipline as the adapter fold, guarded per-unit so one
  // failure never aborts the rest; depSideTable feeds buildEdges.
  // The name registry is seeded with every already-assembled unit so nested
  // expansion can never re-mint an identity a flat unit already owns; merge()
  // guarantees top-level names are unique, so seeding cannot collide.
  const depSideTable = new Map<string, string[]>();
  const nameRegistry: UnitNameRegistry = new Map();
  const seedRegistry = (units: Unit[], parentLocation: string): void => {
    for (const u of units) {
      const location = joinLocation(parentLocation, u.path);
      claim(nameRegistry, u.name, location);
      if (u.units.length > 0) seedRegistry(u.units, location);
    }
  };
  seedRegistry(merged.units, ".");
  for (const unit of merged.units) {
    const dir = unitDiskDir(unit);
    // A forcibly-missing member is never read; unit still emitted, empty
    // signals.
    if (dir === null) continue;
    try {
      enrichUnit(
        effectiveRoot,
        unit,
        0,
        extraDiagnostics,
        depSideTable,
        nameRegistry,
        unit.path,
        dir,
      );
    } catch (error) {
      if (
        error instanceof RootNotFoundError ||
        error instanceof MalformedConfigError
      ) {
        throw error;
      }
      extraDiagnostics.push(censusFailureDiagnostic(unit.name, error));
    }
  }

  // Backstop for the Unit.name uniqueness contract: catches collisions
  // arriving through seams the expansion dedupe cannot see. Runs before the
  // ref probe, drift checks, and edge/degree passes so no downstream
  // consumer can ever observe a duplicate.
  for (const d of enforceUniqueUnitNames(merged.units)) {
    extraDiagnostics.push(d);
  }

  // map(), not the siblings adapter, owns the default-branch ref probe so it
  // applies uniformly to every kind:"repo" unit (MODEL-06); a declared ref
  // wins, only ref:null units are probed. Probes run CONCURRENTLY, each
  // bounded by probeRef's own timeout (it never rejects), so one hostile or
  // slow repo degrades to ref:null without stalling the batch.
  const probeCandidates =
    opts.refProbe === false
      ? []
      : merged.units.filter(
          (unit) => unit.kind === "repo" && unit.ref === null,
        );
  await Promise.all(
    probeCandidates.map(async (unit) => {
      // Probe at the actual disk location; forcibly-missing keeps ref:null.
      const dir = unitDiskDir(unit);
      if (dir === null) return;
      unit.ref = await probeRef(dir);
    }),
  );

  // Drift checks run at ASSEMBLY, not resolution, so map()-from-inside and
  // map()-at-root produce identical diagnostics even for drifted platforms.
  if (definition !== null) {
    try {
      const resolvedPlatformRoot = path.resolve(effectiveRoot);
      for (const member of definition.members) {
        const conventionalPath = member.path ?? member.name;
        const dir = diskDirByName.has(member.name)
          ? (diskDirByName.get(member.name) as string | null)
          : path.join(effectiveRoot, conventionalPath);
        if (dir === null || !isDirectory(dir)) {
          // Listed-but-missing: unit still emitted; identity exists,
          // location doesn't.
          extraDiagnostics.push(
            missingMemberDiagnostic(member.name, conventionalPath),
          );
          continue;
        }
        const sniff = sniffPlatformFile(dir);
        if (sniff.kind === "marker") {
          if (sniff.marker.platform !== definition.name) {
            extraDiagnostics.push(
              markerNameMismatchDiagnostic(
                member.name,
                conventionalPath,
                sniff.marker.platform,
                definition.name,
              ),
            );
          }
          // The root hint is checked against the CONVENTIONAL path (pure
          // path math) so a local relocation never changes the drift verdict.
          const hint = sniff.marker.root ?? "..";
          if (
            path.resolve(resolvedPlatformRoot, conventionalPath, hint) !==
            resolvedPlatformRoot
          ) {
            extraDiagnostics.push(
              markerRootHintMismatchDiagnostic(
                member.name,
                conventionalPath,
                hint,
              ),
            );
          }
        }
        // No marker -> silent: absence is never a negative assertion; a
        // malformed member file is that member's own standalone concern.
      }

      // A platform-root child dir that is no member path, matches no ignore
      // glob, and holds no .git gets an info diagnostic. Dotdirs skipped;
      // symlinks not followed (Dirent.isDirectory() is false for symlinks).
      const memberTopSegments = new Set(
        definition.members.map((m) => (m.path ?? m.name).split("/")[0]),
      );
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(effectiveRoot, { withFileTypes: true });
      } catch {
        entries = [];
      }
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        if (!entry.isDirectory()) continue;
        if (memberTopSegments.has(entry.name)) continue;
        if (
          effectiveIgnore.length > 0 &&
          matchGlob(effectiveIgnore, [entry.name]).matched.length > 0
        ) {
          continue;
        }
        if (fs.existsSync(path.join(effectiveRoot, entry.name, ".git"))) {
          continue; // a .git child is the promotion gate's territory
        }
        extraDiagnostics.push(nonRepoChildDiagnostic(entry.name));
      }
    } catch (error) {
      if (
        error instanceof RootNotFoundError ||
        error instanceof MalformedConfigError
      ) {
        throw error;
      }
      extraDiagnostics.push(driftCheckFailureDiagnostic(error));
    }
  }

  // An overrides key naming no assembled unit is stale: warn and ignore,
  // never throw. Dangerous keys were already stripped by config.ts.
  if (canonicalSide?.overrides !== undefined) {
    const unitNames = new Set<string>();
    collectUnitNames(merged.units, unitNames);
    for (const key of Object.keys(canonicalSide.overrides)) {
      if (!unitNames.has(key)) {
        extraDiagnostics.push(staleOverrideDiagnostic(key));
      }
    }
  }

  // buildEdges returns natural order; sorting happens at serialization.
  const built = buildEdges(merged.units, (u) => depSideTable.get(u.name) ?? []);
  const edges = built.edges;
  for (const d of built.diagnostics) extraDiagnostics.push(d);

  // GRAPH-05 STRICT ORDER: degrees -> cycles -> roles. Degrees MUST be
  // written before applyRoles or deriveRole's degree-sensitive rules read
  // `undefined` and misclassify libraries as unknown.
  // (1) Degrees (0 written explicitly) onto every workspace-package unit.
  populateDegrees(merged.units, edges);

  // (2) One CYCLE_SUSPECTED warning per cycle, additive, never throws; the
  //     same canonicalCycles backs graph().cycles(), so the two views agree.
  const cycleNodes: string[] = [];
  collectWorkspacePackageNames(merged.units, cycleNodes);
  const adjacency = new Map<string, Set<string>>();
  for (const e of edges as Edge[]) {
    let outs = adjacency.get(e.from);
    if (outs === undefined) {
      outs = new Set<string>();
      adjacency.set(e.from, outs);
    }
    outs.add(e.to);
  }
  for (const cycle of canonicalCycles(cycleNodes, adjacency)) {
    extraDiagnostics.push(cycleSuspectedDiagnostic(cycle));
  }

  // (3) Roles at all depths; canonical overrides[name].role beats derivation.
  //     Runs AFTER degrees so degree-sensitive rules see populated values.
  applyRoles(merged.units, canonicalSide?.overrides);

  const pm: PlatformMap = {
    // config.name (the definition's name) is authoritative; else
    // basename(root), with a fixed placeholder (never the raw root).
    name:
      canonicalSide?.name ??
      (path.basename(path.resolve(effectiveRoot)) || "(root)"),
    // Equals the caller's own string whenever no re-anchor happened.
    root: effectiveRoot,
    // A definition (or SE platform) forces multi-repo: a platform root is
    // multi-repo by declaration, not by sibling census.
    mode: definition !== null || sePlatform ? "multi-repo" : detection.mode,
    units: merged.units,
    edges,
    diagnostics: [...merged.diagnostics, ...extraDiagnostics],
    schemaVersion: 1,
  };

  return serialize(pm);
}
