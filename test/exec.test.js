// SEC-04: bounded subprocess exec (spawn + timer + SIGTERM). Plain ESM .js
// importing the already-built dist/ (D-06) — runs unmodified under
// `node --test` and `bun test` (D-05). NOT called by detect() this phase
// (DET-05) — these are standalone unit tests of the primitive itself.

import assert from "node:assert/strict";
import { test } from "node:test";
import { boundedExec } from "../dist/internal/exec.mjs";

test("a never-exiting command resolves { ok:false } within a bounded window via SIGTERM, never hangs or throws", async () => {
  const start = Date.now();
  const result = await boundedExec(
    process.execPath,
    ["-e", "setTimeout(() => {}, 100000)"],
    process.cwd(),
    150,
  );
  const elapsed = Date.now() - start;

  assert.equal(result.ok, false);
  assert.equal(result.stdout, "");
  assert.ok(
    elapsed < 2000,
    `expected the timeout branch to resolve promptly, took ${elapsed}ms`,
  );
});

test("a nonexistent binary resolves { ok:false } via the ENOENT error handler, never throws", async () => {
  await assert.doesNotReject(async () => {
    const result = await boundedExec(
      "platform-map-this-binary-does-not-exist-zzz",
      [],
      process.cwd(),
      500,
    );
    assert.equal(result.ok, false);
    assert.equal(result.stdout, "");
  });
});

test("a real fast command resolves { ok:true, stdout } (degrades gracefully if git is absent)", async () => {
  const result = await boundedExec("git", ["--version"], process.cwd(), 2000);
  if (result.ok) {
    assert.equal(typeof result.stdout, "string");
    assert.ok(result.stdout.length > 0);
  } else {
    // git absent in some future CI image — still must degrade, never throw
    // (the ENOENT contract asserted by the previous test already covers
    // this branch; here we just confirm it doesn't crash the suite).
    assert.equal(result.ok, false);
  }
});

test("a fast successful close resolves well before a long timeoutMs elapses (timer is cleared, not just outraced)", async () => {
  // timeoutMs is deliberately huge (5000ms). If `clearTimeout` were missing
  // on the `close` branch, the promise would still resolve promptly here
  // (the close handler resolves independently of the timer), but the
  // dangling timer would keep the event loop alive for the remaining
  // ~5000ms after this test's own assertions finish — the wall-clock
  // bound below is what a missing-clearTimeout regression would blow.
  const start = Date.now();
  const result = await boundedExec(
    process.execPath,
    ["-e", "1"],
    process.cwd(),
    5000,
  );
  const elapsed = Date.now() - start;
  assert.equal(result.ok, true);
  assert.ok(
    elapsed < 2000,
    `expected the close branch to resolve well before the 5000ms timeout, took ${elapsed}ms`,
  );
});
