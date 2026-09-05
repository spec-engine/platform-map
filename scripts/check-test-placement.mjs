#!/usr/bin/env node
// Test-placement gate: every *.test.ts sits next to the file it tests, named
// after it (src/map.test.ts tests src/map.ts; bin/platform-map.test.ts tests
// bin/platform-map.ts). Shared fixtures and helpers live in test/, which
// holds no tests. Exit 1 with the offending paths.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKIP = new Set(["node_modules", "dist", ".git", ".factory"]);

function* walk(abs) {
  for (const d of fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (SKIP.has(d.name)) continue;
    const p = path.join(abs, d.name);
    if (d.isDirectory()) yield* walk(p);
    else if (d.isFile()) yield p;
  }
}

const problems = [];
for (const file of walk(repoRoot)) {
  const rel = path.relative(repoRoot, file);
  if (rel.endsWith(".test.ts")) {
    const subject = file.replace(/\.test\.ts$/, ".ts");
    if (!fs.existsSync(subject)) {
      problems.push(`${rel}: no ${path.relative(repoRoot, subject)} beside it (a test is named after the file it tests)`);
    }
  } else if (rel.startsWith("test/") && /\.(test|spec)\.[cm]?[jt]s$/.test(rel)) {
    problems.push(`${rel}: test/ holds fixtures and helpers only; put the test next to the file it tests`);
  }
}

if (problems.length > 0) {
  process.stderr.write(`check-test-placement: ${problems.length} problem(s)\n${problems.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write("check-test-placement: clean\n");
