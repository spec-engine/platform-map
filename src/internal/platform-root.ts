// RED-97 (IP-2/IP-8): bounded upward platform-root resolution — sniff-driven
// walk, marker following, and boundary containment (D-05/D-06, PMAP-010/012).
//
// Owns the walk + boundary math ONLY; all three platform-map.json validators
// and the discrimination live in config.ts (IP-2) — sniffPlatformFile here is
// the lenient face of that single shared classifier (files sniffed at OTHER
// directories during the walk never throw; they degrade, IP-3).
//
// Security posture (D-06, T-iha-01): pure path math + bounded fs reads only —
// no writes, no network, no subprocess. The upward WALK never follows
// symlinked ancestry beyond what path.resolve of the given dir yields (no
// realpath on the ascent). The one place resolution FOLLOWS a target — a
// marker's root hint — is realpath'd first (WR-02): a symlink inside the
// boundary must not alias a directory physically outside it, so the physical
// location is what the boundary check sees (one bounded realpath per marker;
// an unresolvable target is treated as an escape, never followed). All other
// boundary comparisons use the path-guard idiom (path.resolve +
// relative-prefix escape test). Diagnostic loci are paths relative to the
// start dir (may contain ".."), never absolute (§5). No sorting anywhere —
// serialize.ts stays the sole sort site.

import * as fs from "node:fs";
import * as path from "node:path";
import type { PlatformFileClassification } from "../config.js";
import { classifyPlatformFile } from "../config.js";
import type { Diagnostic, PlatformDefinition } from "../types.js";

/** The canonical config filename sniffed at each level of the walk. */
const CONFIG_FILENAME = "platform-map.json";

/**
 * Lenient, never-throwing classification of `<dir>/platform-map.json`:
 * definition / marker / config / absent / malformed, with the parsed payload
 * for the valid kinds. Shape checks mirror config.ts exactly (it IS config.ts'
 * classifier) but degrade instead of throw — the resolver and map()'s
 * assembly-time drift checks both consume this face.
 */
export function sniffPlatformFile(dir: string): PlatformFileClassification {
  return classifyPlatformFile(dir);
}

/**
 * The path-guard escape test, applied to the resolution boundary (D-06):
 * true iff `target` (already resolved) sits at or below `boundary` (already
 * resolved). Mirrors resolveWithinRoot's escape math — `..`-prefixed or
 * absolute relative results mean escape.
 */
export function isInsideBoundary(boundary: string, target: string): boolean {
  const relative = path.relative(boundary, target);
  return (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

/** WR-02: the PHYSICAL location of a follow-target, or null when it cannot be
 *  resolved (dangling symlink, denied component, nonexistent path) — callers
 *  treat null as an escape (never followed). Bounded: one realpath call. */
export function physicalPath(target: string): string | null {
  try {
    return fs.realpathSync(target);
  } catch {
    return null;
  }
}

/** WR-02: physical containment for follow-targets — realpaths BOTH sides so a
 *  symlink inside the boundary cannot alias a physically-outside directory
 *  (and so an aliased boundary, e.g. macOS /var -> /private/var, compares
 *  correctly). An unresolvable target is an escape; an unresolvable boundary
 *  falls back to its lexical form. */
export function isPhysicallyInsideBoundary(
  boundary: string,
  target: string,
): boolean {
  const physicalTarget = physicalPath(target);
  if (physicalTarget === null) return false;
  const physicalBoundary = physicalPath(boundary) ?? boundary;
  return isInsideBoundary(physicalBoundary, physicalTarget);
}

/** The resolver's result: the resolved platform root (null = no platform
 *  context — rung-1/2 behavior unchanged), the definition found there, how it
 *  was reached, and any diagnostics the walk produced. */
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
  /** Walk diagnostics (malformed ancestor, dangling marker, boundary escape).
   *  Loci are start-dir-relative, never absolute. */
  diagnostics: Diagnostic[];
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

/** Start-dir-relative locus of a directory's platform-map.json (may contain
 *  ".."), POSIX separators — never an absolute path (§5). */
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
 * The bounded upward walk (IP-8, honoring D-05 precedence and D-06
 * containment). From `startDir`, ascend parent-by-parent while inside
 * `boundary`, sniffing platform-map.json at each level:
 *
 *  - definition  -> that dir IS the platform root (handles subdir-of-root).
 *  - marker      -> resolve its root hint ONCE; the target must be inside the
 *                   boundary AND hold a definition, else the escape/dangling
 *                   diagnostic is emitted and resolution falls back (root null).
 *  - unit config -> STOP with no platform context: a rung-1/2 repo explicitly
 *                   self-describes (the back-compat firewall).
 *  - malformed   -> stop + MALFORMED_CONFIG warning + fallback — UNLESS it is
 *                   the start dir itself, where the caller's strict read
 *                   (readCanonicalConfig's MalformedConfigError) applies as
 *                   today, so the walk stays silent there.
 *  - absent      -> continue up (never above the boundary dir).
 *
 * A `startDir` outside the boundary is INERT (root null, no diagnostics, no
 * reads beyond the containment check) — this is what keeps every existing
 * out-of-boundary caller byte-identical (IP-4).
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
      // Resolve the hint exactly once (IP-8) — never follow a chain of markers.
      const hint = sniff.marker.root ?? "..";
      const target = path.resolve(dir, hint);
      const locus = fileLocus(start, dir);
      // WR-02: the hint target is about to be READ (followed) — containment
      // must hold PHYSICALLY, not just lexically: realpath both sides so a
      // symlink inside the boundary cannot alias an outside directory. An
      // unresolvable target is an escape, never followed.
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
      // Dangling marker: emitted into the fallback map (IP-5).
      diagnostics.push(danglingMarkerDiagnostic(locus, hint));
      return { root: null, viaMarker: false, diagnostics };
    }

    if (sniff.kind === "config") {
      // Back-compat firewall: a rung-1/2 repo explicitly self-describes.
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
