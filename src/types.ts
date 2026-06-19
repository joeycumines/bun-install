export type PackageData = {
  name: string;
  dir: string;
  bins: string[];
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
