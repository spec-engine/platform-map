#!/usr/bin/env node
// Writes the "Supported ecosystems" table into README.md between its two
// markers, from src/ecosystems.ts. src/ecosystems.test.ts fails when the
// README and the table drift, so run this after editing the table.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { renderEcosystemsTable } from "../src/ecosystems.ts";

const readme = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "README.md",
);
const START = "<!-- ecosystems:start -->";
const END = "<!-- ecosystems:end -->";

const text = fs.readFileSync(readme, "utf8");
const a = text.indexOf(START);
const b = text.indexOf(END);
if (a === -1 || b === -1 || b < a) {
  process.stderr.write(`README.md: expected ${START} before ${END}\n`);
  process.exit(1);
}
const next = `${text.slice(0, a + START.length)}\n${renderEcosystemsTable()}\n${text.slice(b)}`;
if (next !== text) fs.writeFileSync(readme, next);
process.stdout.write(next === text ? "README.md: up to date\n" : "README.md: updated\n");
