import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';

import type {PackageData} from './types.ts';
import {
  die,
  extractBinEntries,
  isDependencyRecord,
  topologicalSort,
} from './utils.ts';

/**
 * Resolves workspace glob patterns from the root package.json,
 * supporting both array and object-with-packages shapes.
 */
export function resolveWorkspaceGlobs(
  rootPkg: Record<string, unknown>,
): string[] {
  if (
    Array.isArray(rootPkg.workspaces) &&
    rootPkg.workspaces.every((glob): glob is string => typeof glob === 'string')
  ) {
    return rootPkg.workspaces;
  }
  const workspaces = rootPkg.workspaces as {packages?: unknown} | undefined;
  if (
    Array.isArray(workspaces?.packages) &&
    workspaces.packages.every(
      (glob): glob is string => typeof glob === 'string',
    )
  ) {
    return workspaces.packages;
  }
  console.warn(
    'Warning: workspaces field is neither an array nor an object with a packages key. No workspace packages will be discovered.',
  );
  return [];
}

/**
 * Scans the workspace glob patterns and returns a map of every local package
 * with metadata needed for the rest of the pipeline.
 */
export function discoverWorkspacePackages(
  repoRoot: string,
  workspaceGlobs: string[],
): Map<string, PackageData> {
  const allPackagesMap = new Map<string, PackageData>();

  for (const globStr of workspaceGlobs) {
    const pattern = globStr.endsWith('package.json')
      ? globStr
      : `${globStr}/package.json`;
    const glob = new Bun.Glob(pattern);

    for (const relativePath of glob.scanSync({cwd: repoRoot})) {
      const absPath = resolve(repoRoot, relativePath);
      const pkgDir = dirname(absPath);

      if (pkgDir === repoRoot && workspaceGlobs.length > 1) continue;

      try {
        const pkgData = JSON.parse(readFileSync(absPath, 'utf-8'));
        if (!pkgData.name) continue;

        // Collect ALL dependency types for the BUILD GRAPH: dependencies,
        // peerDependencies, devDependencies, and optionalDependencies.
        // Workspace-local devDependencies / optionalDependencies may be build
        // tools or build inputs that must be built before their dependents
        // (e.g. a local shared-builder in devDependencies whose compiled
        // output is imported during the dependent's build). Without them in
        // localDeps the BFS in computeTopologicalOrder never reaches them.
        // Registry deps are filtered out by the entry point's uniform
        // `filter(dep => allPackagesMap.has(dep))` (src/index.ts). A Set
        // deduplicates entries across dep fields (benign in Kahn's algorithm
        // but cleaner). `isDependencyRecord` guards against malformed values
        // (string/array) whose `Object.keys` would yield char/numeric indices.
        //
        // `runtimeLocalDeps` collects only RUNTIME deps (dependencies +
        // peerDependencies + optionalDependencies, NOT devDependencies).
        // Used by `computeInstallSet` to determine which packages need to be
        // globally installed — devDep build tools are built but NOT installed.
        const allDeps = [
          ...new Set<string>([
            ...(isDependencyRecord(pkgData.dependencies)
              ? Object.keys(pkgData.dependencies)
              : []),
            ...(isDependencyRecord(pkgData.peerDependencies)
              ? Object.keys(pkgData.peerDependencies)
              : []),
            ...(isDependencyRecord(pkgData.devDependencies)
              ? Object.keys(pkgData.devDependencies)
              : []),
            ...(isDependencyRecord(pkgData.optionalDependencies)
              ? Object.keys(pkgData.optionalDependencies)
              : []),
          ]),
        ];

        const runtimeDeps = [
          ...new Set<string>([
            ...(isDependencyRecord(pkgData.dependencies)
              ? Object.keys(pkgData.dependencies)
              : []),
            ...(isDependencyRecord(pkgData.peerDependencies)
              ? Object.keys(pkgData.peerDependencies)
              : []),
            ...(isDependencyRecord(pkgData.optionalDependencies)
              ? Object.keys(pkgData.optionalDependencies)
              : []),
          ]),
        ];

        if (allPackagesMap.has(pkgData.name)) {
          const existing = allPackagesMap.get(pkgData.name);
          die(
            `Duplicate package name '${pkgData.name}' found in both ${existing?.dir} and ${pkgDir}. Ensure workspace globs do not overlap.`,
          );
        }
        allPackagesMap.set(pkgData.name, {
          name: pkgData.name,
          dir: pkgDir,
          binEntries: extractBinEntries(pkgData.name, pkgData.bin),
          localDeps: allDeps,
          runtimeLocalDeps: runtimeDeps,
          hasBuildScript: !!pkgData.scripts?.build,
        });
      } catch {
        console.warn(`Ignoring unparseable package.json at ${absPath}`);
      }
    }
  }

  return allPackagesMap;
}

/**
 * Builds a map from binary/command name to the workspace package that provides it.
 * Dies when a command name is defined by multiple packages (collision).
 *
 * @param allPackagesMap All discovered packages.
 * @param restrictTo When provided, only packages whose name is in this set are
 *   included in the map. Packages outside the set are skipped entirely — their
 *   commands are not mapped and cannot trigger a collision die. This is used by
 *   the `--package` flag to scope collision detection to the selected package's
 *   install closure, preventing false dies from unrelated workspace packages
 *   that happen to share a command name. Collisions WITHIN the restricted set
 *   are still fatal (both packages would be installed and their bins would
 *   clobber). When `undefined` (the default), ALL packages are included —
 *   backward compatible with callers that do not pass this parameter.
 */
export function buildCommandToPackageMap(
  allPackagesMap: Map<string, PackageData>,
  restrictTo?: Set<string>,
): Map<string, string> {
  const commandToPackage = new Map<string, string>();
  for (const [pkgName, pkg] of allPackagesMap.entries()) {
    if (restrictTo && !restrictTo.has(pkgName)) continue;
    for (const entry of pkg.binEntries) {
      if (commandToPackage.has(entry.name)) {
        die(
          `Command '${entry.name}' is defined by both '${commandToPackage.get(entry.name)}' and '${pkgName}'. Resolve the collision before installing.`,
        );
      }
      commandToPackage.set(entry.name, pkgName);
    }
  }
  return commandToPackage;
}

/**
 * Starting from the requested commands, performs a BFS over the local runtime
 * dependency graph to find the minimal set of packages required, then returns
 * them in topologically-sorted build order.
 */
export function computeTopologicalOrder(
  targetCommands: string[],
  allPackagesMap: Map<string, PackageData>,
  commandToPackage: Map<string, string>,
): string[] {
  const entryPackages = new Set<string>();
  for (const cmd of targetCommands) {
    const pkgName = commandToPackage.get(cmd);
    if (!pkgName)
      die(`Requested command '${cmd}' was not found in any local package.`);
    entryPackages.add(pkgName);
  }

  const requiredPackages = new Set<string>();
  const bfsQueue = Array.from(entryPackages);

  while (bfsQueue.length > 0) {
    const current = bfsQueue.shift();
    if (current === undefined) break;
    if (!requiredPackages.has(current)) {
      requiredPackages.add(current);
      const pkgData = allPackagesMap.get(current);
      if (pkgData) bfsQueue.push(...pkgData.localDeps);
    }
  }

  const prunedPackagesMap = new Map<string, PackageData>();
  for (const pkgName of requiredPackages) {
    const pkgData = allPackagesMap.get(pkgName);
    if (pkgData) prunedPackagesMap.set(pkgName, pkgData);
  }

  return topologicalSort(prunedPackagesMap);
}

/**
 * Computes the set of packages that should be GLOBALLY INSTALLED, by
 * performing a BFS from the requested commands' owning packages following
 * ONLY runtime dependencies (`runtimeLocalDeps` — dependencies,
 * peerDependencies, and optionalDependencies, EXCLUDING devDependencies).
 *
 * This is the install-side counterpart to {@link computeTopologicalOrder}
 * (which follows `localDeps` — all 4 dep types — for the build graph). The
 * build graph includes devDep build tools so they are built before their
 * dependents; the install set EXCLUDES them so they are not globally
 * installed as commands (even if they have a `bin` field).
 *
 * The caller filters the build topological order by this set to produce
 * `installOrder` — preserving topological order for the install subset.
 *
 * @returns the set of package names to globally install.
 */
export function computeInstallSet(
  targetCommands: string[],
  allPackagesMap: Map<string, PackageData>,
  commandToPackage: Map<string, string>,
): Set<string> {
  const entryPackages = new Set<string>();
  for (const cmd of targetCommands) {
    const pkgName = commandToPackage.get(cmd);
    if (!pkgName)
      die(`Requested command '${cmd}' was not found in any local package.`);
    entryPackages.add(pkgName);
  }

  const installSet = new Set<string>();
  const bfsQueue = Array.from(entryPackages);

  while (bfsQueue.length > 0) {
    const current = bfsQueue.shift();
    if (current === undefined) break;
    if (!installSet.has(current)) {
      installSet.add(current);
      const pkgData = allPackagesMap.get(current);
      if (pkgData) bfsQueue.push(...pkgData.runtimeLocalDeps);
    }
  }

  return installSet;
}

/**
 * Computes the set of packages that would be GLOBALLY INSTALLED if `<pkgName>`
 * were selected, by performing a BFS from `<pkgName>` following ONLY
 * `runtimeLocalDeps` (dependencies, peerDependencies, optionalDependencies —
 * NOT devDependencies).
 *
 * This is used by the `--package` flag to scope `buildCommandToPackageMap`'s
 * collision detection to only packages that will actually be installed. Without
 * this scoping, a collision between the selected package and an UNRELATED
 * workspace package (one not in the install closure) would cause a false die —
 * even though the unrelated package is never installed.
 *
 * Follows `runtimeLocalDeps` (not `localDeps`) because dev-only build tools are
 * built but NOT globally installed — their bins cannot clobber and therefore
 * should not participate in collision detection.
 *
 * **Precondition:** `runtimeLocalDeps` on each package must already be filtered
 * to local siblings (the caller's responsibility — done in `src/index.ts` before
 * this function is called). Registry deps are already excluded by that filter.
 *
 * @returns The set of package names in the install closure (the package itself
 *   plus all transitively reachable runtime-local siblings).
 */
export function computeInstallClosure(
  allPackagesMap: Map<string, PackageData>,
  pkgName: string,
): Set<string> {
  const closure = new Set<string>();
  const bfsQueue = [pkgName];

  while (bfsQueue.length > 0) {
    const current = bfsQueue.shift();
    if (current === undefined) break;
    if (!closure.has(current)) {
      closure.add(current);
      const pkgData = allPackagesMap.get(current);
      if (pkgData) bfsQueue.push(...pkgData.runtimeLocalDeps);
    }
  }

  return closure;
}
