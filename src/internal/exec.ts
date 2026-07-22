// SEC-04, D-11: a bounded subprocess exec — `spawn` + a manual timer +
// explicit `kill('SIGTERM')`, rather than trusting `child_process.exec`'s
// built-in timeout (more reliable cross-platform kill semantics and
// explicit cleanup control, per 01-RESEARCH.md's "Don't Hand-Roll" table).
// This is DF's own existing, tested pattern (T-03.05-04), ported here, not
// reinvented.
//
// This is the primitive Phase 2's siblings adapter will layer a git
// origin/HEAD probe on top of — one hostile/slow/networked git invocation
// must never hang the caller (DESIGN.md §5, "one hostile sibling must
// never hang the map"). Built and unit-tested standalone here; NOT called
// by `detect()` in this phase (DET-05 stays intact — no subprocess import
// anywhere in `detect.ts`'s call graph).
//
// Never throws, never hangs: a timeout resolves `{ ok:false }` (after
// SIGTERM), and the `error` event (covers ENOENT — missing binary) also
// resolves `{ ok:false }`. The timer is always cleared on `close`/`error`
// so no dangling timer keeps the process alive. Only `node:child_process`
// is imported — no `import.meta.url`/`__dirname` (D-04).

import { spawn } from "node:child_process";

export interface BoundedExecResult {
  stdout: string;
  ok: boolean;
}

// WR-03: caps accumulated stdout so a hostile/misbehaving child can't grow
// `out` unbounded within the timeout window — resource exhaustion is part
// of this primitive's own stated threat model (see header comment above).
const MAX_STDOUT_BYTES = 64 * 1024;

// WR-04: grace period between SIGTERM and a follow-up SIGKILL if a timed-out
// child ignores SIGTERM (common for subprocesses that trap signals, or are
// themselves hung in an uninterruptible state).
const SIGKILL_GRACE_MS = 500;

/**
 * Runs `cmd args` in `cwd`, bounded by `timeoutMs` (default 2000ms). On
 * timeout, sends SIGTERM (escalating to SIGKILL after a short grace period
 * if the child doesn't exit) and resolves `{ stdout:"", ok:false }`
 * immediately — the escalation is fire-and-forget cleanup, it never delays
 * the resolved promise. On a missing binary (ENOENT) or any other
 * spawn-time error, resolves `{ stdout:"", ok:false }`. On a clean exit,
 * resolves `{ stdout:<trimmed>, ok: exitCode === 0 }`. Never throws.
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
      // The promise has already resolved by the time this fires, so this
      // is purely defense-in-depth against an orphaned process lingering
      // with its stdout/close/error listeners still attached.
      killTimer = setTimeout(() => child.kill("SIGKILL"), SIGKILL_GRACE_MS);
      killTimer.unref();
      resolve({ stdout: "", ok: false }); // degrades to diagnostic upstream, never throws
    }, timeoutMs);

    child.stdout?.on("data", (d: Buffer) => {
      // WR-03: the chunk that crosses the cap is TRUNCATED, not appended
      // whole — pipe chunk sizes are platform-dependent (Linux delivers
      // bigger chunks than macOS), so an append-then-stop cap overshoots by
      // up to one chunk on some platforms and made the capped length
      // environment-dependent.
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
      resolve({ stdout: "", ok: false }); // covers ENOENT — missing binary
    });
  });
}
