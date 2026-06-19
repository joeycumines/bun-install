import {describe, expect, test} from 'bun:test';

import {
  pathReferencesPackage,
  contentReferencesPackage,
  isDependencyRecord,
} from '../src/utils.ts';

// --------------------------------------------------------------------------
// pathReferencesPackage (segment-based ownership match for symlink targets)
// --------------------------------------------------------------------------

describe('pathReferencesPackage', () => {
  test('matches a node_modules/<name> path segment', () => {
    expect(
      pathReferencesPackage(
        '/home/u/.bun/install/global/node_modules/foo/index.ts',
        'foo',
      ),
    ).toBe(true);
  });

  test('matches install/global/<name> as consecutive segments', () => {
    expect(pathReferencesPackage('/x/install/global/foo/lib', 'foo')).toBe(
      true,
    );
  });

  test('matches when the name is the final segment', () => {
    expect(pathReferencesPackage('/x/node_modules/foo', 'foo')).toBe(true);
  });

  test('does NOT match a sibling package with a longer name (foo vs foo-bar)', () => {
    // This is the false-positive bug: a naive substring check would match.
    expect(pathReferencesPackage('/x/node_modules/foo-bar/bin.js', 'foo')).toBe(
      false,
    );
  });

  test('does NOT match foo-bin', () => {
    expect(
      pathReferencesPackage('/x/install/global/node_modules/foo-bin/x', 'foo'),
    ).toBe(false);
  });

  test('does NOT match an unrelated package', () => {
    expect(
      pathReferencesPackage('/x/node_modules/lodash/index.js', 'foo'),
    ).toBe(false);
  });

  test('matches the real Bun global symlink target shape', () => {
    // Bun's bin shims are symlinks to .../install/global/node_modules/<name>/...
    expect(
      pathReferencesPackage(
        '/Users/joey/.bun/install/global/node_modules/bun-install/index.ts',
        'bun-install',
      ),
    ).toBe(true);
  });

  test('matches a scoped package name across two segments', () => {
    // Real Bun symlink shape for a scoped package:
    // .../node_modules/@scope/cli/...
    expect(
      pathReferencesPackage(
        '/Users/joey/.bun/install/global/node_modules/@scope/cli/index.ts',
        '@scope/cli',
      ),
    ).toBe(true);
  });

  test('does NOT match a scoped sibling with a different name', () => {
    expect(
      pathReferencesPackage(
        '/x/node_modules/@scope/cli-other/bin.js',
        '@scope/cli',
      ),
    ).toBe(false);
    expect(
      pathReferencesPackage('/x/node_modules/@other/cli/bin.js', '@scope/cli'),
    ).toBe(false);
  });

  test('handles both forward and back slashes', () => {
    expect(
      pathReferencesPackage('C:\\x\\node_modules\\foo\\index.js', 'foo'),
    ).toBe(true);
    expect(pathReferencesPackage('C:\\x\\node_modules\\foo-bar', 'foo')).toBe(
      false,
    );
  });
});

// --------------------------------------------------------------------------
// contentReferencesPackage (file-content ownership heuristic)
// --------------------------------------------------------------------------

describe('contentReferencesPackage', () => {
  test('matches an embedded node_modules/<name>/ path', () => {
    expect(
      contentReferencesPackage('require("node_modules/foo/index.js")', 'foo'),
    ).toBe(true);
  });

  test('matches @bun/<name> with a trailing boundary', () => {
    expect(contentReferencesPackage('require("@bun/foo")', 'foo')).toBe(true);
    expect(
      contentReferencesPackage('module.exports = @bun/foo/lib', 'foo'),
    ).toBe(true);
  });

  test('does NOT match @bun/<name>-bar', () => {
    expect(contentReferencesPackage('require("@bun/foo-bar")', 'foo')).toBe(
      false,
    );
  });

  test('does NOT match a longer-named package in a path', () => {
    expect(contentReferencesPackage('node_modules/foo-bar/bin.js', 'foo')).toBe(
      false,
    );
  });

  test('does NOT match an unrelated package', () => {
    expect(
      contentReferencesPackage('node_modules/lodash/index.js', 'foo'),
    ).toBe(false);
  });

  test('matches backslash paths (cross-platform, R9-3)', () => {
    // On Windows, paths in file content may use backslashes.
    // The regex patterns should match both / and \.
    expect(contentReferencesPackage('node_modules\\foo\\index.js', 'foo')).toBe(
      true,
    );
    expect(
      contentReferencesPackage('install\\global\\foo\\index.js', 'foo'),
    ).toBe(true);
    // Boundary check still works with backslashes — foo-bar does NOT match foo.
    expect(
      contentReferencesPackage('node_modules\\foo-bar\\index.js', 'foo'),
    ).toBe(false);
  });
});

// --------------------------------------------------------------------------
// isDependencyRecord
// --------------------------------------------------------------------------

describe('isDependencyRecord', () => {
  test('accepts a plain dependency object', () => {
    expect(isDependencyRecord({lodash: '^4.0.0'})).toBe(true);
    expect(isDependencyRecord({})).toBe(true);
  });

  test('rejects a string (would yield char indices from Object.keys)', () => {
    expect(isDependencyRecord('invalid')).toBe(false);
  });

  test('rejects an array (would yield numeric indices from Object.keys)', () => {
    expect(isDependencyRecord(['lodash', 'chalk'])).toBe(false);
  });

  test('rejects null and undefined', () => {
    expect(isDependencyRecord(null)).toBe(false);
    expect(isDependencyRecord(undefined)).toBe(false);
  });
});
