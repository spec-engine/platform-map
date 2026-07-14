// SEC-03: the package-name guard. Every package.json `name` that would flow
// into a UnitSignals.packageName is validated here first — an invalid name is
// DROPPED (the packageName signal is omitted) with a MALFORMED_CONFIG
// diagnostic, while the unit itself is KEPT (its identity is its
// platform-relative path, not its npm name; 02-RESEARCH Open Question 2).
//
// Exact analog of internal/path-guard.ts: a pure guard returning
// `{ ok: true, … } | { ok: false, diagnostic }`, header citing the SEC-ID, no
// I/O, never throws. The pattern is the SEC-03 regex verbatim
// (/^@?[a-z0-9][a-z0-9._/-]*$/i): an optional leading scope `@`, a leading
// alphanumeric, then alphanumerics plus the limited punctuation npm names use
// (`.`, `_`, `/`, `-`). It is anchored with a single `*` quantifier — linear,
// never a backtracking/ReDoS shape (T-02-08). Names only ever flow as JSON
// data, never interpolated into a path or a shell.

import type { Diagnostic } from "../types.js";

export type ValidatePackageNameResult =
  | { ok: true; name: string }
  | { ok: false; diagnostic: Diagnostic };

const PACKAGE_NAME_PATTERN = /^@?[a-z0-9][a-z0-9._/-]*$/i;

/**
 * Validates a package.json `name` against the SEC-03 pattern. On success
 * returns the name unchanged; on failure returns a MALFORMED_CONFIG (severity
 * `warning`) diagnostic. Pure, never throws — an invalid name degrades to a
 * dropped signal + diagnostic, never an exception.
 *
 * `locus` is the unit's platform-relative path (WR-01): it is stamped onto the
 * diagnostic's `path` so the failure reports WHICH unit produced it AND so
 * serialize.ts's `compareDiagnostics` (which tie-breaks on severity,code,path)
 * stays total for multiple invalid-name diagnostics — without a locus two such
 * diagnostics collide on the sort key and their order becomes iteration-order
 * dependent.
 */
export function validatePackageName(
  name: string,
  locus?: string,
): ValidatePackageNameResult {
  if (typeof name === "string" && PACKAGE_NAME_PATTERN.test(name)) {
    return { ok: true, name };
  }
  return {
    ok: false,
    diagnostic: {
      code: "MALFORMED_CONFIG",
      severity: "warning",
      path: locus,
      message: `MALFORMED_CONFIG: invalid package name dropped: ${name}`,
    },
  };
}
