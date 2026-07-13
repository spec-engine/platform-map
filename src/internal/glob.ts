// PRIM-01/02, D-12: a deliberately narrow, zero-dep glob subset — the exact
// shapes workspace manifests actually use: literal path segments, `*`
// (matches exactly one segment, with intra-segment `*` wildcarding for
// partial names), `**` (matches zero-or-more segments), and pnpm's leading
// `!negation`. This is NOT a general glob engine (brace expansion, extglob,
// character classes are all explicitly out of scope, per DESIGN.md D9 and
// 01-RESEARCH.md's "Don't Hand-Roll" table).
//
// Security posture (D-12, DESIGN.md §6, T-03-REDOS): matching is
// SEGMENT-BY-SEGMENT using an iterative two-pointer algorithm (the
// generalization, to path segments, of the classic linear-time greedy
// wildcard-matching technique) — never a compiled RegExp, and never
// recursive backtracking over `**`. Compiling `**` to a regex like
// `(.*)+` is exactly the ReDoS class this decision forbids (picomatch
// CVE-2026-33671 is the directly analogous real-world example cited in
// 01-RESEARCH.md Pitfall 4). No `RegExp` literal or constructor call
// appears anywhere in this module.

import type { Diagnostic } from "../types.js";

export interface MatchGlobResult {
  matched: string[];
  diagnostics: Diagnostic[];
}

function splitSegments(p: string): string[] {
  return p.split("/").filter((seg) => seg.length > 0);
}

/**
 * Linear, non-backtracking-exponential wildcard match at the character
 * level within a single segment: `*` matches zero-or-more characters. This
 * is the classic two-pointer greedy algorithm (remember the most recent
 * `*` and a fallback position, advance greedily, backtrack the fallback
 * only on mismatch) — polynomial worst case, never catastrophic, and
 * contains no `RegExp` of any kind.
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
 * Segment-by-segment matcher (D-12): `**` is handled by an iterative
 * two-pointer scan over the segment arrays (the generalization, to whole
 * segments, of the same greedy/fallback technique `wildcardMatchSegment`
 * uses at the character level within one segment) — advancing a position
 * index over path segments, NEVER by compiling `**` to a regex. Worst-case
 * cost is polynomial in (pattern segment count × candidate segment count),
 * never exponential/catastrophic, regardless of how many `**` appear.
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
 * Matches `candidatePaths` against `patterns` (the pnpm-subset: literal
 * segments, `*`, `**`, leading `!negation`). Patterns are processed in
 * DECLARATION ORDER (Pitfall 2): an inclusion pattern is matched against
 * the full `candidatePaths` universe and its matches are added to the
 * accumulated result set; a `!negation` pattern is matched against the
 * CURRENT accumulated set and its matches are removed. Only inclusion
 * patterns with zero matches (against the full candidate universe) emit an
 * `UNMATCHED_PATTERN` diagnostic — a negation pattern that removes nothing
 * is silent (PRIM-02). Returns `matched` sorted in plain code-unit order
 * (sort-at-construction, never locale-aware comparison).
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
