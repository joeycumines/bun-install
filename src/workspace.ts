import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';

import type {PackageData} from './types.ts';
import {
  die,
  extractBinaries,
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
          bins: extractBinaries(pkgData.name, pkgData.bin),
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
 * Warns when a command name is defined by multiple packages.
 */
export function buildCommandToPackageMap(
  allPackagesMap: Map<string, PackageData>,
): Map<string, string> {
  const commandToPackage = new Map<string, string>();
  for (const [pkgName, pkg] of allPackagesMap.entries()) {
    for (const bin of pkg.bins) {
      if (commandToPackage.has(bin)) {
        die(
          `Command '${bin}' is defined by both '${commandToPackage.get(bin)}' and '${pkgName}'. Resolve the collision before installing.`,
        );
      }
      commandToPackage.set(bin, pkgName);
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
