#!/usr/bin/env bun
import {randomUUID} from 'node:crypto';
import {mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {deriveProjectId, resolveArchiveStoreDir} from './archive.ts';
import {fetchNpmPackage} from './npm.ts';
import {resolveProject, ResolverError, NoProjectError} from './resolver.ts';
import type {PackageData, BinEntry, ResolvedProject} from './types.ts';
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
  computeInstallClosure,
  computeTopologicalOrder,
  computeInstallSet,
} from './workspace.ts';

/**
 * Usage text printed when --help is passed.
 */
const USAGE_TEXT = `bun-install — globally install CLI commands from a local project or NPM

USAGE:
  bun-install [OPTIONS] [COMMAND ...]

OPTIONS:
  --bun                Rewrite node shebangs to 'bun' and inject a Bun shebang
                       when a bin target has none. Works cross-platform: on Unix
                       the OS reads the shebang via the symlink; on Windows
                       Bun's shim reads it from the target file.
  --package <pkg>, -p <pkg>
                       Select a specific package. If the package exists in the
                       local workspace, it is installed from there. Otherwise it
                       is fetched from NPM (any specifier that 'bun add'
                       accepts: pkg, pkg@latest, @scope/pkg@^1.0.0, etc.).
                       Positional args after the package name filter to specific
                       commands from that package; if omitted, all commands
                       from the package are installed. Unselected commands are
                       filtered from the packed tarball so they cannot clobber
                       existing commands from other packages.
  --help, -h           Show this help message and exit

COMMANDS:
  Zero or more command names. Without --package, these select commands by
  name across all local packages. With --package <pkg>, they must belong to
  the selected package and filter to specific commands from it. If omitted,
  all commands (from the project, or from the selected package) are installed.

EXAMPLES:
  bun-install                          Install all commands from the project
  bun-install my-cli                   Install only 'my-cli'
  bun-install --bun                    Install all commands, running under Bun
  bun-install --bun my-cli other       Install specific commands under Bun
  bun-install --package my-cli         Install all commands from 'my-cli'
  bun-install -p my-cli tool-a tool-b Install only 'tool-a' and 'tool-b'
  bun-install --package my-cli --bun   Install 'my-cli' commands under Bun
  bun-install -p @scope/pkg@latest     Install all commands from an NPM package
  bun-install -p pkg@2.0.0 cmd1        Install only 'cmd1' from pkg@2.0.0
  bun-install --bun -p pkg@latest      Install NPM package, running under Bun
  bun-install -- --weird-name          Install a command starting with dashes`;

/**
 * Handles the NPM install path: fetches a package from NPM via `bun add`,
 * validates the requested commands, filters the bin field so unselected
 * commands are never symlinked (the no-clobber guarantee), optionally
 * rewrites shebangs for `--bun`, then packs and installs globally.
 *
 * There is no dependency graph or topological sort — NPM dependencies
 * resolve from the registry at `bun add -g` time. The only package that
 * gets packed and installed is the fetched one.
 */
function runNpmMode(
  spec: string,
  commands: string[],
  bun: boolean,
  tmpDir: string,
): void {
  const pkg = fetchNpmPackage(spec, tmpDir);

  if (pkg.binEntries.length === 0) {
    die(
      `Package '${spec}' has no commands (no bin entries in its package.json).`,
    );
  }

  // Validate that any specified commands belong to this package.
  const pkgCmdNames = new Set(pkg.binEntries.map(e => e.name));
  let targetCommands: string[];
  if (commands.length > 0) {
    for (const cmd of commands) {
      if (!pkgCmdNames.has(cmd)) {
        die(
          `Command '${cmd}' is not provided by package '${spec}'. ` +
            `Available commands: ${Array.from(pkgCmdNames).join(', ')}.`,
        );
      }
    }
    targetCommands = commands;
  } else {
    targetCommands = pkg.binEntries.map(e => e.name);
  }

  // Build selectedBins: only the selected commands get symlinked by
  // bun add -g. This is the mechanism that guarantees no clobbering:
  // unselected commands are filtered out of the packed tarball's bin
  // field, so they are never symlinked — even if a command with the
  // same name already exists from a different package.
  const selectedBins = new Map<string, BinEntry[]>();
  const targetSet = new Set(targetCommands);
  // Compute the filtered bin entries once and reuse the local variable
  // for both the selectedBins map and the installBins computation below.
  // This eliminates the non-null assertion that previously round-tripped
  // through the map. See runLocalMode for the same pattern.
  const targetBinEntries = pkg.binEntries.filter(e => targetSet.has(e.name));
  selectedBins.set(pkg.name, targetBinEntries);

  // Single package — no dependency graph.
  const allPackagesMap = new Map<string, PackageData>([[pkg.name, pkg]]);
  const topoOrder = [pkg.name];
  const installSet = new Set<string>([pkg.name]);
  const installOrder = [pkg.name];

  log('=== Starting Command Installation ===');
  log(`Source: NPM (${spec})`);
  log(`Package: ${pkg.name}`);
  log(`\nTarget commands: ${targetCommands.join(', ')}`);

  const bunBinDir = ensureBunBinInPath();
  const projectId = deriveProjectId(process.cwd(), pkg.name);
  const archiveStoreDir = resolveArchiveStoreDir(projectId);
  log(`Archive store: ${archiveStoreDir}`);

  buildAndPackPackages(
    topoOrder,
    installSet,
    allPackagesMap,
    archiveStoreDir,
    tmpDir,
    {bun, selectedBins},
  );
  uninstallOldGlobals(installOrder);

  // Only selected commands are verified — unselected commands are not
  // installed and must not be checked.
  const installBins = targetBinEntries.map(e => e.name);
  verifyCommandsAbsent(installBins, bunBinDir, installOrder);
  installPackages(installOrder, allPackagesMap);
  verifyCommandsPresent(installBins, bunBinDir);

  log('\n=== Success! Requested commands have been globally installed. ===');
}

/**
 * Entry point: discovers the caller's project (workspace or single-package),
 * prunes the graph to the requested commands, builds and packs the required
 * packages, then installs them globally and verifies the resulting binaries.
 *
 * When `--package` is specified and the package is not found in the local
 * project (or there is no local project), falls back to fetching the package
 * from NPM via {@link runNpmMode}.
 */
function main(): void {
  // Parse CLI flags (--bun, --help, --package) and separate them from
  // positional command names. Unknown flags are a fatal error (fail-fast).
  const cli = parseArgs(process.argv.slice(2));

  if (cli.flags.help) {
    console.log(USAGE_TEXT);
    process.exit(0);
  }

  // Guard against an empty --package value (e.g. --package= or -p '').
  // util.parseArgs accepts an empty string for string options; without this
  // guard, the empty string is falsy and silently falls through to the
  // no-package behavior, which is confusing.
  if (cli.flags.package === '') {
    die('--package/-p requires a non-empty package name or specifier.');
  }

  // Create the temp directory early — NPM mode needs it before project
  // resolution to fetch the package.
  const tmpDir = join(tmpdir(), `bun-install-cmd-${randomUUID()}`);
  mkdirSync(tmpDir, {recursive: true});
  const cleanup = setupCleanup(tmpDir);

  try {
    // If --package is specified, check whether it's a local workspace
    // package or an NPM spec. Local packages take precedence.
    if (cli.flags.package) {
      let localResolved: ResolvedProject | null = null;
      try {
        localResolved = resolveProject(process.cwd());
      } catch (err) {
        if (err instanceof NoProjectError) {
          // No local project at all — fall through to NPM mode below.
        } else if (err instanceof ResolverError) {
          // Broken local project (malformed package.json, empty workspace,
          // missing name, etc.) — surface as fatal. Do NOT silently fall back
          // to NPM, which could install a remote package when the user
          // expected a local one (supply-chain footgun).
          die(err.message);
        } else {
          // Unexpected error (e.g. filesystem permission error) — re-throw.
          throw err;
        }
      }

      if (!localResolved || !localResolved.packages.has(cli.flags.package)) {
        runNpmMode(cli.flags.package, cli.commands, cli.flags.bun, tmpDir);
        return;
      }

      // Local --package flow — fall through to the shared local logic below.
      // Re-use the already-resolved project so we don't walk the filesystem
      // twice.
      runLocalMode(cli, localResolved, tmpDir);
      return;
    }

    // No --package: local project required.
    let resolved: ResolvedProject;
    try {
      resolved = resolveProject(process.cwd());
    } catch (err) {
      if (err instanceof ResolverError) {
        die(err.message);
      }
      throw err;
    }
    runLocalMode(cli, resolved, tmpDir);
  } finally {
    cleanup();
  }
}

/**
 * Runs the local install flow: resolves the workspace, prunes the dependency
 * graph to the requested commands, builds and packs the required packages,
 * then installs them globally and verifies the resulting binaries.
 */
function runLocalMode(
  cli: {flags: {bun: boolean; package?: string}; commands: string[]},
  resolved: ResolvedProject,
  tmpDir: string,
): void {
  const rootDir = resolved.rootDir;
  const allPackagesMap = resolved.packages;
  const rootPkgName = resolved.rootPkgName;

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

  // Determine target commands and build the command->package map.
  //
  // Two selection modes:
  //   --package <pkg> [cmds...]  Select by package name. Positional args
  //                              filter to specific commands from that package;
  //                              if omitted, all commands from the package are
  //                              installed. The command->package map is scoped
  //                              to the package's install closure so unrelated
  //                              workspace packages cannot cause a false
  //                              collision die.
  //   [cmds...]                  Select by command name across all packages
  //                              (the original behavior). All packages
  //                              participate in collision detection.
  let targetCommands: string[];
  let commandToPackage: Map<string, string>;
  let selectedBins: Map<string, BinEntry[]> | undefined;

  if (cli.flags.package) {
    const pkgName = cli.flags.package;
    const pkg = allPackagesMap.get(pkgName);
    if (!pkg) {
      die(
        `Package '${pkgName}' not found in the project. Available packages: ` +
          `${Array.from(allPackagesMap.keys()).join(', ') || '(none)'}`,
      );
    }
    if (pkg.binEntries.length === 0) {
      die(
        `Package '${pkgName}' has no commands (no bin entries in its package.json).`,
      );
    }

    // Validate that any specified commands belong to this package.
    const pkgCmdNames = new Set(pkg.binEntries.map(e => e.name));
    if (cli.commands.length > 0) {
      for (const cmd of cli.commands) {
        if (!pkgCmdNames.has(cmd)) {
          die(
            `Command '${cmd}' is not provided by package '${pkgName}'. ` +
              `Available commands: ${Array.from(pkgCmdNames).join(', ')}.`,
          );
        }
      }
      targetCommands = cli.commands;
    } else {
      targetCommands = pkg.binEntries.map(e => e.name);
    }

    // Build selectedBins: only the selected commands from this package get
    // symlinked by bun add -g. Dependencies are installed wholesale (all their
    // bins). This is the mechanism that guarantees no clobbering: unselected
    // commands are filtered out of the packed tarball's bin field, so they are
    // never symlinked — even if a command with the same name already exists
    // from a different package.
    selectedBins = new Map<string, BinEntry[]>();
    const targetSet = new Set(targetCommands);
    // Compute the filtered bin entries once and reuse the local variable
    // for both the selectedBins map and the collision map below. This
    // eliminates the non-null assertion (`selectedBins.get(pkgName)!`) that
    // previously round-tripped through the map — the local variable is
    // provably defined here, making the data flow explicit. (Reviews 03/04
    // flagged the `!` as a bug, but the `set` was always unconditional.
    // The suggested `?? pkg.binEntries` fallback is NOT used — it would
    // mask logic errors by falling back to ALL bins, defeating the
    // collision map's purpose of filtering to selected commands only.)
    const targetBinEntries = pkg.binEntries.filter(e => targetSet.has(e.name));
    selectedBins.set(pkgName, targetBinEntries);

    // Scope collision detection to the install closure (runtime deps only) so
    // unrelated workspace packages don't cause a false die. Collisions WITHIN
    // the closure are still fatal — both packages would be installed and
    // their bins would clobber.
    //
    // The collision map replaces the target package's binEntries with only
    // the SELECTED commands, so unselected commands cannot trigger a false
    // collision die with a runtime dependency's command of the same name.
    // The unselected commands are filtered out of the packed tarball by
    // filterBinField, so they are never installed and cannot clobber. The
    // original allPackagesMap is still used for computeTopologicalOrder and
    // computeInstallSet (dependency graph traversal) — only collision
    // detection uses the filtered view.
    const installClosure = computeInstallClosure(allPackagesMap, pkgName);
    const collisionMap = new Map(allPackagesMap);
    collisionMap.set(pkgName, {
      ...pkg,
      binEntries: targetBinEntries,
    });
    commandToPackage = buildCommandToPackageMap(collisionMap, installClosure);
  } else {
    // Original behavior: select by command name across all packages.
    commandToPackage = buildCommandToPackageMap(allPackagesMap);
    if (commandToPackage.size === 0) {
      die(
        'No commands (binaries) found in any package. Nothing to install.\n' +
          '  Ensure at least one package exposes a "bin" entry in its package.json.',
      );
    }

    targetCommands =
      cli.commands.length > 0
        ? cli.commands
        : Array.from(commandToPackage.keys());
  }

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
    {bun: cli.flags.bun, selectedBins},
  );
  uninstallOldGlobals(installOrder);

  // Verify absence/presence of binary names from the INSTALL set only,
  // not build-only devDep tools. Auxiliary binaries from runtime
  // dependencies must also be checked to prevent collisions.
  //
  // When --package selected a subset of commands, only those selected
  // commands are verified for the primary package — unselected commands
  // are not installed and must not be checked (an existing command from
  // another package would cause a false die if checked). Dependencies'
  // bins are all included (they are installed wholesale).
  const installBins = installOrder.flatMap(pkgName => {
    const selected = selectedBins?.get(pkgName);
    if (selected) return selected.map(e => e.name);
    const pkg = allPackagesMap.get(pkgName);
    return pkg ? pkg.binEntries.map(e => e.name) : [];
  });

  verifyCommandsAbsent(installBins, bunBinDir, installOrder);
  installPackages(installOrder, allPackagesMap);
  verifyCommandsPresent(installBins, bunBinDir);

  log('\n=== Success! Requested commands have been globally installed. ===');
}

main();
