#!/usr/bin/env node
// Public-docs jargon gate. Fails when a public-facing file (README, principles,
// requirements, docs, source, tests, CI, scripts) cites private tooling,
// private ticket IDs, or planning artifacts that do not live in this repo.
// Zero-dep, Node built-ins only. Exit 1 with file:line on any hit.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const ROOTS = [
  "README.md",
  "PRINCIPLES.md",
  "REQUIREMENTS.md",
  "package.json",
  "tsdown.config.ts",
  "docs",
  "src",
  "bin",
  "scripts",
  "test",
  "test-bun",
  ".github",
];
const EXCLUDE_DIRS = new Set(["node_modules", "dist", ".factory"]);
const EXCLUDE_FILES = new Set(["scripts/check-public-docs.mjs"]);
const TEXT_EXT = new Set([".md", ".ts", ".js", ".mjs", ".cjs", ".json", ".yml", ".yaml", ".html"]);

const RULES = [
  { re: /\b(DF|SE|CA)\b/, why: "bare private-tool abbreviation" },
  { re: /\bClarity Audit\b/, why: "private tool" },
  { re: /\bRED-\d+\b/, why: "private ticket id" },
  { re: /\bD-\d{2}\b|\bD(?:[1-9]|10)\b(?=[^a-z])/, why: "private decision id" },
  { re: /\b(CFG|CLI|SEC|MODEL|DET|TEST|IDENT|GRAPH|WR|CR|PRIM|BUILD|PUB|DETR|RUNG1|PLATFORM)-\d{2}\b/, why: "private task id" },
  { re: /\bIP-\d\b/, why: "private task id" },
  { re: /\bT-\d{2}(?:\.\d{2})?-\d{2}\b/, why: "private task id" },
  { re: /\b\d{2}(?:-\d{2})?-(?:RESEARCH|LEARNINGS|SUMMARY|PLAN)\.md\b/, why: "untracked planning artifact" },
  { re: /\bBRIEF(?:\.md| §)|\bDESIGN(?:\.md| §)/, why: "moved to docs/internal (history only)" },
  { re: /\bthree-bucket\b|\bNO_SPEC_CONFIG\b/, why: "another product's vocabulary" },
];

function* walk(abs) {
  const st = fs.statSync(abs);
  if (st.isFile()) {
    if (TEXT_EXT.has(path.extname(abs))) yield abs;
    return;
  }
  for (const name of fs.readdirSync(abs).sort()) {
    if (EXCLUDE_DIRS.has(name)) continue;
    yield* walk(path.join(abs, name));
  }
}

const hits = [];
for (const root of ROOTS) {
  const abs = path.join(repoRoot, root);
  if (!fs.existsSync(abs)) continue;
  for (const file of walk(abs)) {
    if (EXCLUDE_FILES.has(path.relative(repoRoot, file))) continue;
    const lines = fs.readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      for (const rule of RULES) {
        if (rule.re.test(line)) {
          hits.push(`${path.relative(repoRoot, file)}:${i + 1}: [${rule.why}] ${line.trim()}`);
          break;
        }
      }
    });
  }
}

if (hits.length > 0) {
  process.stderr.write(`check-public-docs: ${hits.length} hit(s)\n${hits.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write("check-public-docs: clean\n");
