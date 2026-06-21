import {delimiter, join, resolve} from 'node:path';
import {parseArgs as nodeParseArgs} from 'node:util';

import type {BinEntry, PackageData, SpawnOpts} from './types.ts';

/** Logs an informational message to stdout. */
export function log(msg: string): void {
  console.log(msg);
}

/** Prints a fatal error to stderr and exits the process with code 1. */
export function die(msg: string): never {
  console.error(`\nFATAL: ${msg}`);
  process.exit(1);
}

/**
 * Spawns a command synchronously, inheriting stdio from the parent.
 * Returns the exit code (defaults to 1 if missing).
 */
export function runRaw(cmd: string, args: string[], opts?: SpawnOpts): number {
  const proc = Bun.spawnSync([cmd, ...args], {
    cwd: opts?.cwd,
    stdio: ['inherit', 'inherit', 'inherit'],
    env: process.env as Record<string, string>,
  });
  return proc.exitCode ?? 1;
}

/**
 * Spawns a command synchronously, inheriting stdio.
 * Throws (via {@link die}) if the command exits non-zero.
 */
export function run(cmd: string, args: string[], opts?: SpawnOpts): void {
  const code = runRaw(cmd, args, opts);
  if (code !== 0) {
    die(`Command failed (exit ${code}): ${cmd} ${args.join(' ')}`);
  }
}

/**
 * Spawns a command synchronously, inheriting stdio.
 * Logs a warning and continues if the command exits non-zero.
 */
export function runBestEffort(
  cmd: string,
  args: string[],
  opts?: SpawnOpts,
): void {
  const code = runRaw(cmd, args, opts);
  if (code !== 0) {
    console.warn(
      `  (non-zero exit ${code}, continuing) ${cmd} ${args.join(' ')}`,
    );
  }
}

/** Resolves the absolute path of an executable using Bun's `which`. */
export function which(bin: string): string | null {
  return Bun.which(bin) ?? null;
}

/**
 * Returns the absolute path of Bun's configured global bin directory,
 * preferring `bun pm bin -g` when available, then $BUN_INSTALL, then
 * the default `~/.bun/bin`.
 */
export function getBunGlobalBinDir(): string {
  try {
    const proc = Bun.spawnSync(['bun', 'pm', 'bin', '-g'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      env: process.env as Record<string, string>,
    });
    if (proc.exitCode === 0) {
      const dir = new TextDecoder().decode(proc.stdout).trim();
      if (dir) return dir;
    }
  } catch {
    console.warn(
      'Unable to query bun pm bin -g, falling back to env-based inference',
    );
  }

  const bunInstall = process.env.BUN_INSTALL;
  if (bunInstall) {
    return join(bunInstall, 'bin');
  }

  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (!home) {
    die(
      'Cannot determine Bun global bin directory. Set HOME, USERPROFILE, or BUN_INSTALL.',
    );
  }
  return join(home, '.bun', 'bin');
}

/**
 * Ensures Bun's global bin directory is authoritative in the process PATH by
 * placing it first (removing any existing occurrence). Returns the resolved
 * Bun bin directory so callers can verify binary locations against it.
 */
export function ensureBunBinInPath(): string {
  const bunBin = getBunGlobalBinDir();
  const normalizedBunBin = resolve(bunBin);
  const isWindows = process.platform === 'win32';
  const compareKey = isWindows
    ? (p: string) => resolve(p).toLowerCase()
    : (p: string) => resolve(p);
  const normalizedKey = compareKey(bunBin);
  const rest = (process.env.PATH ?? '')
    .split(delimiter)
    .filter(entry => entry.length > 0 && compareKey(entry) !== normalizedKey);
  process.env.PATH = [normalizedBunBin, ...rest].join(delimiter);
  return normalizedBunBin;
}

/**
 * Extracts bin entries (name + target path) from a package.json `bin` field.
 *
 * Handles both forms:
 * - String: `"bin": "./cli.js"` → single entry; name derived from package
 *   name (unscoped suffix for scoped packages). Handles malformed scoped
 *   names (e.g. `@scope` without `/name`) gracefully.
 * - Object: `"bin": {"cmd": "./cli.js", "other": "./other.js"}` → one
 *   entry per key; name is the key, path is the value.
 *
 * Malformed object values (non-string) are skipped with a warning, matching
 * the resilience pattern of `isDependencyRecord` guards elsewhere.
 *
 * @returns BinEntry[] — may be empty. Paths are raw (not resolved).
 */
export function extractBinEntries(
  pkgName: string,
  binField: unknown,
): BinEntry[] {
  if (!binField) return [];
  if (typeof binField === 'string') {
    return [{name: deriveBinName(pkgName), path: binField}];
  }
  if (
    typeof binField === 'object' &&
    binField !== null &&
    !Array.isArray(binField)
  ) {
    const entries: BinEntry[] = [];
    for (const [key, value] of Object.entries(binField)) {
      if (typeof value === 'string') {
        entries.push({name: key, path: value});
      } else {
        console.warn(
          `Warning: bin entry '${key}' in package '${pkgName}' has a non-string target (${typeof value}). Skipping.`,
        );
      }
    }
    return entries;
  }
  return [];
}

/**
 * Derives the command name from the package name for string-form bin entries.
 * For scoped packages (@scope/name), uses the unscoped suffix.
 * Handles malformed scoped names (@scope without /name) by stripping the @.
 */
function deriveBinName(pkgName: string): string {
  if (pkgName.startsWith('@')) {
    const parts = pkgName.split('/');
    // Defend against malformed scoped names like "@scope" (no second segment)
    return parts.length > 1 && parts[1] ? parts[1] : pkgName.replace(/^@/, '');
  }
  return pkgName;
}

/**
 * Type guard: true when `v` is a plain object suitable for `Object.keys` of
 * dependency entries (i.e. a `Record<string, unknown>`). Guards against
 * malformed `package.json` values like `"dependencies": "invalid"` (a string,
 * whose `Object.keys` would yield character indices) or an array (whose
 * `Object.keys` would yield numeric indices), both of which would silently
 * pollute the dependency graph.
 */
export function isDependencyRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Escapes the special characters in a string for safe inclusion in a RegExp.
 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Returns true when a filesystem path references `name` as a complete path
 * segment under `node_modules` or `install/global` — e.g.
 * `.../node_modules/<name>/...`, `.../install/global/<name>/...`, or the same
 * forms ending in `<name>`.
 *
 * Segment-based matching is used instead of `String.includes` so that a package
 * named `foo` does NOT match `node_modules/foo-bar` (which a naive substring
 * check would wrongly report as owned). Bun's real global-bin symlinks point to
 * `.../install/global/node_modules/<name>/...`, which this also matches.
 *
 * Scoped package names (e.g. `@scope/cli`) span two path segments
 * (`@scope`/`cli`), so `name` is split on separators and matched as a
 * consecutive run of segments — this also keeps the boundary exact (so
 * `@scope/cli` does not match `@scope/cli-other`).
 */
function segmentsMatchAt(
  segments: string[],
  start: number,
  nameSegs: string[],
): boolean {
  for (let j = 0; j < nameSegs.length; j++) {
    if (segments[start + j] !== nameSegs[j]) return false;
  }
  return true;
}

export function pathReferencesPackage(target: string, name: string): boolean {
  const segments = target.split(/[/\\]/);
  const nameSegs = name.split(/[/\\]/);
  for (let i = 0; i < segments.length; i++) {
    if (
      segments[i] === 'node_modules' &&
      segmentsMatchAt(segments, i + 1, nameSegs)
    ) {
      return true;
    }
    if (
      segments[i] === 'install' &&
      segments[i + 1] === 'global' &&
      segmentsMatchAt(segments, i + 2, nameSegs)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Returns true when the textual content of a regular-file binary references
 * package `name`. Uses regex matching with a trailing boundary that is not a
 * valid package-name character, so `node_modules/foo` (followed by `/`, `"`,
 * end-of-string, etc.) matches but `node_modules/foo-bar` does not. This is
 * more permissive than {@link pathReferencesPackage} (which requires clean
 * path segments) because content embeds package references inside quoted
 * strings (e.g. `require("node_modules/foo/index.js")`), where `node_modules`
 * is not a standalone segment.
 *
 * This is a heuristic for non-symlink binaries (e.g. JS shims). When ownership
 * cannot be positively established, callers must NOT delete — see
 * {@link verifyCommandsAbsent}.
 */
export function contentReferencesPackage(
  content: string,
  name: string,
): boolean {
  const esc = escapeRegExp(name);
  // Negative lookahead: the match must NOT be followed by a character that is
  // valid in a package name, preventing `foo` from matching `foo-bar`.
  const boundary = '(?![a-z0-9._-])';
  // Cross-platform path separator: matches `/` or `\` in the regex.
  // While JS source almost universally uses forward slashes, some Windows
  // shims or third-party tools may embed backslash paths.
  const s = '[\\\\/]';
  const patterns = [
    `node_modules${s}${esc}${boundary}`,
    `install${s}global${s}${esc}${boundary}`,
    `@bun${s}${esc}${boundary}`,
  ];
  return patterns.some(p => new RegExp(p, 'i').test(content));
}

/**
 * Perform a topological sort (Kahn's Algorithm) on a subset of local packages.
 */
export function topologicalSort(packages: Map<string, PackageData>): string[] {
  const inDegree = new Map<string, number>();
  const adjList = new Map<string, string[]>();

  for (const name of packages.keys()) {
    inDegree.set(name, 0);
    adjList.set(name, []);
  }

  // Build Graph: Dependency -> Dependent
  for (const [name, pkg] of packages.entries()) {
    for (const dep of pkg.localDeps) {
      if (packages.has(dep)) {
        const list = adjList.get(dep);
        if (list) list.push(name);
        inDegree.set(name, (inDegree.get(name) ?? 0) + 1);
      }
    }
  }

  const queue: string[] = [];
  for (const [name, degree] of inDegree.entries()) {
    if (degree === 0) queue.push(name);
  }

  const result: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    result.push(current);

    const neighbors = adjList.get(current);
    if (neighbors) {
      for (const neighbor of neighbors) {
        const degree = (inDegree.get(neighbor) ?? 1) - 1;
        inDegree.set(neighbor, degree);
        if (degree === 0) {
          queue.push(neighbor);
        }
      }
    }
  }

  if (result.length !== packages.size) {
    die('Circular dependency detected in the required workspace packages!');
  }

  return result;
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

/**
 * Parses a raw argv array into flags and positional arguments using
 * Node.js's standard `util.parseArgs` (GNU-style option parsing).
 *
 * Supported flags:
 *   --bun                 Rewrite shebangs in installed commands to use 'bun'
 *                         instead of 'node' (equivalent to `bunx --bun`).
 *   --package <pkg>, -p <pkg>
 *                         Select a specific package by name. Only commands
 *                         from this package are installed. Positional args
 *                         after the package name filter to specific commands
 *                         from that package; if omitted, all commands from
 *                         the package are installed. Without `--package`,
 *                         positional args select commands by name across all
 *                         packages.
 *   --help, -h            Show usage and exit.
 *
 * GNU-style conventions followed (via `util.parseArgs` with `strict: true`):
 *   - Long options start with `--` (e.g. `--bun`, `--help`, `--package`).
 *   - Short options start with `-` and are a single character (e.g. `-h`,
 *     `-p`).
 *   - String options accept their value inline (`--package=pkg`,
 *     `-ppkg`) or as the next token (`--package pkg`, `-p pkg`).
 *   - `--` terminates option parsing: everything after is positional, even
 *     if it starts with `--`. This allows command names that legitimately
 *     start with dashes (rare but valid in npm bin names).
 *   - A single `-` is treated as a positional argument (commonly means
 *     stdin), NOT as an unknown flag. This is the POSIX/GNU convention.
 *   - Unknown options cause a fatal error via {@link die} — fail-fast
 *     prevents a typo'd flag from being silently treated as a command
 *     name (which would produce a confusing "command not found" later).
 *   - Options and positionals may be interspersed (e.g.
 *     `my-cli --bun other` works — both are collected correctly).
 *
 * @returns `{flags, commands}` where flags is `{bun, help, package?}`.
 *   `package` is `undefined` when `--package`/`-p` is not passed.
 */
export function parseArgs(argv: string[]): {
  flags: {bun: boolean; help: boolean; package?: string};
  commands: string[];
} {
  let parsed;
  try {
    parsed = nodeParseArgs({
      args: argv,
      options: {
        bun: {type: 'boolean'},
        help: {type: 'boolean', short: 'h'},
        package: {type: 'string', short: 'p'},
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (err: unknown) {
    // util.parseArgs throws TypeError (code ERR_PARSE_ARGS_UNKNOWN_OPTION,
    // ERR_INVALID_ARG_VALUE, etc.) with a descriptive message. We re-throw
    // via die() to add the supported-flags hint and exit with code 1.
    const msg = err instanceof Error ? err.message : String(err);
    die(`${msg}\n  Supported flags: --bun, --package/-p <pkg>, --help (-h)`);
  }

  return {
    flags: {
      bun: parsed.values.bun === true,
      help: parsed.values.help === true,
      package: parsed.values.package,
    },
    commands: parsed.positionals,
  };
}
