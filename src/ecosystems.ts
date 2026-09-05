// The support table: one entry per language ecosystem saying which file is
// the package manifest, how to read a package name and its declared
// dependencies out of it, which files declare a workspace and how to read
// the member globs, and which lockfile means which package manager. Every
// other file reads this table; nothing else knows a manifest by name.

import * as path from "node:path";
import { exists } from "./files.ts";
import { parseGoMod, parseGoWork } from "./internal/gomod.ts";
import {
  get,
  isTable,
  parseToml,
  strings,
  type TomlTable,
  type TomlValue,
} from "./internal/toml-subset.ts";
import { parsePnpmWorkspacePackages } from "./internal/yaml-subset.ts";
import type {
  Diagnostic,
  EcosystemName,
  PackageManager,
  WorkspaceManifest,
} from "./types.ts";

export interface ManifestRead {
  packageName?: string;
  /** Declared dependency names as written, deduplicated and sorted. */
  deps: string[];
  /** Why the file could not be read as a manifest, when it could not. */
  problem?: string;
}

export interface WorkspaceRead {
  manifest: WorkspaceManifest;
  /** Member globs (or literal paths); a leading `!` excludes. */
  globs: string[];
  diagnostics: Diagnostic[];
}

export interface WorkspaceKind {
  /** File probed at the repo root. */
  file: string;
  /** Null when the file exists but declares no workspace. */
  read(text: string, dir: string): WorkspaceRead | null;
}

export interface Ecosystem {
  name: EcosystemName;
  /** The package manifest filename. */
  manifest: string;
  readManifest(text: string): ManifestRead;
  /** The form two spellings of one package name are compared in. */
  canonical(name: string): string;
  /** Probed in order; the first that declares a workspace wins. */
  workspaces: WorkspaceKind[];
  /** Lockfile -> package manager, probed in order. */
  lockfiles: Array<[string, PackageManager]>;
  /** Reported when no lockfile is present. */
  defaultPackageManager?: PackageManager;
  /** For the README table. */
  docs: { workspace: string; dependsOn: string };
}

function malformed(file: string, reason: string): Diagnostic {
  return {
    code: "MALFORMED_FILE",
    severity: "warning",
    subject: file,
    message: `${file}: ${reason}`,
  };
}

function sorted(names: Iterable<string>): string[] {
  return [...new Set(names)].sort();
}

function identity(name: string): string {
  return name;
}

// ── node ──────────────────────────────────────────────────────────────────

const NPM_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

function parseJsonObject(
  text: string,
):
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; reason: string } {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
      return { ok: false, reason: "not a JSON object" };
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

function jsonStrings(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((s): s is string => typeof s === "string")
    : [];
}

const node: Ecosystem = {
  name: "node",
  manifest: "package.json",
  readManifest(text) {
    const read = parseJsonObject(text);
    if (!read.ok) return { deps: [], problem: read.reason };
    const pkg = read.value;
    const deps: string[] = [];
    for (const field of [
      "dependencies",
      "devDependencies",
      "peerDependencies",
    ]) {
      const block = pkg[field];
      if (block !== null && typeof block === "object" && !Array.isArray(block))
        deps.push(...Object.keys(block));
    }
    const out: ManifestRead = { deps: sorted(deps) };
    if (typeof pkg.name === "string" && NPM_NAME.test(pkg.name))
      out.packageName = pkg.name;
    return out;
  },
  canonical: identity,
  workspaces: [
    {
      file: "pnpm-workspace.yaml",
      read(text) {
        const parsed = parsePnpmWorkspacePackages(text);
        return {
          manifest: "pnpm-workspace",
          globs: parsed.globs,
          diagnostics: parsed.diagnostics,
        };
      },
    },
    {
      file: "package.json",
      read(text, dir) {
        const read = parseJsonObject(text);
        if (!read.ok || read.value.workspaces === undefined) return null;
        const ws = read.value.workspaces;
        const globs = Array.isArray(ws)
          ? jsonStrings(ws)
          : jsonStrings((ws as { packages?: unknown } | null)?.packages);
        const yarn =
          exists(path.join(dir, "yarn.lock")) ||
          exists(path.join(dir, ".yarnrc.yml"));
        return {
          manifest: yarn ? "yarn-workspaces" : "npm-workspaces",
          globs,
          diagnostics: [],
        };
      },
    },
    {
      file: "lerna.json",
      read(text) {
        const read = parseJsonObject(text);
        if (!read.ok)
          return {
            manifest: "lerna",
            globs: [],
            diagnostics: [malformed("lerna.json", read.reason)],
          };
        const globs = Array.isArray(read.value.packages)
          ? jsonStrings(read.value.packages)
          : ["packages/*"];
        return { manifest: "lerna", globs, diagnostics: [] };
      },
    },
  ],
  lockfiles: [
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["package-lock.json", "npm"],
    ["bun.lock", "bun"],
    ["bun.lockb", "bun"],
  ],
  docs: {
    workspace:
      "`pnpm-workspace.yaml`; `package.json` `workspaces` (yarn or npm); `lerna.json`",
    dependsOn: "`dependencies`, `devDependencies`, `peerDependencies`",
  },
};

// ── python ────────────────────────────────────────────────────────────────

/** The name at the front of a PEP 508 requirement such as `core[x]>=1; ...`. */
const PEP508_NAME = /^\s*([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)/;

function requirementName(spec: string): string | undefined {
  return PEP508_NAME.exec(spec)?.[1];
}

/** PEP 503 normalisation: case-insensitive, `-` `_` `.` runs are one `-`. */
function pep503(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

function tableValues(v: TomlValue | undefined): TomlValue[] {
  return isTable(v) ? Object.values(v) : [];
}

function tomlDocument(
  text: string,
): { ok: true; doc: TomlTable } | { ok: false; reason: string } {
  const read = parseToml(text);
  return read.ok ? { ok: true, doc: read.value } : read;
}

function workspaceGlobs(
  ws: TomlTable,
  manifest: WorkspaceManifest,
): WorkspaceRead {
  return {
    manifest,
    globs: [...strings(ws.members), ...strings(ws.exclude).map((e) => `!${e}`)],
    diagnostics: [],
  };
}

const python: Ecosystem = {
  name: "python",
  manifest: "pyproject.toml",
  readManifest(text) {
    const read = tomlDocument(text);
    if (!read.ok) return { deps: [], problem: read.reason };
    const specs = [
      ...strings(get(read.doc, "project", "dependencies")),
      ...tableValues(get(read.doc, "project", "optional-dependencies")).flatMap(
        strings,
      ),
      ...tableValues(get(read.doc, "dependency-groups")).flatMap(strings),
    ];
    const deps = specs
      .map(requirementName)
      .filter((n): n is string => n !== undefined);
    const out: ManifestRead = { deps: sorted(deps) };
    const name = get(read.doc, "project", "name");
    if (typeof name === "string" && requirementName(name) === name)
      out.packageName = name;
    return out;
  },
  canonical: pep503,
  workspaces: [
    {
      file: "pyproject.toml",
      read(text) {
        const read = tomlDocument(text);
        if (!read.ok) return null;
        const ws = get(read.doc, "tool", "uv", "workspace");
        return isTable(ws) ? workspaceGlobs(ws, "uv-workspace") : null;
      },
    },
  ],
  lockfiles: [
    ["uv.lock", "uv"],
    ["poetry.lock", "poetry"],
    ["pdm.lock", "pdm"],
  ],
  defaultPackageManager: "pip",
  docs: {
    workspace: "`pyproject.toml` `[tool.uv.workspace]` `members` and `exclude`",
    dependsOn:
      "`[project]` `dependencies` and `optional-dependencies`, `[dependency-groups]`; names compared case-insensitively with `-`, `_`, and `.` alike",
  },
};

// ── rust ──────────────────────────────────────────────────────────────────

const CRATE_NAME = /^[A-Za-z0-9_-]+$/;
const CARGO_DEP_TABLES = [
  "dependencies",
  "dev-dependencies",
  "build-dependencies",
];

/** Keys of a dependency table; a renamed dependency counts under `package`. */
function cargoDeps(block: TomlValue | undefined): string[] {
  if (!isTable(block)) return [];
  return Object.entries(block).map(([key, v]) =>
    isTable(v) && typeof v.package === "string" ? v.package : key,
  );
}

const rust: Ecosystem = {
  name: "rust",
  manifest: "Cargo.toml",
  readManifest(text) {
    const read = tomlDocument(text);
    if (!read.ok) return { deps: [], problem: read.reason };
    const deps: string[] = [];
    for (const table of CARGO_DEP_TABLES) {
      deps.push(...cargoDeps(read.doc[table]));
      for (const target of tableValues(read.doc.target))
        if (isTable(target)) deps.push(...cargoDeps(target[table]));
    }
    const out: ManifestRead = { deps: sorted(deps) };
    const name = get(read.doc, "package", "name");
    if (typeof name === "string" && CRATE_NAME.test(name))
      out.packageName = name;
    return out;
  },
  canonical: identity,
  workspaces: [
    {
      file: "Cargo.toml",
      read(text) {
        const read = tomlDocument(text);
        if (!read.ok) return null;
        const ws = read.doc.workspace;
        return isTable(ws) ? workspaceGlobs(ws, "cargo-workspace") : null;
      },
    },
  ],
  lockfiles: [["Cargo.lock", "cargo"]],
  defaultPackageManager: "cargo",
  docs: {
    workspace: "`Cargo.toml` `[workspace]` `members` and `exclude`",
    dependsOn:
      "`[dependencies]`, `[dev-dependencies]`, `[build-dependencies]`, also per target; a renamed dependency counts under its `package` name",
  },
};

// ── go ────────────────────────────────────────────────────────────────────

const go: Ecosystem = {
  name: "go",
  manifest: "go.mod",
  readManifest(text) {
    const read = parseGoMod(text);
    if (!read.ok) return { deps: [], problem: read.reason };
    const out: ManifestRead = { deps: read.requires };
    if (read.module !== undefined && read.module.length > 0)
      out.packageName = read.module;
    return out;
  },
  canonical: identity,
  workspaces: [
    {
      file: "go.work",
      read(text) {
        const read = parseGoWork(text);
        return read.ok
          ? { manifest: "go-work", globs: read.uses, diagnostics: [] }
          : {
              manifest: "go-work",
              globs: [],
              diagnostics: [malformed("go.work", read.reason)],
            };
      },
    },
  ],
  lockfiles: [["go.sum", "go"]],
  defaultPackageManager: "go",
  docs: {
    workspace: "`go.work` `use` lines",
    dependsOn: "`require` lines (the module path is the package name)",
  },
};

// ── the table ─────────────────────────────────────────────────────────────

/** In probe order. When a repo qualifies for more than one, the first wins. */
export const ECOSYSTEMS: readonly Ecosystem[] = [node, python, rust, go];

/** The entry for a name; every `EcosystemName` has one. */
export function ecosystem(name: EcosystemName): Ecosystem {
  return ECOSYSTEMS.find((e) => e.name === name) as Ecosystem;
}

function packageManagersDoc(e: Ecosystem): string {
  const fromLockfiles = sorted(e.lockfiles.map(([, m]) => m)).filter(
    (m) => m !== e.defaultPackageManager,
  );
  if (fromLockfiles.length === 0) return e.defaultPackageManager ?? "";
  const detected = `${fromLockfiles.join(", ")} (from the lockfile)`;
  return e.defaultPackageManager === undefined
    ? detected
    : `${detected}, else ${e.defaultPackageManager}`;
}

/** The README's "Supported ecosystems" table, generated so it cannot drift. */
export function renderEcosystemsTable(): string {
  const rows = ECOSYSTEMS.map((e) =>
    [
      e.name,
      `\`${e.manifest}\``,
      e.docs.workspace,
      packageManagersDoc(e),
      e.docs.dependsOn,
    ].join(" | "),
  );
  return [
    "| Ecosystem | Package manifest | Workspace manifest | Package managers detected | What `dependsOn` reads |",
    "|---|---|---|---|---|",
    ...rows.map((r) => `| ${r} |`),
  ].join("\n");
}
