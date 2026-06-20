import {
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import {isAbsolute, relative, resolve} from 'node:path';

import type {BinEntry} from './types.ts';
import {log} from './utils.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The replacement shebang for all node shebangs when `--bun` is active.
 * Uses `env` so that `bun` is resolved from PATH at runtime — this is the
 * most portable form across platforms and installation layouts.
 */
const BUN_SHEBANG = '#!/usr/bin/env bun';

/**
 * Buffer size for binary detection. Reads the first 8 KiB of each bin target
 * file and checks for null bytes (0x00). This is the same heuristic used by
 * `git` and `grep` to distinguish text from binary files. 8 KiB is sufficient
 * because compiled binaries contain null bytes in their header (first few
 * hundred bytes), while JS/TS source files never contain null bytes.
 */
const SHEBANG_SCAN_BYTES = 8192;

/**
 * Classifies a shebang line after the leading `#!`.
 */
type ShebangKind = 'node' | 'bun' | 'other';

/**
 * Returns the final path segment without a Windows `.exe` suffix.
 */
function executableBaseName(executable: string | undefined): string {
  if (!executable) return '';
  return (
    executable
      .split(/[\\/]/)
      .pop()
      ?.replace(/\.exe$/i, '') ?? ''
  );
}

function isEnvExecutable(executable: string): boolean {
  return executableBaseName(executable) === 'env';
}

function isNodeExecutable(executable: string): boolean {
  return /^(node|nodejs)$/i.test(executableBaseName(executable));
}

function isBunExecutable(executable: string): boolean {
  return /^bun$/i.test(executableBaseName(executable));
}

/**
 * GNU `env` short options (within `-S`/`--split-string` split strings) that
 * take a value, either as the next token (`-u FOO`) or attached (`-uFOO`).
 * Recognized so {@link findEnvCommand} can skip the value when locating the
 * command. Verified against GNU coreutils `env` 9.11 with `env -vS`.
 */
const ENV_VALUE_OPTIONS_SHORT = new Set(['u', 'C', 'S', 'a']);

/**
 * GNU `env` long options that take a value, either inline (`--unset=FOO`) or
 * as the next token (`--unset FOO`).
 */
const ENV_VALUE_OPTIONS_LONG = new Set([
  '--unset',
  '--chdir',
  '--split-string',
  '--argv0',
]);

/**
 * GNU `env` long options that take NO value (boolean), or take an OPTIONAL
 * inline value (`--block-signal[=SIG]`) — either way they consume exactly one
 * token (no next-token consumed).
 *
 * NOTE: `--null` (the long form of `-0`) is intentionally EXCLUDED. GNU env
 * rejects `--null`/`-0` when a command is present (verified: `env -vS
 * '--null node version'` → "cannot specify --null (-0) with command", exit
 * 125), so a `--null ... node` shebang is broken and must be skipped —
 * consistent with the short-form `-0` handling in findEnvCommand.
 */
const ENV_BOOLEAN_OPTIONS_LONG = new Set([
  '--ignore-environment',
  '--debug',
  '--block-signal',
  '--default-signal',
  '--ignore-signal',
  '--list-signal-handling',
]);

/**
 * Finds the command token in a GNU `env -S` / `--split-string=` split string.
 *
 * GNU `env` parses ITS OWN options from the split string first (e.g. `-i`,
 * `-u VAR`, `-C DIR`, `-a ARG`), then runs the first remaining token as the
 * command, passing the rest as the command's arguments. Unknown options make
 * `env` error out (exit 125), so a shebang carrying them is broken and is
 * conservatively treated as unidentifiable (returns `undefined` → the caller
 * skips the file rather than rewriting it).
 *
 * This matters for correctness: a shebang like `#!/usr/bin/env -S wrapper
 * node` runs `wrapper` with `node` as an argument — NOT node. Treating `node`
 * as the command here would cause {@link rewriteShebangInFile} to destructively
 * replace the whole line with `#!/usr/bin/env bun`, silently dropping the
 * wrapper. See `scratch/review-01.md`.
 *
 * Verified empirically against GNU coreutils `env` 9.11 via `env -vS`:
 *   -S 'node'              → command = node
 *   -S 'node --require x'  → command = node (--require x are node's args)
 *   -S 'wrapper node'      → command = wrapper (node is wrapper's arg)  ← the bug
 *   -S '-i node'           → -i is env's option, command = node
 *   -S '-u FOO node'       → -u consumes FOO, command = node
 *   -S '-C /var node'      → -C consumes /var, command = node
 *   -S '-iv node'          → -i -v combined, command = node
 *   -S '-uFOO node'        → -uFOO attached value, command = node
 *   -S '-- node'           → -- ends options, command = node
 *   -S '--require ./foo n' → --require unknown → env exit 125 → skip
 *
 * @returns The command token, or `undefined` if no command can be confidently
 *   identified (broken/ambiguous split string → caller skips the file).
 */
function findEnvCommand(tokens: string[]): string | undefined {
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];
    // `--` ends option parsing; the next token (if any) is the command.
    if (tok === '--') {
      return tokens[i + 1];
    }
    // A token that doesn't start with '-' (or is exactly '-') is the command.
    if (!tok.startsWith('-') || tok === '-') {
      return tok;
    }
    if (tok.startsWith('--')) {
      // Long option: `--name` or `--name=value`.
      const eq = tok.indexOf('=');
      const name = eq === -1 ? tok : tok.slice(0, eq);
      const hasInlineValue = eq !== -1;
      if (ENV_VALUE_OPTIONS_LONG.has(name)) {
        i += hasInlineValue ? 1 : 2; // value is inline, or it is the next token
      } else if (ENV_BOOLEAN_OPTIONS_LONG.has(name)) {
        i += 1;
      } else {
        return undefined; // unknown long option → env errors (exit 125) → skip
      }
    } else {
      // Short option cluster, possibly combined (`-iv`) or with an attached
      // value (`-uFOO`). Scan the cluster left to right.
      const chars = tok.slice(1);
      let consumeNext = false;
      let resolved = false;
      for (let j = 0; j < chars.length; j++) {
        const c = chars[j];
        if (ENV_VALUE_OPTIONS_SHORT.has(c)) {
          // If more chars follow the option letter, they are the inline value
          // (`-uFOO`, `-C/var`); otherwise the value is the next token.
          if (chars.length > j + 1) {
            // attached value — fully consumed by this token
          } else {
            consumeNext = true;
          }
          resolved = true;
          break;
        }
        // Boolean short options: i (ignore-environment), v (debug). Any other
        // short option → env errors → skip. This includes `-0`/`--null`
        // (verified: `env -vS '-0 echo hi'` → "cannot specify --null (-0)
        // with command", exit 125), which is incompatible with a command, so
        // a `-0 ... node` shebang is broken and is skipped — consistent with
        // the unknown-option handling below.
        if (c !== 'i' && c !== 'v') {
          return undefined;
        }
      }
      if (resolved) {
        i += consumeNext ? 2 : 1;
      } else {
        // The whole cluster was boolean options (e.g. `-iv`).
        i += 1;
      }
    }
  }
  return undefined; // no command token found
}

/**
 * Classifies a shebang as invoking Node.js, Bun, or something else.
 *
 * Handles direct interpreters (`#!/usr/bin/node`), env interpreters
 * (`#!/usr/bin/env node`), and GNU env `-S`/`--split-string` forms. For
 * `env -S`, the actual command is located with {@link findEnvCommand} (which
 * skips env's own options), so wrapper scripts like `#!/usr/bin/env -S wrapper
 * node` are NOT mistaken for node. The executable name is matched by final path
 * segment, so `/usr/bin/notnode` and `/usr/bin/node-wrapper` are not mistaken
 * for Node.js either.
 */
function classifyShebang(shebangLine: string): ShebangKind {
  const trimmed = shebangLine.replace(/^#!\s*/, '').trimStart();
  if (!trimmed) return 'other';

  const tokens = trimmed.split(/\s+/);
  const interpreter = tokens[0];

  if (!isEnvExecutable(interpreter)) {
    return classifyExecutable(interpreter);
  }

  const envArgs = tokens.slice(1);
  const splitStringArg = envArgs[0];
  if (
    splitStringArg === '-S' ||
    splitStringArg === '--split-string' ||
    splitStringArg?.startsWith('--split-string=')
  ) {
    const splitStringTokens = splitStringArg?.startsWith('--split-string=')
      ? [splitStringArg.slice('--split-string='.length), ...envArgs.slice(1)]
      : envArgs.slice(1);
    // Locate the actual command token (skipping env's own options). Only that
    // token determines whether this is a node/bun shebang — iterating ALL tokens
    // would misclassify `#!/usr/bin/env -S wrapper node` as node (see
    // scratch/review-01.md) and destructively drop the wrapper on rewrite.
    return classifyExecutable(findEnvCommand(splitStringTokens));
  }

  return classifyExecutable(envArgs[0]);
}

function classifyExecutable(executable: string | undefined): ShebangKind {
  if (isNodeExecutable(executable ?? '')) return 'node';
  if (isBunExecutable(executable ?? '')) return 'bun';
  return 'other';
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Result of attempting to rewrite the shebang in a single bin target file.
 */
export type ShebangRewriteResult = {
  /** The bin name (command name). Set by {@link rewriteShebangs}. */
  binName: string;
  /** The relative path from package.json. Set by {@link rewriteShebangs}. */
  binPath: string;
  /** The absolute path to the file that was inspected. */
  absPath: string;
  /** What happened. */
  status:
    | 'rewritten' // Node shebang found and replaced with bun
    | 'already-bun' // Shebang already points to bun — no change needed
    | 'injected' // No shebang, text file — bun shebang injected at top
    | 'skipped-binary' // File is binary (not text) — skipped
    | 'skipped-non-node' // File has a non-node shebang — skipped
    | 'skipped-empty' // File is empty (0 bytes) — skipped
    | 'skipped-missing' // File does not exist in the throwaway copy — skipped
    | 'skipped-outside-package' // Bin path escapes the package copy — skipped
    | 'skipped-not-utf8' // File exists but is not valid UTF-8 — skipped
    | 'error'; // Unexpected error (e.g. permission denied)
  /** The original shebang line (first line), if a shebang was present. */
  originalShebang?: string;
  /** The new shebang line, if rewritten or injected. */
  newShebang?: string;
  /** Error message when status is 'error'. */
  error?: string;
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if the file content appears to be binary (contains a null
 * byte in the first SHEBANG_SCAN_BYTES). Uses the same heuristic as git
 * and grep: a null byte in the sampled region indicates non-text content.
 */
function isBinary(buffer: Buffer): boolean {
  return buffer
    .subarray(0, Math.min(buffer.length, SHEBANG_SCAN_BYTES))
    .includes(0x00);
}

/**
 * Returns the byte offset of the shebang start (`#!`) in the buffer, or -1
 * if no shebang is present. Handles a leading UTF-8 BOM (EF BB BF) which
 * some Windows tools prepend before the shebang.
 */
function findShebangOffset(buffer: Buffer): number {
  // Direct shebang at byte 0.
  if (buffer.length >= 2 && buffer[0] === 0x23 && buffer[1] === 0x21) {
    return 0;
  }
  // BOM (EF BB BF) followed by shebang at byte 3.
  if (
    buffer.length >= 5 &&
    buffer[0] === 0xef &&
    buffer[1] === 0xbb &&
    buffer[2] === 0xbf &&
    buffer[3] === 0x23 &&
    buffer[4] === 0x21
  ) {
    return 3;
  }
  return -1;
}

/**
 * Extracts the first line from a buffer starting at `shebangOffset`,
 * handling both LF and CRLF line endings. Returns the line WITHOUT the
 * trailing newline and the byte offset where content after the first line
 * begins (for reconstruction during rewriting).
 */
function extractFirstLine(
  buffer: Buffer,
  shebangOffset: number,
): {line: string; contentStart: number} {
  const lfIdx = buffer.indexOf(0x0a, shebangOffset);
  const crIdx = buffer.indexOf(0x0d, shebangOffset);

  let newlineIdx = -1;
  if (lfIdx === -1) newlineIdx = crIdx;
  else if (crIdx === -1) newlineIdx = lfIdx;
  else newlineIdx = Math.min(lfIdx, crIdx);

  if (newlineIdx === -1) {
    return {
      line: buffer.subarray(shebangOffset).toString('utf-8'),
      contentStart: buffer.length,
    };
  }

  let contentStart = newlineIdx + 1;
  // If we hit \r and the next char is \n, advance contentStart past both
  if (buffer[newlineIdx] === 0x0d && buffer[newlineIdx + 1] === 0x0a) {
    contentStart = newlineIdx + 2;
  }

  return {
    line: buffer.subarray(shebangOffset, newlineIdx).toString('utf-8'),
    contentStart,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Rewrites the shebang in a single file to use the Bun runtime.
 *
 * Decision matrix:
 * - File not found → skip (skipped-missing)
 * - Not a regular file → error
 * - Empty file (0 bytes) → skip (skipped-empty)
 * - Binary file (null byte in first 8K) → skip (skipped-binary)
 * - Not valid UTF-8 → skip (skipped-not-utf8)
 * - No shebang, text file → inject `#!/usr/bin/env bun` at top (injected)
 * - Bun shebang already present → no change (already-bun)
 * - Node shebang present → replace first line (rewritten), drop node flags
 * - Non-node shebang → skip (skipped-non-node)
 *
 * Node-specific CLI flags (e.g. `--require`, `--loader`,
 * `--experimental-strip-types`) are DROPPED silently because Bun does not
 * understand them. No comment is appended to the shebang line — a `#`
 * comment would break Linux (the kernel passes the entire rest-of-line as
 * a single argument to env, causing exit 127). The original flags are
 * logged by the caller ({@link rewriteShebangs}) for traceability.
 *
 * @param absPath Absolute path to the file to rewrite.
 * @returns Result describing what happened. `binName` and `binPath` are
 *   empty — the caller ({@link rewriteShebangs}) fills them in.
 */
export function rewriteShebangInFile(absPath: string): ShebangRewriteResult {
  // Check existence.
  if (!existsSync(absPath)) {
    return {binName: '', binPath: '', absPath, status: 'skipped-missing'};
  }

  // Check it's a regular file (not a directory or special file).
  let stat;
  try {
    stat = statSync(absPath);
    if (!stat.isFile()) {
      return {
        binName: '',
        binPath: '',
        absPath,
        status: 'error',
        error: `Not a regular file (isDirectory: ${stat.isDirectory()})`,
      };
    }
  } catch (err: unknown) {
    return {
      binName: '',
      binPath: '',
      absPath,
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // Check for empty file.
  if (stat.size === 0) {
    return {binName: '', binPath: '', absPath, status: 'skipped-empty'};
  }

  // Read the full file (needed for rewriting/injection).
  let buffer: Buffer;
  try {
    buffer = readFileSync(absPath);
  } catch (err: unknown) {
    return {
      binName: '',
      binPath: '',
      absPath,
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // Binary detection: null byte in first SHEBANG_SCAN_BYTES.
  if (isBinary(buffer)) {
    return {binName: '', binPath: '', absPath, status: 'skipped-binary'};
  }

  // UTF-8 validation. A file that is valid Latin-1 but not valid UTF-8
  // would be skipped — we only rewrite text files that we can safely decode
  // and re-encode as UTF-8.
  let content: string;
  try {
    content = new TextDecoder('utf-8', {fatal: true}).decode(buffer);
  } catch {
    return {binName: '', binPath: '', absPath, status: 'skipped-not-utf8'};
  }

  // Shebang detection (handles BOM).
  const shebangOffset = findShebangOffset(buffer);

  // Case: No shebang — inject at top.
  if (shebangOffset === -1) {
    // TextDecoder('utf-8', {fatal: true}) already strips a leading BOM
    // (EF BB BF) from the decoded string — the BOM is NOT present in
    // `content`. So we do NOT need to slice it off. A previous version
    // did `content.slice(1)` which ate the first real character when a
    // BOM was present (data corruption bug).
    //
    // A BOM before a shebang is invalid on Unix (the kernel reads byte 0
    // for `#`), so we intentionally do NOT re-add it to the output. The
    // injected shebang `#!/usr/bin/env bun` is at byte 0 — correct on all
    // platforms.
    const newContent = `${BUN_SHEBANG}\n${content}`;

    try {
      writeFileSync(absPath, newContent, 'utf-8');
    } catch (err: unknown) {
      return {
        binName: '',
        binPath: '',
        absPath,
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      };
    }

    return {
      binName: '',
      binPath: '',
      absPath,
      status: 'injected',
      newShebang: BUN_SHEBANG,
    };
  }

  // Extract the shebang line.
  const {line: shebangLine, contentStart} = extractFirstLine(
    buffer,
    shebangOffset,
  );

  // Case: Already a bun shebang — no change needed.
  const shebangKind = classifyShebang(shebangLine);
  if (shebangKind === 'bun') {
    return {
      binName: '',
      binPath: '',
      absPath,
      status: 'already-bun',
      originalShebang: shebangLine,
    };
  }

  // Case: Node shebang — rewrite.
  if (shebangKind === 'node') {
    const newShebang = BUN_SHEBANG;

    // Reconstruct the file without the leading BOM: a BOM before a shebang is
    // invalid on Unix (the kernel reads byte 0 for `#`), and the user opted
    // into `--bun` to make the installed command executable by the Bun runtime.
    const restContent = buffer.subarray(contentStart).toString('utf-8');
    const newContent = `${newShebang}\n${restContent}`;

    try {
      writeFileSync(absPath, newContent, 'utf-8');
    } catch (err: unknown) {
      return {
        binName: '',
        binPath: '',
        absPath,
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      };
    }

    return {
      binName: '',
      binPath: '',
      absPath,
      status: 'rewritten',
      originalShebang: shebangLine,
      newShebang,
    };
  }

  // Case: Non-node shebang — skip.
  return {
    binName: '',
    binPath: '',
    absPath,
    status: 'skipped-non-node',
    originalShebang: shebangLine,
  };
}

/**
 * Returns true when `candidate` is inside `root`, based on normalized absolute
 * paths. This catches both lexical escapes and symlink targets after realpath.
 */
function isPathInsidePackage(candidate: string, root: string): boolean {
  const relPath = relative(root, candidate);
  return (
    relPath === '' ||
    (relPath !== '..' &&
      !relPath.startsWith('../') &&
      !relPath.startsWith('..\\') &&
      !isAbsolute(relPath))
  );
}

/**
 * Rewrites shebangs in all bin target files of a package's throwaway copy
 * to use the Bun runtime. Intended to be called AFTER the throwaway copy is
 * created and package.json is modified, but BEFORE `bun pm pack`.
 *
 * Processes each bin entry independently — a failure on one bin does not
 * abort the others. Results are logged and returned for caller inspection.
 *
 * @param packDir    The throwaway copy directory (absolute).
 * @param binEntries The bin entries from PackageData.
 * @returns One result per bin entry.
 */
export function rewriteShebangs(
  packDir: string,
  binEntries: BinEntry[],
): ShebangRewriteResult[] {
  const results: ShebangRewriteResult[] = [];

  const packRoot = realpathSync(packDir);
  for (const entry of binEntries) {
    const absPath = resolve(packDir, entry.path);

    let realAbsPath: string;
    try {
      realAbsPath = realpathSync(absPath);
    } catch {
      const result: ShebangRewriteResult = {
        binName: '',
        binPath: '',
        absPath,
        status: 'skipped-missing',
      };
      result.binName = entry.name;
      result.binPath = entry.path;
      log(
        `  --bun: skipped '${entry.name}' (${entry.path}) — target is not resolvable in throwaway copy`,
      );
      results.push(result);
      continue;
    }

    if (!isPathInsidePackage(realAbsPath, packRoot)) {
      const result: ShebangRewriteResult = {
        binName: '',
        binPath: '',
        absPath: realAbsPath,
        status: 'skipped-outside-package',
      };
      result.binName = entry.name;
      result.binPath = entry.path;
      log(
        `  --bun: skipped '${entry.name}' (${entry.path}) — resolved target escapes package copy`,
      );
      results.push(result);
      continue;
    }

    const result = rewriteShebangInFile(realAbsPath);
    result.binName = entry.name;
    result.binPath = entry.path;

    // Log each result with a descriptive message.
    switch (result.status) {
      case 'rewritten':
        log(`  --bun: rewrote '${entry.name}' (${entry.path})`);
        if (result.originalShebang) {
          log(`    was: ${result.originalShebang}`);
          log(`    now: ${result.newShebang}`);
        }
        break;
      case 'injected':
        log(
          `  --bun: injected shebang in '${entry.name}' (${entry.path}) — no shebang was present`,
        );
        break;
      case 'already-bun':
        log(
          `  --bun: '${entry.name}' (${entry.path}) already uses bun — no change`,
        );
        break;
      case 'skipped-binary':
        log(`  --bun: skipped '${entry.name}' (${entry.path}) — binary file`);
        break;
      case 'skipped-non-node':
        log(
          `  --bun: skipped '${entry.name}' (${entry.path}) — non-node shebang: ${result.originalShebang ?? ''}`,
        );
        break;
      case 'skipped-empty':
        log(`  --bun: skipped '${entry.name}' (${entry.path}) — empty file`);
        break;
      case 'skipped-missing':
        log(
          `  --bun: skipped '${entry.name}' (${entry.path}) — file not found in throwaway copy`,
        );
        break;
      case 'skipped-outside-package':
        log(
          `  --bun: skipped '${entry.name}' (${entry.path}) — path escapes package copy`,
        );
        break;
      case 'skipped-not-utf8':
        log(
          `  --bun: skipped '${entry.name}' (${entry.path}) — not valid UTF-8`,
        );
        break;
      case 'error':
        log(
          `  --bun: ERROR on '${entry.name}' (${entry.path}): ${result.error ?? 'unknown'}`,
        );
        break;
    }

    results.push(result);
  }

  return results;
}
