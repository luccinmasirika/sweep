# sweep

Safe, interactive disk cleanup for macOS. `sweep` reports what is taking up
space, then frees it only after you confirm, so nothing is deleted by accident.

## Why

`scan` never touches the disk. `clean` asks before each target, and the
`large-files` target is read-only by design: it surfaces your biggest files so
you can decide, but it will never delete them.

## Install

```sh
cargo install --path .
```

This builds an optimized `sweep` binary into `~/.cargo/bin`.

## Usage

```sh
sweep scan                 # analyse only, delete nothing
sweep scan --json          # same, as machine-readable JSON
sweep clean                # free space, confirming before each target
sweep clean --yes          # skip the prompts
sweep clean --only caches,dev-tools
sweep config               # print the effective configuration
```

## Targets

| Target         | Action                                                       |
| -------------- | ------------------------------------------------------------ |
| `caches`       | Empties `~/Library/Caches`, `~/Library/Logs`, `~/.Trash`.    |
| `dev-tools`    | `brew cleanup`, npm/pnpm/yarn caches, `docker system prune`. |
| `large-files`  | Lists the biggest entries in your folders (read-only).       |
| `node-modules` | Finds `node_modules` dirs, flags idle projects.              |

Only the tools actually installed on your machine are offered under
`dev-tools`. `docker system prune` removes unused images and networks but never
named volumes.

## Configuration

Defaults work out of the box. To customise, copy
[`sweep.example.toml`](sweep.example.toml) to `./sweep.toml` or
`~/.config/sweep/config.toml`, or point at any file with `--config`. Paths
support `~` expansion and missing fields fall back to the built-in defaults.

## Development

```sh
cargo test --all
cargo clippy --all-targets -- -D warnings
cargo fmt --all
```

## License

MIT
