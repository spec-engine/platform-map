// Adversarial ReDoS corpus for matchGlob (PRIM-01/02, D-12, 01-RESEARCH.md
// Pitfall 4). None of these are expected to be "realistic" workspace
// manifests — they exist purely to prove the segment-based matcher's
// worst-case cost stays polynomial (never catastrophic/exponential), since
// this library maps arbitrary caller-supplied, potentially-untrusted
// directory trees and their config files (DESIGN.md §6, T-03-REDOS).

// 1. Deeply nested `**/**/**/...` — the exact shape a naive
//    `**` → `(.*)+`-style regex compilation would blow up on.
const deeplyNestedStar = Array(200).fill("**").join("/");

// 2. A very long single pattern — hundreds of literal segments, each
//    innocuous alone, adversarial in aggregate against a naive
//    per-segment-regex-compile approach.
const veryLongLiteralPattern = `${Array(500).fill("segment").join("/")}/*`;

// 3. Long repeated substrings inside a single segment — the classic
//    "evil regex" shape (`/^(a*)*$/`-style catastrophic backtracking bait)
//    reconstructed at the segment-wildcard level: many `*a` repeats
//    matched against a same-length run of `a`s that ultimately fails to
//    match (worst case for a naive backtracking implementation).
const evilWildcardSegment = `a${"*a".repeat(300)}`;
const evilWildcardCandidateSegment = `${"a".repeat(300)}b`; // deliberately fails at the end

// 4. A pathologically long candidate path (many segments) matched against
//    a `**`-only pattern — stresses the segment-level two-pointer scan's
//    "consume one more candidate segment on fallback" path.
const longCandidatePath = Array(500).fill("d").join("/");

export const patterns = [
  deeplyNestedStar,
  veryLongLiteralPattern,
  `packages/${evilWildcardSegment}`,
  "**",
  "!does-not-exist/**",
];

export const candidatePaths = [
  Array(200).fill("x").join("/"), // matches deeplyNestedStar trivially (** matches anything)
  veryLongLiteralPattern.replace(/\*$/, "leaf"),
  `packages/${evilWildcardCandidateSegment}`, // deliberately does NOT match evilWildcardSegment
  longCandidatePath,
  "a/b/c",
];
