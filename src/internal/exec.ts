// [SEC-04] Bounded subprocess exec: `spawn` + a manual timer + explicit
// `kill('SIGTERM')`, rather than `child_process.exec`'s built-in timeout, for
// reliable cross-platform kill semantics and explicit cleanup control. This is
// the primitive the git ref probe layers on: one hostile/slow/networked child
// must never hang the caller.

import { spawn } from "node:child_process";

export interface BoundedExecResult {
  stdout: string;
  ok: boolean;
}

// Caps accumulated stdout so a misbehaving child cannot grow `out` unbounded
// within the timeout window.
const MAX_STDOUT_BYTES = 64 * 1024;

// Grace period between SIGTERM and a follow-up SIGKILL for a timed-out child
// that traps or ignores SIGTERM.
const SIGKILL_GRACE_MS = 500;

/**
 * Runs `cmd args` in `cwd`, bounded by `timeoutMs` (default 2000ms). On
 * timeout, resolves `{ stdout:"", ok:false }` immediately and sends SIGTERM,
 * escalating to SIGKILL after a grace period as fire-and-forget cleanup. A
 * spawn-time error (including a missing binary) also resolves
 * `{ stdout:"", ok:false }`; a clean exit resolves
 * `{ stdout:<trimmed>, ok: exitCode === 0 }`. Always resolves, never rejects.
 */
export function boundedExec(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs = 2000,
): Promise<BoundedExecResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      // Defense-in-depth: the promise resolves now; this only keeps an
      // orphaned child from lingering.
      killTimer = setTimeout(() => child.kill("SIGKILL"), SIGKILL_GRACE_MS);
      killTimer.unref();
      resolve({ stdout: "", ok: false });
    }, timeoutMs);

    child.stdout?.on("data", (d: Buffer) => {
      // The chunk crossing the cap is TRUNCATED, not appended whole: pipe
      // chunk sizes are platform-dependent, so an append-then-stop cap would
      // make the capped length environment-dependent.
      if (out.length < MAX_STDOUT_BYTES) {
        out = (out + d).slice(0, MAX_STDOUT_BYTES);
      }
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({ stdout: out.trim(), ok: code === 0 });
    });

    child.on("error", () => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({ stdout: "", ok: false }); // covers ENOENT (missing binary)
    });
  });
}
