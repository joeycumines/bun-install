import {afterEach, describe, expect, test} from 'bun:test';
import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {resolveProject, ResolverError} from '../src/resolver.ts';

// --------------------------------------------------------------------------
// Fixture helpers
// --------------------------------------------------------------------------

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, {recursive: true, force: true});
  }
});

/** Creates an empty temp directory tracked for cleanup. */
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bun-install-resolver-'));
  tempDirs.push(dir);
  return dir;
}

/** Writes a `package.json` at the given directory. */
function writePkg(dir: string, data: Record<string, unknown>): void {
  writeFileSync(join(dir, 'package.json'), JSON.stringify(data));
}

// --------------------------------------------------------------------------
// Single-package (non-workspace) tests
// --------------------------------------------------------------------------

describe('resolveProject — single-package mode', () => {
  test('discovers the root package.json from a nested directory', () => {
    const root = makeTempDir();
    const nested = join(root, 'a', 'b', 'c');
    mkdirSync(nested, {recursive: true});
    writePkg(root, {name: 'my-cli', bin: './cli.ts'});

    const project = resolveProject(nested);

    expect(project.rootDir).toBe(root);
    expect(project.isWorkspace).toBe(false);
    expect(project.rootPkgName).toBe('my-cli');
    expect(project.packages.size).toBe(1);
    expect(project.packages.has('my-cli')).toBe(true);
  });

  test('creates correct PackageData for string bin entry', () => {
    const root = makeTempDir();
    writePkg(root, {name: 'my-cli', bin: './cli.ts'});

    const {packages} = resolveProject(root);
    const pkg = packages.get('my-cli')!;

    expect(pkg.name).toBe('my-cli');
    expect(pkg.dir).toBe(root);
    // String bin → binary name equals package name
    expect(pkg.binEntries.map(e => e.name)).toEqual(['my-cli']);
    expect(pkg.hasBuildScript).toBe(false);
    expect(pkg.localDeps).toEqual([]);
  });

  test('creates correct PackageData for object-format bin entry', () => {
    const root = makeTempDir();
    writePkg(root, {
      name: 'toolbox',
      bin: {tool: './tool.ts', helper: './helper.ts'},
    });

    const {packages} = resolveProject(root);
    const pkg = packages.get('toolbox')!;

    expect(pkg.name).toBe('toolbox');
    expect(pkg.dir).toBe(root);
    expect(pkg.binEntries.map(e => e.name)).toEqual(['tool', 'helper']);
  });

  test('detects build script', () => {
    const root = makeTempDir();
    writePkg(root, {
      name: 'buildy-cli',
      bin: './cli.ts',
      scripts: {build: 'bun run build', test: 'bun test'},
    });

    const {packages} = resolveProject(root);
    expect(packages.get('buildy-cli')!.hasBuildScript).toBe(true);
  });

  test('handles no build script', () => {
    const root = makeTempDir();
    writePkg(root, {
      name: 'simple-cli',
      bin: './cli.ts',
      scripts: {lint: 'bun run lint'},
    });

    const {packages} = resolveProject(root);
    expect(packages.get('simple-cli')!.hasBuildScript).toBe(false);
  });

  test('collects all four dependency types (deps, peerDeps, devDeps, optionalDeps)', () => {
    const root = makeTempDir();
    writePkg(root, {
      name: 'dep-cli',
      bin: './cli.ts',
      dependencies: {lodash: '^4.0.0', chalk: '^5.0.0'},
      peerDependencies: {react: '^18.0.0'},
      devDependencies: {typescript: '^5.0.0'},
      optionalDependencies: {fsevents: '^2.3.0'},
    });

    const {packages} = resolveProject(root);
    const pkg = packages.get('dep-cli')!;
    expect(pkg.localDeps.sort()).toEqual([
      'chalk',
      'fsevents',
      'lodash',
      'react',
      'typescript',
    ]);
  });

  test('runtimeLocalDeps excludes devDependencies (R8-1)', () => {
    // runtimeLocalDeps collects only deps + peerDeps + optionalDeps
    // (NOT devDeps). devDeps are in localDeps for build-graph completeness
    // but excluded from runtimeLocalDeps so they are not globally installed.
    const root = makeTempDir();
    writePkg(root, {
      name: 'rt-cli',
      bin: './cli.ts',
      dependencies: {lodash: '^4.0.0'},
      peerDependencies: {react: '^18.0.0'},
      devDependencies: {typescript: '^5.0.0'},
      optionalDependencies: {fsevents: '^2.3.0'},
    });

    const {packages} = resolveProject(root);
    const pkg = packages.get('rt-cli')!;
    // localDeps includes ALL four types.
    expect(pkg.localDeps.sort()).toEqual([
      'fsevents',
      'lodash',
      'react',
      'typescript',
    ]);
    // runtimeLocalDeps excludes devDependencies (typescript).
    expect(pkg.runtimeLocalDeps.sort()).toEqual([
      'fsevents',
      'lodash',
      'react',
    ]);
  });

  test('collects devDependencies and optionalDependencies for build-graph completeness', () => {
    // devDependencies and optionalDependencies are now collected alongside
    // dependencies and peerDependencies. Workspace-local devDeps/optionalDeps
    // may be build tools that must be built before their dependents. Registry
    // devDeps (e.g. typescript) are collected here but filtered out by the
    // entry point's uniform `filter(dep => allPackagesMap.has(dep))` (the
    // single source of truth for "local" status — see src/index.ts).
    const root = makeTempDir();
    writePkg(root, {
      name: 'devdep-cli',
      bin: './cli.ts',
      dependencies: {express: '^4.0.0'},
      devDependencies: {typescript: '^5.0.0'},
      optionalDependencies: {fsevents: '^2.3.0'},
    });

    const {packages} = resolveProject(root);
    const pkg = packages.get('devdep-cli')!;
    // All four dep types are collected (before the src/index.ts local-sibling filter).
    expect(pkg.localDeps.sort()).toEqual(['express', 'fsevents', 'typescript']);
  });

  test('deduplicates a package listed in multiple dependency fields', () => {
    // A package in both dependencies and devDependencies appears once.
    // Duplicates are structurally benign in Kahn's algorithm but removed
    // for cleanliness via a Set in the collection step.
    const root = makeTempDir();
    writePkg(root, {
      name: 'dup-cli',
      bin: './cli.ts',
      dependencies: {shared: '^1.0.0'},
      devDependencies: {shared: '^1.0.0'},
    });

    const {packages} = resolveProject(root);
    const pkg = packages.get('dup-cli')!;
    expect(pkg.localDeps).toEqual(['shared']);
  });

  test('creates package with no bin field (empty bins array)', () => {
    const root = makeTempDir();
    writePkg(root, {name: 'lib-only'});

    const {packages} = resolveProject(root);
    const pkg = packages.get('lib-only')!;
    expect(pkg.binEntries).toEqual([]);
  });

  test('returns rootPkgName for project ID derivation', () => {
    const root = makeTempDir();
    writePkg(root, {name: '@scope/special-cli', bin: './cli.ts'});

    const project = resolveProject(root);
    expect(project.rootPkgName).toBe('@scope/special-cli');
    // rootPkgName preserves the raw value — sanitization happens downstream
    // in deriveProjectId.
  });

  // --- Error cases ---

  test('throws ResolverError when package.json has no name', () => {
    const root = makeTempDir();
    writePkg(root, {version: '1.0.0'});

    expect(() => resolveProject(root)).toThrow(ResolverError);
    expect(() => resolveProject(root)).toThrow(/must have a "name"/);
  });

  test('throws ResolverError when package.json name is empty string', () => {
    const root = makeTempDir();
    writePkg(root, {name: '', bin: './cli.ts'});

    expect(() => resolveProject(root)).toThrow(ResolverError);
    expect(() => resolveProject(root)).toThrow(/must have a "name"/);
  });

  test('throws ResolverError when no package.json exists', () => {
    const root = makeTempDir();
    // No package.json written
    expect(() => resolveProject(root)).toThrow(ResolverError);
    expect(() => resolveProject(root)).toThrow(/No package\.json found/);
  });

  test('throws ResolverError when package.json is malformed JSON', () => {
    const root = makeTempDir();
    writeFileSync(join(root, 'package.json'), '{broken json');

    expect(() => resolveProject(root)).toThrow(ResolverError);
    expect(() => resolveProject(root)).toThrow(/could not be parsed/);
  });
});

// --------------------------------------------------------------------------
// Workspace mode tests
// --------------------------------------------------------------------------

describe('resolveProject — workspace mode', () => {
  test('discovers workspace packages and sets isWorkspace=true', () => {
    const root = makeTempDir();
    const pkgDir = join(root, 'packages', 'lib');
    mkdirSync(pkgDir, {recursive: true});
    writePkg(root, {
      name: 'monorepo-root',
      workspaces: ['packages/*'],
    });
    writePkg(pkgDir, {
      name: 'lib',
      bin: {lib: './index.ts'},
    });

    const project = resolveProject(root);

    expect(project.isWorkspace).toBe(true);
    expect(project.rootDir).toBe(root);
    expect(project.rootPkgName).toBe('monorepo-root');
    expect(project.packages.size).toBe(1);
    expect(project.packages.has('lib')).toBe(true);
    expect(project.packages.get('lib')!.binEntries.map(e => e.name)).toEqual([
      'lib',
    ]);
  });

  test('throws ResolverError when workspace globs match nothing', () => {
    const root = makeTempDir();
    writePkg(root, {
      name: 'empty-workspace',
      workspaces: ['packages/*'],
    });

    expect(() => resolveProject(root)).toThrow(ResolverError);
    expect(() => resolveProject(root)).toThrow(/No packages found/);
    // R9-4: the error message must NOT mention "bin" — discoverWorkspacePackages
    // adds packages with a "name" regardless of "bin". The "no bins" check is
    // in src/index.ts (commandToPackage.size === 0), not here.
    expect(() => resolveProject(root)).not.toThrow(/bin/);
  });
});

// --------------------------------------------------------------------------
// Cross-mode consistency tests
// --------------------------------------------------------------------------

describe('resolveProject — cross-mode consistency', () => {
  test('both modes return structurally identical packages maps', () => {
    // Single-package project
    const singleRoot = makeTempDir();
    writePkg(singleRoot, {name: 'single', bin: './cli.ts'});

    // Workspace with one package (mirror the same structure)
    const wsRoot = makeTempDir();
    const wsPkgDir = join(wsRoot, 'pkg');
    mkdirSync(wsPkgDir, {recursive: true});
    writePkg(wsRoot, {name: 'ws', workspaces: ['pkg']});
    writePkg(wsPkgDir, {name: 'single', bin: './cli.ts'});

    const singleProj = resolveProject(singleRoot);
    const wsProj = resolveProject(wsRoot);

    // Both should have a package named 'single' with a bin './cli.ts'
    const singlePkg = singleProj.packages.get('single')!;
    const wsPkg = wsProj.packages.get('single')!;

    expect(singlePkg.name).toBe(wsPkg.name);
    expect(singlePkg.binEntries).toEqual(wsPkg.binEntries);
    expect(typeof singlePkg.dir).toBe('string');
    expect(typeof wsPkg.dir).toBe('string');
    expect(singlePkg.hasBuildScript).toBe(false);
    expect(wsPkg.hasBuildScript).toBe(false);
  });
});

// --------------------------------------------------------------------------
// Nested-directory discovery & malformed-resilience (review-01 #3, review-02 #5)
// --------------------------------------------------------------------------

describe('resolveProject — nested directory discovery', () => {
  test('from a nested workspace package dir, finds the workspace root (not the leaf)', () => {
    const root = makeTempDir();
    const appDir = join(root, 'packages', 'app', 'src');
    const libDir = join(root, 'packages', 'lib');
    mkdirSync(appDir, {recursive: true});
    mkdirSync(libDir, {recursive: true});
    writePkg(root, {name: 'monorepo', workspaces: ['packages/*']});
    writePkg(join(root, 'packages', 'app'), {
      name: 'app',
      bin: {myapp: './index.ts'},
      dependencies: {lib: '^1.0.0'},
    });
    writePkg(libDir, {name: 'lib', bin: {lib: './index.ts'}});

    // Run from a deeply nested dir INSIDE the leaf package. The resolver must
    // walk up past the leaf package.json (no workspaces) and find the monorepo
    // root (has workspaces), preserving sibling dependency context.
    const project = resolveProject(appDir);

    expect(project.isWorkspace).toBe(true);
    expect(project.rootDir).toBe(root);
    expect(project.packages.has('app')).toBe(true);
    expect(project.packages.has('lib')).toBe(true);
  });

  test('single-package project is still discovered from a nested dir (leaf fallback)', () => {
    const root = makeTempDir();
    const nested = join(root, 'src', 'commands');
    mkdirSync(nested, {recursive: true});
    writePkg(root, {name: 'my-cli', bin: './cli.ts'});

    const project = resolveProject(nested);

    expect(project.isWorkspace).toBe(false);
    expect(project.rootDir).toBe(root);
    expect(project.packages.size).toBe(1);
    expect(project.packages.has('my-cli')).toBe(true);
  });
});

describe('resolveProject — malformed package.json resilience', () => {
  test('skips a malformed intermediate package.json and continues to a valid root', () => {
    const root = makeTempDir();
    // A malformed package.json in a leaf dir...
    const leafDir = join(root, 'packages', 'app');
    const libDir = join(root, 'packages', 'lib');
    mkdirSync(leafDir, {recursive: true});
    mkdirSync(libDir, {recursive: true});
    writeFileSync(join(leafDir, 'package.json'), '{broken json');
    // ...with a valid workspace root above it.
    writePkg(root, {name: 'monorepo', workspaces: ['packages/*']});
    writePkg(libDir, {
      name: 'lib',
      bin: {lib: './i.ts'},
    });

    // Must not crash on the malformed leaf; must find the workspace root.
    const project = resolveProject(leafDir);

    expect(project.isWorkspace).toBe(true);
    expect(project.rootDir).toBe(root);
    expect(project.packages.has('lib')).toBe(true);
  });

  test('throws ResolverError (could not be parsed) when the only package.json is malformed', () => {
    // Preserves the helpful error when there is no valid root to fall back to.
    const root = makeTempDir();
    writeFileSync(join(root, 'package.json'), '{broken json');

    expect(() => resolveProject(root)).toThrow(ResolverError);
    expect(() => resolveProject(root)).toThrow(/could not be parsed/);
  });
});

// --------------------------------------------------------------------------
// Type validation for dependency fields (review-02 #7)
// --------------------------------------------------------------------------

describe('resolveProject — dependency field type validation', () => {
  test('a string dependencies field does not pollute localDeps with char indices', () => {
    const root = makeTempDir();
    writePkg(root, {
      name: 'bad-deps-cli',
      bin: './cli.ts',
      dependencies: 'invalid',
    });

    const {packages} = resolveProject(root);
    const pkg = packages.get('bad-deps-cli')!;
    expect(pkg.localDeps).toEqual([]);
  });

  test('an array dependencies field does not pollute localDeps with numeric indices', () => {
    const root = makeTempDir();
    writePkg(root, {
      name: 'arr-deps-cli',
      bin: './cli.ts',
      dependencies: ['lodash', 'chalk'],
    });

    const {packages} = resolveProject(root);
    const pkg = packages.get('arr-deps-cli')!;
    expect(pkg.localDeps).toEqual([]);
  });

  test('valid object dependencies are still collected', () => {
    const root = makeTempDir();
    writePkg(root, {
      name: 'good-deps-cli',
      bin: './cli.ts',
      dependencies: {lodash: '^4.0.0'},
    });

    const {packages} = resolveProject(root);
    const pkg = packages.get('good-deps-cli')!;
    expect(pkg.localDeps).toEqual(['lodash']);
  });
});
