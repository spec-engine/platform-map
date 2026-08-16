// A deliberately narrow, regex-FREE line parser for the one
// pnpm-workspace.yaml key platform-map needs: the top-level `packages:`
// block-list. Not a general YAML parser: every other key is ignored verbatim,
// never misinterpreted. No YAML library (gadget avoidance) and no regex at
// all: comment stripping and key matching use plain string methods and a
// single linear per-character scan, so untrusted input can never trigger
// backtracking. Unrecognized shapes degrade to a MALFORMED_CONFIG diagnostic.

import type { Diagnostic } from "../types.js";

const PACKAGES_KEY = "packages:";
const FIXTURE_PATH = "pnpm-workspace.yaml";

export interface ParsedPnpmWorkspace {
  globs: string[];
  diagnostics: Diagnostic[];
}

/** Strips a trailing `#` comment via a linear quote-state-tracking scan; a
 *  `#` inside a matching pair of single or double quotes is NOT a comment
 *  start. */
function stripComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (ch === "#" && !inSingle && !inDouble) {
      return line.slice(0, i);
    }
  }
  return line;
}

/** Strips one layer of matching surrounding quotes (single or double).
 *  Leaves unquoted or mismatched-quote values untouched. */
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

function leadingWhitespaceCount(line: string): number {
  let count = 0;
  while (count < line.length && (line[count] === " " || line[count] === "\t")) {
    count++;
  }
  return count;
}

function malformed(reason: string): Diagnostic {
  return {
    code: "MALFORMED_CONFIG",
    severity: "warning",
    path: FIXTURE_PATH,
    message: `MALFORMED_CONFIG: ${FIXTURE_PATH} ${reason}`,
  };
}

/**
 * Parses ONLY the top-level `packages:` block-list key out of raw
 * pnpm-workspace.yaml text, preserving declaration order (negation order is
 * significant to the caller). An absent `packages:` key yields an empty glob
 * list with no diagnostics; a flow-sequence (`packages: [a, b]`) or other
 * unrecognized inline shape degrades to a single MALFORMED_CONFIG diagnostic.
 */
export function parsePnpmWorkspacePackages(text: string): ParsedPnpmWorkspace {
  const lines = text.split("\n");

  let packagesLineIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    // Top-level key: zero leading whitespace, literal "packages:" prefix.
    if (leadingWhitespaceCount(line) === 0 && line.startsWith(PACKAGES_KEY)) {
      packagesLineIndex = i;
      break;
    }
  }

  if (packagesLineIndex === -1) {
    return { globs: [], diagnostics: [] };
  }

  const headerLine = lines[packagesLineIndex] ?? "";
  const afterKey = stripComment(headerLine.slice(PACKAGES_KEY.length)).trim();

  if (afterKey.length > 0) {
    // Non-comment content after "packages:" on the same line (most commonly a
    // flow-sequence) is a shape this parser deliberately does not support.
    return {
      globs: [],
      diagnostics: [
        malformed(
          'packages: must be a block-list ("- item" per line); flow-sequence/inline form is not supported',
        ),
      ],
    };
  }

  const globs: string[] = [];
  for (let i = packagesLineIndex + 1; i < lines.length; i++) {
    const rawLine = lines[i] ?? "";
    const stripped = stripComment(rawLine);
    if (stripped.trim().length === 0) {
      continue; // blank or comment-only line inside the block: skip, keep scanning
    }
    const indent = leadingWhitespaceCount(stripped);
    if (indent === 0) {
      break; // dedent back to top level: end of the packages: block
    }
    const content = stripped.slice(indent);
    if (!content.startsWith("-")) {
      break; // not a list item: end of the block-list form
    }
    const itemText = content.slice(1).trim();
    globs.push(stripQuotes(itemText));
  }

  return { globs, diagnostics: [] };
}
