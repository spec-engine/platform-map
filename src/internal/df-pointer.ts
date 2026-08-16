// The Dark Factory pointer convention: <dir>/.factory/df-config.json is a bare
// pointer iff it is a plain object with exactly one top-level key `platform`,
// itself a plain object with exactly one key `factoryDir` holding a string.
// Explicit key-count + typeof checks only; the untrusted parsed object is
// never spread (prototype-pollution guard).

import * as fs from "node:fs";
import * as path from "node:path";

export type DfConfigClass = "absent" | "pointer" | "full" | "malformed";

export function isPointerOnly(parsed: unknown): boolean {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return false;
  }
  const obj = parsed as Record<string, unknown>;
  if (Object.keys(obj).length !== 1) return false;
  const platform = obj.platform;
  if (
    platform === null ||
    typeof platform !== "object" ||
    Array.isArray(platform)
  ) {
    return false;
  }
  const p = platform as Record<string, unknown>;
  return Object.keys(p).length === 1 && typeof p.factoryDir === "string";
}

/** Reads and classifies `<dirAbs>/.factory/df-config.json`. Never throws; an
 *  unreadable file classifies as "absent". */
export function classifyDfConfig(dirAbs: string): DfConfigClass {
  const p = path.join(dirAbs, ".factory", "df-config.json");
  let text: string;
  try {
    text = fs.readFileSync(p, "utf8");
  } catch {
    return "absent";
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return "malformed";
  }
  return isPointerOnly(parsed) ? "pointer" : "full";
}
