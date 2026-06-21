import {describe, expect, test, afterEach} from 'bun:test';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';

import {parseNpmSpec, resolveInstalledPackageDir} from '../src/npm.ts';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, {recursive: true, force: true});
  }
});

// --------------------------------------------------------------------------
// parseNpmSpec — NPM specifier parsing
// --------------------------------------------------------------------------

describe('parseNpmSpec — unscoped packages', () => {
  test('pkg (no version)', () => {
    expect(parseNpmSpec('pkg')).toEqual({name: 'pkg', version: undefined});
  });

  test('pkg@latest (tag)', () => {
    expect(parseNpmSpec('pkg@latest')).toEqual({
      name: 'pkg',
      version: 'latest',
    });
  });

  test('pkg@1.2.3 (exact version)', () => {
    expect(parseNpmSpec('pkg@1.2.3')).toEqual({
      name: 'pkg',
      version: '1.2.3',
    });
  });

  test('pkg@^1.0.0 (caret range)', () => {
    expect(parseNpmSpec('pkg@^1.0.0')).toEqual({
      name: 'pkg',
      version: '^1.0.0',
    });
  });

  test('pkg@~1.2.0 (tilde range)', () => {
    expect(parseNpmSpec('pkg@~1.2.0')).toEqual({
      name: 'pkg',
      version: '~1.2.0',
    });
  });

  test('pkg@>=1.0.0 <2.0.0 (compound range)', () => {
    expect(parseNpmSpec('pkg@>=1.0.0 <2.0.0')).toEqual({
      name: 'pkg',
      version: '>=1.0.0 <2.0.0',
    });
  });

  test('pkg@next (pre-release tag)', () => {
    expect(parseNpmSpec('pkg@next')).toEqual({
      name: 'pkg',
      version: 'next',
    });
  });
});

describe('parseNpmSpec — scoped packages', () => {
  test('@scope/pkg (no version)', () => {
    expect(parseNpmSpec('@scope/pkg')).toEqual({
      name: '@scope/pkg',
      version: undefined,
    });
  });

  test('@scope/pkg@latest (tag)', () => {
    expect(parseNpmSpec('@scope/pkg@latest')).toEqual({
      name: '@scope/pkg',
      version: 'latest',
    });
  });

  test('@scope/pkg@1.2.3 (exact version)', () => {
    expect(parseNpmSpec('@scope/pkg@1.2.3')).toEqual({
      name: '@scope/pkg',
      version: '1.2.3',
    });
  });

  test('@scope/pkg@^1.0.0 (caret range)', () => {
    expect(parseNpmSpec('@scope/pkg@^1.0.0')).toEqual({
      name: '@scope/pkg',
      version: '^1.0.0',
    });
  });

  test('@some-thing-on/npm-is-what-i-mean@latest (long scoped name)', () => {
    expect(parseNpmSpec('@some-thing-on/npm-is-what-i-mean@latest')).toEqual({
      name: '@some-thing-on/npm-is-what-i-mean',
      version: 'latest',
    });
  });
});

describe('parseNpmSpec — edge cases', () => {
  test('empty string', () => {
    expect(parseNpmSpec('')).toEqual({name: '', version: undefined});
  });

  test('@scope only (malformed, no /pkg)', () => {
    // A bare @scope without /pkg is not a valid NPM spec, but the parser
    // should not crash — it returns the whole string as the name.
    expect(parseNpmSpec('@scope')).toEqual({
      name: '@scope',
      version: undefined,
    });
  });

  test('pkg-name with dashes', () => {
    expect(parseNpmSpec('my-cool-cli')).toEqual({
      name: 'my-cool-cli',
      version: undefined,
    });
  });

  test('pkg-name@1.0.0-beta.1 (pre-release version)', () => {
    expect(parseNpmSpec('pkg-name@1.0.0-beta.1')).toEqual({
      name: 'pkg-name',
      version: '1.0.0-beta.1',
    });
  });

  test('@scope/pkg-name@1.0.0-beta.1 (scoped + pre-release)', () => {
    expect(parseNpmSpec('@scope/pkg-name@1.0.0-beta.1')).toEqual({
      name: '@scope/pkg-name',
      version: '1.0.0-beta.1',
    });
  });
});

describe('parseNpmSpec — @ disambiguation', () => {
  test('the first @ in a scoped package is the scope, not the version', () => {
    const result = parseNpmSpec('@scope/pkg@1.0.0');
    expect(result.name).toBe('@scope/pkg');
    expect(result.version).toBe('1.0.0');
  });

  test('the first @ in an unscoped package is the version separator', () => {
    const result = parseNpmSpec('pkg@1.0.0');
    expect(result.name).toBe('pkg');
    expect(result.version).toBe('1.0.0');
  });

  test('scoped package name does not include the version @', () => {
    const result = parseNpmSpec('@org/cli@latest');
    expect(result.name).not.toContain('@latest');
    expect(result.name).toBe('@org/cli');
  });
});

// --------------------------------------------------------------------------
// resolveInstalledPackageDir — directory resolution from dependencies key
// (review-01 #1, review-071e6d2 #3): replaces name-guessing via parseNpmSpec
// with reading the dependencies key from the temp project's package.json.
// This is specifier-agnostic — works for any `bun add` specifier.
// --------------------------------------------------------------------------

describe('resolveInstalledPackageDir — success paths', () => {
  test('resolves a regular unscoped package', () => {
    const fetchDir = mkdtempSync(join(tmpdir(), 'npm-resolve-'));
    tempDirs.push(fetchDir);
    writeFileSync(
      join(fetchDir, 'package.json'),
      JSON.stringify({
        name: 'bun-install-fetch',
        private: true,
        dependencies: {cowsay: '^1.5.0'},
      }),
    );
    mkdirSync(join(fetchDir, 'node_modules', 'cowsay'), {recursive: true});
    writeFileSync(
      join(fetchDir, 'node_modules', 'cowsay', 'package.json'),
      '{"name":"cowsay"}',
    );

    const pkgDir = resolveInstalledPackageDir(fetchDir, 'cowsay');
    expect(pkgDir).toBe(join(fetchDir, 'node_modules', 'cowsay'));
  });

  test('resolves a scoped package (@scope/pkg)', () => {
    const fetchDir = mkdtempSync(join(tmpdir(), 'npm-resolve-'));
    tempDirs.push(fetchDir);
    writeFileSync(
      join(fetchDir, 'package.json'),
      JSON.stringify({
        name: 'bun-install-fetch',
        private: true,
        dependencies: {'@scope/pkg': '^1.0.0'},
      }),
    );
    mkdirSync(join(fetchDir, 'node_modules', '@scope', 'pkg'), {
      recursive: true,
    });
    writeFileSync(
      join(fetchDir, 'node_modules', '@scope', 'pkg', 'package.json'),
      '{"name":"@scope/pkg"}',
    );

    const pkgDir = resolveInstalledPackageDir(fetchDir, '@scope/pkg');
    expect(pkgDir).toBe(join(fetchDir, 'node_modules', '@scope', 'pkg'));
  });

  test('resolves an aliased package (name differs from spec)', () => {
    // `bun add myalias@npm:realpkg` records 'myalias' in dependencies,
    // and installs to node_modules/myalias. The package.json inside has
    // name: 'realpkg' — but the directory uses the alias name.
    const fetchDir = mkdtempSync(join(tmpdir(), 'npm-resolve-'));
    tempDirs.push(fetchDir);
    writeFileSync(
      join(fetchDir, 'package.json'),
      JSON.stringify({
        name: 'bun-install-fetch',
        private: true,
        dependencies: {myalias: 'npm:realpkg'},
      }),
    );
    mkdirSync(join(fetchDir, 'node_modules', 'myalias'), {recursive: true});
    writeFileSync(
      join(fetchDir, 'node_modules', 'myalias', 'package.json'),
      '{"name":"realpkg"}',
    );

    const pkgDir = resolveInstalledPackageDir(fetchDir, 'myalias@npm:realpkg');
    expect(pkgDir).toBe(join(fetchDir, 'node_modules', 'myalias'));
  });

  test('resolves regardless of the specifier format (simulated git URL)', () => {
    // The directory resolution reads the dependencies key, not the spec.
    // Even for a git URL like 'github:user/repo', `bun add` records the
    // package's actual name in dependencies. This test simulates that.
    const fetchDir = mkdtempSync(join(tmpdir(), 'npm-resolve-'));
    tempDirs.push(fetchDir);
    writeFileSync(
      join(fetchDir, 'package.json'),
      JSON.stringify({
        name: 'bun-install-fetch',
        private: true,
        dependencies: {'github-pkg': 'github:user/repo'},
      }),
    );
    mkdirSync(join(fetchDir, 'node_modules', 'github-pkg'), {
      recursive: true,
    });
    writeFileSync(
      join(fetchDir, 'node_modules', 'github-pkg', 'package.json'),
      '{"name":"github-pkg"}',
    );

    const pkgDir = resolveInstalledPackageDir(fetchDir, 'github:user/repo');
    expect(pkgDir).toBe(join(fetchDir, 'node_modules', 'github-pkg'));
  });
});

// --------------------------------------------------------------------------
// resolveInstalledPackageDir — die paths (verified via subprocess because
// `die` calls process.exit(1), which cannot be asserted in the test runner)
// --------------------------------------------------------------------------

const NPM_MODULE = join(import.meta.dir, '..', 'src', 'npm.ts');

function runIsolated(body: string): {code: number; stderr: string} {
  const file = join(tmpdir(), `bun-install-npm-die-${randomUUID()}.ts`);
  writeFileSync(
    file,
    `import {resolveInstalledPackageDir} from ${JSON.stringify(NPM_MODULE)};\n` +
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

describe('resolveInstalledPackageDir — die paths', () => {
  test('dies when dependencies key is missing', () => {
    const fetchDir = mkdtempSync(join(tmpdir(), 'npm-die-'));
    try {
      writeFileSync(
        join(fetchDir, 'package.json'),
        JSON.stringify({name: 'bun-install-fetch', private: true}),
      );
      const {code, stderr} = runIsolated(
        `resolveInstalledPackageDir(${JSON.stringify(fetchDir)}, 'cowsay');\n`,
      );
      expect(code).toBe(1);
      expect(stderr).toMatch(/did not update dependencies/i);
    } finally {
      rmSync(fetchDir, {recursive: true, force: true});
    }
  });

  test('dies when dependencies is not an object (e.g. a string)', () => {
    const fetchDir = mkdtempSync(join(tmpdir(), 'npm-die-'));
    try {
      writeFileSync(
        join(fetchDir, 'package.json'),
        JSON.stringify({
          name: 'bun-install-fetch',
          private: true,
          dependencies: 'invalid',
        }),
      );
      const {code, stderr} = runIsolated(
        `resolveInstalledPackageDir(${JSON.stringify(fetchDir)}, 'cowsay');\n`,
      );
      expect(code).toBe(1);
      expect(stderr).toMatch(/did not update dependencies/i);
    } finally {
      rmSync(fetchDir, {recursive: true, force: true});
    }
  });

  test('dies when multiple dependencies are present', () => {
    const fetchDir = mkdtempSync(join(tmpdir(), 'npm-die-'));
    try {
      writeFileSync(
        join(fetchDir, 'package.json'),
        JSON.stringify({
          name: 'bun-install-fetch',
          private: true,
          dependencies: {pkg1: '^1.0.0', pkg2: '^2.0.0'},
        }),
      );
      const {code, stderr} = runIsolated(
        `resolveInstalledPackageDir(${JSON.stringify(fetchDir)}, 'pkg1 pkg2');\n`,
      );
      expect(code).toBe(1);
      expect(stderr).toMatch(/Expected exactly 1 dependency/i);
    } finally {
      rmSync(fetchDir, {recursive: true, force: true});
    }
  });

  test('dies when the package directory does not exist', () => {
    const fetchDir = mkdtempSync(join(tmpdir(), 'npm-die-'));
    try {
      writeFileSync(
        join(fetchDir, 'package.json'),
        JSON.stringify({
          name: 'bun-install-fetch',
          private: true,
          dependencies: {ghost: '^1.0.0'},
        }),
      );
      // No node_modules/ghost/ directory created — should die.
      const {code, stderr} = runIsolated(
        `resolveInstalledPackageDir(${JSON.stringify(fetchDir)}, 'ghost');\n`,
      );
      expect(code).toBe(1);
      expect(stderr).toMatch(/Failed to find package directory/i);
    } finally {
      rmSync(fetchDir, {recursive: true, force: true});
    }
  });
});
