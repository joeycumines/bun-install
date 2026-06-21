import {describe, expect, test} from 'bun:test';
import {writeFileSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';

import {
  pathReferencesPackage,
  contentReferencesPackage,
  isDependencyRecord,
  parseArgs,
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

// --------------------------------------------------------------------------
// parseArgs
// --------------------------------------------------------------------------

describe('parseArgs', () => {
  test('parses --bun flag', () => {
    const {flags, commands} = parseArgs(['--bun', 'my-cli']);
    expect(flags.bun).toBe(true);
    expect(flags.help).toBe(false);
    expect(commands).toEqual(['my-cli']);
  });

  test('parses --help flag', () => {
    const {flags, commands} = parseArgs(['--help']);
    expect(flags.help).toBe(true);
    expect(flags.bun).toBe(false);
    expect(commands).toEqual([]);
  });

  test('parses -h shorthand', () => {
    const {flags} = parseArgs(['-h']);
    expect(flags.help).toBe(true);
  });

  test('no flags → all positional', () => {
    const {flags, commands} = parseArgs(['my-cli', 'other']);
    expect(flags.bun).toBe(false);
    expect(flags.help).toBe(false);
    expect(commands).toEqual(['my-cli', 'other']);
  });

  test('-- separator passes subsequent args as positional', () => {
    const {flags, commands} = parseArgs(['--bun', '--', '--weird-cmd']);
    expect(flags.bun).toBe(true);
    expect(commands).toEqual(['--weird-cmd']);
  });

  test('multiple args after -- are all positional', () => {
    const {commands} = parseArgs(['--', '--first', '--second', 'normal']);
    expect(commands).toEqual(['--first', '--second', 'normal']);
  });

  test('mixed flags and commands', () => {
    const {flags, commands} = parseArgs(['my-cli', '--bun', 'other']);
    expect(flags.bun).toBe(true);
    expect(commands).toEqual(['my-cli', 'other']);
  });

  test('single dash (-) is treated as a positional argument (POSIX/GNU)', () => {
    // A single '-' is commonly used to mean stdin. It must NOT be treated
    // as an unknown flag. This is the POSIX/GNU convention that
    // util.parseArgs handles correctly.
    const {flags, commands} = parseArgs(['-']);
    expect(flags.bun).toBe(false);
    expect(flags.help).toBe(false);
    expect(commands).toEqual(['-']);
  });

  test('single dash among other args', () => {
    const {flags, commands} = parseArgs(['--bun', '-', 'my-cli']);
    expect(flags.bun).toBe(true);
    expect(commands).toEqual(['-', 'my-cli']);
  });

  test('empty argv → no flags, no commands', () => {
    const {flags, commands} = parseArgs([]);
    expect(flags.bun).toBe(false);
    expect(flags.help).toBe(false);
    expect(commands).toEqual([]);
  });

  test('--bun can appear multiple times (idempotent)', () => {
    const {flags} = parseArgs(['--bun', '--bun']);
    expect(flags.bun).toBe(true);
  });

  // ------------------------------------------------------------------------
  // --package / -p (string option with short alias)
  // ------------------------------------------------------------------------

  test('parses --package <pkg>', () => {
    const {flags, commands} = parseArgs(['--package', 'my-cli']);
    expect(flags.package).toBe('my-cli');
    expect(flags.bun).toBe(false);
    expect(flags.help).toBe(false);
    expect(commands).toEqual([]);
  });

  test('parses -p <pkg> (short form)', () => {
    const {flags, commands} = parseArgs(['-p', 'my-cli']);
    expect(flags.package).toBe('my-cli');
    expect(commands).toEqual([]);
  });

  test('parses --package=<pkg> (inline form)', () => {
    const {flags} = parseArgs(['--package=my-cli']);
    expect(flags.package).toBe('my-cli');
  });

  test('parses -p<pkg> (attached short form)', () => {
    const {flags} = parseArgs(['-pmy-cli']);
    expect(flags.package).toBe('my-cli');
  });

  test('parses --package <pkg> with commands', () => {
    const {flags, commands} = parseArgs([
      '--package',
      'my-cli',
      'cmd1',
      'cmd2',
    ]);
    expect(flags.package).toBe('my-cli');
    expect(commands).toEqual(['cmd1', 'cmd2']);
  });

  test('combines --bun and --package', () => {
    const {flags} = parseArgs(['--bun', '--package', 'my-cli']);
    expect(flags.bun).toBe(true);
    expect(flags.package).toBe('my-cli');
  });

  test('combines --package and commands after -- separator', () => {
    const {flags, commands} = parseArgs([
      '--package',
      'my-cli',
      '--',
      '--weird-cmd',
    ]);
    expect(flags.package).toBe('my-cli');
    expect(commands).toEqual(['--weird-cmd']);
  });

  test('package is undefined when --package is not passed', () => {
    const {flags} = parseArgs(['my-cli', 'other']);
    expect(flags.package).toBeUndefined();
  });

  test('package is undefined with only --bun', () => {
    const {flags} = parseArgs(['--bun', 'cmd1']);
    expect(flags.package).toBeUndefined();
    expect(flags.bun).toBe(true);
  });

  test('package is undefined on empty argv', () => {
    const {flags} = parseArgs([]);
    expect(flags.package).toBeUndefined();
  });
});

// --------------------------------------------------------------------------
// parseArgs — die path (unknown flag)
// --------------------------------------------------------------------------

const UTILS_MODULE = join(import.meta.dir, '..', 'src', 'utils.ts');

/**
 * Runs a small TypeScript snippet in a child Bun process that imports
 * parseArgs from the real utils module. Used to assert the die path exits
 * non-zero. Same pattern as test/operations.test.ts runIsolated.
 */
function runIsolated(body: string): {code: number; stderr: string} {
  const file = join(tmpdir(), `bun-install-args-${randomUUID()}.ts`);
  writeFileSync(
    file,
    `import {parseArgs} from ${JSON.stringify(UTILS_MODULE)};\n${body}`,
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

describe('parseArgs — die path (unknown flag)', () => {
  test('dies on unknown --flag', () => {
    const {code, stderr} = runIsolated("parseArgs(['--unknown']);\n");
    expect(code).toBe(1);
    expect(stderr).toMatch(/Unknown option/i);
    expect(stderr).toMatch(/Supported flags/i);
    // The supported-flags hint must mention --package/-p.
    expect(stderr).toMatch(/--package/i);
  });

  test('dies on unknown short flag -x', () => {
    const {code, stderr} = runIsolated("parseArgs(['-x']);\n");
    expect(code).toBe(1);
    expect(stderr).toMatch(/Unknown option|ERR_PARSE_ARGS/i);
  });

  test('dies when --package is passed without a value', () => {
    // util.parseArgs requires a value for string-type options.
    const {code} = runIsolated("parseArgs(['--package']);\n");
    expect(code).toBe(1);
  });

  test('does NOT die on -- separator', () => {
    const {code} = runIsolated(
      "const r = parseArgs(['--', '--unknown']);\n" +
        "if (r.commands[0] !== '--unknown') throw new Error('fail');\n",
    );
    expect(code).toBe(0);
  });
});

// --------------------------------------------------------------------------
// Empty --package guard (review-02 #2): main() rejects --package= and -p ''
// --------------------------------------------------------------------------

describe('empty --package guard (review-02 #2)', () => {
  const INDEX_PATH = join(import.meta.dir, '..', 'src', 'index.ts');

  test('dies on --package= (empty inline value)', () => {
    const proc = Bun.spawnSync(['bun', INDEX_PATH, '--package='], {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: process.env as Record<string, string>,
    });
    expect(proc.exitCode).toBe(1);
    const stderr = new TextDecoder().decode(proc.stderr);
    expect(stderr).toMatch(/non-empty/i);
  });

  test('dies on -p "" (empty short value)', () => {
    const proc = Bun.spawnSync(['bun', INDEX_PATH, '-p', ''], {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: process.env as Record<string, string>,
    });
    expect(proc.exitCode).toBe(1);
    const stderr = new TextDecoder().decode(proc.stderr);
    expect(stderr).toMatch(/non-empty/i);
  });
});
