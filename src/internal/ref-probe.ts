// MODEL-06, SEC-05: the default-branch ref probe. A THIN wrapper over
// boundedExec (exec.ts header names this as the primitive it layers on) that
// issues exactly one READ-ONLY git ref lookup and maps its result onto the
// Unit.ref contract (string | null). It re-implements none of the timeout /
// kill / stdout-cap logic — boundedExec already owns all of that and already
// collapses every failure mode (timeout, missing binary, non-zero exit) to
// `{ ok:false }`, so this wrapper never throws and never hangs.
//
// DELIBERATE DIVERGENCE FROM DARK FACTORY: on ANY failure this returns `null`,
// never the literal string 'origin/HEAD' (02-RESEARCH.md Anti-Pattern
// "Falling back to a literal ref string"). Absence of a resolvable default
// branch is honestly `null`, not a fabricated ref.
//
// This is the ONLY subprocess in the library (SEC-05). Its sole caller is
// map()'s per-unit loop, and only for kind:"repo" units — workspace-package
// units are never probed. The command is fixed-arg (no sibling name/path ever
// enters argv, T-02-11) and read-only (T-02-12): no state-mutating git verb
// appears anywhere in this module.

import { boundedExec } from "./exec.js";

/**
 * Resolves a repo's default branch by reading its cached `origin/HEAD`
 * symref via a bounded, read-only git lookup in `repoDir`. Returns the bare
 * branch name (the `origin/` prefix stripped, e.g. `origin/main` -> `main`),
 * or `null` on any failure — timeout, missing git binary, nonexistent dir,
 * detached HEAD, no remote, or empty output. Never throws; never hangs
 * (bounded by `timeoutMs`, default 2000ms).
 */
export async function probeRef(
  repoDir: string,
  timeoutMs = 2000,
): Promise<string | null> {
  const r = await boundedExec(
    "git",
    ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    repoDir,
    timeoutMs,
  );
  if (!r.ok || !r.stdout) return null;
  return r.stdout.trim().replace(/^origin\//, "");
}
