// [MODEL-06] The default-branch ref probe: a thin wrapper over boundedExec
// issuing exactly one READ-ONLY, fixed-arg git lookup (no unit name or path
// ever enters argv). On ANY failure it returns `null`, never a fabricated
// literal like 'origin/HEAD': absence of a resolvable default branch is
// honestly `null`. This is the ONLY subprocess in the library; its sole
// caller is map()'s per-unit loop, and only for kind:"repo" units.

import { boundedExec } from "./exec.js";

/**
 * Resolves a repo's default branch by reading its cached `origin/HEAD` symref
 * via a bounded, read-only git lookup in `repoDir`. Returns the bare branch
 * name (`origin/` prefix stripped, e.g. `main`), or `null` on any failure:
 * timeout, missing git binary, nonexistent dir, detached HEAD, no remote, or
 * empty output. Bounded by `timeoutMs` (default 2000ms).
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
