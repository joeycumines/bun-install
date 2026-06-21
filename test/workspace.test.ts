import {afterEach, describe, expect, test} from 'bun:test';
import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

import {
  buildCommandToPackageMap,
  computeInstallClosure,
  computeTopologicalOrder,
  computeInstallSet,
  discoverWorkspacePackages,
  resolveWorkspaceGlobs,
} from '../src/workspace.ts';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, {recursive: true, force: true});
  }
});

function makeTempWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bun-install-test-'));
  tempDirs.push(dir);
  return dir;
}

describe('workspace discovery', () => {
  test('discovers packages and computes install order from command selection', () => {
    const root = makeTempWorkspace();
    const packageADir = join(root, 'packages', 'package-a');
    const packageBDir = join(root, 'packages', 'package-b');
    mkdirSync(packageADir, {recursive: true});
    mkdirSync(packageBDir, {recursive: true});

    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify(
        {name: 'fixture-workspace', workspaces: ['packages/*']},
        null,
        2,
      ),
    );
    writeFileSync(
      join(packageADir, 'package.json'),
      JSON.stringify(
        {
          name: 'package-a',
          bin: {'command-a': './index.ts'},
          dependencies: {'package-b': 'workspace:*'},
        },
        null,
        2,
      ),
    );
    writeFileSync(
      join(packageBDir, 'package.json'),
      JSON.stringify(
        {
          name: 'package-b',
          bin: {'command-b': './index.ts'},
        },
        null,
        2,
      ),
    );

    const packages = discoverWorkspacePackages(
      root,
      resolveWorkspaceGlobs({workspaces: ['packages/*']}),
    );
    const commandMap = buildCommandToPackageMap(packages);

    expect(Array.from(packages.keys()).sort()).toEqual([
      'package-a',
      'package-b',
    ]);
    expect(commandMap.get('command-a')).toBe('package-a');
    expect(
      computeTopologicalOrder(['command-a'], packages, commandMap),
    ).toEqual(['package-b', 'package-a']);
  });
});

describe('devDependency build-tool ordering (review-05 #1)', () => {
  test('a devDependency on a local build tool is included in topological build order', () => {
    // package-a devDepends on package-builder (a local sibling build tool
    // with a build script but NO bin). The build tool must be built BEFORE
    // package-a, even though it is only a devDependency (not a runtime dep)
    // and is never directly requested via a command.
    const root = makeTempWorkspace();
    const appDir = join(root, 'packages', 'app');
    const builderDir = join(root, 'packages', 'builder');
    mkdirSync(appDir, {recursive: true});
    mkdirSync(builderDir, {recursive: true});

    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({name: 'monorepo', workspaces: ['packages/*']}),
    );
    writeFileSync(
      join(appDir, 'package.json'),
      JSON.stringify({
        name: 'app',
        bin: {myapp: './index.ts'},
        // builder is a devDependency (build tool), not a runtime dep.
        devDependencies: {builder: 'workspace:*'},
      }),
    );
    writeFileSync(
      join(builderDir, 'package.json'),
      JSON.stringify({
        name: 'builder',
        // builder has a build script but NO bin — it's a build-only tool.
        scripts: {build: 'tsc'},
      }),
    );

    const packages = discoverWorkspacePackages(
      root,
      resolveWorkspaceGlobs({workspaces: ['packages/*']}),
    );

    // Apply the same local-sibling filter as src/index.ts (the single source
    // of truth for "local" status).
    for (const pkg of packages.values()) {
      pkg.localDeps = pkg.localDeps.filter(dep => packages.has(dep));
    }

    // builder must be in app's localDeps after the filter (it's a local
    // sibling devDependency).
    expect(packages.get('app')!.localDeps).toContain('builder');

    const commandMap = buildCommandToPackageMap(packages);
    // Request the 'myapp' command. builder has no bin, so it's not directly
    // requestable — but it must still be built before app because app
    // devDepends on it.
    const order = computeTopologicalOrder(['myapp'], packages, commandMap);

    // builder must appear BEFORE app in the topological build order.
    const builderIdx = order.indexOf('builder');
    const appIdx = order.indexOf('app');
    expect(builderIdx).toBeGreaterThanOrEqual(0);
    expect(appIdx).toBeGreaterThanOrEqual(0);
    expect(builderIdx).toBeLessThan(appIdx);
  });

  test('an optionalDependency on a local sibling is included in topological build order', () => {
    // Same as above but via optionalDependencies — optionalDeps that are
    // local siblings must also be in the build graph.
    const root = makeTempWorkspace();
    const appDir = join(root, 'packages', 'app');
    const optLibDir = join(root, 'packages', 'opt-lib');
    mkdirSync(appDir, {recursive: true});
    mkdirSync(optLibDir, {recursive: true});

    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({name: 'monorepo', workspaces: ['packages/*']}),
    );
    writeFileSync(
      join(appDir, 'package.json'),
      JSON.stringify({
        name: 'app',
        bin: {myapp: './index.ts'},
        optionalDependencies: {'opt-lib': 'workspace:*'},
      }),
    );
    writeFileSync(
      join(optLibDir, 'package.json'),
      JSON.stringify({
        name: 'opt-lib',
        bin: {optcli: './index.ts'},
        scripts: {build: 'tsc'},
      }),
    );

    const packages = discoverWorkspacePackages(
      root,
      resolveWorkspaceGlobs({workspaces: ['packages/*']}),
    );
    for (const pkg of packages.values()) {
      pkg.localDeps = pkg.localDeps.filter(dep => packages.has(dep));
    }

    expect(packages.get('app')!.localDeps).toContain('opt-lib');

    const commandMap = buildCommandToPackageMap(packages);
    const order = computeTopologicalOrder(['myapp'], packages, commandMap);

    const optIdx = order.indexOf('opt-lib');
    const appIdx = order.indexOf('app');
    expect(optIdx).toBeGreaterThanOrEqual(0);
    expect(appIdx).toBeGreaterThanOrEqual(0);
    expect(optIdx).toBeLessThan(appIdx);
  });
});

// --------------------------------------------------------------------------
// computeInstallSet — decoupling build order from install set (R8-1)
// --------------------------------------------------------------------------

describe('computeInstallSet — build vs. install decoupling (review-08 #1)', () => {
  test('excludes a devDep-only build tool from the install set', () => {
    // app (entry, has bin) devDepends on builder (local sibling, no bin).
    // builder is in the BUILD graph (topoOrder) but NOT in the install set.
    const root = makeTempWorkspace();
    const appDir = join(root, 'packages', 'app');
    const builderDir = join(root, 'packages', 'builder');
    mkdirSync(appDir, {recursive: true});
    mkdirSync(builderDir, {recursive: true});

    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({name: 'monorepo', workspaces: ['packages/*']}),
    );
    writeFileSync(
      join(appDir, 'package.json'),
      JSON.stringify({
        name: 'app',
        bin: {myapp: './index.ts'},
        devDependencies: {builder: 'workspace:*'},
      }),
    );
    writeFileSync(
      join(builderDir, 'package.json'),
      JSON.stringify({
        name: 'builder',
        scripts: {build: 'tsc'},
        // No bin — builder is a build-only tool.
      }),
    );

    const packages = discoverWorkspacePackages(
      root,
      resolveWorkspaceGlobs({workspaces: ['packages/*']}),
    );

    // Apply the same local-sibling filter as src/index.ts.
    for (const pkg of packages.values()) {
      pkg.localDeps = pkg.localDeps.filter(dep => packages.has(dep));
      pkg.runtimeLocalDeps = pkg.runtimeLocalDeps.filter(dep =>
        packages.has(dep),
      );
    }

    const commandMap = buildCommandToPackageMap(packages);
    const installSet = computeInstallSet(['myapp'], packages, commandMap);

    // app is the entry → in install set.
    expect(installSet.has('app')).toBe(true);
    // builder is a devDep only → NOT in install set.
    expect(installSet.has('builder')).toBe(false);
  });

  test('includes a runtime dep (not just devDep) in the install set', () => {
    // app depends on lib (runtime dep) and devDepends on builder.
    // lib is in install set; builder is NOT.
    const root = makeTempWorkspace();
    const appDir = join(root, 'packages', 'app');
    const libDir = join(root, 'packages', 'lib');
    const builderDir = join(root, 'packages', 'builder');
    mkdirSync(appDir, {recursive: true});
    mkdirSync(libDir, {recursive: true});
    mkdirSync(builderDir, {recursive: true});

    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({name: 'monorepo', workspaces: ['packages/*']}),
    );
    writeFileSync(
      join(appDir, 'package.json'),
      JSON.stringify({
        name: 'app',
        bin: {myapp: './index.ts'},
        dependencies: {lib: 'workspace:*'},
        devDependencies: {builder: 'workspace:*'},
      }),
    );
    writeFileSync(
      join(libDir, 'package.json'),
      JSON.stringify({name: 'lib', bin: {libcli: './index.ts'}}),
    );
    writeFileSync(
      join(builderDir, 'package.json'),
      JSON.stringify({name: 'builder', scripts: {build: 'tsc'}}),
    );

    const packages = discoverWorkspacePackages(
      root,
      resolveWorkspaceGlobs({workspaces: ['packages/*']}),
    );
    for (const pkg of packages.values()) {
      pkg.localDeps = pkg.localDeps.filter(dep => packages.has(dep));
      pkg.runtimeLocalDeps = pkg.runtimeLocalDeps.filter(dep =>
        packages.has(dep),
      );
    }

    const commandMap = buildCommandToPackageMap(packages);
    const installSet = computeInstallSet(['myapp'], packages, commandMap);

    expect(installSet.has('app')).toBe(true);
    expect(installSet.has('lib')).toBe(true);
    expect(installSet.has('builder')).toBe(false);
  });

  test('installOrder is a subset of topoOrder preserving topological order', () => {
    // app depends on lib (runtime) and devDepends on builder.
    // topoOrder includes all 3; installOrder includes only app + lib.
    const root = makeTempWorkspace();
    const appDir = join(root, 'packages', 'app');
    const libDir = join(root, 'packages', 'lib');
    const builderDir = join(root, 'packages', 'builder');
    mkdirSync(appDir, {recursive: true});
    mkdirSync(libDir, {recursive: true});
    mkdirSync(builderDir, {recursive: true});

    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({name: 'monorepo', workspaces: ['packages/*']}),
    );
    writeFileSync(
      join(appDir, 'package.json'),
      JSON.stringify({
        name: 'app',
        bin: {myapp: './index.ts'},
        dependencies: {lib: 'workspace:*'},
        devDependencies: {builder: 'workspace:*'},
      }),
    );
    writeFileSync(
      join(libDir, 'package.json'),
      JSON.stringify({name: 'lib', bin: {libcli: './index.ts'}}),
    );
    writeFileSync(
      join(builderDir, 'package.json'),
      JSON.stringify({name: 'builder', scripts: {build: 'tsc'}}),
    );

    const packages = discoverWorkspacePackages(
      root,
      resolveWorkspaceGlobs({workspaces: ['packages/*']}),
    );
    for (const pkg of packages.values()) {
      pkg.localDeps = pkg.localDeps.filter(dep => packages.has(dep));
      pkg.runtimeLocalDeps = pkg.runtimeLocalDeps.filter(dep =>
        packages.has(dep),
      );
    }

    const commandMap = buildCommandToPackageMap(packages);
    const topoOrder = computeTopologicalOrder(['myapp'], packages, commandMap);
    const installSet = computeInstallSet(['myapp'], packages, commandMap);
    const installOrder = topoOrder.filter(name => installSet.has(name));

    // builder is in topoOrder (built) but NOT in installOrder (not installed).
    expect(topoOrder).toContain('builder');
    expect(installOrder).not.toContain('builder');

    // app and lib are in both.
    expect(installOrder).toContain('app');
    expect(installOrder).toContain('lib');

    // installOrder preserves topological order (lib before app).
    const libIdx = installOrder.indexOf('lib');
    const appIdx = installOrder.indexOf('app');
    expect(libIdx).toBeLessThan(appIdx);

    // builder is built before app in topoOrder (devDep build tool).
    // NOTE: compare indices in topoOrder, not installOrder (builder is not
    // in installOrder, so its installOrder index would be -1).
    const builderTopoIdx = topoOrder.indexOf('builder');
    const appTopoIdx = topoOrder.indexOf('app');
    expect(builderTopoIdx).toBeGreaterThanOrEqual(0);
    expect(builderTopoIdx).toBeLessThan(appTopoIdx);
  });

  test('a devDep build tool WITH a bin is built but NOT installed (R8-1 core)', () => {
    // This is the critical regression scenario: a devDep build tool that
    // has its own `bin` field. Before the fix, it would be globally
    // installed as a command. After the fix, it's built but NOT in the
    // install set (not packed, not installed, its bin not verified).
    const root = makeTempWorkspace();
    const appDir = join(root, 'packages', 'app');
    const builderCliDir = join(root, 'packages', 'builder-cli');
    mkdirSync(appDir, {recursive: true});
    mkdirSync(builderCliDir, {recursive: true});

    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({name: 'monorepo', workspaces: ['packages/*']}),
    );
    writeFileSync(
      join(appDir, 'package.json'),
      JSON.stringify({
        name: 'app',
        bin: {myapp: './index.ts'},
        devDependencies: {'builder-cli': 'workspace:*'},
      }),
    );
    writeFileSync(
      join(builderCliDir, 'package.json'),
      JSON.stringify({
        name: 'builder-cli',
        bin: {buildcmd: './cli.ts'},
        scripts: {build: 'tsc'},
      }),
    );

    const packages = discoverWorkspacePackages(
      root,
      resolveWorkspaceGlobs({workspaces: ['packages/*']}),
    );
    for (const pkg of packages.values()) {
      pkg.localDeps = pkg.localDeps.filter(dep => packages.has(dep));
      pkg.runtimeLocalDeps = pkg.runtimeLocalDeps.filter(dep =>
        packages.has(dep),
      );
    }

    const commandMap = buildCommandToPackageMap(packages);
    const topoOrder = computeTopologicalOrder(['myapp'], packages, commandMap);
    const installSet = computeInstallSet(['myapp'], packages, commandMap);
    const installOrder = topoOrder.filter(name => installSet.has(name));

    // builder-cli IS in the build order (must be built before app).
    expect(topoOrder).toContain('builder-cli');

    // builder-cli is NOT in the install set or install order.
    expect(installSet.has('builder-cli')).toBe(false);
    expect(installOrder).not.toContain('builder-cli');

    // builder-cli's bin ('buildcmd') is NOT in installBins.
    const installBins = installOrder.flatMap(pkgName => {
      const pkg = packages.get(pkgName);
      return pkg ? pkg.binEntries.map(e => e.name) : [];
    });
    expect(installBins).not.toContain('buildcmd');
    expect(installBins).toContain('myapp');
  });
});

// --------------------------------------------------------------------------
// computeInstallClosure (--package scoping)
// --------------------------------------------------------------------------

describe('computeInstallClosure', () => {
  test('includes the package itself', () => {
    const root = makeTempWorkspace();
    const appDir = join(root, 'packages', 'app');
    mkdirSync(appDir, {recursive: true});
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({name: 'monorepo', workspaces: ['packages/*']}),
    );
    writeFileSync(
      join(appDir, 'package.json'),
      JSON.stringify({name: 'app', bin: {myapp: './index.ts'}}),
    );

    const packages = discoverWorkspacePackages(
      root,
      resolveWorkspaceGlobs({workspaces: ['packages/*']}),
    );
    for (const pkg of packages.values()) {
      pkg.localDeps = pkg.localDeps.filter(dep => packages.has(dep));
      pkg.runtimeLocalDeps = pkg.runtimeLocalDeps.filter(dep =>
        packages.has(dep),
      );
    }

    const closure = computeInstallClosure(packages, 'app');
    expect(closure.has('app')).toBe(true);
    expect(closure.size).toBe(1);
  });

  test('includes runtime deps (dependencies)', () => {
    const root = makeTempWorkspace();
    const appDir = join(root, 'packages', 'app');
    const libDir = join(root, 'packages', 'lib');
    mkdirSync(appDir, {recursive: true});
    mkdirSync(libDir, {recursive: true});
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({name: 'monorepo', workspaces: ['packages/*']}),
    );
    writeFileSync(
      join(appDir, 'package.json'),
      JSON.stringify({
        name: 'app',
        bin: {myapp: './index.ts'},
        dependencies: {lib: 'workspace:*'},
      }),
    );
    writeFileSync(
      join(libDir, 'package.json'),
      JSON.stringify({name: 'lib', bin: {libcli: './index.ts'}}),
    );

    const packages = discoverWorkspacePackages(
      root,
      resolveWorkspaceGlobs({workspaces: ['packages/*']}),
    );
    for (const pkg of packages.values()) {
      pkg.localDeps = pkg.localDeps.filter(dep => packages.has(dep));
      pkg.runtimeLocalDeps = pkg.runtimeLocalDeps.filter(dep =>
        packages.has(dep),
      );
    }

    const closure = computeInstallClosure(packages, 'app');
    expect(closure.has('app')).toBe(true);
    expect(closure.has('lib')).toBe(true);
  });

  test('excludes devDependencies (build-only deps are not installed)', () => {
    const root = makeTempWorkspace();
    const appDir = join(root, 'packages', 'app');
    const builderDir = join(root, 'packages', 'builder');
    mkdirSync(appDir, {recursive: true});
    mkdirSync(builderDir, {recursive: true});
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({name: 'monorepo', workspaces: ['packages/*']}),
    );
    writeFileSync(
      join(appDir, 'package.json'),
      JSON.stringify({
        name: 'app',
        bin: {myapp: './index.ts'},
        devDependencies: {builder: 'workspace:*'},
      }),
    );
    writeFileSync(
      join(builderDir, 'package.json'),
      JSON.stringify({name: 'builder', scripts: {build: 'tsc'}}),
    );

    const packages = discoverWorkspacePackages(
      root,
      resolveWorkspaceGlobs({workspaces: ['packages/*']}),
    );
    for (const pkg of packages.values()) {
      pkg.localDeps = pkg.localDeps.filter(dep => packages.has(dep));
      pkg.runtimeLocalDeps = pkg.runtimeLocalDeps.filter(dep =>
        packages.has(dep),
      );
    }

    const closure = computeInstallClosure(packages, 'app');
    expect(closure.has('app')).toBe(true);
    // builder is a devDep → not in runtimeLocalDeps → excluded from closure.
    expect(closure.has('builder')).toBe(false);
  });

  test('follows transitive runtime deps', () => {
    const root = makeTempWorkspace();
    const appDir = join(root, 'packages', 'app');
    const libDir = join(root, 'packages', 'lib');
    const coreDir = join(root, 'packages', 'core');
    mkdirSync(appDir, {recursive: true});
    mkdirSync(libDir, {recursive: true});
    mkdirSync(coreDir, {recursive: true});
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({name: 'monorepo', workspaces: ['packages/*']}),
    );
    writeFileSync(
      join(appDir, 'package.json'),
      JSON.stringify({
        name: 'app',
        bin: {myapp: './index.ts'},
        dependencies: {lib: 'workspace:*'},
      }),
    );
    writeFileSync(
      join(libDir, 'package.json'),
      JSON.stringify({
        name: 'lib',
        dependencies: {core: 'workspace:*'},
      }),
    );
    writeFileSync(
      join(coreDir, 'package.json'),
      JSON.stringify({name: 'core'}),
    );

    const packages = discoverWorkspacePackages(
      root,
      resolveWorkspaceGlobs({workspaces: ['packages/*']}),
    );
    for (const pkg of packages.values()) {
      pkg.localDeps = pkg.localDeps.filter(dep => packages.has(dep));
      pkg.runtimeLocalDeps = pkg.runtimeLocalDeps.filter(dep =>
        packages.has(dep),
      );
    }

    const closure = computeInstallClosure(packages, 'app');
    expect(closure.has('app')).toBe(true);
    expect(closure.has('lib')).toBe(true);
    expect(closure.has('core')).toBe(true);
  });
});

// --------------------------------------------------------------------------
// buildCommandToPackageMap — restrictTo (--package collision scoping)
// --------------------------------------------------------------------------

const WORKSPACE_MODULE = join(import.meta.dir, '..', 'src', 'workspace.ts');
const TYPES_MODULE = join(import.meta.dir, '..', 'src', 'types.ts');

/**
 * Runs a TypeScript snippet in a child Bun process that imports from the
 * real workspace module. Used to assert `die` paths (which call
 * process.exit(1) and cannot be caught with expect().toThrow). Same pattern
 * as test/operations.test.ts runIsolated.
 */
function runIsolated(body: string): {code: number; stderr: string} {
  const file = join(tmpdir(), `bun-install-ws-die-${randomUUID()}.ts`);
  writeFileSync(
    file,
    `import {buildCommandToPackageMap, computeInstallClosure} from ${JSON.stringify(WORKSPACE_MODULE)};\n` +
      `import type {PackageData} from ${JSON.stringify(TYPES_MODULE)};\n` +
      body,
  );
  try {
    const proc = Bun.spawnSync(['bun', file], {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: process.env as Record<string, string>,
    });
    return {
      code: proc.exitCode ?? -1,
      stderr: new TextDecoder().decode(proc.stderr),
    };
  } finally {
    rmSync(file, {force: true});
  }
}

/** Constructs a minimal PackageData for inline use in runIsolated. */
function pkgData(
  name: string,
  bins: Array<[string, string]>,
  runtimeDeps: string[] = [],
): string {
  const binEntries = bins.map(([n, p]) => `{name:'${n}',path:'${p}'}`);
  return `{name:'${name}',dir:'/x',binEntries:[${binEntries.join(',')}],localDeps:[],runtimeLocalDeps:[${runtimeDeps.map(d => `'${d}'`).join(',')}],hasBuildScript:false}`;
}

describe('buildCommandToPackageMap — restrictTo', () => {
  test('without restrictTo: dies on collision (backward compatible)', () => {
    const {code, stderr} = runIsolated(
      'const m = new Map<string, PackageData>([\n' +
        `  ['pkg-a', ${pkgData('pkg-a', [['shared-cmd', './a.ts']])}],\n` +
        `  ['pkg-x', ${pkgData('pkg-x', [['shared-cmd', './x.ts']])}],\n` +
        ']);\n' +
        'buildCommandToPackageMap(m);\n',
    );
    expect(code).toBe(1);
    expect(stderr).toMatch(/is defined by both/);
  });

  test('with restrictTo to one package: no die for the excluded package', () => {
    const root = makeTempWorkspace();
    const pkgADir = join(root, 'packages', 'pkg-a');
    const pkgXDir = join(root, 'packages', 'pkg-x');
    mkdirSync(pkgADir, {recursive: true});
    mkdirSync(pkgXDir, {recursive: true});
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({name: 'monorepo', workspaces: ['packages/*']}),
    );
    writeFileSync(
      join(pkgADir, 'package.json'),
      JSON.stringify({name: 'pkg-a', bin: {'shared-cmd': './a.ts'}}),
    );
    writeFileSync(
      join(pkgXDir, 'package.json'),
      JSON.stringify({name: 'pkg-x', bin: {'shared-cmd': './x.ts'}}),
    );

    const packages = discoverWorkspacePackages(
      root,
      resolveWorkspaceGlobs({workspaces: ['packages/*']}),
    );

    // Restrict to pkg-a only — pkg-x is excluded, no collision die.
    const map = buildCommandToPackageMap(packages, new Set(['pkg-a']));
    expect(map.get('shared-cmd')).toBe('pkg-a');
    expect(map.size).toBe(1);
  });

  test('with restrictTo containing both colliding packages: still dies', () => {
    const {code, stderr} = runIsolated(
      'const m = new Map<string, PackageData>([\n' +
        `  ['pkg-a', ${pkgData('pkg-a', [['shared-cmd', './a.ts']])}],\n` +
        `  ['pkg-b', ${pkgData('pkg-b', [['shared-cmd', './b.ts']])}],\n` +
        ']);\n' +
        "buildCommandToPackageMap(m, new Set(['pkg-a', 'pkg-b']));\n",
    );
    expect(code).toBe(1);
    expect(stderr).toMatch(/is defined by both/);
  });

  test('restrictTo = undefined behaves like no restrictTo', () => {
    const root = makeTempWorkspace();
    const appDir = join(root, 'packages', 'app');
    mkdirSync(appDir, {recursive: true});
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({name: 'monorepo', workspaces: ['packages/*']}),
    );
    writeFileSync(
      join(appDir, 'package.json'),
      JSON.stringify({name: 'app', bin: {myapp: './index.ts'}}),
    );

    const packages = discoverWorkspacePackages(
      root,
      resolveWorkspaceGlobs({workspaces: ['packages/*']}),
    );

    const map1 = buildCommandToPackageMap(packages);
    const map2 = buildCommandToPackageMap(packages, undefined);
    expect(map1).toEqual(map2);
  });
});

// --------------------------------------------------------------------------
// --package selection logic (end-to-end integration tests)
// --------------------------------------------------------------------------

describe('--package selection logic', () => {
  test('--package selects all commands from the package', () => {
    const root = makeTempWorkspace();
    const pkgADir = join(root, 'packages', 'pkg-a');
    const pkgBDir = join(root, 'packages', 'pkg-b');
    mkdirSync(pkgADir, {recursive: true});
    mkdirSync(pkgBDir, {recursive: true});
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({name: 'monorepo', workspaces: ['packages/*']}),
    );
    writeFileSync(
      join(pkgADir, 'package.json'),
      JSON.stringify({
        name: 'pkg-a',
        bin: {cmd1: './c1.ts', cmd2: './c2.ts'},
      }),
    );
    writeFileSync(
      join(pkgBDir, 'package.json'),
      JSON.stringify({name: 'pkg-b', bin: {cmd3: './c3.ts'}}),
    );

    const packages = discoverWorkspacePackages(
      root,
      resolveWorkspaceGlobs({workspaces: ['packages/*']}),
    );
    for (const pkg of packages.values()) {
      pkg.localDeps = pkg.localDeps.filter(dep => packages.has(dep));
      pkg.runtimeLocalDeps = pkg.runtimeLocalDeps.filter(dep =>
        packages.has(dep),
      );
    }

    // Simulate: --package pkg-a (no commands → all from pkg-a)
    const pkgA = packages.get('pkg-a')!;
    const targetCommands = pkgA.binEntries.map(e => e.name);
    expect(targetCommands).toEqual(['cmd1', 'cmd2']);

    const closure = computeInstallClosure(packages, 'pkg-a');
    const commandMap = buildCommandToPackageMap(packages, closure);
    // pkg-b is NOT in the closure → not in the map.
    expect(commandMap.has('cmd3')).toBe(false);
    expect(commandMap.get('cmd1')).toBe('pkg-a');
    expect(commandMap.get('cmd2')).toBe('pkg-a');
  });

  test('--package with command subset: selectedBins filters correctly', () => {
    const root = makeTempWorkspace();
    const pkgADir = join(root, 'packages', 'pkg-a');
    mkdirSync(pkgADir, {recursive: true});
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({name: 'monorepo', workspaces: ['packages/*']}),
    );
    writeFileSync(
      join(pkgADir, 'package.json'),
      JSON.stringify({
        name: 'pkg-a',
        bin: {cmd1: './c1.ts', cmd2: './c2.ts', cmd3: './c3.ts'},
      }),
    );

    const packages = discoverWorkspacePackages(
      root,
      resolveWorkspaceGlobs({workspaces: ['packages/*']}),
    );
    for (const pkg of packages.values()) {
      pkg.localDeps = pkg.localDeps.filter(dep => packages.has(dep));
      pkg.runtimeLocalDeps = pkg.runtimeLocalDeps.filter(dep =>
        packages.has(dep),
      );
    }

    // Simulate: --package pkg-a cmd1 cmd3
    const pkgA = packages.get('pkg-a')!;
    const targetCommands = ['cmd1', 'cmd3'];
    const targetSet = new Set(targetCommands);
    const selectedBins = new Map<string, typeof pkgA.binEntries>();
    selectedBins.set(
      'pkg-a',
      pkgA.binEntries.filter(e => targetSet.has(e.name)),
    );

    // selectedBins only has cmd1 and cmd3 — NOT cmd2.
    const selected = selectedBins.get('pkg-a')!;
    expect(selected).toHaveLength(2);
    expect(selected.map(e => e.name)).toEqual(['cmd1', 'cmd3']);
    expect(selected.find(e => e.name === 'cmd2')).toBeUndefined();
  });

  test('no-clobber: collision with unrelated package does not die', () => {
    // pkg-a has B and C. pkg-x (unrelated, not a dep) also has B.
    // --package pkg-a C should NOT die — pkg-x is not in the closure.
    const root = makeTempWorkspace();
    const pkgADir = join(root, 'packages', 'pkg-a');
    const pkgXDir = join(root, 'packages', 'pkg-x');
    mkdirSync(pkgADir, {recursive: true});
    mkdirSync(pkgXDir, {recursive: true});
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({name: 'monorepo', workspaces: ['packages/*']}),
    );
    writeFileSync(
      join(pkgADir, 'package.json'),
      JSON.stringify({
        name: 'pkg-a',
        bin: {B: './b.ts', C: './c.ts'},
      }),
    );
    writeFileSync(
      join(pkgXDir, 'package.json'),
      JSON.stringify({
        name: 'pkg-x',
        bin: {B: './bx.ts', other: './o.ts'},
      }),
    );

    const packages = discoverWorkspacePackages(
      root,
      resolveWorkspaceGlobs({workspaces: ['packages/*']}),
    );
    for (const pkg of packages.values()) {
      pkg.localDeps = pkg.localDeps.filter(dep => packages.has(dep));
      pkg.runtimeLocalDeps = pkg.runtimeLocalDeps.filter(dep =>
        packages.has(dep),
      );
    }

    // Simulate: --package pkg-a C
    const closure = computeInstallClosure(packages, 'pkg-a');
    // pkg-x is NOT in the closure.
    expect(closure.has('pkg-x')).toBe(false);

    // buildCommandToPackageMap scoped to the closure does NOT die.
    const commandMap = buildCommandToPackageMap(packages, closure);
    expect(commandMap.get('B')).toBe('pkg-a');
    expect(commandMap.get('C')).toBe('pkg-a');
    // pkg-x's 'other' is not in the map.
    expect(commandMap.has('other')).toBe(false);
  });

  test('collision within install closure IS detected', () => {
    // pkg-a depends on pkg-d (runtime dep). Both define 'shared-cmd'.
    // --package pkg-a should die — both would be installed and clobber.
    const {code, stderr} = runIsolated(
      'const m = new Map<string, PackageData>([\n' +
        `  ['pkg-a', ${pkgData('pkg-a', [['shared-cmd', './a.ts']], ['pkg-d'])}],\n` +
        `  ['pkg-d', ${pkgData('pkg-d', [['shared-cmd', './d.ts']])}],\n` +
        ']);\n' +
        "const closure = computeInstallClosure(m, 'pkg-a');\n" +
        'buildCommandToPackageMap(m, closure);\n',
    );
    expect(code).toBe(1);
    expect(stderr).toMatch(/is defined by both/);
  });

  // ------------------------------------------------------------------------
  // False collision die — review-02 #1: when --package selects a subset of
  // commands, the target package's binEntries must be filtered in the
  // collision map so unselected commands cannot trigger a false die with a
  // runtime dependency's command of the same name.
  // ------------------------------------------------------------------------

  test('false collision die: unselected command does not collide with dep (review-02 #1)', () => {
    // pkg-a has commands [B, C]. pkg-d (runtime dep) also has command [B].
    // --package pkg-a C selects ONLY C. B from pkg-a is unselected and
    // filtered out of the collision map, so no collision with pkg-d's B.
    const root = makeTempWorkspace();
    const pkgADir = join(root, 'packages', 'pkg-a');
    const pkgDDir = join(root, 'packages', 'pkg-d');
    mkdirSync(pkgADir, {recursive: true});
    mkdirSync(pkgDDir, {recursive: true});
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({name: 'monorepo', workspaces: ['packages/*']}),
    );
    writeFileSync(
      join(pkgADir, 'package.json'),
      JSON.stringify({
        name: 'pkg-a',
        bin: {B: './b.ts', C: './c.ts'},
        dependencies: {'pkg-d': 'workspace:*'},
      }),
    );
    writeFileSync(
      join(pkgDDir, 'package.json'),
      JSON.stringify({
        name: 'pkg-d',
        bin: {B: './bd.ts'},
      }),
    );

    const packages = discoverWorkspacePackages(
      root,
      resolveWorkspaceGlobs({workspaces: ['packages/*']}),
    );
    for (const pkg of packages.values()) {
      pkg.localDeps = pkg.localDeps.filter(dep => packages.has(dep));
      pkg.runtimeLocalDeps = pkg.runtimeLocalDeps.filter(dep =>
        packages.has(dep),
      );
    }

    // Simulate: --package pkg-a C (selecting only C)
    const pkgA = packages.get('pkg-a')!;
    const targetCommands = ['C'];
    const targetSet = new Set(targetCommands);
    const selectedBins = new Map<string, typeof pkgA.binEntries>();
    selectedBins.set(
      'pkg-a',
      pkgA.binEntries.filter(e => targetSet.has(e.name)),
    );

    // Build the collision map: replace pkg-a's binEntries with only the
    // selected entries (C only). This is what runLocalMode does.
    const installClosure = computeInstallClosure(packages, 'pkg-a');
    const collisionMap = new Map(packages);
    collisionMap.set('pkg-a', {
      ...pkgA,
      binEntries: selectedBins.get('pkg-a')!,
    });

    // buildCommandToPackageMap with the filtered collision map should NOT die.
    // pkg-a contributes only C; pkg-d contributes B. No collision.
    const commandMap = buildCommandToPackageMap(collisionMap, installClosure);
    expect(commandMap.get('C')).toBe('pkg-a');
    expect(commandMap.get('B')).toBe('pkg-d');
    expect(commandMap.size).toBe(2);
  });

  test('real collision die: selected command DOES collide with dep (review-02 #1)', () => {
    // Same workspace as above, but --package pkg-a (all commands, including B).
    // Both pkg-a and pkg-d define B → real collision → die.
    const {code, stderr} = runIsolated(
      'const m = new Map<string, PackageData>([\n' +
        `  ['pkg-a', ${pkgData(
          'pkg-a',
          [
            ['B', './b.ts'],
            ['C', './c.ts'],
          ],
          ['pkg-d'],
        )}],\n` +
        `  ['pkg-d', ${pkgData('pkg-d', [['B', './bd.ts']])}],\n` +
        ']);\n' +
        "const closure = computeInstallClosure(m, 'pkg-a');\n" +
        // Simulate the full-selection case: collision map = original map
        // (all binEntries, no filtering). This should die.
        'buildCommandToPackageMap(m, closure);\n',
    );
    expect(code).toBe(1);
    expect(stderr).toMatch(/is defined by both/);
  });

  test('real collision die: selected command subset collides with dep', () => {
    // pkg-a has [B, C]. pkg-d (runtime dep) has [C].
    // --package pkg-a B C selects both including C → collision with pkg-d's C.
    // The collision map has C for pkg-a (selected) and C for pkg-d → die.
    const {code, stderr} = runIsolated(
      'const m = new Map<string, PackageData>([\n' +
        `  ['pkg-a', ${pkgData(
          'pkg-a',
          [
            ['B', './b.ts'],
            ['C', './c.ts'],
          ],
          ['pkg-d'],
        )}],\n` +
        `  ['pkg-d', ${pkgData('pkg-d', [['C', './cd.ts']])}],\n` +
        ']);\n' +
        "const closure = computeInstallClosure(m, 'pkg-a');\n" +
        // Simulate: collision map with pkg-a's binEntries = [B, C] (both selected).
        // This should die because C collides with pkg-d's C.
        'const collisionMap = new Map(m);\n' +
        "collisionMap.set('pkg-a', {...m.get('pkg-a')!, binEntries: [{name:'B',path:'./b.ts'},{name:'C',path:'./c.ts'}]});\n" +
        'buildCommandToPackageMap(collisionMap, closure);\n',
    );
    expect(code).toBe(1);
    expect(stderr).toMatch(/is defined by both/);
  });
});
