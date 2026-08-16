// Bounded upward platform-root resolution: sniff-driven walk, marker
// following, boundary containment. Pure path math and bounded fs reads only;
// no writes, network, or subprocess. The ascent never realpaths ancestry; the
// one FOLLOWED target, a marker's root hint, is realpath'd first so an
// inside-boundary symlink cannot alias a physically-outside directory, and an
// unresolvable target is an escape. Diagnostic loci are start-dir-relative
// (may contain ".."), never absolute.

import * as fs from "node:fs";
import * as path from "node:path";
import type { PlatformFileClassification } from "../config.js";
import { classifyPlatformFile } from "../config.js";
import type { Diagnostic, PlatformDefinition } from "../types.js";

const CONFIG_FILENAME = "platform-map.json";

/** Lenient, never-throwing classification of `<dir>/platform-map.json`:
 *  definition / marker / config / absent / malformed. Delegates to config.ts'
 *  shared classifier; degrades instead of throwing. */
export function sniffPlatformFile(dir: string): PlatformFileClassification {
  return classifyPlatformFile(dir);
}

/** Path-guard escape test: true iff `target` (resolved) sits at or below
 *  `boundary` (resolved); `..`-prefixed or absolute relative results mean
 *  escape. */
export function isInsideBoundary(boundary: string, target: string): boolean {
  const relative = path.relative(boundary, target);
  return (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

/** The physical location of a follow-target, or null when it cannot be
 *  resolved (dangling symlink, denied component, nonexistent path); callers
 *  treat null as an escape. One realpath call. */
export function physicalPath(target: string): string | null {
  try {
    return fs.realpathSync(target);
  } catch {
    return null;
  }
}

/** Physical containment for follow-targets: realpaths BOTH sides so a symlink
 *  inside the boundary cannot alias a physically-outside directory (and so an
 *  aliased boundary, e.g. macOS /var -> /private/var, compares correctly). An
 *  unresolvable target is an escape; an unresolvable boundary falls back to
 *  its lexical form. */
export function isPhysicallyInsideBoundary(
  boundary: string,
  target: string,
): boolean {
  const physicalTarget = physicalPath(target);
  if (physicalTarget === null) return false;
  const physicalBoundary = physicalPath(boundary) ?? boundary;
  return isInsideBoundary(physicalBoundary, physicalTarget);
}

/** The resolver's result. */
export interface PlatformContext {
  /** The resolved platform root (absolute), or null when no definition was
   *  found inside the boundary. */
  root: string | null;
  /** The definition at `root` (present exactly when root is non-null). */
  definition?: PlatformDefinition;
  /** True when the root was reached by following a member marker's hint. */
  viaMarker: boolean;
  /** The directory holding the marker that was followed (viaMarker only). */
  memberDir?: string;
  /** Walk diagnostics: malformed ancestor, dangling marker, boundary escape. */
  diagnostics: Diagnostic[];
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

/** Start-dir-relative locus of a directory's platform-map.json (may contain
 *  ".."), POSIX separators; never an absolute path. */
function fileLocus(startDir: string, dir: string): string {
  const rel = path.relative(startDir, path.join(dir, CONFIG_FILENAME));
  return toPosix(rel === "" ? CONFIG_FILENAME : rel);
}

function danglingMarkerDiagnostic(locus: string, hint: string): Diagnostic {
  return {
    code: "PLATFORM_DRIFT",
    severity: "warning",
    path: locus,
    message: `PLATFORM_DRIFT: dangling marker: root hint "${hint}" resolves to a directory holding no platform definition`,
  };
}

function hintEscapeDiagnostic(locus: string, hint: string): Diagnostic {
  return {
    code: "UNIT_PATH_ESCAPE",
    severity: "warning",
    path: locus,
    message: `UNIT_PATH_ESCAPE: marker root hint "${hint}" escapes resolution boundary`,
  };
}

function malformedAncestorDiagnostic(
  locus: string,
  reason: string,
): Diagnostic {
  return {
    code: "MALFORMED_CONFIG",
    severity: "warning",
    path: locus,
    message: `MALFORMED_CONFIG: ${locus} stopped platform resolution: ${reason}`,
  };
}

/**
 * The bounded upward walk: from `startDir`, ascend parent-by-parent while
 * inside `boundary`, sniffing platform-map.json at each level. definition ->
 * that dir IS the platform root; marker -> resolve its root hint ONCE (never
 * chained), which must land inside the boundary on a definition, else an
 * escape/dangling diagnostic and fallback; unit config -> stop with no
 * platform context (back-compat firewall: the repo self-describes);
 * malformed -> stop + warning, unless at the start dir itself where the
 * caller's strict read applies; absent -> ascend, never above the boundary.
 * A `startDir` outside the boundary is inert: root null, no diagnostics, no
 * reads beyond the containment check.
 */
export function resolvePlatformContext(
  startDir: string,
  boundary: string,
): PlatformContext {
  const start = path.resolve(startDir);
  const bound = path.resolve(boundary);
  const diagnostics: Diagnostic[] = [];

  if (!isInsideBoundary(bound, start)) {
    return { root: null, viaMarker: false, diagnostics };
  }

  let dir = start;
  for (;;) {
    const sniff = sniffPlatformFile(dir);

    if (sniff.kind === "definition") {
      return {
        root: dir,
        definition: sniff.definition,
        viaMarker: false,
        diagnostics,
      };
    }

    if (sniff.kind === "marker") {
      const hint = sniff.marker.root ?? "..";
      const target = path.resolve(dir, hint);
      const locus = fileLocus(start, dir);
      // The hint target is about to be READ, so containment must hold
      // physically, not just lexically; an unresolvable target is an escape.
      if (!isPhysicallyInsideBoundary(bound, target)) {
        diagnostics.push(hintEscapeDiagnostic(locus, hint));
        return { root: null, viaMarker: false, diagnostics };
      }
      const targetSniff = sniffPlatformFile(target);
      if (targetSniff.kind === "definition") {
        return {
          root: target,
          definition: targetSniff.definition,
          viaMarker: true,
          memberDir: dir,
          diagnostics,
        };
      }
      diagnostics.push(danglingMarkerDiagnostic(locus, hint));
      return { root: null, viaMarker: false, diagnostics };
    }

    if (sniff.kind === "config") {
      // Back-compat firewall: a repo with unit-level config self-describes.
      return { root: null, viaMarker: false, diagnostics };
    }

    if (sniff.kind === "malformed") {
      if (dir !== start) {
        diagnostics.push(
          malformedAncestorDiagnostic(fileLocus(start, dir), sniff.reason),
        );
      }
      return { root: null, viaMarker: false, diagnostics };
    }

    // absent -> ascend, never above the boundary dir.
    if (dir === bound) break;
    const parent = path.dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }

  return { root: null, viaMarker: false, diagnostics };
}
