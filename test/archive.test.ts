import {describe, expect, test} from 'bun:test';

import {deriveProjectId} from '../src/archive.ts';
import {extractBinEntries} from '../src/utils.ts';

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

describe('extractBinEntries', () => {
  test('uses the package name for string bin entries', () => {
    expect(extractBinEntries('bun-install', './index.ts')).toEqual([
      {name: 'bun-install', path: './index.ts'},
    ]);
  });

  test('uses the unscoped package suffix for scoped string bin entries', () => {
    expect(extractBinEntries('@scope/bun-install', './index.ts')).toEqual([
      {name: 'bun-install', path: './index.ts'},
    ]);
  });

  test('handles malformed scoped name (@scope without /name)', () => {
    expect(extractBinEntries('@scope', './cli.js')).toEqual([
      {name: 'scope', path: './cli.js'},
    ]);
  });

  test('object form → one entry per key with path', () => {
    expect(
      extractBinEntries('toolbox', {tool: './tool.ts', helper: './helper.ts'}),
    ).toEqual([
      {name: 'tool', path: './tool.ts'},
      {name: 'helper', path: './helper.ts'},
    ]);
  });

  test('null bin field → empty', () => {
    expect(extractBinEntries('foo', null)).toEqual([]);
  });

  test('undefined bin field → empty', () => {
    expect(extractBinEntries('foo', undefined)).toEqual([]);
  });

  test('skips non-string object values with warning', () => {
    expect(extractBinEntries('foo', {valid: './a.js', invalid: 123})).toEqual([
      {name: 'valid', path: './a.js'},
    ]);
  });

  test('array bin field → empty (not a record)', () => {
    expect(extractBinEntries('foo', ['./a.js'])).toEqual([]);
  });
});
