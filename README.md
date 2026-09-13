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
sweep clean --dry-run      # exactly what would go, and what's left in use
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
sweep log                  # what recent cleans did, scheduled ones included
sweep config               # print the effective configuration
```

Removable items (project dirs, big files) are **moved to the Trash** so a
mistake is undoable with Finder's "Put Back", or pass `--purge` to delete
immediately. Pure caches are always deleted outright. `--yes` only touches
safe, idle items — never personal files or projects that still look active.

Items go to the Trash through `NSFileManager`, not by scripting the Finder:
no Automation permission to grant, no trash sound per item, and it works from
a scheduled run where no one is there to answer a prompt. "Put Back" still
works.

Moving something to the Trash frees nothing, so at the end of an interactive
run sweep offers to empty **exactly what that run moved there** — found again
by inode, since the Finder renames items whose name is already taken. Whatever
you put in the Trash yourself is never part of it, and the Trash itself is
never emptied by `--yes`, `smart` or a scheduled run: it is listed as a
personal item and only goes if you tick it.

Nothing in use is removed. Just before the first item goes, sweep takes one
snapshot of what's busy — every file a process has open (`lsof`), every running
app, and the caches of system services like iCloud Drive and Apple Account
sign-in — and leaves those in place, listing what it skipped and why:

```
   in use   3.6 GB  (6 item(s) left alone — run again once they're closed)
     open in ShipIt:  ~/Library/Caches/com.todesktop….ShipIt
     Dia is running:  ~/Library/Caches/Dia +2 more
```

Deleting under a running app can crash it, corrupt its cache or break an update
halfway, and a file that's still open doesn't give its space back until it's
closed anyway. `uninstall` refuses outright while the app is running.

The numbers at the end are measured, not the scan's estimates. Each folder is
weighed again after it's emptied, and each cleanup command's cache again after
it ran, so a command that frees nothing reports nothing. Entries that refuse to
delete are listed with the reason instead of counted as gone. When the disk
gained less than was deleted, sweep says why — space still held by apps that
had those files open, or APFS local snapshots keeping the data:

```
   freed       2.10 MB
   not removed 3.15 MB  (1 item(s) wouldn't delete)
     Permission denied (os error 13):  ~/Library/Caches/locked-app
```

### Checking what a clean does

`clean --dry-run` (and `smart --dry-run`) runs every check a real clean would —
including what's in use right now — and prints the result without touching
anything: each item it would empty, trash, delete or run, what it would leave
in place and why, and what it leaves out because it needs a deliberate tick.
It's exactly what `clean --yes`, `smart --yes` and a scheduled run would do.

Every run that changes the disk is recorded, one line per item, in
`~/Library/Application Support/sweep/journal.log` — not under `~/Library/Logs`,
which sweep itself empties. `sweep log` shows the last runs:

```
2026-09-13 01:02  sweep smart --yes
  freed 2.10 MB · 1 left in use
  skipped     3.15 MB  ~/Library/Caches/busy-app  (open in tail)
  emptied     2.10 MB  ~/Library/Caches
```

In the per-target menu, the default action cleans the safe items only — the
same set `--yes` would take. Personal files, active projects and the Trash are
reached through "Choose items…", so a stray Enter can't delete them.

## What it detects

| Detector        | How it finds it                                                          |
| --------------- | ------------------------------------------------------------------------ |
| `system-caches` | Known paths: `~/Library/Caches`, `~/Library/Logs`, `~/.Trash`.           |
| `app-caches`    | Cache-named dirs discovered under Application Support / Containers.       |
| `dev-tools`     | `brew`/npm/pnpm/yarn + cargo/pip caches, `docker prune` (tools present).  |
| `xcode`         | DerivedData, device support, simulators, archives, iOS backups.          |
| `projects`      | Marker-aware home walk: project artifacts (`node_modules`, `target`, `build`…). |
| `large-items`   | Biggest personal files/folders over a threshold (start unchecked).       |
| `vm-images`     | Container/VM disk images (Colima, Docker, OrbStack, UTM, Parallels…).     |
| `applications`  | Installed apps over 500 MB and leftover macOS installers (start unchecked). |
| `heavy`         | Anything over 1 GB anywhere under `~`, by size alone — no name needed.    |
| `privacy`       | Browser caches (safe) + cookies/history (start unchecked) + Mail downloads. |
| `leftovers`     | Support files of uninstalled apps (opt-in; heuristic, starts unchecked). |

Nothing is hard-coded to a particular machine: detectors resolve known paths
relative to your home and discover the rest by scanning.

Detectors overlap — `~/Library/Caches` holds the Chrome cache `privacy` lists,
a heavy folder can hold an app cache — so every byte is counted once. A path
belongs to the finding that names it most precisely: the folder around it
reports its size without it, and emptying that folder leaves the path in place,
so unticking "chrome cache" keeps the Chrome cache even when `~/Library/Caches`
is cleaned. Cleanup commands overlap through the folders they actually clear:
the npm cache is weighed as `_cacache`, not the `_npx` installs next to it.

`heavy` is the one that answers "my disk is full and I can't see why". Every
other detector recognises a name it was taught; this one only follows bytes, so
a one-off `.migration-staging` folder, a tool's browser recordings, or a 4 GB
model file inside an app's support directory show up like anything else. It
reports the folder that best describes each item — climbing out of a chain of
single-child directories, but never as far as a folder that just holds many
unrelated things — and skips whatever another detector already lists, so the
same gigabytes never appear twice. Everything it finds starts unchecked.

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

`sweep doctor` is read-only. It reports the whole APFS container volume by
volume — Data, Preboot, System, VM, Recovery all share one pool, so `df` on a
single mount never shows the real picture — plus purgeable space, APFS local
snapshots and the heaviest `~/Library` folders.

It then accounts for the Data volume from its root: every top-level folder
(`/Users`, `/Applications`, `/System`, `/private`, `/opt`…) sized, and whatever
they don't add up to shown as a remainder rather than left out. The space macOS
owns outside any home folder is named and explained — `AssetsV2` (Siri,
dictation and Apple Intelligence models), `/private/var/folders`, the sleep
image, the Spotlight index, Homebrew.

Sizes never cross into another mounted volume, so an external disk or a network
share mounted inside a folder neither inflates it nor stalls the scan.

It also flags a **stalled macOS update**: an update that was staged and never
finished leaves the system volume's seal broken, tens of gigabytes parked in
Preboot, an installer in `/Library/Updates`, and `com.apple.os.update-*`
snapshots pinning blocks. None of it is a file you can find in the Finder, and
it is a common reason a Mac is full with nothing large on it. Finish the update
in System Settings, or let `sweep doctor --fix` drop the snapshots to abandon
it.

## Configuration

Defaults work out of the box. To customise, copy
[`sweep.example.toml`](sweep.example.toml) to `~/.config/sweep/config.toml`, or
point at any file with `--config`. A `sweep.toml` in the current directory is
not read on its own: one from a cloned repository could widen what gets
deleted. Paths support `~` expansion and missing fields fall back to the
built-in defaults.

## Development

```sh
cargo test --all
cargo clippy --all-targets -- -D warnings
cargo fmt --all
```

## License

MIT
