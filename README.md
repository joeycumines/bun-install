# bun-install

Globally install CLI commands from a local Bun project — works with both
**monorepo workspaces** and **single-package projects**.

`bun-install` discovers your project, builds it (if it has a `build` script),
packs it, and installs the resulting package(s) globally via `bun add -g`.
It handles dependency ordering, cache management, and binary verification.

## Install

```sh
bun add -g bun-install
```

## Usage

Run `bun-install` from your project root (or any subdirectory):

```sh
bun-install
```

Install only selected commands (by binary name):

```sh
bun-install my-command another-command
```

### Project types

`bun-install` supports two project structures seamlessly:

| Type                   | Detection                                                      | What gets installed                                           |
|------------------------|----------------------------------------------------------------|---------------------------------------------------------------|
| **Monorepo workspace** | Root `package.json` has a `workspaces` field                   | Packages matched by workspace globs that expose `bin` entries |
| **Single package**     | No `workspaces` field — the root `package.json` is the package | The root project's package itself (if it has a `bin` entry)   |

Discovery walks upwards from your current directory, so you can run
`bun-install` from any nested directory inside the project.

## Requirements

- Bun 1.3.14 or newer
- A `package.json` in the project root with:
  - A `"name"` field
  - At least one package that exposes a `"bin"` entry
- **Workspace mode only**: a `"workspaces"` field pointing to package directories

## Development

```sh
bun install
bun run check
```

Use `bun src/index.ts` to install a copy of this command into Bun's global package store via the command itself.

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
