// merge(): the pure precedence fold where adapter disagreements
// become visible. Input is precedence-ordered, HIGH first; the first writer of
// a field wins. A later source with a DIFFERENT value for an already-set field
// surfaces one CONFIG_CONFLICT naming both contributors and both values (the
// existing value is kept); filling an UNSET field is a silent gap-fill.
// Unit.sources[] accumulates every contributor in input order. A provisional
// sibling no higher source claimed becomes an UNCONFIGURED_SIBLING diagnostic
// when canonicalDeclaredUnits is true ("config disposes"), else a real unit.
// Pure: no I/O, no sorting, input never mutated, untrusted parsed objects
// never spread (only known fields copied explicitly).

import type { AdapterResult, PartialUnit } from "./adapters/index.js";
import type { AdapterName, Diagnostic, Unit, UnitSignals } from "./types.js";

type Source = AdapterName | "caller";

/** The full known-signal allowlist. Iterating this (never Object.keys on an
 *  untrusted parsed object) is the prototype-pollution guard for signals. */
const SIGNAL_KEYS: Array<keyof UnitSignals> = [
  "private",
  "hasExports",
  "hasBin",
  "hasStartScript",
  "packageName",
  "hasDockerfile",
  "hasDeployConfig",
  "languages",
  "packageManager",
  "workspaceInDegree",
  "workspaceOutDegree",
  "hasDfPointer",
  "dfConfigConflict",
  "hasSpecEngineConfig",
];

function fmt(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.join(",")}]`;
  return String(value);
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }
  return a === b;
}

function conflictDiagnostic(
  unitName: string,
  field: string,
  existingSources: string[],
  existingValue: unknown,
  incomingSource: Source,
  incomingValue: unknown,
): Diagnostic {
  const existingLabel = existingSources.join(",");
  return {
    code: "CONFIG_CONFLICT",
    severity: "warning",
    path: unitName,
    message:
      `CONFIG_CONFLICT: unit "${unitName}" ${field} disagreement — ` +
      `${existingLabel}="${fmt(existingValue)}" vs ` +
      `${incomingSource}="${fmt(incomingValue)}" (${existingLabel} wins)`,
  };
}

function unconfiguredSiblingDiagnostic(name: string, path: string): Diagnostic {
  return {
    code: "UNCONFIGURED_SIBLING",
    severity: "info",
    path,
    message: `UNCONFIGURED_SIBLING: "${name}" at ${path} is a candidate sibling not named by any config source`,
  };
}

function seedUnit(pu: PartialUnit, source: Source, claimed: Set<string>): Unit {
  // Copy only known signal fields explicitly (prototype-pollution guard).
  const signals: Record<string, unknown> = {};
  if (pu.signals) {
    for (const key of SIGNAL_KEYS) {
      const v = pu.signals[key];
      if (v !== undefined) {
        signals[key] = v;
        claimed.add(`signals.${key}`);
      }
    }
  }
  claimed.add("path");
  claimed.add("kind");
  if (pu.mode !== undefined) claimed.add("mode");
  if (pu.ref !== undefined) claimed.add("ref");

  return {
    name: pu.name,
    path: pu.path,
    kind: pu.kind,
    // Default "single-repo"; map() overwrites per-unit mode during recursion.
    mode: pu.mode ?? "single-repo",
    // null when no contributing partial declared a ref; map()'s probe fills it
    // for kind:"repo" units.
    ref: pu.ref ?? null,
    units: [],
    signals: signals as UnitSignals,
    role: "unknown",
    sources: [source],
  };
}

function considerScalar(
  unit: Unit,
  claimed: Set<string>,
  field: "path" | "kind" | "mode" | "ref",
  incoming: string | undefined,
  source: Source,
  diagnostics: Diagnostic[],
): void {
  if (incoming === undefined) return;
  const record = unit as unknown as Record<string, unknown>;
  if (claimed.has(field)) {
    if (!valuesEqual(record[field], incoming)) {
      diagnostics.push(
        conflictDiagnostic(
          unit.name,
          field,
          unit.sources.slice(),
          record[field],
          source,
          incoming,
        ),
      );
    }
    return;
  }
  record[field] = incoming;
  claimed.add(field);
}

function considerSignal(
  unit: Unit,
  claimed: Set<string>,
  key: keyof UnitSignals,
  incoming: unknown,
  source: Source,
  diagnostics: Diagnostic[],
): void {
  const claimKey = `signals.${key}`;
  const signals = unit.signals as unknown as Record<string, unknown>;
  if (claimed.has(claimKey)) {
    if (!valuesEqual(signals[key], incoming)) {
      diagnostics.push(
        conflictDiagnostic(
          unit.name,
          claimKey,
          unit.sources.slice(),
          signals[key],
          source,
          incoming,
        ),
      );
    }
    return;
  }
  signals[key] = incoming;
  claimed.add(claimKey);
}

/**
 * Folds precedence-ordered adapter results (high first) into resolved units.
 * `canonicalDeclaredUnits` gates the sibling-promotion rule. Returns unsorted
 * units + diagnostics.
 */
export function merge(
  results: Array<{ source: Source; result: AdapterResult }>,
  canonicalDeclaredUnits: boolean,
): { units: Unit[]; diagnostics: Diagnostic[] } {
  const byName = new Map<string, Unit>();
  const claims = new Map<string, Set<string>>();
  const diagnostics: Diagnostic[] = [];

  for (const { source, result } of results) {
    for (const pu of result.partialUnits) {
      const existing = byName.get(pu.name);

      if (existing === undefined) {
        // No prior claim: a provisional candidate is a diagnostic, not a unit,
        // only when canonical declared explicit units[]; else it is promoted.
        if (pu.provisional && canonicalDeclaredUnits) {
          diagnostics.push(unconfiguredSiblingDiagnostic(pu.name, pu.path));
          continue;
        }
        const claimed = new Set<string>();
        byName.set(pu.name, seedUnit(pu, source, claimed));
        claims.set(pu.name, claimed);
        continue;
      }

      // A provisional candidate whose name is already claimed simply confirms
      // and contributes (no UNCONFIGURED_SIBLING).
      const claimed = claims.get(pu.name) as Set<string>;
      considerScalar(existing, claimed, "path", pu.path, source, diagnostics);
      considerScalar(existing, claimed, "kind", pu.kind, source, diagnostics);
      considerScalar(existing, claimed, "mode", pu.mode, source, diagnostics);
      considerScalar(existing, claimed, "ref", pu.ref, source, diagnostics);
      if (pu.signals) {
        for (const key of SIGNAL_KEYS) {
          const v = pu.signals[key];
          if (v === undefined) continue;
          considerSignal(existing, claimed, key, v, source, diagnostics);
        }
      }
      existing.sources.push(source);
    }

    for (const d of result.diagnostics) diagnostics.push(d);
  }

  return { units: [...byName.values()], diagnostics };
}
