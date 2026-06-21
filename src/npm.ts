import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';

import type {PackageData} from './types.ts';
import {die, extractBinEntries, isDependencyRecord, log, run} from './utils.ts';

// ---------------------------------------------------------------------------
// NPM spec parsing
// ---------------------------------------------------------------------------

/**
 * Parses an NPM package specifier into its name and version components.
 *
 * The `@` character is overloaded in NPM specs: it is both the scope prefix
 * (`@scope/pkg`) and the version separator (`pkg@1.2.3`). The rule is:
 * for scoped packages, the first `@` is the scope, and the version `@`
 * is the one that appears *after* the package name (i.e. after the `/`).
 *
 * Examples:
 *   pkg                    -> {name: "pkg", version: undefined}
 *   pkg@latest             -> {name: "pkg", version: "latest"}
 *   pkg@1.2.3              -> {name: "pkg", version: "1.2.3"}
 *   pkg@^1.0.0             -> {name: "pkg", version: "^1.0.0"}
 *   @scope/pkg             -> {name: "@scope/pkg", version: undefined}
 *   @scope/pkg@latest      -> {name: "@scope/pkg", version: "latest"}
 *   @scope/pkg@1.2.3       -> {name: "@scope/pkg", version: "1.2.3"}
 *
 * @param spec A raw NPM specifier (the same string you would pass to
 *   `bun add` or `npm install`).
 * @returns The package name (always including scope if present) and the
 *   version string (or `undefined` when no version is specified).
 *
 * **Note:** This function is NOT used for directory resolution in
 * {@link fetchNpmPackage}. Directory resolution reads the `dependencies`
 * key from the temp project's `package.json` (via
 * {@link resolveInstalledPackageDir}), which is specifier-agnostic and
 * works for any `bun add` specifier. This parser is retained as a tested
 * utility for NPM spec parsing and may be useful for future features.
 */
export function parseNpmSpec(spec: string): {
  name: string;
  version: string | undefined;
} {
  if (spec.startsWith('@')) {
    // Scoped: @scope/pkg[@version]
    const slashIdx = spec.indexOf('/');
    if (slashIdx === -1) {
      // Malformed: @scope without /pkg — treat the whole thing as the name.
      return {name: spec, version: undefined};
    }
    const rest = spec.slice(slashIdx + 1);
    const atIdx = rest.indexOf('@');
    if (atIdx === -1) {
      return {name: spec, version: undefined};
    }
    return {
      name: spec.slice(0, slashIdx + 1 + atIdx),
      version: rest.slice(atIdx + 1),
    };
  }
  // Unscoped: pkg[@version]
  const atIdx = spec.indexOf('@');
  if (atIdx === -1) {
    return {name: spec, version: undefined};
  }
  return {
    name: spec.slice(0, atIdx),
    version: spec.slice(atIdx + 1),
  };
}

// ---------------------------------------------------------------------------
// NPM package fetching
// ---------------------------------------------------------------------------

/**
 * Resolves the directory of the package installed by `bun add` in a temp
 * project, by reading the `dependencies` key of the temp project's
 * `package.json`.
 *
 * This is specifier-agnostic: it works for any `bun add` specifier (registry
 * name, scoped name, version range, git URL, file path, alias) because `bun
 * add` records the resolved package name in `dependencies`. The temp project
 * starts with zero dependencies (see {@link fetchNpmPackage}), so the single
 * added dependency is the resolved package.
 *
 * This replaces the previous name-derived approach that used
 * {@link parseNpmSpec} to guess the installed directory. That approach failed
 * for non-registry specifiers (git URLs, file paths, aliases) where the
 * installed directory name cannot be syntactically inferred from the spec.
 *
 * @param fetchDir The temp project directory where `bun add` was run.
 * @param spec The original specifier (for error messages).
 * @returns The absolute path to the installed package directory
 *   (e.g. `<fetchDir>/node_modules/<name>`).
 */
export function resolveInstalledPackageDir(
  fetchDir: string,
  spec: string,
): string {
  const fetchPkgJsonPath = join(fetchDir, 'package.json');
  const fetchPkgJson = JSON.parse(
    readFileSync(fetchPkgJsonPath, 'utf-8'),
  ) as Record<string, unknown>;
  const deps = fetchPkgJson.dependencies;
  if (!isDependencyRecord(deps)) {
    die(
      `Failed to determine installed package name. 'bun add ${spec}' did not update dependencies.`,
    );
  }
  const addedNames = Object.keys(deps);
  if (addedNames.length !== 1) {
    die(
      `Expected exactly 1 dependency after 'bun add ${spec}', found ${addedNames.length}.`,
    );
  }
  const actualName = addedNames[0];
  const pkgDir = join(fetchDir, 'node_modules', ...actualName.split('/'));
  if (!existsSync(pkgDir)) {
    die(
      `Failed to find package directory at ${pkgDir} after 'bun add ${spec}'.`,
    );
  }
  return pkgDir;
}

/**
 * Fetches an NPM package by installing it into a throwaway project via
 * `bun add`. Returns a {@link PackageData} describing the installed package.
 *
 * **Why `bun add` instead of hitting the registry directly:** `bun add`
 * handles registry selection (`.npmrc` / `bunfig.toml`), authentication
 * tokens, version resolution (semver ranges, dist-tags, exact versions),
 * and scoped packages. Reimplementing all of that would be fragile.
 *
 * The package's transitive dependencies are also installed by `bun add`,
 * but they are irrelevant — only the target package's files are packed and
 * installed globally. When `bun add -g <tarball>` runs later, it resolves
 * the package's dependencies from the registry.
 *
 * The installed package directory is discovered by reading the `dependencies`
 * key from the temp project's `package.json` (via
 * {@link resolveInstalledPackageDir}). This is specifier-agnostic — it works
 * for any `bun add` specifier, including git URLs, file paths, and aliases,
 * because `bun add` records the resolved package name in `dependencies`.
 *
 * The returned `dir` points inside the temp project's `node_modules`.
 * That directory is the unpacked published tarball — exactly the files
 * that `bun add -g <spec>` would install, before `bun-install` applies
 * bin filtering and shebang rewriting.
 *
 * `isNpmFetched` is set to `true` on the returned `PackageData` so that
 * `buildAndPackPackages` knows to preserve nested `node_modules` (bundled
 * dependencies) during the copy step — unlike local workspace packages,
 * where nested `node_modules` are installed deps and should be stripped.
 *
 * @param spec The NPM specifier (e.g. `pkg`, `pkg@latest`,
 *   `@scope/pkg@^1.2.0`, `github:user/repo`, `./local.tgz`).
 * @param tmpDir A temporary directory owned by the caller's cleanup
 *   routine. The fetch creates a subdirectory inside it.
 * @returns A {@link PackageData} with `localDeps` and `runtimeLocalDeps`
 *   both empty (NPM dependencies resolve from the registry at install
 *   time, not from a local workspace) and `isNpmFetched: true`.
 */
export function fetchNpmPackage(spec: string, tmpDir: string): PackageData {
  // Create a throwaway project so `bun add` has a place to install.
  const fetchDir = join(tmpDir, `npm-fetch-${randomUUID()}`);
  mkdirSync(fetchDir, {recursive: true});
  writeFileSync(
    join(fetchDir, 'package.json'),
    JSON.stringify({name: 'bun-install-fetch', private: true}),
  );

  log(`Fetching NPM package: ${spec}`);
  run('bun', ['add', spec], {cwd: fetchDir});

  // Locate the installed package by reading the dependencies key from the
  // temp project's package.json. This is specifier-agnostic — it works for
  // any `bun add` specifier (registry, git URL, file path, alias) because
  // `bun add` records the resolved package name in dependencies.
  const pkgDir = resolveInstalledPackageDir(fetchDir, spec);

  const pkgJsonPath = join(pkgDir, 'package.json');
  const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8')) as Record<
    string,
    unknown
  >;
  const realName = pkgJson.name;
  if (typeof realName !== 'string' || !realName) {
    die(`Package '${spec}' has no "name" field in its package.json.`);
  }

  const binEntries = extractBinEntries(realName, pkgJson.bin);

  return {
    name: realName,
    dir: pkgDir,
    binEntries,
    // NPM dependencies resolve from the registry at global-install time.
    // There is no local workspace graph to sort or pin.
    localDeps: [],
    runtimeLocalDeps: [],
    // Published packages are pre-built — no build step needed.
    hasBuildScript: false,
    // Mark as NPM-fetched so buildAndPackPackages preserves nested
    // node_modules (bundled deps) instead of stripping them.
    isNpmFetched: true,
  };
}
