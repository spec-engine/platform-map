// Public types. These are the API: changing a shape is a breaking change.

export type Mode = "single-repo" | "monorepo" | "multi-repo";

/** The language ecosystems platform-map reads manifests for. */
export type EcosystemName = "node" | "python" | "rust" | "go";

export type PackageManager =
  | "npm"
  | "pnpm"
  | "yarn"
  | "bun"
  | "uv"
  | "poetry"
  | "pdm"
  | "pip"
  | "cargo"
  | "go";

/** Which workspace manifest declared a monorepo's packages. */
export type WorkspaceManifest =
  | "pnpm-workspace"
  | "yarn-workspaces"
  | "npm-workspaces"
  | "lerna"
  | "uv-workspace"
  | "cargo-workspace"
  | "go-work";

export interface PlatformMap {
  /** Platform name from the platform file; otherwise the directory name. */
  name: string;
  mode: Mode;
  /** False when the map was built from discovery alone (a folder of repos
   *  with no platform file yet). Such a map is a preview: nothing in it is a
   *  member until `init` writes the files. */
  declared: boolean;
  /** One entry for a single repo or monorepo; one per member for a platform.
   *  Sorted by name. */
  repos: Repo[];
  /** Sorted by severity (error, warning, info), then code, then subject. */
  diagnostics: Diagnostic[];
  schemaVersion: 2;
}

export interface Repo {
  /** Member name from the platform file, or the directory name. */
  name: string;
  mode: "single-repo" | "monorepo";
  /** Which ecosystem's manifests describe the repo: the one whose workspace
   *  manifest is present, else the first found in table order. Absent when
   *  the repo has no package manifest at all. */
  ecosystem?: EcosystemName;
  /** The package name from the repo's own manifest, when it has one. */
  packageName?: string;
  /** From the lockfile present in the repo, or the ecosystem's default. */
  packageManager?: PackageManager;
  /** Package names from this platform, in the same ecosystem, that the
   *  repo's own manifest declares as dependencies. Sorted. */
  dependsOn: string[];
  /** The workspace packages of a monorepo; empty for a single repo. Sorted by path. */
  packages: Package[];
  /** Whether the repo was found on this machine. When false, mode is
   *  "single-repo", packages is empty, and marker is "unknown". */
  present: boolean;
  /** State of the leaf marker inside the repo. "unknown" for a lone repo
   *  that is not part of any platform, or a member that is not on disk. */
  marker: "ok" | "missing" | "mismatch" | "unknown";
}

export interface Package {
  /** Path relative to the repo root, e.g. "packages/ui". */
  path: string;
  /** Always the ecosystem of the workspace that listed the package. */
  ecosystem: EcosystemName;
  /** The package name from the package's manifest, when it has one. */
  packageName?: string;
  /** Package names from this platform, in the same ecosystem, that this
   *  package depends on. Sorted. */
  dependsOn: string[];
}

export type DiagnosticCode =
  | "MALFORMED_FILE" // a platform-map.json, a package or workspace manifest, or the user file failed to parse or validate
  | "MEMBER_MISSING" // listed in the platform file, not found on this machine
  | "MARKER_MISSING" // member has no platform-map.json marker
  | "MARKER_MISMATCH" // member's marker names a different platform
  | "UNLISTED_REPO" // a repository in the platform folder is not a member
  | "PLATFORM_NOT_LOCATED" // marker names a platform this machine cannot find
  | "UNDECLARED_PLATFORM" // folder of repos with no platform file; the map is a preview
  | "UNMATCHED_PATTERN" // a workspace glob matched no package
  | "AMBIGUOUS_ECOSYSTEM" // a repo has manifests from more than one ecosystem
  | "SCAN_TRUNCATED"; // a directory walk hit its depth or entry cap

export interface Diagnostic {
  code: DiagnosticCode;
  severity: "error" | "warning" | "info";
  /** What the diagnostic is about: a member name, a package path, or a filename. */
  subject: string;
  message: string;
}

export interface Detection {
  mode: Mode;
  /** Present when mode is "monorepo": which manifest declared the packages. */
  manifest?: WorkspaceManifest;
  /** Present when mode is "monorepo": the ecosystem of that manifest. */
  ecosystem?: EcosystemName;
  /** Present when mode is "monorepo": the raw globs or paths from that manifest. */
  workspaceGlobs?: string[];
}

export interface Candidate {
  /** Directory name. */
  name: string;
  hasGit: boolean;
  hasPackageJson: boolean;
  /** Present when the directory holds a leaf marker: the platform it names. */
  marker?: string;
  /** True when a platform file in the folder already lists it. */
  listed: boolean;
}

/** Where things are on this machine. Never part of a PlatformMap. */
export interface Locations {
  /** Absolute path of the platform repo, or of the lone repo. */
  root: string;
  /** Member name -> absolute path. Missing members are absent. */
  repos: Record<string, string>;
  /** Which entries came from the user file rather than the convention. */
  overridden: string[];
}

export interface InitPlan {
  /** Absolute path of the directory the platform file lives (or will live) in. */
  root: string;
  platformName: string;
  /** Members already listed in an existing platform file; empty for a new one. */
  members: string[];
  /** Every discovered candidate, with whether it is already a member. */
  candidates: Candidate[];
  /** Files that would be written if every eligible candidate is included,
   *  as root-relative path -> content. applyInit recomputes this for the
   *  confirmed subset. */
  writes: Record<string, PlatformFile | LeafMarker>;
  /** Root-relative marker paths that already exist and would be left alone. */
  skipped: string[];
  /** Set when nothing can be written (for example a malformed platform file). */
  problem?: string;
}

export interface LinkPlan {
  platformName: string;
  /** Absolute path of the platform root; null when it could not be located. */
  root: string | null;
  /** Member name -> absolute path to record. Empty when the checkout already
   *  follows the convention. */
  members: Record<string, string>;
  /** Absolute path of the user file that would be written. */
  userFile: string;
  /** Why nothing can be written, when root is null. */
  problem?: string;
}

export interface WriteResult {
  /** Absolute paths written. */
  written: string[];
  /** Absolute paths deliberately not written (already existed). */
  skipped: string[];
}

/** The committed platform file: `platform-map.json` at the platform root. */
export interface PlatformFile {
  name: string;
  members: string[];
  /** Directory names to ignore during discovery. */
  ignore?: string[];
}

/** The committed leaf marker: `platform-map.json` inside a member. */
export interface LeafMarker {
  platform: string;
  /** The member name this repo is listed under. Written by `init`; lets a
   *  checkout that lives elsewhere identify itself. Defaults to the directory name. */
  member?: string;
}

/** The per-user file: platform name -> where it is on this machine. */
export type UserConfig = Record<
  string,
  { root: string; members?: Record<string, string> }
>;

/** Options accepted by every command. */
export interface Options {
  /** Path of the per-user file. Default: $PLATFORM_MAP_CONFIG, else
   *  ~/.config/platform-map/platforms.json. */
  userConfigPath?: string;
  /** Extra directory names to ignore during discovery. Merged with the
   *  platform file's `ignore`. node_modules and dot-directories are always ignored. */
  ignore?: string[];
  /** Absolute path of the platform root, for `planLink` when the platform
   *  is not yet known on this machine. */
  root?: string;
}
