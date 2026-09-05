// Shared helpers for tests: build a throwaway directory tree, clean it up.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** A temp directory outside $HOME so the upward walk never reaches real files. */
export function tmpDir(prefix = "platform-map-"): string {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
}

export function rm(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

export function write(file: string, content: string | object): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    typeof content === "string"
      ? content
      : `${JSON.stringify(content, null, 2)}\n`,
  );
}

export function gitRepo(dir: string): void {
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
}

export function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** A platform folder with three members: two single repos and one pnpm
 *  monorepo with two packages. Returns the platform directory. */
export function acmePlatform(parent: string, declared = true): string {
  const root = path.join(parent, "acme");
  for (const m of ["api", "webapp", "shared"]) gitRepo(path.join(root, m));
  write(path.join(root, "api", "package.json"), {
    name: "@acme/api",
    dependencies: { "@acme/config": "*", express: "*" },
  });
  write(path.join(root, "webapp", "package.json"), {
    name: "@acme/webapp",
    dependencies: { "@acme/ui": "*", "@acme/config": "*" },
  });
  write(path.join(root, "shared", "package.json"), {
    name: "@acme/shared",
    private: true,
  });
  write(
    path.join(root, "shared", "pnpm-workspace.yaml"),
    'packages:\n  - "packages/*"\n',
  );
  write(path.join(root, "shared", "pnpm-lock.yaml"), "");
  write(path.join(root, "shared", "packages", "ui", "package.json"), {
    name: "@acme/ui",
    dependencies: { "@acme/config": "*" },
  });
  write(path.join(root, "shared", "packages", "config", "package.json"), {
    name: "@acme/config",
  });
  if (declared) {
    write(path.join(root, "platform-map.json"), {
      name: "acme",
      members: ["api", "shared", "webapp"],
    });
    for (const m of ["api", "webapp", "shared"]) {
      write(path.join(root, m, "platform-map.json"), {
        platform: "acme",
        member: m,
      });
    }
  }
  return root;
}
