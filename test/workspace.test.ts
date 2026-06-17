import {afterEach, describe, expect, test} from 'bun:test';
import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {
  buildCommandToPackageMap,
  computeTopologicalOrder,
  discoverWorkspacePackages,
  findWorkspaceRoot,
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
  test('finds the nearest package.json with workspaces from a nested directory', () => {
    const root = makeTempWorkspace();
    const nested = join(root, 'packages', 'app', 'src');
    mkdirSync(nested, {recursive: true});
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify(
        {name: 'fixture-workspace', workspaces: ['packages/*']},
        null,
        2,
      ),
    );

    expect(findWorkspaceRoot(nested)).toBe(root);
  });

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
