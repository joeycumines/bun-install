import {describe, expect, test} from 'bun:test';

import {deriveProjectId} from '../src/archive.ts';
import {extractBinaries} from '../src/utils.ts';

describe('deriveProjectId', () => {
  test('sanitizes package names for filesystem use', () => {
    expect(deriveProjectId('/tmp/repo', '@scope/bun-install')).toBe(
      'scope_bun-install',
    );
  });

  test('falls back to the repository directory name', () => {
    expect(deriveProjectId('/tmp/my-workspace', '')).toBe('my-workspace');
  });
});

describe('extractBinaries', () => {
  test('uses the package name for string bin entries', () => {
    expect(extractBinaries('bun-install', './index.ts')).toEqual([
      'bun-install',
    ]);
  });

  test('uses the unscoped package suffix for scoped string bin entries', () => {
    expect(extractBinaries('@scope/bun-install', './index.ts')).toEqual([
      'bun-install',
    ]);
  });
});
