// The three outputs: deterministic JSON, the human tree, and a Mermaid
// flowchart. All pure.

import type { Locations, PlatformMap, Repo } from "./types.ts";

export function toJSON(map: PlatformMap): string {
  return `${JSON.stringify(map, null, 2)}\n`;
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

export function render(map: PlatformMap, locations?: Locations): string {
  const lines: string[] = [];
  const title = map.declared ? map.mode : `${map.mode}, undeclared`;
  lines.push(`${map.name} (${title})${locations ? `  ${locations.root}` : ""}`);

  const nameWidth = Math.max(4, ...map.repos.map((r) => r.name.length));
  const single = map.mode !== "multi-repo" && map.repos.length === 1;

  map.repos.forEach((repo, i) => {
    const last = i === map.repos.length - 1;
    const branch = single ? "" : last ? "└── " : "├── ";
    const childIndent = single ? "" : last ? "    " : "│   ";
    if (!single) {
      const notes: string[] = [];
      if (!repo.present) notes.push("not on this machine");
      if (repo.marker === "missing") notes.push("no marker");
      if (repo.marker === "mismatch")
        notes.push("marker names another platform");
      const loc = locations?.repos[repo.name];
      const cells = [
        `${branch}${pad(repo.name, nameWidth)}`,
        pad(repo.mode, 11),
        repo.packageName ?? "",
        notes.length > 0 ? `(${notes.join("; ")})` : "",
        loc ?? "",
      ];
      lines.push(
        cells
          .filter((c) => c !== "")
          .join("  ")
          .trimEnd(),
      );
    }
    const pkgWidth = Math.max(4, ...repo.packages.map((p) => p.path.length));
    repo.packages.forEach((pkg, j) => {
      const lastPkg = j === repo.packages.length - 1;
      const pkgBranch = lastPkg ? "└── " : "├── ";
      lines.push(
        `${childIndent}${pkgBranch}${pad(pkg.path, pkgWidth)}  ${pkg.packageName ?? ""}`.trimEnd(),
      );
    });
  });
  return `${lines.join("\n")}\n`;
}

export function formatDiagnostics(map: PlatformMap): string {
  if (map.diagnostics.length === 0) return "";
  const codeWidth = Math.max(...map.diagnostics.map((d) => d.code.length));
  return `${map.diagnostics
    .map(
      (d) => `${pad(d.severity, 7)}  ${pad(d.code, codeWidth)}  ${d.message}`,
    )
    .join("\n")}\n`;
}

function nodeId(s: string): string {
  return `n_${s.replace(/[^A-Za-z0-9]/g, "_")}`;
}

function label(s: string): string {
  return `"${s.replace(/"/g, "'")}"`;
}

export function toMermaid(map: PlatformMap): string {
  const lines: string[] = ["flowchart LR"];
  const idByPackageName = new Map<string, string>();
  const edges: string[] = [];

  const declare = (repo: Repo): void => {
    const repoId = nodeId(repo.name);
    if (repo.packageName !== undefined)
      idByPackageName.set(repo.packageName, repoId);
    if (repo.mode === "monorepo") {
      lines.push(`  subgraph ${repoId}[${label(`${repo.name} (monorepo)`)}]`);
      for (const pkg of repo.packages) {
        const pkgId = nodeId(`${repo.name}/${pkg.path}`);
        if (pkg.packageName !== undefined)
          idByPackageName.set(pkg.packageName, pkgId);
        lines.push(`    ${pkgId}[${label(pkg.packageName ?? pkg.path)}]`);
      }
      lines.push("  end");
    } else {
      lines.push(
        `  ${repoId}[${label(repo.packageName ? `${repo.name} (${repo.packageName})` : repo.name)}]`,
      );
    }
  };

  for (const repo of map.repos) declare(repo);

  for (const repo of map.repos) {
    const from = nodeId(repo.name);
    for (const dep of repo.dependsOn) {
      const to = idByPackageName.get(dep);
      if (to !== undefined && to !== from) edges.push(`  ${from} --> ${to}`);
    }
    for (const pkg of repo.packages) {
      const pkgFrom = nodeId(`${repo.name}/${pkg.path}`);
      for (const dep of pkg.dependsOn) {
        const to = idByPackageName.get(dep);
        if (to !== undefined && to !== pkgFrom)
          edges.push(`  ${pkgFrom} --> ${to}`);
      }
    }
  }

  return `${[...lines, ...edges].join("\n")}\n`;
}
