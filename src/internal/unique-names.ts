// Unit-name registry backing map()'s nested-expansion dedupe. Unit.name is
// the identity every downstream consumer (depSideTable, edges, degrees,
// graph(), serialize) keys on, so a duplicate silently corrupts all of them.
// Pure: no I/O, never throws.

import type { Diagnostic, Unit } from "../types.js";

export type ClaimOutcome =
  | "free"
  | "duplicate-same-location"
  | "duplicate-different-location";

/** Unit name -> platform-relative location of the first claimant. */
export type UnitNameRegistry = Map<string, string>;

/** POSIX join of platform-relative segments; a "." parent contributes nothing. */
export function joinLocation(parent: string, child: string): string {
  return parent === "." ? child : `${parent}/${child}`;
}

/**
 * Claims `name` at `location`. "free" registers the pair; a duplicate leaves
 * the registry untouched and reports whether the locations agree (two honest
 * sources describing the same unit) or disagree (a genuine collision).
 */
export function claim(
  registry: UnitNameRegistry,
  name: string,
  location: string,
): ClaimOutcome {
  const existing = registry.get(name);
  if (existing === undefined) {
    registry.set(name, location);
    return "free";
  }
  return existing === location
    ? "duplicate-same-location"
    : "duplicate-different-location";
}

/**
 * Post-assembly backstop for the types.ts Unit.name uniqueness contract.
 * Walks the tree depth-first in array order (the merged fold order, which
 * follows adapter precedence, so first equals first-precedence); the first
 * occurrence keeps the name, every later duplicate is removed in place from
 * its containing units array with one CONFIG_CONFLICT diagnostic per drop.
 * Deterministic, never throws.
 */
export function enforceUniqueUnitNames(units: Unit[]): Diagnostic[] {
  const registry: UnitNameRegistry = new Map();
  const diagnostics: Diagnostic[] = [];
  const visit = (list: Unit[], parentLocation: string): void => {
    let write = 0;
    for (const u of list) {
      const location = joinLocation(parentLocation, u.path);
      if (claim(registry, u.name, location) !== "free") {
        diagnostics.push(
          nameCollisionDiagnostic(
            u.name,
            registry.get(u.name) as string,
            location,
          ),
        );
        continue;
      }
      list[write] = u;
      write++;
      if (u.units.length > 0) visit(u.units, location);
    }
    list.length = write;
  };
  visit(units, ".");
  return diagnostics;
}

/** A name claimed at two different root-relative locations; `path` is the
 *  colliding name, the first claimant keeps it. Locations are root-relative
 *  only, never absolute. */
export function nameCollisionDiagnostic(
  name: string,
  keptLocation: string,
  droppedLocation: string,
): Diagnostic {
  return {
    code: "CONFIG_CONFLICT",
    severity: "warning",
    path: name,
    message:
      `CONFIG_CONFLICT: unit name "${name}" is claimed at both ` +
      `"${keptLocation}" and "${droppedLocation}"; the first claimant at ` +
      `"${keptLocation}" keeps the name`,
  };
}
