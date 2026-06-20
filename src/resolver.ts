import {existsSync, readFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';

import type {PackageData, ResolvedProject} from './types.ts';
import {extractBinEntries, isDependencyRecord} from './utils.ts';
import {resolveWorkspaceGlobs, discoverWorkspacePackages} from './workspace.ts';

// ---------------------------------------------------------------------------
// Exported error type
// ---------------------------------------------------------------------------

/**
 * Thrown by {@link resolveProject} (and its internal helpers) when the caller
 * is not inside a valid project directory or the project configuration is
 * insufficient for global installation.
 *
 * The entry point (`src/index.ts`) catches this, prints a user-friendly
 * "FATAL:" message via `die()`, and exits with code 1. Unit tests catch it
 * normally to assert error behaviour.
 */
export class ResolverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResolverError';
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Maximum number of parent directories to traverse while searching for a
 * `package.json`. This guard prevents infinite loops on cyclic mount points
 * or deeply nested virtual filesystems.
 */
const MAX_PARENT_WALK = 100;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Unifies project package resolution for two modes:
 *
 * **Workspace (monorepo) mode** — the root `package.json` has a `workspaces`
 * field. Delegates to workspace glob scanning and multi-package discovery.
 *
 * **Single-package mode** — the root `package.json` has no `workspaces` field.
 * The root package itself is treated as the sole installable package. If it
 * exposes a `"bin"` entry, that command can be globally installed.
 *
 * In both modes the returned {@link ResolvedProject.packages} map is
 * structurally identical, so downstream code (build, pack, install) never
 * needs to branch on the project type.
 *
 * @throws {ResolverError} when the cwd is not under a valid project.
 */
export function resolveProject(cwd: string): ResolvedProject {
  const {rootDir, rootPkg} = findProjectRoot(cwd);
  const hasWorkspaces = !!rootPkg.workspaces;

  let packages: Map<string, PackageData>;

  if (hasWorkspaces) {
    packages = resolveWorkspaceProject(rootDir, rootPkg);
  } else {
    packages = resolveSinglePackage(rootDir, rootPkg);
  }

  return {
    rootDir,
    packages,
    isWorkspace: hasWorkspaces,
    rootPkgName: rootPkg.name,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Walks up from `startDir` to resolve the project root.
 *
 * Resolution strategy (so `bun-install` works from any nested directory, as
 * documented in the README):
 *
 * 1. **Prefer a workspace root.** The walk continues upward past leaf
 *    `package.json` files looking for the nearest `package.json` that
 *    declares a `workspaces` field. If found, that is the project root
 *    (workspace mode). This means running from `packages/my-cli` resolves the
 *    monorepo root, not the leaf — preserving sibling dependency context.
 *
 * 2. **Fall back to the nearest valid leaf.** If no workspace root is found
 *    before the filesystem root, the nearest *valid* (parseable) `package.json`
 *    is used as a single-package project.
 *
 * 3. **Skip malformed intermediates.** A `package.json` that cannot be parsed
 *    is skipped with a warning and the walk continues, so a stray broken
 *    `package.json` in a parent directory does not crash discovery (matching
 *    the resilience of the former `findWorkspaceRoot`). If NO valid root is
 *    found but a malformed one was seen, a `ResolverError` is thrown that
 *    reports the parse failure (so a genuinely broken root is surfaced, not
 *    silently ignored).
 *
 * The walk is bounded by {@link MAX_PARENT_WALK} and terminates when the
 * filesystem root is reached (`dirname` of the root equals the root).
 * Because `path.resolve` performs lexical normalization only (it does NOT
 * resolve symlinks, unlike `fs.realpathSync`), each iteration produces a
 * strictly shorter canonical path — a cycle is structurally impossible.
 * `MAX_PARENT_WALK` serves as the hard upper bound for pathological
 * filesystems (e.g. cyclic bind mounts).
 *
 * @throws {ResolverError} when no `package.json` is found, or the only one(s)
 *   seen cannot be parsed.
 */
function findProjectRoot(startDir: string): {
  rootDir: string;
  rootPkg: Record<string, unknown>;
} {
  let current = startDir;
  let depth = 0;

  // Track the nearest candidates discovered while walking up.
  let leafDir: string | null = null;
  let leafPkg: Record<string, unknown> | null = null;
  let malformed: {dir: string; message: string} | null = null;

  while (depth < MAX_PARENT_WALK) {
    const resolved = resolve(current);

    const pkgPath = join(resolved, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as Record<
          string,
          unknown
        >;
        if (pkg.workspaces) {
          // Nearest workspace root — this is the project root. Stop walking.
          return {rootDir: resolved, rootPkg: pkg};
        }
        // Valid leaf (no workspaces). Remember the nearest one and keep
        // walking in case a workspace root exists further up.
        if (leafDir === null) {
          leafDir = resolved;
          leafPkg = pkg;
        }
      } catch (err: unknown) {
        // Malformed package.json: skip it and keep walking. A broken file in
        // a parent directory must not abort discovery of a valid root above.
        if (malformed === null) {
          const msg = err instanceof Error ? err.message : String(err);
          malformed = {dir: resolved, message: msg};
        }
        console.warn(
          `Warning: ignoring unparseable package.json at '${resolved}' while searching for project root.`,
        );
      }
    }

    const parent = resolve(dirname(resolved));
    if (parent === resolved) {
      // Reached filesystem root.
      break;
    }
    current = parent;
    depth++;
  }

  if (leafDir !== null && leafPkg !== null) {
    // No workspace root found; fall back to the nearest valid leaf.
    return {rootDir: leafDir, rootPkg: leafPkg};
  }

  if (malformed !== null) {
    throw new ResolverError(
      `Found package.json at '${malformed.dir}' but it could not be parsed: ${malformed.message}`,
    );
  }

  throw new ResolverError(
    'No package.json found in any parent directory.\n' +
      '  bun-install must be run from within (or under) a JavaScript/TypeScript\n' +
      '  project that has a package.json file.',
  );
}

/**
 * Resolves a workspace (monorepo) project by scanning workspace glob patterns
 * and discovering all matching packages.
 *
 * @throws {ResolverError} when no packages match the workspace globs.
 */
function resolveWorkspaceProject(
  rootDir: string,
  rootPkg: Record<string, unknown>,
): Map<string, PackageData> {
  const workspaceGlobs = resolveWorkspaceGlobs(rootPkg);
  const packages = discoverWorkspacePackages(rootDir, workspaceGlobs);

  if (packages.size === 0) {
    throw new ResolverError(
      'No packages found matching workspace globs. Ensure your workspaces\n' +
        '  array points to valid package directories with a "name" field in\n' +
        '  their package.json.',
    );
  }

  return packages;
}

/**
 * Creates a single-entry package map from the root `package.json` for
 * projects that do NOT use workspaces.
 *
 * @throws {ResolverError} when the root package.json has no `name` field.
 */
function resolveSinglePackage(
  rootDir: string,
  rootPkg: Record<string, unknown>,
): Map<string, PackageData> {
  const pkgName: unknown = rootPkg.name;

  if (typeof pkgName !== 'string' || !pkgName) {
    throw new ResolverError(
      'The root package.json must have a "name" field with a non-empty value.\n' +
        '  Example: { "name": "my-cli", "bin": "./index.ts" }',
    );
  }

  const scripts = rootPkg.scripts as Record<string, unknown> | undefined;
  const binEntries = extractBinEntries(pkgName, rootPkg.bin);

  // Collect dependency names for the BUILD GRAPH: dependencies,
  // peerDependencies, devDependencies, and optionalDependencies.
  //
  // All four types are collected (not just runtime deps) because workspace-
  // local devDependencies / optionalDependencies may be BUILD TOOLS or build
  // inputs that must be `bun run build`-ed before their dependents can compile
  // (e.g. a local shared-builder in devDependencies whose compiled dist/ is
  // imported during the dependent's build). Without them in localDeps, the
  // BFS in computeTopologicalOrder never reaches the build tool, it is never
  // built, and the dependent's build fails. Registry devDependencies /
  // optionalDependencies (e.g. typescript) are naturally filtered out by the
  // entry point's uniform `filter(dep => allPackagesMap.has(dep))` (the
  // single source of truth for "local" status across both modes — see
  // src/index.ts).
  //
  // NOTE: `pinWorkspaceDeps` (src/operations.ts) deliberately does NOT pin
  // devDependencies — `bun add -g` skips devDeps (production install), so
  // pinning them is pointless. optionalDependencies ARE runtime-installed and
  // ARE pinned there.
  //
  // `localDeps` here is the full dependency name list (registry + any local
  // siblings), intentionally NOT pre-filtered to local siblings. In
  // single-package mode there are no siblings, so the src/index.ts filter yields
  // []. `isDependencyRecord` guards against malformed values (e.g. a string
  // or array) whose `Object.keys` would yield character/numeric indices and
  // pollute the dependency graph. A Set deduplicates entries (a package
  // listed in multiple dep fields) — duplicates are structurally benign in
  // Kahn's algorithm but removed here for cleanliness.
  //
  // `runtimeLocalDeps` collects only RUNTIME deps (dependencies +
  // peerDependencies + optionalDependencies, NOT devDependencies). It is
  // used to compute the install set — only runtime deps need to be globally
  // installed. devDep build tools are built (via `localDeps`) but not packed
  // or installed.
  const rawDeps = rootPkg.dependencies;
  const rawPeerDeps = rootPkg.peerDependencies;
  const rawDevDeps = rootPkg.devDependencies;
  const rawOptDeps = rootPkg.optionalDependencies;

  const allDeps = [
    ...new Set<string>([
      ...(isDependencyRecord(rawDeps) ? Object.keys(rawDeps) : []),
      ...(isDependencyRecord(rawPeerDeps) ? Object.keys(rawPeerDeps) : []),
      ...(isDependencyRecord(rawDevDeps) ? Object.keys(rawDevDeps) : []),
      ...(isDependencyRecord(rawOptDeps) ? Object.keys(rawOptDeps) : []),
    ]),
  ];

  const runtimeDeps = [
    ...new Set<string>([
      ...(isDependencyRecord(rawDeps) ? Object.keys(rawDeps) : []),
      ...(isDependencyRecord(rawPeerDeps) ? Object.keys(rawPeerDeps) : []),
      ...(isDependencyRecord(rawOptDeps) ? Object.keys(rawOptDeps) : []),
    ]),
  ];

  const packages = new Map<string, PackageData>();
  packages.set(pkgName, {
    name: pkgName,
    dir: rootDir,
    binEntries,
    localDeps: allDeps,
    runtimeLocalDeps: runtimeDeps,
    hasBuildScript: !!scripts?.build,
  });

  return packages;
}
