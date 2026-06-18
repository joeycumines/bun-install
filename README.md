# bun-install

Install command packages from a local Bun workspace into Bun's global package store.

## Install

```sh
bun add -g bun-install
```

## Usage

Run `bun-install` from a workspace root, or any directory inside the workspace.

```sh
bun-install
```

Install only selected commands:

```sh
bun-install my-command another-command
```

## Requirements

- Bun 1.3.14 or newer
- A workspace root `package.json` with a `workspaces` field
- Workspace packages that expose commands through `bin`

## Development

```sh
bun run bootstrap
bun run check
```

Use `bun run link` to link the package into Bun's global package store for local development.

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
