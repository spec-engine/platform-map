// A small glob matcher for workspace manifests: literal segments, `*`,
// `**`, and a leading `!` to exclude. Matching is segment by segment with
// no regular expressions, so hostile patterns cannot cause backtracking.

import type { Diagnostic } from "../types.ts";

export interface MatchGlobResult {
  matched: string[];
  diagnostics: Diagnostic[];
}

function splitSegments(p: string): string[] {
  return p.split("/").filter((seg) => seg.length > 0);
}

/** `*` within one segment, two-pointer greedy scan. */
function wildcardMatchSegment(pattern: string, text: string): boolean {
  if (pattern === "*") return true;
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

/** `**` across segments, same greedy scan one level up. */
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
  while (pi < patSegs.length && patSegs[pi] === "**") pi++;
  return pi === patSegs.length;
}

function compare(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Applies `patterns` in order to `candidatePaths`. An inclusion adds its
 * matches; a `!pattern` removes from what has been added so far. An inclusion
 * that matches nothing yields an UNMATCHED_PATTERN diagnostic. The result is
 * sorted with plain string comparison.
 */
export function matchGlob(
  patterns: string[],
  candidatePaths: string[],
): MatchGlobResult {
  const accumulated = new Set<string>();
  const diagnostics: Diagnostic[] = [];

  for (const pattern of patterns) {
    const isNegation = pattern.startsWith("!");
    const patSegs = splitSegments(isNegation ? pattern.slice(1) : pattern);

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
        severity: "info",
        subject: pattern,
        message: `workspace pattern matched no package: ${pattern}`,
      });
    }
  }

  return { matched: Array.from(accumulated).sort(compare), diagnostics };
}
