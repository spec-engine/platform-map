# Architecture

Everything is a plain function over the filesystem. The CLI in
`bin/platform-map.ts` parses arguments, calls one function, prints, and sets
the exit code.

```mermaid
flowchart TD
  CLI["bin/platform-map.ts"] --> MAP
  CLI --> INIT["planInit / applyInit<br/>src/init.ts"]
  CLI --> LINK["planLink / applyLink<br/>src/link.ts"]
  CLI --> CHECK["check / locate<br/>src/map.ts"]

  MAP["map()<br/>src/map.ts"] --> START["findStart<br/>src/resolve.ts<br/>walk up to the nearest platform-map.json or .git"]
  START --> RES["resolvePlatform<br/>platform file here → root<br/>marker → parent, or the user file"]
  RES --> MEMBERS["one describeRepo per member<br/>src/packages.ts"]
  MEMBERS --> DESC["detect + workspace globs<br/>src/detect.ts, internal/glob.ts, internal/walk.ts"]
  DESC --> DEPS["dependsOn: each package.json's deps ∩ the platform's package names"]
  DEPS --> DIAG["markers, missing members, unlisted repos → diagnostics"]
  DIAG --> SORT["sort repos, packages, diagnostics"]
  SORT --> OUT["PlatformMap"]
  OUT --> R1["render (tree)"]
  OUT --> R2["toJSON"]
  OUT --> R3["toMermaid"]

  INIT --> DISC["discover<br/>src/discover.ts<br/>children with .git or package.json"]
  FILES["src/files.ts<br/>platform-map.json (both shapes), platforms.json"] --> RES
  FILES --> INIT
  FILES --> LINK
```

## Files

| File | Job |
|---|---|
| `src/types.ts` | The public types. |
| `src/files.ts` | Read and validate the platform file, the leaf marker, and the per-user file. Write them. |
| `src/detect.ts` | `single-repo` / `monorepo` / `multi-repo` for one directory; which workspace manifest. |
| `src/discover.ts` | Child directories that look like repositories. |
| `src/packages.ts` | Facts about one repo: package name, package manager, workspace packages, declared deps. |
| `src/resolve.ts` | Find the platform root from wherever the command ran. |
| `src/map.ts` | `map`, `locate`, `check`. |
| `src/init.ts`, `src/link.ts` | The two writing commands, each split into a plan and an apply. |
| `src/render.ts` | Tree, JSON, Mermaid. |
| `src/internal/` | The glob matcher, the bounded directory walk, and the pnpm YAML subset. |

## Rules that hold everywhere

- Nothing throws except `DirectoryNotFoundError`. A broken file is a diagnostic.
- `map` output never contains an absolute path, and every array is sorted with
  plain string comparison. Same files and same disk give the same bytes.
- Symlinks are never followed. Directory walks are capped and say so when
  they stop early.
- Only `applyInit` and `applyLink` write, and only what their plan lists.
  `applyInit` never overwrites a marker.
