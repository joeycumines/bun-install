import {describe, expect, test} from 'bun:test';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  chmodSync,
  symlinkSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {rewriteShebangInFile, rewriteShebangs} from '../src/shebang.ts';
import type {BinEntry} from '../src/types.ts';

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

/** Creates a temp directory for test fixtures. */
function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'shebang-test-'));
}

// --------------------------------------------------------------------------
// rewriteShebangInFile — node shebang variants
// --------------------------------------------------------------------------

describe('rewriteShebangInFile — node shebang rewriting', () => {
  test('rewrites #!/usr/bin/env node → #!/usr/bin/env bun', () => {
    const dir = makeTmpDir();
    try {
      const f = join(dir, 'cli.js');
      writeFileSync(f, '#!/usr/bin/env node\nconsole.log("hi");\n');
      const result = rewriteShebangInFile(f);
      expect(result.status).toBe('rewritten');
      expect(result.originalShebang).toBe('#!/usr/bin/env node');
      expect(result.newShebang).toBe('#!/usr/bin/env bun');
      expect(readFileSync(f, 'utf-8')).toBe(
        '#!/usr/bin/env bun\nconsole.log("hi");\n',
      );
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });

  test('rewrites #!/usr/bin/node (absolute path)', () => {
    const dir = makeTmpDir();
    try {
      const f = join(dir, 'cli.js');
      writeFileSync(f, '#!/usr/bin/node\nconsole.log(1);\n');
      const result = rewriteShebangInFile(f);
      expect(result.status).toBe('rewritten');
      expect(readFileSync(f, 'utf-8').startsWith('#!/usr/bin/env bun')).toBe(
        true,
      );
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });

  test('rewrites #!/usr/local/bin/node (Homebrew Intel)', () => {
    const dir = makeTmpDir();
    try {
      const f = join(dir, 'cli.js');
      writeFileSync(f, '#!/usr/local/bin/node\nconsole.log(1);\n');
      expect(rewriteShebangInFile(f).status).toBe('rewritten');
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });

  test('rewrites #!/opt/homebrew/bin/node (Homebrew Apple Silicon)', () => {
    const dir = makeTmpDir();
    try {
      const f = join(dir, 'cli.js');
      writeFileSync(f, '#!/opt/homebrew/bin/node\nconsole.log(1);\n');
      expect(rewriteShebangInFile(f).status).toBe('rewritten');
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });

  test('rewrites #!/usr/bin/env nodejs (Debian variant)', () => {
    const dir = makeTmpDir();
    try {
      const f = join(dir, 'cli.js');
      writeFileSync(f, '#!/usr/bin/env nodejs\nconsole.log(1);\n');
      expect(rewriteShebangInFile(f).status).toBe('rewritten');
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });

  test('rewrites #!/usr/bin/nodejs (Debian absolute)', () => {
    const dir = makeTmpDir();
    try {
      const f = join(dir, 'cli.js');
      writeFileSync(f, '#!/usr/bin/nodejs\nconsole.log(1);\n');
      expect(rewriteShebangInFile(f).status).toBe('rewritten');
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });

  test('rewrites #!/usr/bin/env -S node (env -S syntax)', () => {
    const dir = makeTmpDir();
    try {
      const f = join(dir, 'cli.js');
      writeFileSync(f, '#!/usr/bin/env -S node\nconsole.log(1);\n');
      expect(rewriteShebangInFile(f).status).toBe('rewritten');
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });

  test('rewrites #!/usr/bin/env -S node --require ./foo (env -S, node first, flags after)', () => {
    // GNU env -S parses its own options from the split string, then runs the
    // first remaining token as the command. `node --require ./foo` means node
    // is the command and --require ./foo are node's args — a VALID shebang.
    // (The prior form `#!/usr/bin/env -S --require ./foo node` was OS-invalid:
    // GNU env rejects --require with exit 125 — verified via `env -vS` against
    // GNU coreutils 9.11. See scratch/review-01.md.)
    const dir = makeTmpDir();
    try {
      const f = join(dir, 'cli.js');
      writeFileSync(
        f,
        '#!/usr/bin/env -S node --require ./foo\nconsole.log(1);\n',
      );
      expect(rewriteShebangInFile(f).status).toBe('rewritten');
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });

  test('rewrites #!/usr/bin/env --split-string=node (GNU env split-string form)', () => {
    const dir = makeTmpDir();
    try {
      const f = join(dir, 'cli.js');
      writeFileSync(f, '#!/usr/bin/env --split-string=node\nconsole.log(1);\n');
      expect(rewriteShebangInFile(f).status).toBe('rewritten');
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });

  test('rewrites #!/usr/bin/env node.exe (Windows .exe form)', () => {
    const dir = makeTmpDir();
    try {
      const f = join(dir, 'cli.js');
      writeFileSync(f, '#!/usr/bin/env node.exe\nconsole.log(1);\n');
      expect(rewriteShebangInFile(f).status).toBe('rewritten');
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });

  test('rewrites #!/usr/bin/node.exe (Windows direct .exe form)', () => {
    const dir = makeTmpDir();
    try {
      const f = join(dir, 'cli.js');
      writeFileSync(f, '#!/usr/bin/node.exe\nconsole.log(1);\n');
      expect(rewriteShebangInFile(f).status).toBe('rewritten');
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });

  test('rewrites #! /usr/bin/env node (space after #!)', () => {
    const dir = makeTmpDir();
    try {
      const f = join(dir, 'cli.js');
      writeFileSync(f, '#! /usr/bin/env node\nconsole.log(1);\n');
      expect(rewriteShebangInFile(f).status).toBe('rewritten');
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });

  test('drops node flags silently (no comment in shebang)', () => {
    const dir = makeTmpDir();
    try {
      const f = join(dir, 'cli.js');
      writeFileSync(
        f,
        '#!/usr/bin/env node --require ./foo\nconsole.log(1);\n',
      );
      const result = rewriteShebangInFile(f);
      expect(result.status).toBe('rewritten');
      // The new shebang must be exactly #!/usr/bin/env bun — no trailing
      // comment. A comment like `#!/usr/bin/env bun  # dropped: --require ./foo`
      // would break on Linux (the kernel passes the entire rest-of-line as a
      // single argument to env, causing exit 127).
      expect(result.newShebang).toBe('#!/usr/bin/env bun');
      const content = readFileSync(f, 'utf-8');
      expect(content.startsWith('#!/usr/bin/env bun\n')).toBe(true);
      // Body is preserved.
      expect(content).toContain('console.log(1);');
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });

  test('shebang line has no trailing comment after rewrite (Linux compat)', () => {
    // On Linux, the kernel passes everything after the interpreter path as a
    // SINGLE argument. A `# comment` would be part of that argument and
    // cause env to fail. The shebang must be exactly `#!/usr/bin/env bun`.
    const dir = makeTmpDir();
    try {
      const f = join(dir, 'cli.js');
      writeFileSync(
        f,
        '#!/usr/bin/env node --loader tsx --experimental-specifier-resolution=node\nconsole.log(1);\n',
      );
      const result = rewriteShebangInFile(f);
      expect(result.status).toBe('rewritten');
      expect(result.newShebang).toBe('#!/usr/bin/env bun');
      const content = readFileSync(f, 'utf-8');
      const firstLine = content.split('\n')[0];
      expect(firstLine).toBe('#!/usr/bin/env bun');
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });
});

// --------------------------------------------------------------------------
// rewriteShebangInFile — env -S split-string command resolution
// --------------------------------------------------------------------------
//
// Regression suite for scratch/review-01.md: classifyShebang must locate the
// ACTUAL command token in a GNU `env -S` split string (skipping env's own
// options), not match `node`/`bun` appearing anywhere in the string. Verified
// against GNU coreutils `env` 9.11 via `env -vS`.

describe('rewriteShebangInFile — env -S command resolution (review-01 regression)', () => {
  test('wrapper before node → skipped-non-node, file UNCHANGED (the bug)', () => {
    // `#!/usr/bin/env -S wrapper node` runs `wrapper` with `node` as an arg.
    // The old code matched `node` anywhere in the string and destructively
    // rewrote the line to `#!/usr/bin/env bun`, dropping the wrapper.
    const dir = makeTmpDir();
    try {
      const f = join(dir, 'cli.js');
      const original = '#!/usr/bin/env -S wrapper node\nconsole.log(1);\n';
      writeFileSync(f, original);
      const result = rewriteShebangInFile(f);
      expect(result.status).toBe('skipped-non-node');
      expect(result.originalShebang).toBe('#!/usr/bin/env -S wrapper node');
      // The file must be byte-for-byte unchanged — no destructive rewrite.
      expect(readFileSync(f, 'utf-8')).toBe(original);
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });

  test('env -S -i node (clear environment) → rewritten', () => {
    // `-i` is env's own option (ignore-environment); node is still the command.
    const dir = makeTmpDir();
    try {
      const f = join(dir, 'cli.js');
      writeFileSync(f, '#!/usr/bin/env -S -i node\nconsole.log(1);\n');
      expect(rewriteShebangInFile(f).status).toBe('rewritten');
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });

  test('env -S -u FOO node (unset variable) → rewritten', () => {
    // `-u FOO` is env's option (unset FOO); node is the command afterward.
    const dir = makeTmpDir();
    try {
      const f = join(dir, 'cli.js');
      writeFileSync(f, '#!/usr/bin/env -S -u FOO node\nconsole.log(1);\n');
      expect(rewriteShebangInFile(f).status).toBe('rewritten');
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });

  test('env -S -C /var node (chdir) → rewritten', () => {
    // `-C /var` is env's option (chdir); node is the command afterward.
    // Note: /var here is just text in the shebang — env is not actually run.
    const dir = makeTmpDir();
    try {
      const f = join(dir, 'cli.js');
      writeFileSync(f, '#!/usr/bin/env -S -C /var node\nconsole.log(1);\n');
      expect(rewriteShebangInFile(f).status).toBe('rewritten');
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });

  test('env -S -iv node (combined boolean short options) → rewritten', () => {
    // `-iv` = `-i -v` (ignore-environment + debug); node is the command.
    const dir = makeTmpDir();
    try {
      const f = join(dir, 'cli.js');
      writeFileSync(f, '#!/usr/bin/env -S -iv node\nconsole.log(1);\n');
      expect(rewriteShebangInFile(f).status).toBe('rewritten');
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });

  test('env -S -uFOO node (attached short option value) → rewritten', () => {
    // `-uFOO` = `-u` with attached value FOO; node is the command.
    const dir = makeTmpDir();
    try {
      const f = join(dir, 'cli.js');
      writeFileSync(f, '#!/usr/bin/env -S -uFOO node\nconsole.log(1);\n');
      expect(rewriteShebangInFile(f).status).toBe('rewritten');
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });

  test('env -S -- node (-- end of options) → rewritten', () => {
    // `--` ends env's option parsing; the next token (node) is the command.
    const dir = makeTmpDir();
    try {
      const f = join(dir, 'cli.js');
      writeFileSync(f, '#!/usr/bin/env -S -- node\nconsole.log(1);\n');
      expect(rewriteShebangInFile(f).status).toBe('rewritten');
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });

  test('env -S --bogus node (unknown long option) → skipped-non-node', () => {
    // Unknown env options make `env` error (exit 125). The shebang is broken;
    // we conservatively skip rather than destructively rewrite.
    const dir = makeTmpDir();
    try {
      const f = join(dir, 'cli.js');
      const original = '#!/usr/bin/env -S --bogus node\nconsole.log(1);\n';
      writeFileSync(f, original);
      expect(rewriteShebangInFile(f).status).toBe('skipped-non-node');
      expect(readFileSync(f, 'utf-8')).toBe(original);
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });

  test('env -S -0/--null node (null output, incompatible with command) → skipped-non-node', () => {
    // GNU env rejects `-0`/`--null` when a command is present (verified:
    // `env -vS '-0 node version'` and `env -vS '--null node version'` both →
    // "cannot specify --null (-0) with command", exit 125). The shebang is
    // broken, so we skip it — consistent for BOTH the short and long forms
    // (they are the same option), rather than destructively rewriting.
    const dir = makeTmpDir();
    try {
      for (const shebangForm of [
        '#!/usr/bin/env -S -0 node\nconsole.log(1);\n',
        '#!/usr/bin/env -S --null node\nconsole.log(1);\n',
      ]) {
        const f = join(
          dir,
          `cli-${shebangForm.includes('--null') ? 'long' : 'short'}.js`,
        );
        writeFileSync(f, shebangForm);
        const result = rewriteShebangInFile(f);
        expect(result.status).toBe('skipped-non-node');
        expect(readFileSync(f, 'utf-8')).toBe(shebangForm);
        rmSync(f, {force: true});
      }
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });

  test('env -S --require ./foo node (OS-invalid form) → skipped-non-node, file UNCHANGED', () => {
    // GNU env rejects --require (it is a node flag, not env's). This shebang
    // is broken (exit 125). The old test expected 'rewritten'; that was
    // validating an invalid shebang AND drove the destructive loop. We now
    // skip it safely (no destructive rewrite). See scratch/review-01.md.
    const dir = makeTmpDir();
    try {
      const f = join(dir, 'cli.js');
      const original =
        '#!/usr/bin/env -S --require ./foo node\nconsole.log(1);\n';
      writeFileSync(f, original);
      expect(rewriteShebangInFile(f).status).toBe('skipped-non-node');
      expect(readFileSync(f, 'utf-8')).toBe(original);
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });
});

// --------------------------------------------------------------------------
// rewriteShebangInFile — already-bun (idempotency)
// --------------------------------------------------------------------------

describe('rewriteShebangInFile — already-bun (idempotency)', () => {
  test('already-bun shebang → no change', () => {
    const dir = makeTmpDir();
    try {
      const f = join(dir, 'cli.js');
      writeFileSync(f, '#!/usr/bin/env bun\nconsole.log("bun");\n');
      const result = rewriteShebangInFile(f);
      expect(result.status).toBe('already-bun');
      // File is unchanged.
      expect(readFileSync(f, 'utf-8')).toBe(
        '#!/usr/bin/env bun\nconsole.log("bun");\n',
      );
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });

  test('already-bun with flags → no change', () => {
    const dir = makeTmpDir();
    try {
      const f = join(dir, 'cli.js');
      writeFileSync(f, '#!/usr/bin/env bun --smol\nconsole.log("bun");\n');
      const result = rewriteShebangInFile(f);
      expect(result.status).toBe('already-bun');
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });

  test('already-bun via direct path → no change', () => {
    const dir = makeTmpDir();
    try {
      const f = join(dir, 'cli.js');
      writeFileSync(f, '#!/usr/local/bin/bun\nconsole.log("bun");\n');
      const result = rewriteShebangInFile(f);
      expect(result.status).toBe('already-bun');
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });

  test('already-bun via Windows .exe env form → no change', () => {
    const dir = makeTmpDir();
    try {
      const f = join(dir, 'cli.js');
      writeFileSync(f, '#!/usr/bin/env bun.exe\nconsole.log("bun");\n');
      const result = rewriteShebangInFile(f);
      expect(result.status).toBe('already-bun');
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });

  test('already-bun via Windows direct .exe path → no change', () => {
    const dir = makeTmpDir();
    try {
      const f = join(dir, 'cli.js');
      writeFileSync(f, '#!/usr/local/bin/bun.exe\nconsole.log("bun");\n');
      const result = rewriteShebangInFile(f);
      expect(result.status).toBe('already-bun');
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });
});

// --------------------------------------------------------------------------
// rewriteShebangInFile — skips (non-node, binary, empty, missing, not-utf8)
// --------------------------------------------------------------------------

describe('rewriteShebangInFile — skip cases', () => {
  test('non-node shebang (python) → skipped-non-node', () => {
    const dir = makeTmpDir();
    try {
      const f = join(dir, 'script.py');
      writeFileSync(f, '#!/usr/bin/python3\nprint("hello")\n');
      const result = rewriteShebangInFile(f);
      expect(result.status).toBe('skipped-non-node');
      expect(result.originalShebang).toBe('#!/usr/bin/python3');
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });

  test('shell shebang → skipped-non-node', () => {
    const dir = makeTmpDir();
    try {
      const f = join(dir, 'script.sh');
      writeFileSync(f, '#!/bin/sh\necho hello\n');
      const result = rewriteShebangInFile(f);
      expect(result.status).toBe('skipped-non-node');
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });

  test('interpreter containing node but not named node → skipped-non-node', () => {
    const dir = makeTmpDir();
    try {
      const f = join(dir, 'script.js');
      writeFileSync(f, '#!/usr/bin/notnode\nconsole.log(1);\n');
      const result = rewriteShebangInFile(f);
      expect(result.status).toBe('skipped-non-node');
      expect(result.originalShebang).toBe('#!/usr/bin/notnode');
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });

  test('interpreter with node-like suffix/prefix → skipped-non-node', () => {
    const dir = makeTmpDir();
    try {
      const f = join(dir, 'script.js');
      writeFileSync(f, '#!/usr/bin/foo-node\n#!/usr/bin/node-wrapper\n');
      const result = rewriteShebangInFile(f);
      expect(result.status).toBe('skipped-non-node');
      expect(result.originalShebang).toBe('#!/usr/bin/foo-node');
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });

  test('not valid UTF-8 → skipped-not-utf8', () => {
    const dir = makeTmpDir();
    try {
      const f = join(dir, 'latin1.js');
      writeFileSync(f, Buffer.from([0xff, 0xfe, 0x0a]));
      const result = rewriteShebangInFile(f);
      expect(result.status).toBe('skipped-not-utf8');
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });

  test('binary file (null byte) → skipped-binary', () => {
    const dir = makeTmpDir();
    try {
      const f = join(dir, 'native.node');
      // Write a binary buffer with a null byte in the first 8K.
      const buf = Buffer.alloc(100, 0x41); // 'A' bytes
      buf[10] = 0x00; // null byte at position 10
      writeFileSync(f, buf);
      const result = rewriteShebangInFile(f);
      expect(result.status).toBe('skipped-binary');
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });

  test('empty file (0 bytes) → skipped-empty', () => {
    const dir = makeTmpDir();
    try {
      const f = join(dir, 'empty.js');
      writeFileSync(f, '');
      const result = rewriteShebangInFile(f);
      expect(result.status).toBe('skipped-empty');
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });

  test('missing file → skipped-missing', () => {
    const dir = makeTmpDir();
    try {
      const result = rewriteShebangInFile(join(dir, 'nonexistent.js'));
      expect(result.status).toBe('skipped-missing');
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });

  test('directory at bin path → error', () => {
    const dir = makeTmpDir();
    try {
      mkdirSync(join(dir, 'somedir'), {recursive: true});
      const result = rewriteShebangInFile(join(dir, 'somedir'));
      expect(result.status).toBe('error');
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });
});

// --------------------------------------------------------------------------
// rewriteShebangInFile — shebang injection (no shebang, text file)
// --------------------------------------------------------------------------

describe('rewriteShebangInFile — injection (no shebang)', () => {
  test('injects bun shebang for JS file without shebang', () => {
    const dir = makeTmpDir();
    try {
      const f = join(dir, 'cli.js');
      writeFileSync(f, 'console.log("no shebang");\n');
      const result = rewriteShebangInFile(f);
      expect(result.status).toBe('injected');
      expect(result.newShebang).toBe('#!/usr/bin/env bun');
      const content = readFileSync(f, 'utf-8');
      expect(content.startsWith('#!/usr/bin/env bun\n')).toBe(true);
      expect(content).toContain('console.log("no shebang");');
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });

  test('injects for file starting with "use strict"', () => {
    const dir = makeTmpDir();
    try {
      const f = join(dir, 'cli.js');
      writeFileSync(f, '"use strict";\nconsole.log(1);\n');
      const result = rewriteShebangInFile(f);
      expect(result.status).toBe('injected');
      const content = readFileSync(f, 'utf-8');
      expect(content.startsWith('#!/usr/bin/env bun\n')).toBe(true);
      expect(content).toContain('"use strict";');
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });

  test('BOM + no shebang → injects without eating first character (regression)', () => {
    // Regression test: TextDecoder('utf-8') already strips the BOM from
    // the decoded string. A previous version did content.slice(1) which ate
    // the first real character. This test verifies the fix.
    const dir = makeTmpDir();
    try {
      const f = join(dir, 'cli.js');
      // Write BOM + content (no shebang).
      const bom = Buffer.from([0xef, 0xbb, 0xbf]);
      const body = Buffer.from('"use strict";\nconsole.log(1);\n');
      writeFileSync(f, Buffer.concat([bom, body]));

      const result = rewriteShebangInFile(f);
      expect(result.status).toBe('injected');

      const content = readFileSync(f, 'utf-8');
      // Shebang is injected at the top.
      expect(content.startsWith('#!/usr/bin/env bun\n')).toBe(true);
      // The first real character (") is NOT eaten — "use strict" is intact.
      expect(content).toContain('"use strict";');
      expect(content).toContain('console.log(1);');
      // Verify the exact body after the shebang line.
      const lines = content.split('\n');
      expect(lines[0]).toBe('#!/usr/bin/env bun');
      expect(lines[1]).toBe('"use strict";');
      expect(lines[2]).toBe('console.log(1);');
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });
});

// --------------------------------------------------------------------------
// rewriteShebangInFile — CRLF and BOM handling
// --------------------------------------------------------------------------

describe('rewriteShebangInFile — CRLF and BOM', () => {
  test('CRLF shebang is rewritten with LF output', () => {
    const dir = makeTmpDir();
    try {
      const f = join(dir, 'cli.js');
      writeFileSync(f, '#!/usr/bin/env node\r\nconsole.log(1);\r\n');
      const result = rewriteShebangInFile(f);
      expect(result.status).toBe('rewritten');
      expect(result.originalShebang).toBe('#!/usr/bin/env node');
      // The new shebang line uses LF.
      const content = readFileSync(f, 'utf-8');
      expect(content.startsWith('#!/usr/bin/env bun\n')).toBe(true);
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });

  test('CR-only shebang is rewritten without dropping the body', () => {
    const dir = makeTmpDir();
    try {
      const f = join(dir, 'cli.js');
      writeFileSync(f, '#!/usr/bin/env node\rconsole.log(1);\r');
      const result = rewriteShebangInFile(f);
      expect(result.status).toBe('rewritten');
      expect(readFileSync(f, 'utf-8')).toBe(
        '#!/usr/bin/env bun\nconsole.log(1);\r',
      );
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });

  test('BOM + shebang is rewritten without preserving invalid leading BOM', () => {
    const dir = makeTmpDir();
    try {
      const f = join(dir, 'cli.js');
      // Write BOM + shebang + content.
      const bom = Buffer.from([0xef, 0xbb, 0xbf]);
      const shebang = Buffer.from('#!/usr/bin/env node\nconsole.log(1);\n');
      writeFileSync(f, Buffer.concat([bom, shebang]));
      const result = rewriteShebangInFile(f);
      expect(result.status).toBe('rewritten');
      // The output should start directly with the new shebang. A leading BOM
      // before a shebang is invalid on Unix, so --bun removes it.
      const content = readFileSync(f);
      expect(content[0]).toBe(0x23); // '#'
      expect(content[1]).toBe(0x21); // '!'
      expect(readFileSync(f, 'utf-8').startsWith('#!/usr/bin/env bun\n')).toBe(
        true,
      );
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });
});

// --------------------------------------------------------------------------
// rewriteShebangInFile — content preservation
// --------------------------------------------------------------------------

describe('rewriteShebangInFile — content preservation', () => {
  test('multi-line file body is fully preserved after rewrite', () => {
    const dir = makeTmpDir();
    try {
      const f = join(dir, 'cli.js');
      const original =
        '#!/usr/bin/env node\n' + 'line 1\n' + 'line 2\n' + 'line 3\n';
      writeFileSync(f, original);
      rewriteShebangInFile(f);
      const content = readFileSync(f, 'utf-8');
      // First line changed, rest preserved.
      expect(content).toBe('#!/usr/bin/env bun\nline 1\nline 2\nline 3\n');
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });

  test('file with only a shebang line (no body)', () => {
    const dir = makeTmpDir();
    try {
      const f = join(dir, 'cli.js');
      writeFileSync(f, '#!/usr/bin/env node\n');
      rewriteShebangInFile(f);
      const content = readFileSync(f, 'utf-8');
      expect(content).toBe('#!/usr/bin/env bun\n');
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });
});

// --------------------------------------------------------------------------
// rewriteShebangs — batch function
// --------------------------------------------------------------------------

describe('rewriteShebangs — batch', () => {
  test('processes multiple bins with mixed results', () => {
    const dir = makeTmpDir();
    try {
      // Bin 1: node shebang → rewritten.
      writeFileSync(
        join(dir, 'cli.js'),
        '#!/usr/bin/env node\nconsole.log("cli");\n',
      );
      // Bin 2: no shebang → injected.
      writeFileSync(join(dir, 'helper.js'), 'console.log("helper");\n');
      // Bin 3: binary → skipped.
      const buf = Buffer.alloc(20, 0x42);
      buf[5] = 0x00;
      writeFileSync(join(dir, 'native.node'), buf);
      // Bin 4: already bun → already-bun.
      writeFileSync(
        join(dir, 'bun-cli.js'),
        '#!/usr/bin/env bun\nconsole.log("bun");\n',
      );

      const binEntries: BinEntry[] = [
        {name: 'cli', path: './cli.js'},
        {name: 'helper', path: './helper.js'},
        {name: 'native', path: './native.node'},
        {name: 'bun-cli', path: './bun-cli.js'},
      ];

      const results = rewriteShebangs(dir, binEntries);

      expect(results).toHaveLength(4);
      expect(results[0].status).toBe('rewritten');
      expect(results[0].binName).toBe('cli');
      expect(results[0].binPath).toBe('./cli.js');
      expect(results[1].status).toBe('injected');
      expect(results[1].binName).toBe('helper');
      expect(results[2].status).toBe('skipped-binary');
      expect(results[2].binName).toBe('native');
      expect(results[3].status).toBe('already-bun');
      expect(results[3].binName).toBe('bun-cli');

      // Verify file modifications.
      expect(
        readFileSync(join(dir, 'cli.js'), 'utf-8').startsWith(
          '#!/usr/bin/env bun',
        ),
      ).toBe(true);
      expect(
        readFileSync(join(dir, 'helper.js'), 'utf-8').startsWith(
          '#!/usr/bin/env bun',
        ),
      ).toBe(true);
      // Binary file is untouched (still has null byte).
      expect(readFileSync(join(dir, 'native.node'))[5]).toBe(0x00);
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });

  test('empty binEntries → empty results', () => {
    const dir = makeTmpDir();
    try {
      const results = rewriteShebangs(dir, []);
      expect(results).toEqual([]);
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });

  test('missing file in throwaway copy → skipped-missing', () => {
    const dir = makeTmpDir();
    try {
      const binEntries: BinEntry[] = [
        {name: 'missing-cmd', path: './does-not-exist.js'},
      ];
      const results = rewriteShebangs(dir, binEntries);
      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('skipped-missing');
      expect(results[0].binName).toBe('missing-cmd');
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });

  test('bin path escaping package copy → skipped-outside-package', () => {
    const dir = makeTmpDir();
    const outside = join(dir, '..', 'escape.js');
    try {
      writeFileSync(outside, '#!/usr/bin/env node\nconsole.log("escape");\n');
      const binEntries: BinEntry[] = [
        {name: 'escape-cmd', path: '../escape.js'},
      ];
      const results = rewriteShebangs(dir, binEntries);
      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('skipped-outside-package');
      expect(results[0].binName).toBe('escape-cmd');
      expect(readFileSync(outside, 'utf-8')).toBe(
        '#!/usr/bin/env node\nconsole.log("escape");\n',
      );
    } finally {
      rmSync(outside, {force: true});
      rmSync(dir, {recursive: true, force: true});
    }
  });

  test('symlink target escaping package copy → skipped-outside-package', () => {
    const dir = makeTmpDir();
    const outside = join(dir, '..', 'escape-symlink.js');
    try {
      writeFileSync(outside, '#!/usr/bin/env node\nconsole.log("escape");\n');
      symlinkSync(outside, join(dir, 'cli.js'));
      const results = rewriteShebangs(dir, [{name: 'cli', path: './cli.js'}]);
      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('skipped-outside-package');
      expect(results[0].binName).toBe('cli');
      expect(readFileSync(outside, 'utf-8')).toBe(
        '#!/usr/bin/env node\nconsole.log("escape");\n',
      );
    } finally {
      rmSync(outside, {force: true});
      rmSync(dir, {recursive: true, force: true});
    }
  });
});

// --------------------------------------------------------------------------
// rewriteShebangInFile — end-to-end execution test
// --------------------------------------------------------------------------

describe('rewriteShebangInFile — end-to-end execution', () => {
  test('rewritten file executes under bun (not node)', () => {
    // This test verifies that the rewritten shebang actually works when the
    // file is executed directly by the OS (not via `bun file.js`). The OS
    // reads the shebang, resolves `env bun`, and runs the file under bun.
    // The script prints 'BUN' if running under Bun, 'NODE' otherwise.
    //
    // Skipped on Windows (no shebang support at the OS level).
    if (process.platform === 'win32') return;

    const dir = makeTmpDir();
    try {
      const f = join(dir, 'cli.js');
      writeFileSync(
        f,
        '#!/usr/bin/env node\n' +
          "if (typeof Bun !== 'undefined') { console.log('BUN'); } " +
          "else { console.log('NODE'); }\n",
      );

      // Rewrite the shebang.
      const result = rewriteShebangInFile(f);
      expect(result.status).toBe('rewritten');

      // Make executable.
      chmodSync(f, 0o755);

      // Execute directly — the OS reads the shebang.
      const proc = Bun.spawnSync([f], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env as Record<string, string>,
      });

      const stdout = new TextDecoder().decode(proc.stdout).trim();
      expect(proc.exitCode).toBe(0);
      expect(stdout).toBe('BUN');
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });

  test('injected shebang file executes under bun', () => {
    // Same as above but for the injection case (no original shebang).
    if (process.platform === 'win32') return;

    const dir = makeTmpDir();
    try {
      const f = join(dir, 'cli.js');
      writeFileSync(
        f,
        "if (typeof Bun !== 'undefined') { console.log('BUN'); } " +
          "else { console.log('NODE'); }\n",
      );

      const result = rewriteShebangInFile(f);
      expect(result.status).toBe('injected');

      chmodSync(f, 0o755);

      const proc = Bun.spawnSync([f], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env as Record<string, string>,
      });

      const stdout = new TextDecoder().decode(proc.stdout).trim();
      expect(proc.exitCode).toBe(0);
      expect(stdout).toBe('BUN');
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });

  test('rewritten file with dropped flags executes under bun', () => {
    // Verifies that node flags are safely dropped — the rewritten shebang
    // is exactly `#!/usr/bin/env bun` with no trailing comment.
    if (process.platform === 'win32') return;

    const dir = makeTmpDir();
    try {
      const f = join(dir, 'cli.js');
      writeFileSync(
        f,
        '#!/usr/bin/env node --require ./foo --no-warnings\n' +
          "if (typeof Bun !== 'undefined') { console.log('BUN'); } " +
          "else { console.log('NODE'); }\n",
      );

      const result = rewriteShebangInFile(f);
      expect(result.status).toBe('rewritten');
      expect(result.newShebang).toBe('#!/usr/bin/env bun');

      chmodSync(f, 0o755);

      const proc = Bun.spawnSync([f], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env as Record<string, string>,
      });

      const stdout = new TextDecoder().decode(proc.stdout).trim();
      expect(proc.exitCode).toBe(0);
      expect(stdout).toBe('BUN');
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });
});
