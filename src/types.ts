/**
 * A single bin entry from a package.json `bin` field, pairing the command
 * name with its target file path (relative to the package directory).
 *
 * For string-form bin (`"bin": "./cli.js"`), `name` is derived from the
 * package name (unscoped suffix for scoped packages) and `path` is the
 * string value.
 *
 * For object-form bin (`"bin": {"cmd": "./cli.js"}`), `name` is the object
 * key and `path` is the value.
 *
 * `path` is the raw string from package.json — NOT resolved. Callers must
 * resolve it relative to the package directory. This preserves the original
 * form for logging and matches how `bun pm pack` interprets it.
 */
export type BinEntry = {
  /** The command name (what the user types in the shell). */
  name: string;
  /** The target file path, relative to the package root (raw from package.json). */
  path: string;
};

export type PackageData = {
  name: string;
  dir: string;
  /**
   * Bin entries for this package. Each entry pairs the command name with its
   * target file path (relative to the package directory). For packages with
   * no `bin` field, this is an empty array.
   *
   * NOTE: `binEntries` is populated at discovery time (resolver.ts /
   * workspace.ts) from the ORIGINAL package.json — before any throwaway copy
   * or build step. The paths are relative to `dir` (the original package
   * directory). When rewriting shebangs in the throwaway copy, the same
   * relative path applies (the copy preserves structure).
   */
  binEntries: BinEntry[];
  /** ALL local dependency names (dependencies + peerDependencies +
   * devDependencies + optionalDependencies) for build-graph completeness.
   * Used by the topological sort to determine build order — devDep build
   * tools must be built before their dependents. */
  localDeps: string[];
  /** Local RUNTIME dependency names only (dependencies + peerDependencies +
   * optionalDependencies, EXCLUDING devDependencies). Used to compute the
   * install set — only runtime deps need to be globally installed. devDep
   * build tools are built (via `localDeps` in the build graph) but NOT
   * packed or installed. Parallels `localDeps` as a full dep-name list
   * (before the local-sibling filter in src/index.ts). */
  runtimeLocalDeps: string[];
  hasBuildScript: boolean;
  archivePath?: string; // Populated after packing
};

export type SpawnOpts = {cwd?: string};

export const EXIT_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

/**
 * Unified representation of a resolved project.
 *
 * A project is either:
 *   - A **monorepo workspace** with a root `package.json` that declares
 *     `workspaces` and any number of child packages, OR
 *   - A **single-package project** whose root `package.json` is itself the
 *     only package.
 *
 * Downstream consumers (build, pack, install) treat both cases identically
 * via the `packages` map.
 */
export type ResolvedProject = {
  /** Absolute path to the project root directory. */
  rootDir: string;
  /** All discoverable packages keyed by package name. */
  packages: Map<string, PackageData>;
  /** `true` when the root `package.json` has a `workspaces` field. */
  isWorkspace: boolean;
  /**
   * The raw `name` field of the root `package.json`, used downstream to
   * derive a filesystem-safe project identifier for the archive cache.
   * May be `undefined` or `null` for workspace roots that lack a name
   * (unusual but not fatal — the directory-name fallback kicks in).
   */
  rootPkgName: unknown;
};
