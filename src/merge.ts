// merge(): the pure precedence-fold reducer (CFG-08). The single place all
// five adapters' disagreements become visible. Contract:
//   - Input is precedence-ordered, HIGH first. The first writer of a field
//     wins; a later (lower-precedence) source providing a DIFFERENT value for
//     an ALREADY-SET field surfaces exactly one CONFIG_CONFLICT naming both
//     the existing contributor(s) and the incoming source plus both values —
//     the existing value is KEPT (never a silent override).
//   - A later source filling an UNSET field is a silent gap-fill (no diagnostic).
//   - Unit.sources[] accumulates every contributing source in input order.
//   - Sibling-promotion gate (Pattern 3): a provisional candidate whose name
//     no higher source claimed becomes an UNCONFIGURED_SIBLING diagnostic when
//     canonicalDeclaredUnits is true ("config disposes"), else a real unit.
//
// This module deliberately does NOT:
//   - sort anything — serialize.ts is the SOLE sort site (determinism §5); the
//     Phase-5 shuffle test proves merge output is order-independent.
//   - perform any I/O (pure, unit-testable in isolation).
//   - mutate its input `results` (only newly-created Unit objects are written).
//   - spread untrusted parsed objects — only known fields are copied explicitly
//     (prototype-pollution guard, 02-RESEARCH.md L509/L516).

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
    // First-writer-wins ref; null when no contributing partial declared one,
    // leaving map()'s MODEL-06 probe to fill it for kind:"repo" units.
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
      // Existing (higher precedence) holds the field: report both, keep existing.
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
  // Lower precedence fills a gap the higher one left unset — silent.
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
 * units + diagnostics — serialize() is the sole sort site.
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
        // No prior claim: an unconfirmed provisional candidate is a diagnostic
        // (not a unit) ONLY when canonical declared an explicit units[] — else
        // it is promoted (the zero-config multi-repo case).
        if (pu.provisional && canonicalDeclaredUnits) {
          diagnostics.push(unconfiguredSiblingDiagnostic(pu.name, pu.path));
          continue;
        }
        const claimed = new Set<string>();
        byName.set(pu.name, seedUnit(pu, source, claimed));
        claims.set(pu.name, claimed);
        continue;
      }

      // Merge this lower-precedence contribution into the existing unit. A
      // provisional candidate whose name is already claimed simply confirms
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
