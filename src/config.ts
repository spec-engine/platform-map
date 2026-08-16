// Hand-rolled, zero-dependency validators for platform-map.json and
// platform-map.local.json. readCanonicalConfig is the one hard-error path
// besides RootNotFoundError: a present file that fails read, parse, or shape
// validation throws MalformedConfigError with a stage-tagged message; absent
// returns null (config is optional forever). Overrides are shape-checked
// only; the references-a-real-unit check lives in map(), which knows the
// assembled unit set. Messages carry the fixed root-relative filename only.

import * as fs from "node:fs";
import * as path from "node:path";
import { MalformedConfigError } from "./errors.js";
import type {
  Diagnostic,
  MemberMarker,
  PlatformDefinition,
  PlatformLocalConfig,
  PlatformMapConfig,
  Role,
} from "./types.js";

const CONFIG_FILENAME = "platform-map.json";

/** The per-user local location-override filename. */
const LOCAL_CONFIG_FILENAME = "platform-map.local.json";

const ROLE_VALUES: ReadonlySet<string> = new Set<Role>([
  "library",
  "app",
  "unknown",
]);

/** Never copied from untrusted input: the classic prototype-pollution sink. */
const DANGEROUS_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** errno code only: Node interpolates the absolute file path into fs error
 *  messages, so `e.message` must never reach a diagnostics reason string. */
function fsErrorCode(e: unknown): string {
  if (e instanceof Error && "code" in e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (typeof code === "string" && code.length > 0) return code;
  }
  return "unknown";
}

/** Returns a reason string on the first shape violation, else null. Unknown
 *  top-level keys are ignored (forward-compat). */
function validateShape(raw: unknown): string | null {
  if (!isPlainObject(raw)) {
    return "top-level value must be a JSON object";
  }

  if (raw.name !== undefined && typeof raw.name !== "string") {
    return `"name" must be a string`;
  }

  if (raw.units !== undefined) {
    if (!Array.isArray(raw.units)) return `"units" must be an array`;
    for (let i = 0; i < raw.units.length; i++) {
      const u: unknown = raw.units[i];
      if (!isPlainObject(u)) return `"units[${i}]" must be an object`;
      if (typeof u.name !== "string") {
        return `"units[${i}].name" must be a string`;
      }
      if (typeof u.path !== "string") {
        return `"units[${i}].path" must be a string`;
      }
      if (u.ref !== undefined && typeof u.ref !== "string") {
        return `"units[${i}].ref" must be a string when present`;
      }
    }
  }

  if (raw.ignore !== undefined) {
    if (!Array.isArray(raw.ignore)) return `"ignore" must be an array`;
    for (let i = 0; i < raw.ignore.length; i++) {
      if (typeof raw.ignore[i] !== "string") {
        return `"ignore[${i}]" must be a string`;
      }
    }
  }

  if (raw.overrides !== undefined) {
    if (!isPlainObject(raw.overrides)) {
      return `"overrides" must be an object`;
    }
    for (const key of Object.keys(raw.overrides)) {
      const entry: unknown = (raw.overrides as Record<string, unknown>)[key];
      if (!isPlainObject(entry)) {
        return `"overrides.${key}" must be an object`;
      }
      if (entry.role !== undefined) {
        if (typeof entry.role !== "string" || !ROLE_VALUES.has(entry.role)) {
          return `"overrides.${key}.role" must be one of library|app|unknown`;
        }
      }
    }
  }

  return null;
}

/** Copies only known fields from the shape-validated parse; never spreads
 *  untrusted keys, and skips DANGEROUS_KEYS. */
function copyKnownFields(raw: Record<string, unknown>): PlatformMapConfig {
  const config: PlatformMapConfig = {};

  if (typeof raw.name === "string") config.name = raw.name;

  if (Array.isArray(raw.units)) {
    config.units = raw.units.map((u) => {
      const unit = u as Record<string, unknown>;
      const out: { name: string; path: string; ref?: string } = {
        name: unit.name as string,
        path: unit.path as string,
      };
      if (typeof unit.ref === "string") out.ref = unit.ref;
      return out;
    });
  }

  if (Array.isArray(raw.ignore)) {
    config.ignore = raw.ignore.slice() as string[];
  }

  if (isPlainObject(raw.overrides)) {
    const overrides: Record<string, { role?: Role }> = {};
    const src = raw.overrides as Record<string, unknown>;
    for (const key of Object.keys(src)) {
      if (DANGEROUS_KEYS.has(key)) continue; // prototype-pollution guard
      const entry = src[key];
      if (!isPlainObject(entry)) continue; // validated already; narrow for TS
      const out: { role?: Role } = {};
      if (typeof entry.role === "string") out.role = entry.role as Role;
      overrides[key] = out;
    }
    config.overrides = overrides;
  }

  return config;
}

// One filename, three shapes, discriminated by key presence IN THIS ORDER:
// `members` present -> platform definition; else `platform` present -> member
// marker; else -> unit-level config.

/** The strict discriminated read result. The marker kind also carries the
 *  coexisting sanitized unit-level config, used when the member maps
 *  standalone. */
export type PlatformFileResult =
  | { kind: "absent" }
  | { kind: "config"; config: PlatformMapConfig }
  | { kind: "marker"; marker: MemberMarker; config: PlatformMapConfig }
  | { kind: "definition"; definition: PlatformDefinition };

/** PlatformFileResult plus a never-throwing `malformed` kind carrying the
 *  stage-tagged reason; files sniffed at other directories during the upward
 *  walk must degrade, never throw. */
export type PlatformFileClassification =
  | PlatformFileResult
  | { kind: "malformed"; reason: string };

/** A definition is identity only; these keys never coexist with `members`. */
const FORBIDDEN_WITH_MEMBERS: readonly string[] = [
  "platform",
  "root",
  "units",
  "overrides",
];

/** Validates + sanitizes the `members`-keyed definition shape. */
function validateDefinition(
  raw: Record<string, unknown>,
): { definition: PlatformDefinition } | { reason: string } {
  for (const key of FORBIDDEN_WITH_MEMBERS) {
    if (raw[key] !== undefined) {
      return { reason: `"${key}" is forbidden alongside "members"` };
    }
  }
  if (typeof raw.name !== "string" || raw.name.length === 0) {
    return {
      reason: `"name" must be a non-empty string when "members" is present`,
    };
  }
  if (!Array.isArray(raw.members) || raw.members.length === 0) {
    return { reason: `"members" must be a non-empty array` };
  }
  const members: Array<{ name: string; path?: string }> = [];
  const seenNames = new Set<string>();
  for (let i = 0; i < raw.members.length; i++) {
    const m: unknown = raw.members[i];
    if (!isPlainObject(m))
      return { reason: `"members[${i}]" must be an object` };
    if (typeof m.name !== "string" || m.name.length === 0) {
      return { reason: `"members[${i}].name" must be a non-empty string` };
    }
    // Everything downstream keys members by name, so a duplicate identity is
    // an authoring error, rejected like any shape violation.
    if (seenNames.has(m.name)) {
      return {
        reason: `"members[${i}].name" duplicates member "${m.name}"`,
      };
    }
    seenNames.add(m.name);
    if (m.path !== undefined) {
      if (typeof m.path !== "string" || m.path.length === 0) {
        return {
          reason: `"members[${i}].path" must be a non-empty string when present`,
        };
      }
    }
    // Copy only known fields explicitly (prototype-pollution guard).
    const out: { name: string; path?: string } = { name: m.name };
    if (typeof m.path === "string") out.path = m.path;
    members.push(out);
  }
  if (raw.ignore !== undefined) {
    if (!Array.isArray(raw.ignore))
      return { reason: `"ignore" must be an array` };
    for (let i = 0; i < raw.ignore.length; i++) {
      if (typeof raw.ignore[i] !== "string") {
        return { reason: `"ignore[${i}]" must be a string` };
      }
    }
  }
  const definition: PlatformDefinition = { name: raw.name, members };
  if (Array.isArray(raw.ignore))
    definition.ignore = raw.ignore.slice() as string[];
  return { definition };
}

/** Validates + sanitizes the `platform`-keyed marker shape, including the
 *  coexisting unit-config keys. `root` defaults to "..". */
function validateMarker(
  raw: Record<string, unknown>,
): { marker: MemberMarker; config: PlatformMapConfig } | { reason: string } {
  if (raw.units !== undefined) {
    return { reason: `"units" is forbidden alongside "platform"` };
  }
  if (typeof raw.platform !== "string" || raw.platform.length === 0) {
    return { reason: `"platform" must be a non-empty string` };
  }
  if (raw.root !== undefined) {
    if (typeof raw.root !== "string" || raw.root.length === 0) {
      return { reason: `"root" must be a non-empty string when present` };
    }
  }
  const reason = validateShape(raw);
  if (reason !== null) return { reason };
  const marker: MemberMarker = {
    platform: raw.platform,
    root: typeof raw.root === "string" ? raw.root : "..",
  };
  return { marker, config: copyKnownFields(raw) };
}

/** Never-throwing classification of `<root>/platform-map.json`: the shared
 *  engine under both the strict readPlatformFile and the resolver's lenient
 *  sniff. Failure reasons match the strict thrown messages byte-for-byte. */
export function classifyPlatformFile(root: string): PlatformFileClassification {
  const p = path.join(root, CONFIG_FILENAME);
  // existsSync separates "truly absent" from "present but unreadable"; a race
  // between the two only downgrades to the read-failure kind, never a skip.
  if (!fs.existsSync(p)) return { kind: "absent" };

  let text: string;
  try {
    text = fs.readFileSync(p, "utf8");
  } catch (e) {
    return {
      kind: "malformed",
      reason: `${CONFIG_FILENAME} at ${CONFIG_FILENAME} could not be read (${fsErrorCode(e)})`,
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return {
      kind: "malformed",
      reason: `${CONFIG_FILENAME} at ${CONFIG_FILENAME} failed to parse as JSON: ${msg(e)}`,
    };
  }

  if (!isPlainObject(raw)) {
    return {
      kind: "malformed",
      reason: `${CONFIG_FILENAME} at ${CONFIG_FILENAME} failed validation: top-level value must be a JSON object`,
    };
  }

  // Shape discrimination, checked in this order.
  if (raw.members !== undefined) {
    const r = validateDefinition(raw);
    if ("reason" in r) {
      return {
        kind: "malformed",
        reason: `${CONFIG_FILENAME} at ${CONFIG_FILENAME} failed validation: ${r.reason}`,
      };
    }
    return { kind: "definition", definition: r.definition };
  }

  if (raw.platform !== undefined) {
    const r = validateMarker(raw);
    if ("reason" in r) {
      return {
        kind: "malformed",
        reason: `${CONFIG_FILENAME} at ${CONFIG_FILENAME} failed validation: ${r.reason}`,
      };
    }
    return { kind: "marker", marker: r.marker, config: r.config };
  }

  const reason = validateShape(raw);
  if (reason !== null) {
    return {
      kind: "malformed",
      reason: `${CONFIG_FILENAME} at ${CONFIG_FILENAME} failed validation: ${reason}`,
    };
  }
  return { kind: "config", config: copyKnownFields(raw) };
}

/** The strict read: classifyPlatformFile with `malformed` escalated to
 *  MalformedConfigError. Absent -> kind "absent"; config is optional forever. */
export function readPlatformFile(root: string): PlatformFileResult {
  const classified = classifyPlatformFile(root);
  if (classified.kind === "malformed") {
    throw new MalformedConfigError(classified.reason);
  }
  return classified;
}

/**
 * Reads and validates the authoritative canonical config: absent -> null,
 * malformed -> throw, valid -> sanitized config. A marker returns its
 * coexisting config; a definition converts members to declared units with
 * `path` defaulting to the member name (the child-dir convention), so a
 * definition rides the existing canonical machinery unchanged.
 */
export function readCanonicalConfig(root: string): PlatformMapConfig | null {
  const result = readPlatformFile(root);
  switch (result.kind) {
    case "absent":
      return null;
    case "config":
      return result.config;
    case "marker":
      return result.config;
    case "definition": {
      const config: PlatformMapConfig = {
        name: result.definition.name,
        units: result.definition.members.map((m) => ({
          name: m.name,
          path: m.path ?? m.name,
        })),
      };
      if (result.definition.ignore !== undefined) {
        config.ignore = result.definition.ignore;
      }
      return config;
    }
  }
}

/** A malformed platform-map.local.json degrades to a diagnostic; per-user
 *  machine state must never brick the map. */
export type ReadLocalConfigResult =
  | { ok: true; config: PlatformLocalConfig }
  | { ok: false; diagnostic: Diagnostic };

function localConfigDiagnostic(detail: string): Diagnostic {
  return {
    code: "MALFORMED_CONFIG",
    severity: "warning",
    path: LOCAL_CONFIG_FILENAME,
    message: `MALFORMED_CONFIG: ${LOCAL_CONFIG_FILENAME} ${detail}`,
  };
}

/**
 * Reads `<root>/platform-map.local.json`, the per-user disk-location override
 * file. Lenient: absent -> null; malformed -> `{ ok: false, diagnostic }`,
 * never a throw. Valid input returns a sanitized PlatformLocalConfig,
 * dangerous keys skipped.
 */
export function readLocalConfig(root: string): ReadLocalConfigResult | null {
  const p = path.join(root, LOCAL_CONFIG_FILENAME);
  if (!fs.existsSync(p)) return null;

  let text: string;
  try {
    text = fs.readFileSync(p, "utf8");
  } catch (e) {
    return {
      ok: false,
      diagnostic: localConfigDiagnostic(
        `could not be read (${fsErrorCode(e)})`,
      ),
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return {
      ok: false,
      diagnostic: localConfigDiagnostic(`failed to parse as JSON: ${msg(e)}`),
    };
  }

  if (!isPlainObject(raw)) {
    return {
      ok: false,
      diagnostic: localConfigDiagnostic(
        "failed validation: top-level value must be a JSON object",
      ),
    };
  }

  const config: PlatformLocalConfig = {};
  if (raw.locations !== undefined) {
    if (!isPlainObject(raw.locations)) {
      return {
        ok: false,
        diagnostic: localConfigDiagnostic(
          `failed validation: "locations" must be an object`,
        ),
      };
    }
    const locations: Record<string, string> = {};
    const src = raw.locations as Record<string, unknown>;
    for (const key of Object.keys(src)) {
      if (DANGEROUS_KEYS.has(key)) continue; // prototype-pollution guard
      const value = src[key];
      if (typeof value !== "string" || value.length === 0) {
        return {
          ok: false,
          diagnostic: localConfigDiagnostic(
            `failed validation: "locations.${key}" must be a non-empty string`,
          ),
        };
      }
      locations[key] = value;
    }
    config.locations = locations;
  }
  return { ok: true, config };
}
