import {randomUUID} from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  rmSync,
  writeFileSync,
  cpSync,
} from 'node:fs';
import {dirname, join, relative, resolve, sep} from 'node:path';

import {moveIntoStore} from './archive.ts';
import {rewriteShebangs} from './shebang.ts';
import type {PackageData, BinEntry} from './types.ts';
import {EXIT_SIGNALS} from './types.ts';
import {
  contentReferencesPackage,
  die,
  isDependencyRecord,
  log,
  pathReferencesPackage,
  run,
  runBestEffort,
  which,
} from './utils.ts';

// ---------------------------------------------------------------------------
// Signal handling infrastructure
// ---------------------------------------------------------------------------

/**
 * Conventional shell exit codes for signals: 128 + signal number.
 * Allows parent shells to distinguish "killed by signal" from "exited with
 * a generic error", which is important for scripts that check `$?`.
 *
 * @see https://tldp.org/LDP/abs/html/exitcodes.html
 */
export const SIGNAL_EXIT_CODES: Readonly<Record<string, number>> = {
  SIGINT: 130, // 128 + 2  — user pressed Ctrl+C
  SIGTERM: 143, // 128 + 15 — termination request (e.g. `kill`)
  SIGHUP: 129, // 128 + 1  — terminal closed / session ended
};

/**
 * Returns the conventional exit code for a given signal name.
 * Falls back to `1` (generic error) for unknown signals.
 */
export function getSignalExitCode(sig: string): number {
  return SIGNAL_EXIT_CODES[sig] ?? 1;
}

/**
 * Registers process signal handlers to clean up the temporary directory on exit.
 * Returns a callable cleanup function for explicit invocation.
 *
 * Signal handlers use conventional exit codes (130 for SIGINT, etc.) so that
 * parent shells can distinguish signal-terminated exits from generic errors.
 *
 * **Note on prompt interruption:** These signal handlers are event-loop
 * callbacks and cannot fire during the synchronous `readSync` call in
 * {@link confirmAction}. Instead, `confirmAction` detects the interruption
 * directly (readSync returning 0) and handles the abort itself — printing
 * "Aborted." and exiting with 130 before the caller's `die()` can run.
 */
export function setupCleanup(tmpDir: string): () => void {
  let cleanedUp = false;
  function cleanup(): void {
    if (cleanedUp) return;
    cleanedUp = true;
    log('\nCleaning up temporary files...');
    try {
      rmSync(tmpDir, {recursive: true, force: true});
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Warning: failed to remove temp dir ${tmpDir}: ${msg}`);
    }
  }

  process.on('exit', cleanup);
  for (const sig of EXIT_SIGNALS) {
    process.on(sig, () => {
      cleanup();
      process.exit(getSignalExitCode(sig));
    });
  }

  return cleanup;
}

/**
 * Exit code used when an interactive prompt is aborted.
 *
 * This is the conventional SIGINT exit code (128 + 2 = 130). When `readSync`
 * is interrupted during {@link confirmAction}, the interrupting signal is
 * INDISTINGUISHABLE from EOF or from another signal: Bun's signal handlers are
 * event-loop callbacks and cannot fire while the thread is blocked in the
 * synchronous `readSync` call, and `readSync` returns `0` for both a signal
 * interruption and a clean EOF (Ctrl+D). We therefore cannot select a more
 * specific code (e.g. 143 for SIGTERM). 130 is the most defensible choice
 * because the overwhelmingly common case is a user pressing Ctrl+C at the
 * prompt, and 130 is also a widely accepted convention for an aborted prompt.
 *
 * Note: {@link getSignalExitCode} is a separate concern — it serves the
 * non-prompt signal-handler path in {@link setupCleanup}, where the signal
 * name IS known. There is no contract linking the two paths.
 */
export const PROMPT_ABORT_EXIT_CODE = 130;

/**
 * Returns true when a `readSync` result indicates the prompt should be aborted
 * (the user pressed Ctrl+C / sent EOF, or the read threw and could not yield
 * confirmation bytes). Extracted as a pure function so the abort policy is
 * unit-testable without a TTY — the `readSync` path itself cannot be exercised
 * in tests.
 *
 * `bytesRead <= 0` covers both the "returned 0" case (signal/EOF) and the
 * "readSync threw" case (which {@link confirmAction} maps to `bytesRead = 0`).
 * Any read failure means we could not obtain confirmation, so aborting is the
 * safe response.
 */
export function shouldAbortPrompt(bytesRead: number): boolean {
  return bytesRead <= 0;
}

/**
 * Returns true when the {@link confirmAction} read loop should read another
 * chunk: the previous read completely filled the buffer AND did not contain a
 * newline byte.
 *
 * A short read (`bytesRead < bufferLength`) indicates end-of-line or
 * end-of-input in canonical TTY mode, so the loop stops. A newline byte
 * (0x0a) anywhere in the chunk means the line is complete. Only when the
 * buffer was filled without a newline do we need to read more — the input line
 * exceeds the buffer size and the remainder would otherwise be left in the OS
 * kernel TTY input buffer (a "terminal stdin bleed" vector).
 *
 * Extracted as a pure function so the read-loop termination policy is
 * unit-testable without a TTY.
 */
export function shouldReadMore(
  bytesRead: number,
  hasNewline: boolean,
  bufferLength: number,
): boolean {
  return bytesRead > 0 && !hasNewline && bytesRead >= bufferLength;
}

/**
 * Prompts the user for a yes/no confirmation on stdout/stdin.
 * Returns `true` only when the user types "y" or "yes" (case-insensitive).
 * Returns `false` for non-TTY stdin.
 *
 * **Read loop:** stdin is read in a loop until a newline (0x0a) is
 * encountered, consuming the FULL first line even when it exceeds the read
 * buffer size (256 bytes). This prevents "terminal stdin bleed" — where a
 * single fixed-size `readSync` would leave unconsumed bytes in the OS kernel
 * TTY input buffer for the parent shell to execute as commands after
 * bun-install exits. See {@link shouldReadMore} for the termination policy.
 *
 * **Known limitation:** multi-line paste (first line "y" followed by
 * subsequent command lines) still bleeds the subsequent lines. Fully draining
 * requires non-blocking I/O (fcntl O_NONBLOCK) or async readline, which is
 * out of scope for a simple synchronous prompt. This loop addresses the
 * primary vector: a single line exceeding the buffer size.
 *
 * **Signal/abort handling:** When `readSync` returns 0 bytes (interruption by a
 * signal such as SIGINT, or EOF via Ctrl+D) or throws, this function prints
 * `\n  Aborted.\n` to stderr and calls
 * `process.exit(PROMPT_ABORT_EXIT_CODE)` directly. This bypasses the caller's
 * `die()` path, which would print a confusing "binary remains" message. The
 * `process.on('exit', cleanup)` handler registered by {@link setupCleanup}
 * ensures the temp directory is still cleaned up.
 *
 * This approach is necessary because Bun's signal handlers are event-loop
 * callbacks that cannot fire during the blocking `readSync` call. By the
 * time the event loop regains control, `die()` would have already exited
 * the process. Handling the abort synchronously within `confirmAction`
 * avoids this race entirely. Calling `process.exit` directly bypasses the
 * registered SIGINT/SIGTERM/SIGHUP handlers for this path, but
 * `process.on('exit')` still fires — this is an accepted architectural
 * constraint documented here.
 */
export function confirmAction(msg: string): boolean {
  if (!process.stdin.isTTY) {
    log(`  ${msg}`);
    log(
      '  (stdin is not a TTY — cannot prompt. Run interactively to confirm.)',
    );
    return false;
  }

  process.stdout.write(`  ${msg} [y/N] `);

  // Read the FULL first line from stdin in a loop. A single fixed-size
  // readSync would only consume the first N bytes of a long line (held-down
  // key, large paste), leaving the remainder in the OS kernel TTY input
  // buffer — which the parent shell would then read and execute as commands
  // after bun-install exits (terminal stdin bleed). Loop until a newline
  // (0x0a) is encountered, a short read terminates the loop, or a signal
  // interruption / EOF triggers the abort path — consuming the entire line.
  const READ_BUFFER_SIZE = 256;
  const chunks: Buffer[] = [];
  for (;;) {
    const buf = Buffer.alloc(READ_BUFFER_SIZE);
    let n: number;
    try {
      n = readSync(0, buf, 0, READ_BUFFER_SIZE, null);
    } catch {
      // readSync threw (e.g. EBADF when stdin is closed, or EIO). We could
      // not read a confirmation, so treat it as an abort. The safe behavior
      // is to abort rather than crash with an unhandled error.
      n = 0;
    }

    if (shouldAbortPrompt(n)) {
      // readSync returned 0 bytes — the read was interrupted (most likely by
      // SIGINT) or the user sent EOF (Ctrl+D). In either case the user wants
      // to abort. Print a clean message and exit directly with the
      // conventional SIGINT/abort exit code rather than returning false
      // (which would trigger the caller's die() with a confusing message).
      //
      // process.exit() triggers process.on('exit', cleanup) so the temp
      // directory is still cleaned up.
      process.stderr.write('\n  Aborted.\n');
      process.exit(PROMPT_ABORT_EXIT_CODE);
    }

    const chunk = buf.subarray(0, n);
    chunks.push(chunk);
    const hasNewline = chunk.includes(0x0a);
    if (!shouldReadMore(n, hasNewline, READ_BUFFER_SIZE)) break;
  }

  // Truncate at the first newline (defensive against non-canonical input
  // where bytes may follow \n in one chunk; in canonical TTY mode \n is
  // always the last byte of a line).
  const full = Buffer.concat(chunks).toString('utf-8');
  const newlineIdx = full.indexOf('\n');
  const line = newlineIdx >= 0 ? full.slice(0, newlineIdx) : full;
  const answer = line.trim().toLowerCase();
  return answer === 'y' || answer === 'yes';
}

/**
 * Builds a `cpSync` filter that excludes `node_modules` directories nested
 * *inside* `baseDir` (the package being copied), while never excluding the
 * package itself.
 *
 * The check is computed against the path **relative to `baseDir`** rather
 * than the absolute `src` path. This fixes a blackhole bug where, if the
 * package's absolute directory contains a `node_modules` segment anywhere
 * (e.g. `~/Projects/node_modules/myproj`, or a `TMPDIR` containing
 * `node_modules`), the previous absolute-path filter returned `false` for
 * every entry and copied nothing — crashing the subsequent `readFileSync`.
 *
 * For `src === baseDir` the relative path is `''` (an empty string —
 * `path.relative` returns `''` when both arguments resolve to the same
 * path, NOT `'.'`). The empty-string guard returns `true` so the base
 * directory itself is always included.
 *
 * The `node_modules` segment check uses a pre-compiled regex instead of
 * `rel.split().some()` so that `cpSync` does not allocate a new array for
 * every file and directory it visits — important for packages with
 * thousands of files. The regex `/(?:^|[/\\])node_modules(?:[/\\]|$)/`
 * is provably equivalent to the split+some for all inputs: it matches
 * `node_modules` as a complete path segment (bounded by path separators
 * or string start/end), so `node_modules_foo` and `my_node_modules` do
 * NOT match.
 */
const NODE_MODULES_SEGMENT_RE = /(?:^|[/\\])node_modules(?:[/\\]|$)/;

export function makeCopyFilter(baseDir: string): (src: string) => boolean {
  return (src: string): boolean => {
    const rel = relative(baseDir, src);
    if (rel === '' || rel === '.') return true;
    return !NODE_MODULES_SEGMENT_RE.test(rel);
  };
}

/**
 * Rewrites workspace-local dependencies in `pkgJson` (the throwaway copy's
 * parsed `package.json`) to point at the absolute tarball paths of already-
 * packed local siblings via the `file:` protocol.
 *
 * A dependency is treated as local when its name is present in `packagesMap`.
 * Bun (like npm/Yarn) auto-links local siblings during workspace install
 * whether they are referenced via the `workspace:` protocol OR via plain
 * semver (e.g. `^1.2.0`). `bun pm pack` preserves plain semver verbatim in
 * the tarball, so without pinning a plain-semver local sibling would be
 * fetched from the registry (stale or missing) when the tarball is later
 * installed via `bun add -g`. Pinning to `file:<archive>` makes the global
 * install resolve the local snapshot instead. `bun pm pack` preserves
 * `file:` specs verbatim, so this is effective.
 *
 * Iterates `dependencies`, `peerDependencies`, and `optionalDependencies`.
 * `optionalDependencies` ARE installed by `bun add -g` (they are "optional"
 * only in that install failure does not abort, but they ARE installed when
 * satisfiable), so local siblings in optionalDependencies must be pinned to
 * prevent registry leaks. `devDependencies` are deliberately NOT iterated —
 * `bun add -g` skips them (production install), so pinning them is pointless.
 *
 * - Local sibling WITH an archive path → rewrite to `file:<archivePath>`
 *   with backslashes normalized to forward slashes, regardless of the
 *   original spec (`workspace:` or plain semver). On Windows, `archivePath`
 *   contains backslashes (e.g. `C:\Users\...\foo.tgz`), which would produce
 *   `file:C:\...` — an invalid spec that relies on undocumented parser
 *   leniency. Normalizing to `file:C:/.../foo.tgz` produces a valid
 *   cross-platform path spec. We deliberately do NOT use `pathToFileURL`
 *   here because it percent-encodes special characters (e.g. spaces →
 *   `%20`), and Bun 1.3.14 does not decode percent-encoding in `file:`
 *   dependency specs — a path containing a space would fail with ENOENT.
 * - Local sibling WITHOUT an archive path → `die`. Topological order
 *   guarantees dependencies pack before dependents, so this indicates a
 *   graph/ordering problem rather than a recoverable state.
 * - `workspace:` spec whose name is NOT a local package → `die`. The
 *   `workspace:` protocol cannot be resolved outside a workspace, so the
 *   global install would fail.
 * - Non-local dependency (registry) → left untouched.
 *
 * Returns `true` if any dependency was rewritten.
 */
export function pinWorkspaceDeps(
  pkgJson: Record<string, unknown>,
  packagesMap: Map<string, PackageData>,
  pkgName: string,
): boolean {
  let pinned = false;

  for (const depType of [
    'dependencies',
    'peerDependencies',
    'optionalDependencies',
  ] as const) {
    const deps = pkgJson[depType];
    if (!isDependencyRecord(deps)) continue;

    for (const depName of Object.keys(deps)) {
      const depSpec = deps[depName];
      const depPkg = packagesMap.get(depName);

      if (depPkg) {
        // Local sibling — pin to its local archive regardless of the original
        // spec (workspace: or plain semver). Normalize backslashes to forward
        // slashes so Windows paths (C:\...) produce file:C:/... rather than
        // the malformed file:C:\... We deliberately avoid pathToFileURL here
        // because it percent-encodes spaces (%20), which Bun does not decode
        // in file: dependency specs — causing ENOENT for paths with spaces.
        if (depPkg.archivePath) {
          deps[depName] = `file:${depPkg.archivePath.replace(/\\/g, '/')}`;
          pinned = true;
        } else {
          die(
            `Package '${pkgName}' depends on local sibling '${depName}' but no archive is available for it. ` +
              `Ensure '${depName}' is included in the install graph and packs before '${pkgName}'.`,
          );
        }
      } else if (
        typeof depSpec === 'string' &&
        depSpec.startsWith('workspace:')
      ) {
        // workspace: protocol can only be resolved inside a workspace. If the
        // dep is not a local package, the global install cannot satisfy it.
        die(
          `Package '${pkgName}' has workspace: dependency '${depName}' (${depSpec}) but it is not a local package. ` +
            `Ensure '${depName}' is included in the install graph or remove the workspace reference.`,
        );
      }
      // else: registry dependency — leave the spec untouched.
    }
  }

  return pinned;
}

/**
 * Removes `devDependencies` from the throwaway copy's parsed `package.json`.
 *
 * `bun add -g` installs in production mode, which skips `devDependencies`
 * entirely. They therefore serve no purpose in the global install tarball.
 * Removing them prevents unresolvable `workspace:*` specs from being baked
 * into the packed artifact — a strict ecosystem anti-pattern where a local
 * build tool declared as a `devDependency` with `"workspace:*"` would leave
 * an unresolvable protocol spec in the published tarball.
 *
 * Returns `true` when `devDependencies` was present and deleted.
 */
export function stripDevDependencies(
  pkgJson: Record<string, unknown>,
): boolean {
  if ('devDependencies' in pkgJson) {
    delete pkgJson.devDependencies;
    return true;
  }
  return false;
}

/**
 * Rewrites the `bin` field in a parsed package.json (the throwaway copy's) to
 * include ONLY the selected bin entries.
 *
 * This is called when `--package` selects a subset of a package's commands.
 * Without this filtering, `bun add -g` would symlink ALL of the package's bin
 * entries — clobbering any existing command with the same name from a
 * different package. Bun's `bun add -g` deletes and recreates symlinks on
 * EEXIST without warning (per Bun source: `src/install/bin.zig`
 * `createSymlink()`), so filtering the `bin` field in the packed tarball is
 * the ONLY way to prevent clobbering of unselected commands.
 *
 * The `bin` field is reconstructed as an object `{name: path}` for each
 * selected entry. This is semantically equivalent to the original form (string
 * or object) — `bun add -g` handles both identically (string form is sugar for
 * `{"<packageName>": "<path>"}`; see `extractBinEntries` in `utils.ts` for the
 * inverse derivation).
 *
 * @param pkgJson The parsed package.json (mutated in place).
 * @param selectedEntries The bin entries to retain (a subset of the package's
 *   full `binEntries`). When empty, the `bin` field is deleted entirely.
 * @returns `true` if the `bin` field was modified, `false` if no change was
 *   needed (empty selection with no existing `bin` field).
 */
export function filterBinField(
  pkgJson: Record<string, unknown>,
  selectedEntries: BinEntry[],
): boolean {
  if (selectedEntries.length === 0) {
    if ('bin' in pkgJson) {
      delete pkgJson.bin;
      return true;
    }
    return false;
  }

  // Reconstruct as object form. This is always semantically correct —
  // bun add -g treats string and object forms identically.
  const newBin: Record<string, string> = {};
  for (const entry of selectedEntries) {
    newBin[entry.name] = entry.path;
  }
  pkgJson.bin = newBin;
  return true;
}

/**
 * Iterates the topologically-sorted packages, conditionally runs `bun run build`,
 * packs each INSTALL-SET package, and moves the resulting tarball into the
 * persistent archive store.
 *
 * **Build vs. install decoupling:** ALL packages in `topoOrder` are built (so
 * that devDep build tools are compiled before their dependents), but ONLY
 * packages in `installSet` are packed and archived. devDep-only build tools
 * (reachable via `devDependencies` but not via runtime deps) are built but
 * NOT packed or globally installed — they are intermediate build artifacts,
 * not CLI commands. This prevents a devDep build tool with a `bin` field from
 * polluting the user's global binary namespace.
 *
 * Before packing, `devDependencies` are stripped from the throwaway copy's
 * `package.json` (via {@link stripDevDependencies}) and workspace-local
 * runtime dependencies are pinned to `file:<archive>` (via
 * {@link pinWorkspaceDeps}). Stripping devDeps prevents unresolvable
 * `workspace:*` specs from being baked into the tarball.
 *
 * When `opts.selectedBins` maps a package to a subset of its `binEntries`,
 * the throwaway copy's `package.json` `bin` field is filtered (via
 * {@link filterBinField}) to include only the selected commands BEFORE
 * packing. This ensures `bun add -g` only symlinks the selected commands,
 * preventing clobbering of existing commands from other packages. Shebang
 * rewriting (when `opts.bun` is also set) is applied only to the selected
 * bin target files.
 */
export function buildAndPackPackages(
  topoOrder: string[],
  installSet: Set<string>,
  packagesMap: Map<string, PackageData>,
  archiveStoreDir: string,
  tmpDir: string,
  opts?: {bun?: boolean; selectedBins?: Map<string, BinEntry[]>},
): void {
  log('\nBuilding and Packaging required modules...');
  for (const pkgName of topoOrder) {
    const pkg = packagesMap.get(pkgName);
    if (!pkg) die(`Package ${pkgName} not found in map`);

    log(`\n--- Processing ${pkgName} ---`);

    // Build ALL packages in topological order (including devDep build tools
    // that are NOT in the install set — they must be compiled before their
    // dependents can build).
    if (pkg.hasBuildScript) {
      log(`Building ${pkgName}...`);
      run('bun', ['run', 'build'], {cwd: pkg.dir});
    }

    // Only pack and archive packages in the install set. Build-only
    // dependencies (devDep build tools) are built above but skipped here.
    if (!installSet.has(pkgName)) {
      log('  Skipping pack (build-only dependency, not globally installed)');
      continue;
    }

    // Create a throwaway copy of the package directory for packing so that
    // dependency pinning never mutates the real workspace. This avoids signal-
    // safety issues (SIGINT can skip finally blocks that restore mutated files).
    // The copy filter excludes nested `node_modules` directories *inside* the
    // package, computed relative to pkg.dir so that a host path whose absolute
    // form contains a `node_modules` segment does not blackhole the whole copy.
    //
    // NPM-fetched packages (isNpmFetched: true) are an exception: their nested
    // `node_modules` may contain bundled dependencies or vendored payloads that
    // are part of the published tarball. Stripping them would corrupt the
    // package. The filter is skipped for these packages — everything is copied.
    const packDir = join(tmpDir, randomUUID());
    cpSync(pkg.dir, packDir, {
      recursive: true,
      filter: pkg.isNpmFetched ? undefined : makeCopyFilter(pkg.dir),
    });

    // Strip devDependencies from the throwaway copy. `bun add -g` skips them
    // (production install), so they serve no purpose in the global install
    // tarball. Removing them prevents unresolvable `workspace:*` specs from
    // being baked into the packed artifact.
    const pkgJsonPath = join(packDir, 'package.json');
    const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
    const stripped = stripDevDependencies(pkgJson);

    // Pin workspace-local runtime dependencies to their already-packed tarball
    // paths in the throwaway copy so that the packed archive's package.json
    // points to local snapshots instead of the registry.
    const pinned = pinWorkspaceDeps(pkgJson, packagesMap, pkgName);

    // Filter the bin field to only selected commands when --package selects
    // a subset. This prevents bun add -g from symlinking unselected commands
    // (which would clobber existing commands from other packages — Bun's
    // bun add -g deletes and recreates symlinks on EEXIST without warning).
    const selectedEntries = opts?.selectedBins?.get(pkgName) ?? pkg.binEntries;
    const filteredBin =
      selectedEntries.length < pkg.binEntries.length
        ? filterBinField(pkgJson, selectedEntries)
        : false;

    if (pinned || stripped || filteredBin) {
      writeFileSync(pkgJsonPath, JSON.stringify(pkgJson, null, 2) + '\n');
      if (pinned) log('  Pinned workspace dependencies to local tarballs');
      if (stripped)
        log('  Stripped devDependencies (not needed for global install)');
      if (filteredBin)
        log(
          `  Filtered bin to selected commands: ${selectedEntries.map(e => e.name).join(', ')}`,
        );
    }

    // --bun: Rewrite shebangs in the SELECTED bin target files BEFORE packing
    // so the modified shebangs flow into the tarball. The throwaway copy
    // (packDir) is the staging ground, and `bun pm pack` seals the
    // modifications into the archive. After `bun add -g` installs the archive,
    // the installed bin target files have `#!/usr/bin/env bun` shebangs. On
    // Unix, the OS reads the shebang via the symlink. On Windows, Bun's .exe
    // shim reads the shebang from the target file. Files that cannot be safely
    // rewritten (binaries, non-node shebangs) are skipped with a warning.
    if (opts?.bun) {
      log('  --bun: rewriting shebangs in bin targets...');
      rewriteShebangs(packDir, selectedEntries);
    }

    log(`Packing ${pkgName}...`);
    const isolatedPkgTmp = join(tmpDir, randomUUID());
    mkdirSync(isolatedPkgTmp, {recursive: true});

    run('bun', ['pm', 'pack', '--destination', isolatedPkgTmp], {
      cwd: packDir,
    });

    const archives = readdirSync(isolatedPkgTmp).filter(f =>
      f.endsWith('.tgz'),
    );
    if (archives.length !== 1) {
      die(
        `Expected exactly 1 archive in ${isolatedPkgTmp}, found ${archives.length}`,
      );
    }

    const archiveFilename = archives[0];
    const sourceArchive = join(isolatedPkgTmp, archiveFilename);
    const persistentArchive = join(archiveStoreDir, archiveFilename);

    moveIntoStore(sourceArchive, persistentArchive);
    pkg.archivePath = persistentArchive;
  }
}

/**
 * Uninstalls existing global installations in reverse topological order.
 * Uses best-effort removal so missing packages do not abort the script.
 */
export function uninstallOldGlobals(topoOrder: string[]): void {
  log(
    '\nRemoving existing global installations (reverse topological order)...',
  );
  const removeOrder = [...topoOrder].reverse();
  for (const pkgName of removeOrder) {
    runBestEffort('bun', ['remove', '-g', pkgName]);
  }
}

/**
 * Verifies that none of the target commands are currently reachable via the
 * Bun global bin directory. If a stale binary is found inside Bun's bin dir,
 * the user is prompted for confirmation before removal — but ONLY after
 * verifying the wrapper specifically belongs to one of the removed packages.
 * Binaries found outside Bun's bin dir are treated as unexpected collisions
 * and abort the script.
 */
export function verifyCommandsAbsent(
  targetCommands: string[],
  bunBinDir: string,
  removedPackageNames: string[] = [],
): void {
  log('\nVerifying absence of target commands in PATH...');
  const isWindows = process.platform === 'win32';
  const comparePath = isWindows
    ? (p: string) => resolve(p).toLowerCase()
    : (p: string) => resolve(p);
  const binDirKey = comparePath(bunBinDir);

  for (const bin of targetCommands) {
    let resolved = which(bin);
    if (resolved === null) continue;

    const resolvedKey = comparePath(resolved);
    const isInBunBinDir =
      resolvedKey.startsWith(binDirKey + sep) || resolvedKey === binDirKey;

    if (isInBunBinDir) {
      // Verify specific ownership: only remove if the wrapper can be proven
      // to belong to one of the packages we just removed. This prevents
      // accidentally deleting a wrapper belonging to another globally
      // installed Bun package that exposes the same command name.
      let ownedByRemovedPackage = false;
      try {
        const stat = lstatSync(resolved);
        if (stat.isSymbolicLink()) {
          const target = resolve(dirname(resolved), readlinkSync(resolved));
          // Symlink must point into a Bun global install of one of our packages.
          // Use segment-based matching so package "foo" does not falsely match
          // a sibling directory like "foo-bar". Bun's real symlink targets look
          // like .../install/global/node_modules/<name>/...
          ownedByRemovedPackage = removedPackageNames.some(name =>
            pathReferencesPackage(target, name),
          );
        } else {
          // Regular file — Bun wrappers are typically small JS shims.
          // Check if the content references one of the removed packages via
          // segment-based path matching or the scoped @bun/<name> form.
          const content = readFileSync(resolved, 'utf-8');
          ownedByRemovedPackage = removedPackageNames.some(name =>
            contentReferencesPackage(content, name),
          );
        }
      } catch {
        // Inspection failed — do NOT assume ownership. Require manual removal.
        ownedByRemovedPackage = false;
      }

      if (!ownedByRemovedPackage) {
        die(
          `Binary '${bin}' at ${resolved} appears to belong to another package ` +
            `(not one of: ${removedPackageNames.join(', ')}). Remove it manually and re-run.`,
        );
      }

      const shouldRemove = confirmAction(
        `Binary '${bin}' is still present at ${resolved} after uninstall.\n  Remove it?`,
      );
      if (shouldRemove) {
        try {
          rmSync(resolved, {force: true});
        } catch (err: unknown) {
          die(
            `Failed to remove stale binary '${bin}' at ${resolved}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        // Re-verify after removal — if something else resolves the
        // same name (e.g. a system package further down in PATH), we treat
        // that as a legitimate collision.
        resolved = which(bin);
        if (resolved !== null) {
          die(
            `Binary '${bin}' is still present at: ${resolved} after attempted removal`,
          );
        }
      } else {
        die(
          `Aborting: binary '${bin}' remains at ${resolved}. Remove it manually and re-run.`,
        );
      }
    } else {
      die(
        `Binary '${bin}' is present at: ${resolved} (outside Bun global bin dir). Aborting.`,
      );
    }
  }
}

/**
 * Installs each required package globally from its cached archive using `bun add -g`.
 */
export function installPackages(
  topoOrder: string[],
  packagesMap: Map<string, PackageData>,
): void {
  log('\nInstalling packages globally...');
  for (const pkgName of topoOrder) {
    const pkg = packagesMap.get(pkgName);
    if (!pkg) die(`Package ${pkgName} not found in map`);
    if (!pkg.archivePath) die(`Archive path missing for ${pkgName}`);

    log(`  Installing ${pkgName}...`);
    run('bun', ['add', '-g', '--minimum-release-age=0', pkg.archivePath]);
  }
}

/**
 * Verifies that each target command is now reachable in PATH after installation
 * AND that the resolved binary actually lives inside Bun's global bin directory.
 * This prevents false positives when an unrelated executable shadows the
 * Bun-installed one.
 */
export function verifyCommandsPresent(
  targetCommands: string[],
  bunBinDir: string,
): void {
  log('\nVerifying presence of target commands in PATH...');
  const isWindows = process.platform === 'win32';
  const comparePath = isWindows
    ? (p: string) => resolve(p).toLowerCase()
    : (p: string) => resolve(p);
  const binDirKey = comparePath(bunBinDir);
  for (const bin of targetCommands) {
    const resolved = which(bin);
    if (resolved === null) {
      die(`Binary '${bin}' was not found in PATH after installation!`);
    }
    const resolvedKey = comparePath(resolved);
    const isInBunBinDir =
      resolvedKey.startsWith(binDirKey + sep) || resolvedKey === binDirKey;
    if (!isInBunBinDir) {
      die(
        `Binary '${bin}' resolved to ${resolved}, which is outside Bun's global bin dir (${bunBinDir}). The Bun-installed version may be shadowed by another provider.`,
      );
    }
    log(`  Verified: '${bin}' -> ${resolved}`);
  }
}
