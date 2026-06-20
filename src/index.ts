#!/usr/bin/env bun
import {randomUUID} from 'node:crypto';
import {mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {deriveProjectId, resolveArchiveStoreDir} from './archive.ts';
import {resolveProject, ResolverError} from './resolver.ts';
import type {PackageData} from './types.ts';
import {
  setupCleanup,
  buildAndPackPackages,
  uninstallOldGlobals,
  verifyCommandsAbsent,
  installPackages,
  verifyCommandsPresent,
} from './operations.ts';
import {die, ensureBunBinInPath, log, parseArgs} from './utils.ts';
import {
  buildCommandToPackageMap,
  computeTopologicalOrder,
  computeInstallSet,
} from './workspace.ts';

/**
 * Usage text printed when --help is passed.
 */
const USAGE_TEXT = `bun-install — globally install CLI commands from a local Bun project

USAGE:
  bun-install [OPTIONS] [COMMAND ...]

OPTIONS:
  --bun       Rewrite node shebangs to 'bun' and inject a Bun shebang when
              a bin target has none. Works cross-platform: on Unix the OS
              reads the shebang via the symlink; on Windows Bun's shim reads
              it from the target file.
  --help, -h  Show this help message and exit

COMMANDS:
  Zero or more command names to install. If omitted, all commands from the
  project are installed.

EXAMPLES:
  bun-install                        Install all commands from the project
  bun-install my-cli                 Install only 'my-cli'
  bun-install --bun                  Install all commands, running under Bun
  bun-install --bun my-cli other     Install specific commands under Bun
  bun-install -- --weird-name        Install a command starting with dashes`;

/**
 * Entry point: discovers the caller's project (workspace or single-package),
 * prunes the graph to the requested commands, builds and packs the required
 * packages, then installs them globally and verifies the resulting binaries.
 */
function main(): void {
  // Parse CLI flags (--bun, --help) and separate them from positional
  // command names. Unknown flags are a fatal error (fail-fast).
  const cli = parseArgs(process.argv.slice(2));

  if (cli.flags.help) {
    console.log(USAGE_TEXT);
    process.exit(0);
  }

  // Resolve the project — supports both monorepo workspaces and single-package
  // projects that have no "workspaces" field in their package.json.
  let rootDir: string;
  let allPackagesMap: Map<string, PackageData>;
  let rootPkgName: unknown;
  try {
    const resolved = resolveProject(process.cwd());
    rootDir = resolved.rootDir;
    allPackagesMap = resolved.packages;
    rootPkgName = resolved.rootPkgName;
  } catch (err) {
    if (err instanceof ResolverError) {
      die(err.message);
    }
    throw err;
  }

  log('=== Starting Command Installation ===');
  log(`Project Root: ${rootDir}`);

  // Filter out dependency entries that reference packages not in our local
  // map (i.e. registry dependencies). Only workspace-local deps matter for
  // topological ordering and packing.
  //
  // This filter is the SINGLE source of truth for "local" status across BOTH
  // project modes. Resolvers (resolver.ts / workspace.ts) intentionally
  // populate `localDeps` with the FULL dependency name list across ALL FOUR
  // dep types (dependencies, peerDependencies, devDependencies,
  // optionalDependencies) — registry + any local siblings; this filter then
  // retains only names present in `allPackagesMap`. This means a workspace-
  // local devDependency build tool (e.g. a local shared-builder) survives the
  // filter and is included in the topological build order, while a registry
  // devDependency (e.g. typescript) is dropped. In single-package mode
  // `allPackagesMap` contains only the root package itself, so the result is
  // always [] (no siblings) — the collection step is retained for uniformity
  // rather than special-cased.
  //
  // `runtimeLocalDeps` is filtered identically — it contains only RUNTIME dep
  // names (deps + peerDeps + optionalDeps, NOT devDeps) and is used by
  // `computeInstallSet` to determine which packages need to be globally
  // installed. devDep build tools are built (via `localDeps` in the build
  // graph) but NOT packed or installed (they're not in the install set).
  for (const pkg of allPackagesMap.values()) {
    pkg.localDeps = pkg.localDeps.filter(dep => allPackagesMap.has(dep));
    pkg.runtimeLocalDeps = pkg.runtimeLocalDeps.filter(dep =>
      allPackagesMap.has(dep),
    );
  }

  // Build a reverse map: command name → owning package name.
  const commandToPackage = buildCommandToPackageMap(allPackagesMap);
  if (commandToPackage.size === 0) {
    die(
      'No commands (binaries) found in any package. Nothing to install.\n' +
        '  Ensure at least one package exposes a "bin" entry in its package.json.',
    );
  }

  const requestedCommands = cli.commands;
  const targetCommands =
    requestedCommands.length > 0
      ? requestedCommands
      : Array.from(commandToPackage.keys());

  const topoOrder = computeTopologicalOrder(
    targetCommands,
    allPackagesMap,
    commandToPackage,
  );

  // Compute the install set: a BFS from the requested commands following
  // ONLY runtime dependencies (dependencies, peerDependencies,
  // optionalDependencies — NOT devDependencies). devDep build tools are
  // built (they're in topoOrder) but NOT globally installed (they're not
  // in the install set). This prevents a devDep build tool with a `bin`
  // field from polluting the user's global binary namespace.
  const installSet = computeInstallSet(
    targetCommands,
    allPackagesMap,
    commandToPackage,
  );
  // installOrder preserves the topological order of the build graph,
  // filtered to only the install set. This ensures dependencies are packed
  // and installed before dependents.
  const installOrder = topoOrder.filter(name => installSet.has(name));

  log(`\nTarget commands: ${targetCommands.join(', ')}`);
  log(
    `Graph pruned to ${topoOrder.length} build packages, ${installOrder.length} install packages. Build order:`,
  );
  topoOrder.forEach((p, i) => {
    const inInstall = installSet.has(p);
    log(`  ${i + 1}. ${p}${inInstall ? '' : ' (build-only)'}`);
  });

  const tmpDir = join(tmpdir(), `bun-install-cmd-${randomUUID()}`);
  mkdirSync(tmpDir, {recursive: true});
  const cleanup = setupCleanup(tmpDir);

  try {
    // Make Bun's global bin dir authoritative (first in PATH) and keep a
    // reference so we can verify binaries land there.
    const bunBinDir = ensureBunBinInPath();

    const projectId = deriveProjectId(rootDir, rootPkgName);
    const archiveStoreDir = resolveArchiveStoreDir(projectId);
    log(`Archive store: ${archiveStoreDir}`);

    buildAndPackPackages(
      topoOrder,
      installSet,
      allPackagesMap,
      archiveStoreDir,
      tmpDir,
      {bun: cli.flags.bun},
    );
    uninstallOldGlobals(installOrder);

    // Verify absence/presence of binary names from the INSTALL set only,
    // not build-only devDep tools. Auxiliary binaries from runtime
    // dependencies must also be checked to prevent collisions.
    const installBins = installOrder.flatMap(pkgName => {
      const pkg = allPackagesMap.get(pkgName);
      return pkg ? pkg.binEntries.map(e => e.name) : [];
    });

    verifyCommandsAbsent(installBins, bunBinDir, installOrder);
    installPackages(installOrder, allPackagesMap);
    verifyCommandsPresent(installBins, bunBinDir);

    log('\n=== Success! Requested commands have been globally installed. ===');
  } finally {
    cleanup();
  }
}

main();
