// A deliberately narrow regex-FREE line-oriented parser for the one
// pnpm-workspace.yaml key platform-map needs: the top-level `packages:`
// block-list. This is NOT a general YAML parser (PRIM-03, D9/zero-dep
// contract): every other pnpm-workspace.yaml setting (catalog,
// onlyBuiltDependencies, overrides, patchedDependencies, ...) is ignored
// verbatim, never misinterpreted.
//
// Security posture (DESIGN.md §6, T-02-YG, T-02-RD): no YAML library
// (gadget-avoidance), and — per 01-RESEARCH.md Pitfall 4 — no regex at all
// in this module. Both the "strip a trailing unquoted `#` comment" step and
// the "is this the `packages:` key" check are done with plain string
// methods and a single linear per-character scan, never a greedy/nested-
// quantifier regex over untrusted input. A malformed or unrecognized shape
// (e.g. flow-sequence `packages: [a, b]`) degrades to a MALFORMED_CONFIG
// diagnostic — this function never throws.

import type { Diagnostic } from "../types.js";

const PACKAGES_KEY = "packages:";
const FIXTURE_PATH = "pnpm-workspace.yaml";

export interface ParsedPnpmWorkspace {
  globs: string[];
  diagnostics: Diagnostic[];
}

/** Strips a trailing `#` comment via a linear, quote-state-tracking char
 *  scan — never a greedy `.*#` regex (ReDoS avoidance, Pitfall 4). A `#`
 *  inside a matching pair of single or double quotes is NOT a comment
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
 * Parses ONLY the top-level `packages:` block-list key out of a
 * pnpm-workspace.yaml file's raw text. All other keys (catalog,
 * onlyBuiltDependencies, overrides, patchedDependencies, ...) are ignored
 * without being misread. Declaration order is preserved (never sorted here
 * — negation-order significance is the caller's concern; the top-level
 * determinism sort lives in serialize.ts only).
 *
 * Never throws: an absent `packages:` key yields an empty glob list with no
 * diagnostics (the file is still a valid pnpm-workspace.yaml signal on its
 * own); a flow-sequence (`packages: [a, b]`) or otherwise unrecognized
 * inline shape degrades to a single MALFORMED_CONFIG diagnostic.
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
    // Anything non-comment after "packages:" on the same line — most
    // commonly a flow-sequence ("[a, b]") — is a shape this narrow parser
    // deliberately does not support.
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
      continue; // blank or comment-only line inside the block — skip, keep scanning
    }
    const indent = leadingWhitespaceCount(stripped);
    if (indent === 0) {
      break; // dedent back to top level — end of the packages: block
    }
    const content = stripped.slice(indent);
    if (!content.startsWith("-")) {
      break; // not a list item — end of the block-list form
    }
    const itemText = content.slice(1).trim();
    globs.push(stripQuotes(itemText));
  }

  return { globs, diagnostics: [] };
}
