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
# Homebrew (builds from source — no notarization needed)
brew install luccinmasirika/tap/sweep

# From crates.io
cargo install sweep

# From a clone
cargo install --path .
```

Each builds an optimized `sweep` binary (Homebrew/crates.io install it on your
`PATH`; the clone puts it in `~/.cargo/bin`). Prebuilt universal-binary tarballs
are also attached to each [GitHub release](https://github.com/luccinmasirika/sweep/releases).

## Usage

```sh
sweep scan                 # analyse only, delete nothing
sweep scan --json          # same, as machine-readable JSON
sweep clean                # free space, confirming before each target
sweep clean --yes          # skip the prompts (only safe, idle items)
sweep clean --only projects,app-caches
sweep clean --aggressive   # prune all unused Docker images, heavier dev caches
sweep clean --purge        # delete removable items outright instead of trashing
sweep smart                # scan everything, then clean what's safe — one step
sweep explore [DIR]        # browse what's big and trash it interactively
sweep dupes [DIR]          # find byte-identical duplicates and trash extras
sweep uninstall <App>      # remove an app and its whole footprint
sweep maintenance          # flush DNS, rebuild Spotlight, reset Launch Services…
sweep doctor               # diagnose where space is going
sweep doctor --fix         # also delete APFS local snapshots and empty every Trash
sweep schedule install     # run `sweep smart` on a recurring launchd schedule
sweep config               # print the effective configuration
```

Removable items (project dirs, big files) are **moved to the Trash** so a
mistake is undoable with Finder's "Put Back"; empty the Trash to reclaim the
space, or pass `--purge` to delete immediately. Pure caches are always deleted
outright. `--yes` only touches safe, idle items — never personal files or
projects that still look active.

## What it detects

| Detector        | How it finds it                                                          |
| --------------- | ------------------------------------------------------------------------ |
| `system-caches` | Known paths: `~/Library/Caches`, `~/Library/Logs`, `~/.Trash`.           |
| `app-caches`    | Cache-named dirs discovered under Application Support / Containers.       |
| `dev-tools`     | `brew`/npm/pnpm/yarn + cargo/pip caches, `docker prune` (tools present).  |
| `xcode`         | DerivedData, device support, simulators, archives, iOS backups.          |
| `projects`      | Marker-aware home walk: project artifacts (`node_modules`, `target`, `build`…). |
| `large-items`   | Biggest personal files/folders over a threshold (start unchecked).       |
| `privacy`       | Browser caches (safe) + cookies/history (start unchecked) + Mail downloads. |
| `leftovers`     | Support files of uninstalled apps (opt-in; heuristic, starts unchecked). |

Nothing is hard-coded to a particular machine: detectors resolve known paths
relative to your home and discover the rest by scanning.

The `projects` walk skips version-manager and toolchain roots (`~/.nvm`,
`~/.fnm`, `~/.volta`, `~/.asdf`, `~/.cargo`, `~/.rustup`, …) so a global
`node_modules` is never swept, and as a last line of defence `sweep` refuses to
delete any path belonging to a toolchain currently on your `PATH`. It also stays
out of app/library bundles (`.app`, `.photoslibrary`, …) and skips evicted
iCloud files so sizing one never forces a download.

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
