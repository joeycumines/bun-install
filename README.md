# bun-install

Install CLI commands from a local workspace or an NPM package into Bun's global package store.

Supports command selection and Bun runtime override.
Excellent for dev builds of MCPs and other tools.
Automatically resolves dependencies within your project's workspace.

## Install

### From NPM

```sh
bun add -g bun-install
```

### From source

Clone the repo and run the entrypoint directly:

```sh
git clone https://github.com/joeycumines/bun-install.git
cd bun-install
bun src/index.ts
```

This installs `bun-install` into Bun's global package store just as the
published package would.

## Usage

### Local project

Run `bun-install` from your project root (or any subdirectory):

```sh
bun-install
```

Install only selected commands (by binary name):

```sh
bun-install my-command another-command
```

Select a specific package, optionally filtering to specific commands from it:

```sh
bun-install --package my-cli           # all commands from my-cli
bun-install -p my-cli tool-a tool-b   # only tool-a and tool-b
```

### NPM package

Install from NPM by passing a package specifier to `--package`:

```sh
bun-install -p prettier                 # all commands from prettier
bun-install -p @scope/pkg@latest        # all commands from a scoped package
bun-install -p pkg@2.0.0 cmd1           # only cmd1 from pkg@2.0.0
bun-install --bun -p pkg@latest          # install under Bun runtime
```

Any specifier that `bun add` accepts works, including version ranges and
dist-tags. The package is fetched via `bun add` into a temporary project,
then packed and installed globally.

### No-clobber guarantee

When a subset of a package's commands is selected, only those commands are
symlinked into Bun's global bin directory. [`bun add -g`](https://bun.sh/docs/pm/cli/install)
overwrites existing symlinks without warning, so `bun-install` filters the
`bin` field in the packed tarball before installation, ensuring unselected
commands are never symlinked and cannot clobber existing commands from other
packages. This applies to both local and NPM packages.

Command-level selection does not prune dependencies. Determining which deps
a specific command uses is undecidable for dynamic imports, and the risk of
runtime failures outweighs the marginal benefit.

### Forcing the Bun runtime

```sh
bun-install --bun
bun-install --bun my-command
bun-install --package my-cli --bun
bun-install --bun -p pkg@latest
```

The `--bun` flag rewrites node shebangs in the installed commands to
`#!/usr/bin/env bun` and injects a Bun shebang when a bin target has none, so
they run under the Bun runtime instead of Node.js. This works cross-platform:
on Unix the OS reads the shebang via the symlink; on Windows Bun's shim reads
it from the target file. Files that cannot be safely rewritten (native
binaries, non-node scripts) are skipped with a warning. The install proceeds.

Bun's own mechanism for forcing the Bun runtime is
[`bunx --bun`](https://bun.sh/docs/pm/bunx), which resolves packages from the
current directory's `node_modules` first and does not consult globally
installed packages. This makes it unsuitable for commands that should be
available everywhere. `bun-install --bun` rewrites shebangs in the installed
bin targets so they run under Bun regardless of the working directory.

Show help:

```sh
bun-install --help
```

### Local project types

`bun-install` supports two local project structures:

| Type                   | Detection                                                      | What gets installed                                           |
|------------------------|----------------------------------------------------------------|---------------------------------------------------------------|
| **Monorepo workspace** | Root `package.json` has a `workspaces` field                   | Packages matched by workspace globs that expose `bin` entries |
| **Single package**     | No `workspaces` field; the root `package.json` is the package | The root project's package itself (if it has a `bin` entry)   |

Discovery walks upwards from your current directory, so you can run
`bun-install` from any nested directory inside the project.

When `--package` is specified and the package is not found in the local
project, `bun-install` falls back to fetching it from NPM. If there is no
local project at all (no `package.json` in any parent directory), it also
falls back to NPM. However, if the local project is broken (e.g. malformed
`package.json`, empty workspace), the error is surfaced rather than silently
substituting a remote package.

## Requirements

- Bun 1.3.14 or newer

### Local project mode

- A `package.json` in the project root with:
  - A `"name"` field
  - At least one package that exposes a `"bin"` entry
- **Workspace mode only**: a `"workspaces"` field pointing to package directories

### NPM mode

- No local project required
- The package must expose a `"bin"` entry in its `package.json`

## Development

```sh
bun install
bun run check
```

## Release

```sh
# bump version (pick one)
bun run version:patch
bun run version:minor
bun run version:major
bun run version:prerelease

# publish (dry-run first, then latest or next)
bun run publish:dry
bun run publish:latest
bun run publish:next

# push the tag
bun run release
```
