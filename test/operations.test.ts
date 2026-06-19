import {describe, expect, test} from 'bun:test';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  cpSync,
  readFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

import {EXIT_SIGNALS} from '../src/types.ts';
import type {PackageData} from '../src/types.ts';
import {
  SIGNAL_EXIT_CODES,
  getSignalExitCode,
  confirmAction,
  makeCopyFilter,
  pinWorkspaceDeps,
  stripDevDependencies,
  shouldAbortPrompt,
  shouldReadMore,
  PROMPT_ABORT_EXIT_CODE,
} from '../src/operations.ts';

// --------------------------------------------------------------------------
// getSignalExitCode
// --------------------------------------------------------------------------

describe('getSignalExitCode', () => {
  test('returns 130 for SIGINT (128 + 2)', () => {
    expect(getSignalExitCode('SIGINT')).toBe(130);
  });

  test('returns 143 for SIGTERM (128 + 15)', () => {
    expect(getSignalExitCode('SIGTERM')).toBe(143);
  });

  test('returns 129 for SIGHUP (128 + 1)', () => {
    expect(getSignalExitCode('SIGHUP')).toBe(129);
  });

  test('falls back to 1 for unknown signals', () => {
    expect(getSignalExitCode('SIGUSR1')).toBe(1);
    expect(getSignalExitCode('SIGKILL')).toBe(1);
    expect(getSignalExitCode('')).toBe(1);
  });

  test('SIGNAL_EXIT_CODES covers every signal in EXIT_SIGNALS', () => {
    for (const sig of EXIT_SIGNALS) {
      expect(SIGNAL_EXIT_CODES).toHaveProperty(sig);
      expect(typeof SIGNAL_EXIT_CODES[sig]).toBe('number');
      // All exit codes should be > 128 (the 128+signum convention)
      expect(SIGNAL_EXIT_CODES[sig]).toBeGreaterThan(128);
    }
  });
});

// --------------------------------------------------------------------------
// confirmAction (non-TTY path)
// --------------------------------------------------------------------------

describe('confirmAction', () => {
  test('returns false when stdin is not a TTY', () => {
    // In the test environment, stdin is typically not a TTY.
    // If it happens to be one, this test passes vacuously.
    if (process.stdin.isTTY) return;

    const result = confirmAction('Delete this file?');
    expect(result).toBe(false);
  });
});

// --------------------------------------------------------------------------
// shouldAbortPrompt / PROMPT_ABORT_EXIT_CODE
// --------------------------------------------------------------------------

describe('shouldAbortPrompt', () => {
  test('aborts when bytesRead is 0 (signal/EOF)', () => {
    expect(shouldAbortPrompt(0)).toBe(true);
  });

  test('aborts when bytesRead is negative (defensive)', () => {
    expect(shouldAbortPrompt(-1)).toBe(true);
  });

  test('does not abort when bytes were read', () => {
    expect(shouldAbortPrompt(1)).toBe(false);
    expect(shouldAbortPrompt(256)).toBe(false);
  });
});

describe('PROMPT_ABORT_EXIT_CODE', () => {
  test('is the conventional SIGINT code 130', () => {
    expect(PROMPT_ABORT_EXIT_CODE).toBe(130);
    expect(PROMPT_ABORT_EXIT_CODE).toBe(getSignalExitCode('SIGINT'));
  });
});

// --------------------------------------------------------------------------
// shouldReadMore (read-until-newline loop termination policy)
// --------------------------------------------------------------------------

describe('shouldReadMore', () => {
  test('returns true when buffer is full and no newline found', () => {
    expect(shouldReadMore(256, false, 256)).toBe(true);
  });

  test('returns false when a newline is found (even if buffer is full)', () => {
    expect(shouldReadMore(256, true, 256)).toBe(false);
  });

  test('returns false on a short read without newline (end of input)', () => {
    expect(shouldReadMore(100, false, 256)).toBe(false);
  });

  test('returns false for a normal short line with newline', () => {
    expect(shouldReadMore(2, true, 256)).toBe(false);
  });

  test('returns false when zero bytes were read (abort path handles this)', () => {
    expect(shouldReadMore(0, false, 256)).toBe(false);
  });
});

// --------------------------------------------------------------------------
// makeCopyFilter (cpSync node_modules exclusion, relative-path based)
// --------------------------------------------------------------------------

describe('makeCopyFilter', () => {
  test('excludes a nested node_modules directory inside the package', () => {
    const base = mkdtempSync(join(tmpdir(), 'mcf-'));
    try {
      mkdirSync(join(base, 'node_modules', 'some-dep'), {recursive: true});
      writeFileSync(join(base, 'package.json'), '{}');
      const filter = makeCopyFilter(base);

      // base dir itself is included
      expect(filter(base)).toBe(true);
      // a regular file is included
      expect(filter(join(base, 'package.json'))).toBe(true);
      // a nested node_modules dir is excluded
      expect(filter(join(base, 'node_modules'))).toBe(false);
      // children under node_modules are also excluded
      expect(filter(join(base, 'node_modules', 'some-dep'))).toBe(false);
    } finally {
      rmSync(base, {recursive: true, force: true});
    }
  });

  test('does NOT blackhole when the base path contains a node_modules segment', () => {
    // Reproduces the original bug: a package whose absolute path contains a
    // "node_modules" segment (e.g. ~/Projects/node_modules/myproj) must still
    // copy its files. The relative-path filter ignores the ancestor segment.
    const host = mkdtempSync(join(tmpdir(), 'mcf-host-'));
    const base = join(host, 'node_modules', 'myproj');
    try {
      mkdirSync(base, {recursive: true});
      writeFileSync(join(base, 'package.json'), '{"name":"myproj"}');
      writeFileSync(join(base, 'index.ts'), 'console.log("hi")');
      const filter = makeCopyFilter(base);

      expect(filter(base)).toBe(true);
      expect(filter(join(base, 'package.json'))).toBe(true);
      expect(filter(join(base, 'index.ts'))).toBe(true);
      // and a real nested node_modules is still excluded
      mkdirSync(join(base, 'node_modules'), {recursive: true});
      expect(filter(join(base, 'node_modules'))).toBe(false);
    } finally {
      rmSync(host, {recursive: true, force: true});
    }
  });

  test('end-to-end cpSync copies files when base path contains node_modules', () => {
    const host = mkdtempSync(join(tmpdir(), 'mcf-e2e-'));
    const base = join(host, 'node_modules', 'myproj');
    const dest = mkdtempSync(join(tmpdir(), 'mcf-dest-'));
    try {
      mkdirSync(base, {recursive: true});
      writeFileSync(join(base, 'package.json'), '{"name":"myproj"}');
      writeFileSync(join(base, 'index.ts'), 'console.log("hi")');
      mkdirSync(join(base, 'node_modules', 'dep'), {recursive: true});

      cpSync(base, dest, {recursive: true, filter: makeCopyFilter(base)});

      // package.json is present (previously the blackhole left dest empty)
      expect(readFileSync(join(dest, 'package.json'), 'utf-8')).toBe(
        '{"name":"myproj"}',
      );
      // nested node_modules was excluded
      expect(() => readFileSync(join(dest, 'node_modules', 'dep'))).toThrow();
    } finally {
      rmSync(host, {recursive: true, force: true});
      rmSync(dest, {recursive: true, force: true});
    }
  });
});

// --------------------------------------------------------------------------
// pinWorkspaceDeps
// --------------------------------------------------------------------------

/** Builds a minimal PackageData with an archive path (a "packed" sibling). */
function packedSibling(name: string, archivePath: string): PackageData {
  return {
    name,
    dir: '/dev/null',
    bins: [],
    localDeps: [],
    runtimeLocalDeps: [],
    hasBuildScript: false,
    archivePath,
  };
}

describe('pinWorkspaceDeps — behavioral paths', () => {
  test('pins a plain-semver local sibling to file: (the core fix)', () => {
    const map = new Map<string, PackageData>([
      ['lib', packedSibling('lib', '/store/lib-1.5.0.tgz')],
    ]);
    const pkgJson = {dependencies: {lib: '^1.5.0'}};

    const pinned = pinWorkspaceDeps(pkgJson, map, 'cli');

    expect(pinned).toBe(true);
    expect(pkgJson.dependencies).toEqual({lib: 'file:/store/lib-1.5.0.tgz'});
  });

  test('pins a workspace: local sibling to file:', () => {
    const map = new Map<string, PackageData>([
      ['lib', packedSibling('lib', '/store/lib-1.5.0.tgz')],
    ]);
    const pkgJson = {dependencies: {lib: 'workspace:*'}};

    const pinned = pinWorkspaceDeps(pkgJson, map, 'cli');

    expect(pinned).toBe(true);
    expect(pkgJson.dependencies).toEqual({lib: 'file:/store/lib-1.5.0.tgz'});
  });

  test('pins peerDependencies too', () => {
    const map = new Map<string, PackageData>([
      ['peer-lib', packedSibling('peer-lib', '/store/peer.tgz')],
    ]);
    const pkgJson = {peerDependencies: {'peer-lib': '^2.0.0'}};

    const pinned = pinWorkspaceDeps(pkgJson, map, 'cli');

    expect(pinned).toBe(true);
    expect(pkgJson.peerDependencies).toEqual({
      'peer-lib': 'file:/store/peer.tgz',
    });
  });

  test('leaves registry dependencies untouched', () => {
    const map = new Map<string, PackageData>();
    const pkgJson = {
      dependencies: {lodash: '^4.0.0', chalk: '^5.0.0'},
    };

    const pinned = pinWorkspaceDeps(pkgJson, map, 'cli');

    expect(pinned).toBe(false);
    expect(pkgJson.dependencies).toEqual({lodash: '^4.0.0', chalk: '^5.0.0'});
  });

  test('mixes local pins and registry deps correctly', () => {
    const map = new Map<string, PackageData>([
      ['lib', packedSibling('lib', '/store/lib.tgz')],
    ]);
    const pkgJson = {
      dependencies: {lib: '^1.5.0', lodash: '^4.0.0'},
    };

    const pinned = pinWorkspaceDeps(pkgJson, map, 'cli');

    expect(pinned).toBe(true);
    expect(pkgJson.dependencies).toEqual({
      lib: 'file:/store/lib.tgz',
      lodash: '^4.0.0',
    });
  });

  test('returns false when dependency fields are absent', () => {
    const map = new Map<string, PackageData>();
    const pkgJson = {};

    expect(pinWorkspaceDeps(pkgJson, map, 'cli')).toBe(false);
  });

  test('ignores malformed (non-object) dependency fields without polluting', () => {
    const map = new Map<string, PackageData>();
    // "dependencies": "invalid" must NOT yield char-index entries
    const pkgJson = {dependencies: 'invalid'} as unknown as Record<
      string,
      unknown
    >;

    const pinned = pinWorkspaceDeps(pkgJson, map, 'cli');

    expect(pinned).toBe(false);
    expect(pkgJson.dependencies).toBe('invalid');
  });

  test('pins optionalDependencies local sibling to file:', () => {
    // optionalDependencies ARE installed by `bun add -g` (they are "optional"
    // only in that install failure does not abort), so a local sibling
    // referenced there must be pinned to prevent a registry leak.
    const map = new Map<string, PackageData>([
      ['opt-lib', packedSibling('opt-lib', '/store/opt-lib.tgz')],
    ]);
    const pkgJson = {optionalDependencies: {'opt-lib': '^1.2.0'}};

    const pinned = pinWorkspaceDeps(pkgJson, map, 'cli');

    expect(pinned).toBe(true);
    expect(pkgJson.optionalDependencies).toEqual({
      'opt-lib': 'file:/store/opt-lib.tgz',
    });
  });

  test('pins optionalDependencies with workspace: protocol too', () => {
    const map = new Map<string, PackageData>([
      ['opt-lib', packedSibling('opt-lib', '/store/opt-lib.tgz')],
    ]);
    const pkgJson = {optionalDependencies: {'opt-lib': 'workspace:*'}};

    const pinned = pinWorkspaceDeps(pkgJson, map, 'cli');

    expect(pinned).toBe(true);
    expect(pkgJson.optionalDependencies).toEqual({
      'opt-lib': 'file:/store/opt-lib.tgz',
    });
  });

  test('leaves registry optionalDependencies untouched', () => {
    // A non-local optionalDep (e.g. fsevents) is not in packagesMap, so it
    // is left untouched (the else branch).
    const map = new Map<string, PackageData>();
    const pkgJson = {
      optionalDependencies: {fsevents: '^2.3.0'},
    };

    const pinned = pinWorkspaceDeps(pkgJson, map, 'cli');

    expect(pinned).toBe(false);
    expect(pkgJson.optionalDependencies).toEqual({fsevents: '^2.3.0'});
  });
});

// --------------------------------------------------------------------------
// pinWorkspaceDeps — die paths (verified via an isolated subprocess because
// `die` calls process.exit(1), which cannot be asserted inside the test runner)
// --------------------------------------------------------------------------

const OPS_MODULE = join(import.meta.dir, '..', 'src', 'operations.ts');

/**
 * Runs a small TypeScript snippet in a child Bun process that imports from the
 * real operations module. Used to assert `die` paths exit non-zero with the
 * expected message. Deterministic (no races) and cleans up its temp file.
 */
function runIsolated(body: string): {code: number; stderr: string} {
  const file = join(tmpdir(), `bun-install-die-${randomUUID()}.ts`);
  writeFileSync(
    file,
    `import {pinWorkspaceDeps} from ${JSON.stringify(OPS_MODULE)};\n${body}`,
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

describe('pinWorkspaceDeps — die paths', () => {
  test('dies loudly when a local sibling has no archive path', () => {
    const {code, stderr} = runIsolated(
      'const m = new Map();\n' +
        "m.set('lib', {name:'lib',dir:'/x',bins:[],localDeps:[],runtimeLocalDeps:[],hasBuildScript:false});\n" +
        "pinWorkspaceDeps({dependencies:{lib:'^1.5.0'}}, m, 'cli');\n",
    );
    expect(code).toBe(1);
    expect(stderr).toMatch(/depends on local sibling 'lib' but no archive/i);
  });

  test('dies when a workspace: dependency is not a local package', () => {
    const {code, stderr} = runIsolated(
      'const m = new Map();\n' +
        "pinWorkspaceDeps({dependencies:{missing:'workspace:*'}}, m, 'cli');\n",
    );
    expect(code).toBe(1);
    expect(stderr).toMatch(
      /workspace: dependency 'missing'.*not a local package/i,
    );
  });
});

// --------------------------------------------------------------------------
// stripDevDependencies (R9-1: prevent workspace:* timebomb in packed tgz)
// --------------------------------------------------------------------------

describe('stripDevDependencies', () => {
  test('deletes devDependencies when present and returns true', () => {
    const pkgJson = {
      dependencies: {lodash: '^4.0.0'},
      devDependencies: {'my-builder': 'workspace:*'},
    };

    const stripped = stripDevDependencies(pkgJson);

    expect(stripped).toBe(true);
    expect(pkgJson.devDependencies).toBeUndefined();
    // Other fields are untouched.
    expect(pkgJson.dependencies).toEqual({lodash: '^4.0.0'});
  });

  test('returns false when devDependencies is absent', () => {
    const pkgJson = {
      dependencies: {lodash: '^4.0.0'},
    };

    const stripped = stripDevDependencies(pkgJson);

    expect(stripped).toBe(false);
    expect(pkgJson.dependencies).toEqual({lodash: '^4.0.0'});
  });

  test('deletes devDependencies even when it is the only field', () => {
    const pkgJson = {
      devDependencies: {'my-builder': 'workspace:*'},
    };

    const stripped = stripDevDependencies(pkgJson);

    expect(stripped).toBe(true);
    expect(pkgJson.devDependencies).toBeUndefined();
  });

  test('does NOT delete dependencies, peerDependencies, or optionalDependencies', () => {
    const pkgJson = {
      dependencies: {lodash: '^4.0.0'},
      peerDependencies: {react: '^18.0.0'},
      optionalDependencies: {fsevents: '^2.3.0'},
      devDependencies: {typescript: '^5.0.0'},
    };

    const stripped = stripDevDependencies(pkgJson);

    expect(stripped).toBe(true);
    expect(pkgJson.devDependencies).toBeUndefined();
    expect(pkgJson.dependencies).toEqual({lodash: '^4.0.0'});
    expect(pkgJson.peerDependencies).toEqual({react: '^18.0.0'});
    expect(pkgJson.optionalDependencies).toEqual({fsevents: '^2.3.0'});
  });
});

// --------------------------------------------------------------------------
// makeCopyFilter — empty-string guard (R9-2: path.relative returns '' not '.')
// --------------------------------------------------------------------------

describe('makeCopyFilter — empty-string guard (R9-2)', () => {
  test('explicitly handles rel === "" (src === baseDir)', () => {
    // path.relative(baseDir, baseDir) returns '' (empty string), NOT '.'.
    // The guard must explicitly check for '' to avoid relying on the
    // accidental behavior of ''.split(/[/\\]/) returning [''].
    const base = mkdtempSync(join(tmpdir(), 'mcf-empty-'));
    try {
      writeFileSync(join(base, 'package.json'), '{}');
      const filter = makeCopyFilter(base);

      // The base dir itself: rel === '' → guard returns true.
      expect(filter(base)).toBe(true);
    } finally {
      rmSync(base, {recursive: true, force: true});
    }
  });
});
