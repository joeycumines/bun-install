import {afterEach, describe, expect, test} from 'bun:test';
import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {
  buildCommandToPackageMap,
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
      return pkg ? pkg.bins : [];
    });
    expect(installBins).not.toContain('buildcmd');
    expect(installBins).toContain('myapp');
  });
});
