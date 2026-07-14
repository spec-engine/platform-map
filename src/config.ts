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
import type { PlatformMapConfig, Role } from "./types.js";

/** The canonical config filename, always resolved directly under `root`. */
const CONFIG_FILENAME = "platform-map.json";

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

/**
 * Reads and validates `<root>/platform-map.json`, the authoritative canonical
 * config (CFG-01/CFG-02). Three-stage gate:
 *   1. absent           -> null (config optional forever, D8; no throw)
 *   2. present, unread  -> throw MalformedConfigError "... could not be read"
 *   3. present, unparse -> throw MalformedConfigError "... failed to parse as JSON"
 *   4. wrong shape      -> throw MalformedConfigError "... failed validation: <reason>"
 * On success returns a SANITIZED config (known fields only). All thrown messages
 * carry the root-relative filename only, never an absolute path (§5).
 */
export function readCanonicalConfig(root: string): PlatformMapConfig | null {
  const p = path.join(root, CONFIG_FILENAME);
  // The existsSync gate is load-bearing: it separates "truly absent" (no throw)
  // from "present but unreadable" (throw) — a race between the two windows only
  // ever downgrades to the read-failure throw, never a silent skip.
  if (!fs.existsSync(p)) return null;

  let text: string;
  try {
    text = fs.readFileSync(p, "utf8");
  } catch (e) {
    throw new MalformedConfigError(
      `${CONFIG_FILENAME} at ${CONFIG_FILENAME} could not be read: ${msg(e)}`,
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new MalformedConfigError(
      `${CONFIG_FILENAME} at ${CONFIG_FILENAME} failed to parse as JSON: ${msg(e)}`,
    );
  }

  const reason = validateShape(raw);
  if (reason !== null) {
    throw new MalformedConfigError(
      `${CONFIG_FILENAME} at ${CONFIG_FILENAME} failed validation: ${reason}`,
    );
  }

  return copyKnownFields(raw as Record<string, unknown>);
}
