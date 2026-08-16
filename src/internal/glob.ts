// A deliberately narrow, zero-dep glob subset, the shapes workspace manifests
// actually use: literal segments, `*` (one segment, with intra-segment
// wildcarding), `**` (zero-or-more segments), and pnpm's leading `!negation`.
// Brace expansion, extglob, and character classes are out of scope. Matching
// is SEGMENT-BY-SEGMENT via an iterative two-pointer algorithm; `**` is never
// compiled to a RegExp (a `(.*)+`-style regex is exactly the ReDoS class this
// forbids). No `RegExp` literal or constructor appears in this module.

import type { Diagnostic } from "../types.js";

export interface MatchGlobResult {
  matched: string[];
  diagnostics: Diagnostic[];
}

function splitSegments(p: string): string[] {
  return p.split("/").filter((seg) => seg.length > 0);
}

/**
 * Character-level wildcard match within one segment: the classic two-pointer
 * greedy algorithm (remember the last `*` and a fallback position, backtrack
 * only the fallback on mismatch); polynomial worst case, no RegExp.
 */
function wildcardMatchSegment(pattern: string, text: string): boolean {
  if (pattern === "*") return true; // the common case: whole-segment wildcard
  let pi = 0;
  let ti = 0;
  let starIdx = -1;
  let match = 0;
  while (ti < text.length) {
    if (pi < pattern.length && pattern[pi] === "*") {
      starIdx = pi;
      match = ti;
      pi++;
    } else if (pi < pattern.length && pattern[pi] === text[ti]) {
      pi++;
      ti++;
    } else if (starIdx !== -1) {
      pi = starIdx + 1;
      match++;
      ti = match;
    } else {
      return false;
    }
  }
  while (pi < pattern.length && pattern[pi] === "*") pi++;
  return pi === pattern.length;
}

/**
 * Segment-level matcher: `**` uses the same iterative greedy/fallback scan
 * generalized to whole segments, NEVER a compiled regex; worst case is
 * polynomial in pattern segments times candidate segments.
 */
function matchSegments(patSegs: string[], candSegs: string[]): boolean {
  let pi = 0;
  let ci = 0;
  let starIdx = -1;
  let matchIdx = 0;
  while (ci < candSegs.length) {
    const patSeg = pi < patSegs.length ? patSegs[pi] : undefined;
    if (patSeg === "**") {
      starIdx = pi;
      matchIdx = ci;
      pi++;
    } else if (
      patSeg !== undefined &&
      wildcardMatchSegment(patSeg, candSegs[ci] ?? "")
    ) {
      pi++;
      ci++;
    } else if (starIdx !== -1) {
      pi = starIdx + 1;
      matchIdx++;
      ci = matchIdx;
    } else {
      return false;
    }
  }
  // A trailing `**` in the pattern matches the zero-segments-remaining case.
  while (pi < patSegs.length && patSegs[pi] === "**") pi++;
  return pi === patSegs.length;
}

function compareCodeUnit(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Matches `candidatePaths` against `patterns` in DECLARATION ORDER: an
 * inclusion pattern matches against the full candidate universe and adds to
 * the accumulated set; a `!negation` matches against the CURRENT accumulated
 * set and removes. Only a zero-match inclusion emits UNMATCHED_PATTERN; a
 * negation removing nothing is silent. `matched` is sorted in plain code-unit
 * order, never locale-aware.
 */
export function matchGlob(
  patterns: string[],
  candidatePaths: string[],
): MatchGlobResult {
  const accumulated = new Set<string>();
  const diagnostics: Diagnostic[] = [];

  for (const pattern of patterns) {
    const isNegation = pattern.startsWith("!");
    const rawPattern = isNegation ? pattern.slice(1) : pattern;
    const patSegs = splitSegments(rawPattern);

    if (isNegation) {
      for (const candidate of accumulated) {
        if (matchSegments(patSegs, splitSegments(candidate))) {
          accumulated.delete(candidate);
        }
      }
      continue;
    }

    let matchCount = 0;
    for (const candidate of candidatePaths) {
      if (matchSegments(patSegs, splitSegments(candidate))) {
        accumulated.add(candidate);
        matchCount++;
      }
    }
    if (matchCount === 0) {
      diagnostics.push({
        code: "UNMATCHED_PATTERN",
        severity: "warning",
        path: pattern,
        message: `UNMATCHED_PATTERN: glob pattern matched nothing: ${pattern}`,
      });
    }
  }

  const matched = Array.from(accumulated).sort(compareCodeUnit);
  return { matched, diagnostics };
}
