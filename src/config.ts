// CFG-02 / SEC-01: the hand-rolled, ZERO-dependency canonical-config validator.
// `readCanonicalConfig` is the ONE hard-error path in the library besides
// RootNotFoundError: a PRESENT `platform-map.json` that cannot be read, parsed,
// or shape-validated throws MalformedConfigError with a DISTINCT location-tagged
// message per stage (read / parse / validate). An ABSENT file returns `null`
// (config is optional forever, D8). Adapter source files NEVER throw — they
// degrade to MALFORMED_CONFIG diagnostics; canonical is the sole exception.
//
// Deliberately NOT here:
//  - the overrides-references-a-real-unit check. The validator cannot know the
//    assembled unit set, so that honesty check lives in map() after assembly
//    (Assumption A3). Here we validate only the SHAPE of overrides.
//  - any dependency (no zod): the shape checks are hand-rolled, mirroring the
//    object-shape guard of detect.ts's readJsonObject (L54-73).
//  - absolute paths in thrown messages: the file is always <root>/platform-map.json
//    so the message carries the fixed root-relative name, never the absolute path
//    (errors.ts §5 discipline).

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

/** The canonical config filename, always resolved directly under `root`. */
const CONFIG_FILENAME = "platform-map.json";

/** The per-user local location-override filename (RED-97 IP-1, D-02). */
const LOCAL_CONFIG_FILENAME = "platform-map.local.json";

/** The valid `Role` values a per-unit override may declare (types.ts). */
const ROLE_VALUES: ReadonlySet<string> = new Set<Role>([
  "library",
  "app",
  "unknown",
]);

/** Object keys that must never be copied from untrusted parsed input — assigning
 *  them onto a plain object is the classic prototype-pollution sink (T-02-16). */
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

/** WR-01: extracts ONLY the errno code from an fs error. Node interpolates the
 *  ABSOLUTE file path into fs error messages (`EACCES ... open '/Users/...'`),
 *  so `e.message` must never reach a reason string that can land in
 *  `pm.diagnostics` (D-02/§5: member names and root-relative paths only). */
function fsErrorCode(e: unknown): string {
  if (e instanceof Error && "code" in e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (typeof code === "string" && code.length > 0) return code;
  }
  return "unknown";
}

/**
 * Hand-rolled strict shape check over the KNOWN keys of PlatformMapConfig.
 * Returns a human-readable reason string on the first violation, or `null` when
 * the shape is valid. Unknown top-level keys are IGNORED (forward-compat) — only
 * known-key shapes are validated. Reads (never spreads) the parsed object.
 */
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

/**
 * Builds a sanitized PlatformMapConfig copying ONLY known fields explicitly from
 * the (already shape-validated) parsed object — never spreads untrusted keys
 * (prototype-pollution guard, T-02-16) and drops unknown top-level keys
 * (forward-compat). Dangerous override keys (__proto__/constructor/prototype)
 * are skipped so they can never reach a plain-object assignment sink.
 */
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

// ── RED-97 (IP-1): the discriminated platform-map.json shapes ──────────────
// One filename, three deterministically distinguishable shapes, discriminated
// by key presence IN THIS ORDER: `members` present -> platform definition;
// else `platform` present -> member marker; else -> unit-level config (today's
// shape, byte-for-byte unchanged behavior).

/** The strict discriminated read result (readPlatformFile). The marker kind
 *  also carries the coexisting sanitized rung-1/2 config — `name`/`ignore`/
 *  `overrides` keep their meaning when the member maps standalone (fallback). */
export type PlatformFileResult =
  | { kind: "absent" }
  | { kind: "config"; config: PlatformMapConfig }
  | { kind: "marker"; marker: MemberMarker; config: PlatformMapConfig }
  | { kind: "definition"; definition: PlatformDefinition };

/** The lenient classification: PlatformFileResult plus a never-throwing
 *  `malformed` kind carrying the stage-tagged reason (the exact message the
 *  strict reader would have thrown). Consumed by the upward resolver's sniff,
 *  where files at OTHER directories must degrade, never throw (IP-3/IP-8). */
export type PlatformFileClassification =
  | PlatformFileResult
  | { kind: "malformed"; reason: string };

/** Keys forbidden alongside `members` (IP-1 shape 1): a definition is identity
 *  only — it never doubles as a marker or a unit-level config. */
const FORBIDDEN_WITH_MEMBERS: readonly string[] = [
  "platform",
  "root",
  "units",
  "overrides",
];

/** Validates + sanitizes the `members`-keyed definition shape. Returns a
 *  reason string on the first violation (config.ts three-stage style). */
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
  for (let i = 0; i < raw.members.length; i++) {
    const m: unknown = raw.members[i];
    if (!isPlainObject(m))
      return { reason: `"members[${i}]" must be an object` };
    if (typeof m.name !== "string" || m.name.length === 0) {
      return { reason: `"members[${i}].name" must be a non-empty string` };
    }
    if (m.path !== undefined) {
      if (typeof m.path !== "string" || m.path.length === 0) {
        return {
          reason: `"members[${i}].path" must be a non-empty string when present`,
        };
      }
    }
    // Copy only known fields explicitly (prototype-pollution guard, T-02-16).
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
 *  coexisting rung-1/2 config keys (name/ignore/overrides — validated with the
 *  exact unit-config rules). `root` defaults to ".." (D-03). */
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
  // The coexisting rung-1/2 keys keep their meaning when the member maps
  // standalone (fallback path) — validate them with the unit-config rules
  // (`units` is already excluded above, so validateShape sees none).
  const reason = validateShape(raw);
  if (reason !== null) return { reason };
  const marker: MemberMarker = {
    platform: raw.platform,
    root: typeof raw.root === "string" ? raw.root : "..",
  };
  return { marker, config: copyKnownFields(raw) };
}

/**
 * Reads and classifies `<root>/platform-map.json` WITHOUT throwing (the shared
 * engine under both the strict readPlatformFile and the resolver's lenient
 * sniff). Stage-tagged failure reasons match the strict thrown messages
 * byte-for-byte; all messages carry the fixed root-relative filename only,
 * never an absolute path (§5).
 */
export function classifyPlatformFile(root: string): PlatformFileClassification {
  const p = path.join(root, CONFIG_FILENAME);
  // The existsSync gate is load-bearing: it separates "truly absent" from
  // "present but unreadable" — a race between the two windows only ever
  // downgrades to the read-failure classification, never a silent skip.
  if (!fs.existsSync(p)) return { kind: "absent" };

  let text: string;
  try {
    text = fs.readFileSync(p, "utf8");
  } catch (e) {
    return {
      kind: "malformed",
      // Code only — never the fs error message, which embeds the absolute
      // path (WR-01); this reason can reach pm.diagnostics via the resolver.
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

  // IP-1 discrimination, checked in this order.
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

/**
 * The STRICT discriminated read of `<root>/platform-map.json` (RED-97 IP-1):
 * same three-stage read/parse/validate MalformedConfigError discipline as
 * readCanonicalConfig always had, extended with the definition/marker
 * discrimination and forbidden-key-combination reasons. Absent -> kind
 * "absent" (config is optional forever, D8).
 */
export function readPlatformFile(root: string): PlatformFileResult {
  const classified = classifyPlatformFile(root);
  if (classified.kind === "malformed") {
    throw new MalformedConfigError(classified.reason);
  }
  return classified;
}

/**
 * Reads and validates `<root>/platform-map.json`, the authoritative canonical
 * config (CFG-01/CFG-02). Three-stage gate:
 *   1. absent           -> null (config optional forever, D8; no throw)
 *   2. present, unread  -> throw MalformedConfigError "... could not be read"
 *   3. present, unparse -> throw MalformedConfigError "... failed to parse as JSON"
 *   4. wrong shape      -> throw MalformedConfigError "... failed validation: <reason>"
 * On success returns a SANITIZED config (known fields only). All thrown messages
 * carry the root-relative filename only, never an absolute path (§5).
 *
 * RED-97: implemented over readPlatformFile so unit-level config behavior is
 * byte-for-byte unchanged. A marker returns its coexisting rung-1/2 config
 * (fallback path). A DEFINITION converts members to declared units with `path`
 * defaulting to the member name (the child-dir convention) and carries
 * name/ignore — this is the D-05 canonical-rank reuse: a definition rides the
 * existing canonical machinery (declared units gate sibling promotion, D-04)
 * with zero merge changes.
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

/** The lenient local-config read result (readLocalConfig): a malformed or
 *  wrong-shaped `platform-map.local.json` degrades to a diagnostic-shaped
 *  failure — per-user machine state must never brick the map (IP-1). */
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
 * Reads `<root>/platform-map.local.json` (RED-97 IP-1, D-02): the per-user
 * disk-location override file. LENIENT — absent returns null; a malformed
 * read/parse/shape returns `{ ok: false, diagnostic }` (a MALFORMED_CONFIG
 * warning carrying the fixed root-relative filename, never an absolute path)
 * and NEVER throws. Valid input returns a sanitized PlatformLocalConfig with
 * dangerous keys (__proto__/constructor/prototype) silently skipped.
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
      // Code only — never the fs error message (absolute-path leak, WR-01).
      diagnostic: localConfigDiagnostic(`could not be read (${fsErrorCode(e)})`),
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
