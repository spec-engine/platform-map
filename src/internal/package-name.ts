// [SEC-03] The package-name guard: every package.json `name` that would flow
// into UnitSignals.packageName is validated here first. An invalid name is
// DROPPED (the signal is omitted) with a MALFORMED_CONFIG diagnostic while
// the unit itself is KEPT; unit identity is its platform-relative path, not
// its npm name. The pattern allows an optional leading `@` scope, a leading
// alphanumeric, then alphanumerics plus `.`, `_`, `/`, `-`; anchored with a
// single `*` quantifier, so matching is linear, never a backtracking shape.
// Names only ever flow as JSON data, never into a path or a shell.

import type { Diagnostic } from "../types.js";

export type ValidatePackageNameResult =
  | { ok: true; name: string }
  | { ok: false; diagnostic: Diagnostic };

const PACKAGE_NAME_PATTERN = /^@?[a-z0-9][a-z0-9._/-]*$/i;

/**
 * Validates a package.json `name`. On success returns the name unchanged; on
 * failure returns a MALFORMED_CONFIG (warning) diagnostic instead of throwing.
 * `locus` (the unit's platform-relative path) is stamped onto the diagnostic's
 * `path` so the failure names its unit and so the diagnostic sort key
 * (severity, code, path) stays total when multiple invalid names occur.
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
