import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { gitRepo, rm, tmpDir, write } from "../test/helpers.ts";
import { discover } from "./discover.ts";

test("a child counts as a repository with a .git entry or a package.json", () => {
  const dir = tmpDir();
  try {
    gitRepo(path.join(dir, "with-git"));
    write(path.join(dir, "with-git-file", ".git"), "gitdir: ../somewhere");
    write(path.join(dir, "with-package", "package.json"), {});
    fs.mkdirSync(path.join(dir, "plain-folder"));
    fs.mkdirSync(path.join(dir, "node_modules", "x"), { recursive: true });
    gitRepo(path.join(dir, ".hidden"));
    write(path.join(dir, "a-file.txt"), "");
    assert.deepEqual(
      discover(dir).map((c) => [c.name, c.hasGit, c.hasPackageJson]),
      [
        ["with-git", true, false],
        ["with-git-file", true, false],
        ["with-package", false, true],
      ],
    );
  } finally {
    rm(dir);
  }
});

test("candidates report their marker and whether the platform file lists them", () => {
  const dir = tmpDir();
  try {
    write(path.join(dir, "platform-map.json"), {
      name: "p",
      members: ["a"],
      ignore: ["skip"],
    });
    gitRepo(path.join(dir, "a"));
    write(path.join(dir, "a", "platform-map.json"), { platform: "p" });
    gitRepo(path.join(dir, "b"));
    write(path.join(dir, "b", "platform-map.json"), { platform: "other" });
    gitRepo(path.join(dir, "skip"));
    gitRepo(path.join(dir, "also-skip"));
    assert.deepEqual(
      discover(dir, { ignore: ["also-skip"] }).map((c) => [
        c.name,
        c.listed,
        c.marker,
      ]),
      [
        ["a", true, "p"],
        ["b", false, "other"],
      ],
    );
  } finally {
    rm(dir);
  }
});

test("symlinked directories are never followed", () => {
  const dir = tmpDir();
  try {
    gitRepo(path.join(dir, "real"));
    fs.symlinkSync(path.join(dir, "real"), path.join(dir, "linked"), "dir");
    assert.deepEqual(
      discover(dir).map((c) => c.name),
      ["real"],
    );
  } finally {
    rm(dir);
  }
});
