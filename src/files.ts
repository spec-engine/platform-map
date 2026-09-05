// Reading and writing the three files platform-map knows about: the
// platform file, the leaf marker (both named platform-map.json), and the
// per-user platforms.json. Readers never throw; a broken file comes back as
// a diagnostic.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  Diagnostic,
  LeafMarker,
  Options,
  PlatformFile,
  UserConfig,
} from "./types.ts";

export const PLATFORM_FILE = "platform-map.json";

export type PlatformFileRead =
  | { kind: "absent" }
  | { kind: "platform"; file: PlatformFile }
  | { kind: "marker"; marker: LeafMarker }
  | { kind: "invalid"; diagnostic: Diagnostic };

export function exists(p: string): boolean {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

export function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Parses a JSON file into a plain object. Returns null when the file is
 *  absent, and a reason string when it is present but not a JSON object. */
export type JsonObjectRead =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; reason: string };

export function readJsonObject(file: string): JsonObjectRead | null {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return { ok: false, reason: "not a JSON object" };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

function malformed(subject: string, reason: string): Diagnostic {
  return {
    code: "MALFORMED_FILE",
    severity: "error",
    subject,
    message: `${subject}: ${reason}`,
  };
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

function isName(v: unknown): v is string {
  return typeof v === "string" && NAME_PATTERN.test(v);
}

/** Reads `<dir>/platform-map.json` and says which of the two shapes it is.
 *  A file with `members` is the platform file; a file with `platform` is a
 *  leaf marker; anything else is invalid. `subject` names the file for
 *  diagnostics, relative to wherever the caller is reporting from. */
export function readPlatformFile(
  dir: string,
  subject: string = PLATFORM_FILE,
): PlatformFileRead {
  const read = readJsonObject(path.join(dir, PLATFORM_FILE));
  if (read === null) return { kind: "absent" };
  if (!read.ok)
    return { kind: "invalid", diagnostic: malformed(subject, read.reason) };
  const obj = read.value;

  if ("members" in obj) {
    if (!isName(obj.name)) {
      return {
        kind: "invalid",
        diagnostic: malformed(subject, '"name" must be a simple name'),
      };
    }
    if (!Array.isArray(obj.members) || !obj.members.every(isName)) {
      return {
        kind: "invalid",
        diagnostic: malformed(
          subject,
          '"members" must be an array of directory names',
        ),
      };
    }
    if (
      obj.ignore !== undefined &&
      (!Array.isArray(obj.ignore) ||
        !obj.ignore.every((s) => typeof s === "string"))
    ) {
      return {
        kind: "invalid",
        diagnostic: malformed(subject, '"ignore" must be an array of strings'),
      };
    }
    const file: PlatformFile = {
      name: obj.name,
      members: [...obj.members].sort(),
    };
    if (obj.ignore !== undefined) file.ignore = obj.ignore as string[];
    return { kind: "platform", file };
  }

  if ("platform" in obj) {
    if (!isName(obj.platform)) {
      return {
        kind: "invalid",
        diagnostic: malformed(subject, '"platform" must be a simple name'),
      };
    }
    if (obj.member !== undefined && !isName(obj.member)) {
      return {
        kind: "invalid",
        diagnostic: malformed(subject, '"member" must be a simple name'),
      };
    }
    const marker: LeafMarker = { platform: obj.platform };
    if (obj.member !== undefined) marker.member = obj.member;
    return { kind: "marker", marker };
  }

  return {
    kind: "invalid",
    diagnostic: malformed(
      subject,
      'expected either "members" (platform file) or "platform" (leaf marker)',
    ),
  };
}

export function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

// ── The per-user file ─────────────────────────────────────────────────────

export function userConfigPath(options: Options = {}): string {
  return (
    options.userConfigPath ??
    process.env.PLATFORM_MAP_CONFIG ??
    path.join(os.homedir(), ".config", "platform-map", "platforms.json")
  );
}

export function readUserConfig(options: Options = {}): {
  config: UserConfig;
  diagnostic?: Diagnostic;
} {
  const file = userConfigPath(options);
  const read = readJsonObject(file);
  if (read === null) return { config: {} };
  const subject = path.basename(file);
  if (!read.ok) {
    return {
      config: {},
      diagnostic: { ...malformed(subject, read.reason), severity: "warning" },
    };
  }
  const config: UserConfig = {};
  for (const [name, entry] of Object.entries(read.value)) {
    if (
      entry === null ||
      typeof entry !== "object" ||
      typeof (entry as Record<string, unknown>).root !== "string"
    ) {
      return {
        config: {},
        diagnostic: {
          ...malformed(
            subject,
            `entry "${name}" must be { root: string, members?: object }`,
          ),
          severity: "warning",
        },
      };
    }
    const e = entry as { root: string; members?: unknown };
    const out: UserConfig[string] = { root: e.root };
    if (
      e.members !== undefined &&
      e.members !== null &&
      typeof e.members === "object"
    ) {
      const members: Record<string, string> = {};
      for (const [m, p] of Object.entries(
        e.members as Record<string, unknown>,
      )) {
        if (typeof p === "string") members[m] = p;
      }
      out.members = members;
    }
    config[name] = out;
  }
  return { config };
}

export function writeUserConfig(
  config: UserConfig,
  options: Options = {},
): string {
  const file = userConfigPath(options);
  writeJson(file, config);
  return file;
}
