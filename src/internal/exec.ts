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

/**
 * Runs `cmd args` in `cwd`, bounded by `timeoutMs` (default 2000ms). On
 * timeout, sends SIGTERM and resolves `{ stdout:"", ok:false }`. On a
 * missing binary (ENOENT) or any other spawn-time error, resolves
 * `{ stdout:"", ok:false }`. On a clean exit, resolves
 * `{ stdout:<trimmed>, ok: exitCode === 0 }`. Never throws.
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

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve({ stdout: "", ok: false }); // degrades to diagnostic upstream, never throws
    }, timeoutMs);

    child.stdout?.on("data", (d: Buffer) => {
      out += d;
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout: out.trim(), ok: code === 0 });
    });

    child.on("error", () => {
      clearTimeout(timer);
      resolve({ stdout: "", ok: false }); // covers ENOENT — missing binary
    });
  });
}
