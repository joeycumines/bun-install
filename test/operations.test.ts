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
import type {PackageData, BinEntry} from '../src/types.ts';
import {extractBinEntries} from '../src/utils.ts';
import {
  SIGNAL_EXIT_CODES,
  getSignalExitCode,
  confirmAction,
  filterBinField,
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
    binEntries: [],
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
        "m.set('lib', {name:'lib',dir:'/x',binEntries:[],localDeps:[],runtimeLocalDeps:[],hasBuildScript:false});\n" +
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

// --------------------------------------------------------------------------
// filterBinField (--package bin-field filtering for no-clobber guarantee)
// --------------------------------------------------------------------------

describe('filterBinField', () => {
  test('object form: filters to a single selected command', () => {
    const pkgJson: Record<string, unknown> = {
      bin: {cmd1: './a.js', cmd2: './b.js'},
    };
    const selected: BinEntry[] = [{name: 'cmd1', path: './a.js'}];

    const modified = filterBinField(pkgJson, selected);

    expect(modified).toBe(true);
    expect(pkgJson.bin).toEqual({cmd1: './a.js'});
  });

  test('object form: filters to a subset of multiple commands', () => {
    const pkgJson: Record<string, unknown> = {
      bin: {a: './a.js', b: './b.js', c: './c.js'},
    };
    const selected: BinEntry[] = [
      {name: 'a', path: './a.js'},
      {name: 'c', path: './c.js'},
    ];

    const modified = filterBinField(pkgJson, selected);

    expect(modified).toBe(true);
    expect(pkgJson.bin).toEqual({a: './a.js', c: './c.js'});
  });

  test('string form: converts to object form with the selected entry', () => {
    const pkgJson: Record<string, unknown> = {bin: './cli.js'};
    const selected: BinEntry[] = [{name: 'my-cli', path: './cli.js'}];

    const modified = filterBinField(pkgJson, selected);

    expect(modified).toBe(true);
    // String form is reconstructed as object form — semantically equivalent.
    expect(pkgJson.bin).toEqual({'my-cli': './cli.js'});
  });

  test('empty selection: deletes the bin field', () => {
    const pkgJson: Record<string, unknown> = {bin: {cmd1: './a.js'}};
    const selected: BinEntry[] = [];

    const modified = filterBinField(pkgJson, selected);

    expect(modified).toBe(true);
    expect(pkgJson.bin).toBeUndefined();
  });

  test('empty selection with no bin field: returns false (no change)', () => {
    const pkgJson: Record<string, unknown> = {name: 'pkg'};
    const selected: BinEntry[] = [];

    const modified = filterBinField(pkgJson, selected);

    expect(modified).toBe(false);
    expect(pkgJson.bin).toBeUndefined();
  });

  test('no bin field: adds bin from selected entries', () => {
    const pkgJson: Record<string, unknown> = {name: 'pkg'};
    const selected: BinEntry[] = [{name: 'cmd1', path: './a.js'}];

    const modified = filterBinField(pkgJson, selected);

    expect(modified).toBe(true);
    expect(pkgJson.bin).toEqual({cmd1: './a.js'});
  });

  test('single selected from single-entry object form', () => {
    const pkgJson: Record<string, unknown> = {bin: {only: './o.js'}};
    const selected: BinEntry[] = [{name: 'only', path: './o.js'}];

    const modified = filterBinField(pkgJson, selected);

    expect(modified).toBe(true);
    expect(pkgJson.bin).toEqual({only: './o.js'});
  });

  test('preserves other package.json fields', () => {
    const pkgJson: Record<string, unknown> = {
      name: 'pkg-a',
      version: '1.0.0',
      bin: {cmd1: './a.js', cmd2: './b.js'},
      dependencies: {lodash: '^4.0.0'},
    };
    const selected: BinEntry[] = [{name: 'cmd1', path: './a.js'}];

    filterBinField(pkgJson, selected);

    expect(pkgJson.name).toBe('pkg-a');
    expect(pkgJson.version).toBe('1.0.0');
    expect(pkgJson.dependencies).toEqual({lodash: '^4.0.0'});
    expect(pkgJson.bin).toEqual({cmd1: './a.js'});
  });
});

// --------------------------------------------------------------------------
// filterBinField + extractBinEntries round-trip (review-05 #2):
// Verifies that extractBinEntries produces raw paths that filterBinField
// faithfully preserves in the rewritten bin field — no normalization, no
// path resolution, no ./ stripping. Closes the coverage gap where
// filterBinField was only tested with hand-constructed BinEntry objects,
// never with the actual output of extractBinEntries.
// --------------------------------------------------------------------------

describe('filterBinField + extractBinEntries round-trip (review-05 #2)', () => {
  test('object form: extract then filter preserves exact paths including subdirs', () => {
    const pkgJson: Record<string, unknown> = {
      name: 'multi-cli',
      bin: {
        cmd1: './src/cmd1.js',
        cmd2: './src/cmd2.js',
        cmd3: './src/subdir/cmd3.js',
      },
    };
    // Extract entries from the raw bin field — this is what the resolver
    // (resolver.ts / workspace.ts) does at discovery time.
    const entries = extractBinEntries(pkgJson.name as string, pkgJson.bin);
    expect(entries).toHaveLength(3);
    // Paths must be the exact raw strings from package.json.
    expect(entries.map(e => e.path).sort()).toEqual([
      './src/cmd1.js',
      './src/cmd2.js',
      './src/subdir/cmd3.js',
    ]);

    // Select only cmd1 and cmd3 — simulate --package multi-cli cmd1 cmd3.
    const selected = entries.filter(e => ['cmd1', 'cmd3'].includes(e.name));
    expect(selected).toHaveLength(2);

    const modified = filterBinField(pkgJson, selected);
    expect(modified).toBe(true);
    // The rewritten bin must preserve the EXACT original paths — no
    // normalization, no ./ stripping, no path resolution.
    expect(pkgJson.bin).toEqual({
      cmd1: './src/cmd1.js',
      cmd3: './src/subdir/cmd3.js',
    });
  });

  test('string form: extract then filter preserves exact path', () => {
    const pkgJson: Record<string, unknown> = {
      name: 'single-cli',
      bin: './cli.js',
    };
    const entries = extractBinEntries(pkgJson.name as string, pkgJson.bin);
    expect(entries).toHaveLength(1);
    // String form: name derived from package name, path is the raw string.
    expect(entries[0].name).toBe('single-cli');
    expect(entries[0].path).toBe('./cli.js');

    // Select the single entry — simulate --package single-cli (all commands).
    const modified = filterBinField(pkgJson, entries);
    expect(modified).toBe(true);
    // Reconstructed as object form — semantically equivalent, path preserved.
    expect(pkgJson.bin).toEqual({'single-cli': './cli.js'});
  });

  test('scoped package: extract then filter preserves paths and uses object keys', () => {
    const pkgJson: Record<string, unknown> = {
      name: '@scope/cli',
      bin: {tool: './tool.js', helper: './helper.js'},
    };
    const entries = extractBinEntries(pkgJson.name as string, pkgJson.bin);
    expect(entries).toHaveLength(2);
    // Object form: names are the object keys, not the package name.
    expect(entries.map(e => e.name).sort()).toEqual(['helper', 'tool']);
    expect(entries.map(e => e.path).sort()).toEqual([
      './helper.js',
      './tool.js',
    ]);

    // Select only tool — simulate --package @scope/cli tool.
    const selected = entries.filter(e => e.name === 'tool');
    expect(selected).toHaveLength(1);

    const modified = filterBinField(pkgJson, selected);
    expect(modified).toBe(true);
    expect(pkgJson.bin).toEqual({tool: './tool.js'});
  });
});

// --------------------------------------------------------------------------
// isNpmFetched copy-filter behavior (review-071e6d2 #2):
// NPM-fetched packages must preserve nested node_modules (bundled deps).
// Local workspace packages must strip them (installed deps, not payload).
// buildAndPackPackages uses: pkg.isNpmFetched ? undefined : makeCopyFilter(pkg.dir)
// --------------------------------------------------------------------------

describe('isNpmFetched copy-filter behavior (review-071e6d2 #2)', () => {
  test('cpSync without filter preserves nested node_modules (NPM package path)', () => {
    // Simulates the isNpmFetched: true path in buildAndPackPackages.
    // No filter is passed to cpSync, so everything is copied — including
    // nested node_modules (bundled deps, vendored payloads).
    const src = mkdtempSync(join(tmpdir(), 'npm-cf-src-'));
    const dest = mkdtempSync(join(tmpdir(), 'npm-cf-dest-'));
    try {
      writeFileSync(
        join(src, 'package.json'),
        '{"name":"pkg","version":"1.0.0"}',
      );
      writeFileSync(join(src, 'cli.js'), 'console.log("hi")');
      mkdirSync(join(src, 'node_modules', 'bundled-dep'), {recursive: true});
      writeFileSync(
        join(src, 'node_modules', 'bundled-dep', 'package.json'),
        '{"name":"bundled-dep"}',
      );
      writeFileSync(
        join(src, 'node_modules', 'bundled-dep', 'index.js'),
        'module.exports = {}',
      );

      // Without filter (isNpmFetched: true)
      cpSync(src, dest, {recursive: true});

      // Regular files are present
      expect(readFileSync(join(dest, 'package.json'), 'utf-8')).toBe(
        '{"name":"pkg","version":"1.0.0"}',
      );
      expect(readFileSync(join(dest, 'cli.js'), 'utf-8')).toBe(
        'console.log("hi")',
      );
      // Nested node_modules IS preserved (the fix)
      expect(
        readFileSync(
          join(dest, 'node_modules', 'bundled-dep', 'package.json'),
          'utf-8',
        ),
      ).toBe('{"name":"bundled-dep"}');
      expect(
        readFileSync(
          join(dest, 'node_modules', 'bundled-dep', 'index.js'),
          'utf-8',
        ),
      ).toBe('module.exports = {}');
    } finally {
      rmSync(src, {recursive: true, force: true});
      rmSync(dest, {recursive: true, force: true});
    }
  });

  test('cpSync with makeCopyFilter strips nested node_modules (local package path)', () => {
    // Simulates the isNpmFetched: false/undefined path in buildAndPackPackages.
    // makeCopyFilter strips nested node_modules (installed deps, not payload).
    const src = mkdtempSync(join(tmpdir(), 'local-cf-src-'));
    const dest = mkdtempSync(join(tmpdir(), 'local-cf-dest-'));
    try {
      writeFileSync(
        join(src, 'package.json'),
        '{"name":"pkg","version":"1.0.0"}',
      );
      writeFileSync(join(src, 'cli.js'), 'console.log("hi")');
      mkdirSync(join(src, 'node_modules', 'installed-dep'), {recursive: true});
      writeFileSync(
        join(src, 'node_modules', 'installed-dep', 'package.json'),
        '{"name":"installed-dep"}',
      );

      // With filter (isNpmFetched: false/undefined — local package)
      cpSync(src, dest, {recursive: true, filter: makeCopyFilter(src)});

      // Regular files are present
      expect(readFileSync(join(dest, 'package.json'), 'utf-8')).toBe(
        '{"name":"pkg","version":"1.0.0"}',
      );
      expect(readFileSync(join(dest, 'cli.js'), 'utf-8')).toBe(
        'console.log("hi")',
      );
      // Nested node_modules is stripped (existing behavior for local packages)
      expect(() =>
        readFileSync(
          join(dest, 'node_modules', 'installed-dep', 'package.json'),
        ),
      ).toThrow();
    } finally {
      rmSync(src, {recursive: true, force: true});
      rmSync(dest, {recursive: true, force: true});
    }
  });

  test('PackageData.isNpmFetched is optional (backward compatible)', () => {
    // Existing PackageData objects (local packages) don't set isNpmFetched.
    // It's undefined, which is falsy — makeCopyFilter is applied.
    // This test verifies the field is optional and doesn't break existing code.
    const pkg: PackageData = {
      name: 'local-pkg',
      dir: '/dev/null',
      binEntries: [],
      localDeps: [],
      runtimeLocalDeps: [],
      hasBuildScript: false,
    };
    expect(pkg.isNpmFetched).toBeUndefined();
    expect(pkg.isNpmFetched ? true : false).toBe(false);
  });
});
