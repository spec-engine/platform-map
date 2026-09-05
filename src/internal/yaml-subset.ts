// Reads the `packages:` list out of pnpm-workspace.yaml without a YAML
// library. Only the top-level block-list form is understood; anything else
// is reported as malformed rather than guessed at.

import type { Diagnostic } from "../types.ts";

const KEY = "packages:";
const FILE = "pnpm-workspace.yaml";

export interface ParsedPnpmWorkspace {
  globs: string[];
  diagnostics: Diagnostic[];
}

/** Drops a trailing `# comment`, respecting quotes. */
function stripComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === "#" && !inSingle && !inDouble) return line.slice(0, i);
  }
  return line;
}

function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === "'" && last === "'") || (first === '"' && last === '"')) {
      return value.slice(1, -1);
    }
  }
  return value;
}

function indentOf(line: string): number {
  let n = 0;
  while (n < line.length && (line[n] === " " || line[n] === "\t")) n++;
  return n;
}

export function parsePnpmWorkspacePackages(text: string): ParsedPnpmWorkspace {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => indentOf(l) === 0 && l.startsWith(KEY));
  if (start === -1) return { globs: [], diagnostics: [] };

  const afterKey = stripComment((lines[start] ?? "").slice(KEY.length)).trim();
  if (afterKey.length > 0) {
    return {
      globs: [],
      diagnostics: [
        {
          code: "MALFORMED_FILE",
          severity: "warning",
          subject: FILE,
          message: `${FILE}: "packages:" must be a block list, one "- item" per line`,
        },
      ],
    };
  }

  const globs: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const stripped = stripComment(lines[i] ?? "");
    if (stripped.trim().length === 0) continue;
    const indent = indentOf(stripped);
    if (indent === 0) break;
    const content = stripped.slice(indent);
    if (!content.startsWith("-")) break;
    globs.push(stripQuotes(content.slice(1).trim()));
  }
  return { globs, diagnostics: [] };
}
