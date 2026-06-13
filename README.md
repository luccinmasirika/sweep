# sweep

Safe, interactive disk cleanup for macOS. `sweep` discovers what is taking up
space on its own and frees it only after you confirm, so nothing is deleted by
accident.

## Why

There is nothing to configure. `sweep` knows the places that usually grow on a
Mac (system and app caches, Xcode, package-manager caches) and walks your home
folder to find regenerable build/dependency dirs wherever they live — it does
not need to be told where your projects are. `scan` never touches the disk;
`clean` confirms each target; personal files are surfaced but start unchecked
and are never removed by `--yes`.

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
sweep clean --only projects,app-caches
sweep clean --aggressive   # prune all unused Docker images, heavier dev caches
sweep doctor               # diagnose where space is going (read-only)
sweep config               # print the effective configuration
```

## What it detects

| Detector        | How it finds it                                                          |
| --------------- | ------------------------------------------------------------------------ |
| `system-caches` | Known paths: `~/Library/Caches`, `~/Library/Logs`, `~/.Trash`.           |
| `app-caches`    | Cache-named dirs discovered under Application Support / Containers.       |
| `dev-tools`     | `brew`/npm/pnpm/yarn + cargo/pip caches, `docker prune` (tools present).  |
| `xcode`         | DerivedData, device support, simulators, archives, iOS backups.          |
| `projects`      | Deep home walk for regenerable build/dep dirs (`node_modules`, `target`…). |
| `large-items`   | Biggest personal files/folders over a threshold (start unchecked).       |

Nothing is hard-coded to a particular machine: detectors resolve known paths
relative to your home and discover the rest by scanning.

### Aggressive mode

`--aggressive` upgrades `docker system prune` to `-a` (every unused image) and
adds the heavier dev caches like `go clean -modcache`. `--volumes` additionally
prunes Docker volumes — this destroys volume data, so it is never on by default.

### Doctor

`sweep doctor` is read-only. It reports free space, APFS local snapshots, and
the heaviest `~/Library` folders, which is usually where the opaque "System
Data" hides.

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
