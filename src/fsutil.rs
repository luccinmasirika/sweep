use std::cmp::Reverse;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use anyhow::{bail, Context, Result};
use jwalk::WalkDirGeneric;
use serde::Serialize;

/// How much of a path could be measured. macOS answers a Full Disk Access
/// denial exactly like an empty folder unless the error is kept, so a size of
/// zero on its own proves nothing.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Usage {
    pub bytes: u64,
    /// Some of the tree refused to be listed, so `bytes` is a floor.
    pub unreadable: bool,
}

/// On-disk size of a single path: the whole subtree for a directory, the file's
/// own blocks otherwise. Symlinks are measured as the link, never followed.
pub fn path_size(path: &Path) -> u64 {
    path_usage(path).bytes
}

pub fn path_usage(path: &Path) -> Usage {
    match fs::symlink_metadata(path) {
        Ok(m) if m.is_dir() => dir_usage(path),
        Ok(m) => Usage {
            bytes: m.blocks() * 512,
            unreadable: false,
        },
        Err(e) => Usage {
            bytes: 0,
            unreadable: e.kind() == io::ErrorKind::PermissionDenied,
        },
    }
}

pub fn dir_size(path: &Path) -> u64 {
    dir_usage(path).bytes
}

/// Bytes actually occupied on disk by every regular file under `path`, walked
/// in parallel and not following symlinks. Counts real allocated blocks, so
/// sparse files aren't over-reported, and counts shared blocks once: a file
/// hardlinked twice, or copied as an APFS clone, weighs what it costs on disk
/// rather than once per name.
///
/// The walk stays on the volume it starts on. Another disk mounted inside the
/// tree is not part of this folder's weight, and a network share mounted in a
/// home folder would otherwise stall the whole scan.
pub fn dir_usage(path: &Path) -> Usage {
    let root_dev = fs::symlink_metadata(path).map(|m| m.dev()).ok();
    let walk = WalkDirGeneric::<((), Option<FileBlocks>)>::new(path)
        .follow_links(false)
        // jwalk skips dotfiles unless told otherwise, which silently leaves out
        // `.git`, `.next`, a pnpm `node_modules/.pnpm` — often most of the bytes.
        .skip_hidden(false)
        .process_read_dir(move |_depth, _path, _state, children| {
            for child in children.iter_mut().flatten() {
                let file_type = child.file_type();
                if file_type.is_file() {
                    child.client_state = file_blocks(&child.path());
                } else if file_type.is_dir()
                    && root_dev.is_some_and(|dev| {
                        fs::symlink_metadata(child.path()).is_ok_and(|m| m.dev() != dev)
                    })
                {
                    child.read_children_path = None;
                }
            }
        });

    let mut inodes = HashSet::new();
    // Blocks a clone family shares, counted once per family. APFS gives an
    // edited clone a new id, so its shared blocks can no longer be matched to
    // the source and are counted again — never less than the truth, at worst
    // what `du` would say.
    let mut shared: HashMap<(u64, u64), u64> = HashMap::new();
    let mut usage = Usage::default();
    for entry in walk {
        let entry = match entry {
            Ok(entry) => entry,
            Err(e) => {
                usage.unreadable |= is_denied(&e);
                continue;
            }
        };
        // jwalk hands back a directory it couldn't list as a normal entry,
        // with the refusal tucked inside it.
        if let Some(e) = &entry.read_children_error {
            usage.unreadable |= is_denied(e);
        }
        let Some(file) = entry.client_state else {
            continue;
        };
        if !inodes.insert((file.dev, file.ino)) {
            continue;
        }
        match file.clone {
            Some((id, bytes)) => {
                usage.bytes += file.bytes - bytes;
                let family = shared.entry((file.dev, id)).or_default();
                *family = (*family).max(bytes);
            }
            None => usage.bytes += file.bytes,
        }
    }
    usage.bytes += shared.values().sum::<u64>();
    usage
}

/// What a single file occupies, and how much of that it may share.
#[derive(Debug, Default, Clone, Copy)]
struct FileBlocks {
    dev: u64,
    ino: u64,
    /// Allocated on disk, shared blocks included.
    bytes: u64,
    /// For an APFS clone: its clone id — the same for every untouched copy —
    /// and the blocks it shares with other files.
    clone: Option<(u64, u64)>,
}

/// `getattrlist` instead of `lstat`: the same device, inode and allocated size,
/// plus whether APFS says the file may share blocks. Only for the few that do
/// is the private size asked for — working it out means walking the file's
/// extents, and doing that for every file made a scan half again as slow.
#[cfg(target_os = "macos")]
fn file_blocks(path: &Path) -> Option<FileBlocks> {
    use std::os::unix::ffi::OsStrExt;

    /// `sys/stat.h`: the file may share blocks with another file.
    const EF_MAY_SHARE_BLOCKS: u64 = 0x1;

    let c_path = std::ffi::CString::new(path.as_os_str().as_bytes()).ok()?;
    let mut buf = [0u8; 128];
    let Some(mut r) = get_attrs(
        &c_path,
        libc::ATTR_CMN_DEVID | libc::ATTR_CMN_FILEID,
        libc::ATTR_FILE_ALLOCSIZE,
        libc::ATTR_CMNEXT_CLONEID | libc::ATTR_CMNEXT_EXT_FLAGS,
        &mut buf,
    ) else {
        return lstat_blocks(path);
    };
    // Packed in request order — common, file, then extended common — so the
    // fields read back in the order of their bits within each group.
    let dev = r.u32()? as u64;
    let ino = r.u64()?;
    let bytes = r.u64()?;
    let clone_id = r.u64()?;
    let flags = r.u64()?;

    let mut clone = None;
    if flags & EF_MAY_SHARE_BLOCKS != 0 {
        let mut buf = [0u8; 64];
        let private = get_attrs(&c_path, 0, 0, libc::ATTR_CMNEXT_PRIVATESIZE, &mut buf)
            .and_then(|mut r| r.u64());
        if let Some(private) = private.filter(|p| *p < bytes) {
            clone = Some((clone_id, bytes - private));
        }
    }
    Some(FileBlocks {
        dev,
        ino,
        bytes,
        clone,
    })
}

/// One `getattrlist` call, with a reader positioned on the first requested
/// attribute. `None` when the call fails.
#[cfg(target_os = "macos")]
fn get_attrs<'a>(
    path: &std::ffi::CStr,
    common: libc::attrgroup_t,
    file: libc::attrgroup_t,
    extended: libc::attrgroup_t,
    buf: &'a mut [u8],
) -> Option<AttrReader<'a>> {
    let mut request = libc::attrlist {
        bitmapcount: libc::ATTR_BIT_MAP_COUNT,
        reserved: 0,
        commonattr: libc::ATTR_CMN_RETURNED_ATTRS | common,
        volattr: 0,
        dirattr: 0,
        fileattr: file,
        forkattr: extended,
    };
    // SAFETY: `request` and `buf` outlive the call, and the size passed is the
    // buffer's real length, so the kernel never writes past it.
    let rc = unsafe {
        libc::getattrlist(
            path.as_ptr(),
            (&mut request as *mut libc::attrlist).cast(),
            buf.as_mut_ptr().cast(),
            buf.len(),
            libc::FSOPT_NOFOLLOW | libc::FSOPT_PACK_INVAL_ATTRS | libc::FSOPT_ATTR_CMN_EXTENDED,
        )
    };
    if rc != 0 {
        return None;
    }
    // The buffer opens with its length and the set of attributes returned.
    Some(AttrReader {
        buf,
        at: 4 + std::mem::size_of::<libc::attribute_set_t>(),
    })
}

#[cfg(not(target_os = "macos"))]
fn file_blocks(path: &Path) -> Option<FileBlocks> {
    lstat_blocks(path)
}

fn lstat_blocks(path: &Path) -> Option<FileBlocks> {
    let m = fs::symlink_metadata(path).ok()?;
    Some(FileBlocks {
        dev: m.dev(),
        ino: m.ino(),
        bytes: m.blocks() * 512,
        clone: None,
    })
}

#[cfg(target_os = "macos")]
struct AttrReader<'a> {
    buf: &'a [u8],
    at: usize,
}

#[cfg(target_os = "macos")]
impl AttrReader<'_> {
    fn take<const N: usize>(&mut self) -> Option<[u8; N]> {
        let bytes = self.buf.get(self.at..self.at + N)?.try_into().ok()?;
        self.at = (self.at + N).next_multiple_of(4);
        Some(bytes)
    }

    fn u32(&mut self) -> Option<u32> {
        self.take().map(u32::from_ne_bytes)
    }

    fn u64(&mut self) -> Option<u64> {
        self.take().map(u64::from_ne_bytes)
    }
}

fn is_denied(e: &jwalk::Error) -> bool {
    e.io_error()
        .is_some_and(|io| io.kind() == io::ErrorKind::PermissionDenied)
}

/// Install prefixes of language toolchains found on `PATH` (e.g. the Node
/// version nvm has active). Computed once and cached.
fn protected_roots() -> &'static [PathBuf] {
    static ROOTS: OnceLock<Vec<PathBuf>> = OnceLock::new();
    ROOTS.get_or_init(|| {
        let tools = [
            "node", "npm", "npx", "corepack", "cargo", "rustc", "go", "python3", "ruby", "bun",
            "deno", "pnpm", "yarn",
        ];
        let mut roots = Vec::new();
        for tool in tools {
            // <prefix>/bin/<tool> → canonicalise <prefix>, not the binary, so a
            // symlinked `npm` doesn't resolve us into lib/node_modules.
            if let Some(prefix) = crate::exec::which(tool)
                .and_then(|p| p.parent()?.parent().map(Path::to_path_buf))
                .and_then(|p| p.canonicalize().ok())
            {
                if !roots.contains(&prefix) {
                    roots.push(prefix);
                }
            }
        }
        roots
    })
}

/// True when removing `path` would damage a live toolchain: it is the install
/// prefix or an ancestor of one, or it falls inside a prefix's `bin`/`lib`
/// (the binaries and the global `node_modules`). Regenerable caches deeper in a
/// prefix, like `~/.cargo/registry/cache`, stay removable.
fn is_protected(path: &Path, roots: &[PathBuf]) -> bool {
    let target = path.canonicalize();
    let path = target.as_deref().unwrap_or(path);
    roots.iter().any(|r| {
        r.starts_with(path) || path.starts_with(r.join("bin")) || path.starts_with(r.join("lib"))
    })
}

/// Remove a path. By default it moves to the Trash so a mistake is recoverable
/// with Finder's "Put Back"; `purge` deletes it outright to reclaim space now.
pub fn remove_path(path: &Path, purge: bool) -> Result<()> {
    let Ok(meta) = fs::symlink_metadata(path) else {
        return Ok(());
    };
    if is_protected(path, protected_roots()) {
        bail!(
            "refusing to remove protected toolchain path {}",
            path.display()
        );
    }
    if purge {
        hard_remove(path, &meta)
    } else {
        trash::delete(path).with_context(|| format!("moving {} to Trash", path.display()))
    }
}

/// Unlink a path for real. A symlink is removed as the link itself, never
/// followed into its target.
fn hard_remove(path: &Path, meta: &fs::Metadata) -> Result<()> {
    if meta.is_dir() {
        fs::remove_dir_all(path).with_context(|| format!("removing {}", path.display()))
    } else {
        fs::remove_file(path).with_context(|| format!("removing {}", path.display()))
    }
}

/// Empty a directory, keeping the directory itself. Caches are pure regenerable
/// junk, so entries are hard-deleted rather than sent to the Trash. Best-effort:
/// locked or in-use entries like the `com.apple.Music` cache are skipped, and
/// protected toolchain paths are left untouched, instead of aborting.
pub fn empty_dir(path: &Path) -> Result<()> {
    if !path.is_dir() {
        return Ok(());
    }
    let roots = protected_roots();
    for entry in fs::read_dir(path)? {
        let Ok(entry) = entry else { continue };
        let p = entry.path();
        if is_protected(&p, roots) {
            continue;
        }
        if let Ok(meta) = fs::symlink_metadata(&p) {
            let _ = hard_remove(&p, &meta);
        }
    }
    Ok(())
}

/// An iCloud file evicted from local storage: it reports its full size but
/// holds almost nothing on disk, and deleting the placeholder would remove the
/// real file from the cloud. Read from `lstat` flags so checking it never
/// triggers a download.
#[cfg(target_os = "macos")]
pub fn is_dataless(meta: &fs::Metadata) -> bool {
    use std::os::macos::fs::MetadataExt;
    const SF_DATALESS: u32 = 0x4000_0000;
    meta.st_flags() & SF_DATALESS != 0
}

#[cfg(not(target_os = "macos"))]
pub fn is_dataless(_: &fs::Metadata) -> bool {
    false
}

/// Every Trash this user can empty: the home Trash plus the per-user trash on
/// each mounted volume (`/Volumes/<v>/.Trashes/<uid>`).
pub fn all_trashes() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(home) = dirs::home_dir() {
        out.push(home.join(".Trash"));
    }
    if let Ok(uid) = crate::exec::capture(&["id".into(), "-u".into()]) {
        let uid = uid.trim().to_string();
        if !uid.is_empty() {
            if let Ok(vols) = fs::read_dir("/Volumes") {
                for vol in vols.flatten() {
                    out.push(vol.path().join(".Trashes").join(&uid));
                }
            }
        }
    }
    out.retain(|p| p.is_dir());
    out
}

/// Available bytes on the root volume, parsed from `df -k /`.
pub fn free_space_root() -> Option<u64> {
    df(Path::new("/")).map(|d| d.avail)
}

/// What `df -k` reports for one mount point.
pub struct Df {
    pub used: u64,
    pub avail: u64,
}

fn df(mount: &Path) -> Option<Df> {
    let out =
        crate::exec::capture(&["df".into(), "-k".into(), mount.display().to_string()]).ok()?;
    let mut cols = out.lines().nth(1)?.split_whitespace().skip(2);
    let used: u64 = cols.next()?.parse().ok()?;
    let avail: u64 = cols.next()?.parse().ok()?;
    Some(Df {
        used: used * 1024,
        avail: avail * 1024,
    })
}

#[derive(Debug, Serialize)]
pub struct DirUsage {
    pub path: String,
    pub size: u64,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub unreadable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<&'static str>,
}

/// Where the Data volume's bytes are, folder by folder from its root, set
/// against what the filesystem says is in use. Whatever the folders don't add
/// up to is kept as a remainder instead of quietly disappearing.
#[derive(Debug, Serialize)]
pub struct DataVolume {
    pub used: u64,
    pub folders: Vec<DirUsage>,
    /// macOS-owned consumers inside those folders, named and explained.
    pub system: Vec<DirUsage>,
    /// APFS metadata, snapshot overhead, and anything in folders that refused
    /// to be listed.
    pub unattributed: u64,
}

/// The writable half of the startup disk. `/Applications`, `/Users` and the
/// rest are firmlinked here from `/`, so this is the one place to measure them.
const DATA_ROOT: &str = "/System/Volumes/Data";

const SYSTEM_SPACE: &[(&str, &str)] = &[
    (
        "System/Library/AssetsV2",
        "Apple-managed downloads: Siri, dictation, Apple Intelligence models",
    ),
    (
        "private/var/folders",
        "per-app temp files and caches, mostly cleared on restart",
    ),
    ("private/var/db", "system databases and unified logs"),
    (
        "private/var/vm",
        "sleep image and swap, recreated as needed",
    ),
    (".Spotlight-V100", "Spotlight index"),
    ("Library/Caches", "caches shared by every user"),
    (
        "Library/Developer",
        "command line tools and simulator runtimes",
    ),
    ("Library/Updates", "downloaded macOS updates"),
    (
        "opt/homebrew",
        "Homebrew packages — `brew cleanup` drops old versions",
    ),
    ("usr/local", "Intel Homebrew and hand-installed tools"),
];

/// One APFS volume inside the container: its role (`Data`, `Preboot`, `VM`…)
/// and the bytes it actually consumes out of the shared pool.
#[derive(Debug, Serialize)]
pub struct VolumeUsage {
    pub role: String,
    pub name: String,
    pub consumed: u64,
}

/// The APFS container holding `/`. Every volume shares one free-space pool, so
/// this — not `df` on a single mount — is the only honest picture of the disk.
#[derive(Debug, Serialize)]
pub struct Container {
    pub capacity: u64,
    pub used: u64,
    pub free: u64,
    pub volumes: Vec<VolumeUsage>,
    /// The System volume's seal. `Broken` means a macOS update was staged and
    /// never finalised, which strands gigabytes in Preboot and snapshots.
    pub seal_broken: bool,
}

impl Container {
    fn volume(&self, role: &str) -> Option<&VolumeUsage> {
        self.volumes.iter().find(|v| v.role == role)
    }
}

/// A macOS update that was downloaded and staged but never completed. It holds
/// space in three places at once and none of it shows up as a file you can see.
#[derive(Debug, Serialize)]
pub struct StalledUpdate {
    pub seal_broken: bool,
    /// `com.apple.os.update-*` snapshots, which are not Time Machine backups.
    /// They pin blocks the filesystem cannot report a size for.
    pub update_snapshots: Vec<String>,
    /// What Preboot carries beyond a healthy baseline.
    pub preboot_bytes: u64,
    /// The downloaded installer still sitting in `/Library/Updates`.
    pub updates_bytes: u64,
}

impl StalledUpdate {
    /// Only what can be measured without double counting. The snapshots hold
    /// more on top, and nothing can size those.
    pub fn total(&self) -> u64 {
        self.preboot_bytes + self.updates_bytes
    }
}

#[derive(Debug, Serialize)]
pub struct Diagnosis {
    pub free_space: Option<u64>,
    pub local_snapshots: Vec<String>,
    pub library_dirs: Vec<DirUsage>,
    pub container: Option<Container>,
    /// Free space as the Finder counts it: what's free now plus what macOS
    /// will purge on demand.
    pub finder_free: Option<u64>,
    /// Caches and snapshots macOS deletes by itself when space runs low. It
    /// looks used to `df` and free to the Finder, which is why they disagree.
    pub purgeable: Option<u64>,
    pub stalled_update: Option<StalledUpdate>,
    pub data_volume: Option<DataVolume>,
}

/// The token `tmutil deletelocalsnapshots` accepts for a snapshot: the
/// `YYYY-MM-DD-HHMMSS` stamp for a Time Machine snapshot
/// (`com.apple.TimeMachine.2024-06-19-120000.local`), and the whole name for
/// everything else — update snapshots like `com.apple.os.update-<hash>` carry
/// no date, and passing them by name is the only way to delete them.
pub fn snapshot_id(line: &str) -> Option<String> {
    let line = line.trim();
    if !line.starts_with("com.apple") {
        return None;
    }
    let date = line.split('.').find(|tok| {
        tok.starts_with("20")
            && tok.len() == 17
            && tok.chars().all(|c| c.is_ascii_digit() || c == '-')
    });
    Some(date.unwrap_or(line).to_string())
}

/// True for the snapshots macOS leaves behind when an update is staged. They
/// look like Time Machine snapshots to `tmutil` but have nothing to do with
/// backups, and deleting them is how the staged update is abandoned.
pub fn is_update_snapshot(line: &str) -> bool {
    line.contains("com.apple.os.update") || line.contains("MSUPrepareUpdate")
}

fn local_snapshots() -> Vec<String> {
    crate::exec::capture(&["tmutil".into(), "listlocalsnapshots".into(), "/".into()])
        .map(|out| {
            out.lines()
                .map(str::trim)
                .filter(|l| l.starts_with("com.apple"))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// Parse `diskutil apfs list`, keeping the container that holds the Data volume
/// mounted at `/System/Volumes/Data` — a Mac can have several containers
/// (external disks, VM images) and only one of them is the startup disk.
fn parse_container(out: &str) -> Option<Container> {
    for block in out.split("+-- Container ").skip(1) {
        if !block.contains("/System/Volumes/Data") {
            continue;
        }
        let mut c = Container {
            capacity: field_bytes(block, "Size (Capacity Ceiling):")?,
            used: field_bytes(block, "Capacity In Use By Volumes:")?,
            free: field_bytes(block, "Capacity Not Allocated:").unwrap_or(0),
            volumes: Vec::new(),
            seal_broken: false,
        };
        for vol in block.split("+-> Volume ").skip(1) {
            let Some(consumed) = field_bytes(vol, "Capacity Consumed:") else {
                continue;
            };
            let role = field(vol, "APFS Volume Disk (Role):")
                .and_then(|v| {
                    v.split_once('(')
                        .map(|(_, r)| r.trim_end_matches(')').to_string())
                })
                .unwrap_or_default();
            let name = field(vol, "Name:")
                .map(|n| n.split(" (").next().unwrap_or(&n).to_string())
                .unwrap_or_default();
            if role == "System" && field(vol, "Sealed:").as_deref() == Some("Broken") {
                c.seal_broken = true;
            }
            c.volumes.push(VolumeUsage {
                role,
                name,
                consumed,
            });
        }
        c.volumes.sort_by_key(|a| Reverse(a.consumed));
        return Some(c);
    }
    None
}

/// Value of a `Label:   value` line in a `diskutil` block.
fn field(block: &str, label: &str) -> Option<String> {
    block
        .lines()
        .find_map(|l| l.trim_start_matches(['|', ' ']).strip_prefix(label))
        .map(|v| v.trim().to_string())
}

/// `diskutil` prints sizes as `179942858752 B (179.9 GB)`; take the exact byte
/// count, not the rounded human figure.
fn field_bytes(block: &str, label: &str) -> Option<u64> {
    field(block, label)?.split_whitespace().next()?.parse().ok()
}

fn apfs_container() -> Option<Container> {
    let out = crate::exec::capture(&["diskutil".into(), "apfs".into(), "list".into()]).ok()?;
    parse_container(&out)
}

/// Look for a macOS update that was staged and left unfinished. Any one of the
/// three signals alone is normal noise; together they are the reason tens of
/// gigabytes are missing with no large file in sight.
fn stalled_update(container: Option<&Container>) -> Option<StalledUpdate> {
    let snapshots: Vec<String> = local_snapshots()
        .into_iter()
        .filter(|s| is_update_snapshot(s))
        .collect();
    let seal_broken = container.is_some_and(|c| c.seal_broken);
    let preboot = container
        .and_then(|c| c.volume("Preboot"))
        .map(|v| v.consumed)
        .unwrap_or(0);
    // A healthy Preboot is a couple of GB; past that it is holding a staged
    // system. Only the excess is attributed, and the installer sitting inside
    // Preboot is deliberately not measured on its own — it is already in there.
    const PREBOOT_NORMAL: u64 = 4_000_000_000;
    if !seal_broken && snapshots.is_empty() && preboot <= PREBOOT_NORMAL {
        return None;
    }
    Some(StalledUpdate {
        seal_broken,
        update_snapshots: snapshots,
        preboot_bytes: preboot.saturating_sub(PREBOOT_NORMAL),
        updates_bytes: dir_size(Path::new("/Library/Updates")),
    })
}

/// The two free-space figures macOS keeps for the startup volume.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Capacity {
    /// Free right now.
    available: u64,
    /// Free once macOS purges what it's allowed to — the number the Finder
    /// and System Settings show.
    important: u64,
}

/// Only Foundation exposes the purgeable-inclusive figure, so it is read
/// through `osascript`'s Objective-C bridge rather than linking the framework.
fn finder_capacity() -> Option<Capacity> {
    const SCRIPT: &str = r#"ObjC.import("Foundation");
var keys = ["NSURLVolumeAvailableCapacityKey", "NSURLVolumeAvailableCapacityForImportantUsageKey"];
var values = $.NSURL.fileURLWithPath("/").resourceValuesForKeysError(keys, null);
keys.map(function (k) { return ObjC.unwrap(values.objectForKey(k)); }).join(" ")"#;
    let out = crate::exec::capture(&[
        "osascript".into(),
        "-l".into(),
        "JavaScript".into(),
        "-e".into(),
        SCRIPT.into(),
    ])
    .ok()?;
    parse_capacity(&out)
}

fn parse_capacity(out: &str) -> Option<Capacity> {
    let mut numbers = out.split_whitespace().map(str::parse::<u64>);
    Some(Capacity {
        available: numbers.next()?.ok()?,
        important: numbers.next()?.ok()?,
    })
}

/// Every entry at the root of the Data volume, sized. Nothing is picked by
/// name, so a folder nobody thought to look for still shows up.
fn folder_breakdown(root: &Path) -> Vec<DirUsage> {
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };
    let mut folders: Vec<DirUsage> = entries
        .flatten()
        .map(|entry| {
            let usage = path_usage(&entry.path());
            let name = entry.file_name().to_string_lossy().into_owned();
            let note = (name == "Users").then_some("home folders — `sweep scan` breaks these down");
            DirUsage {
                path: format!("/{name}"),
                size: usage.bytes,
                unreadable: usage.unreadable,
                note,
            }
        })
        .filter(|f| f.size > 0 || f.unreadable)
        .collect();
    folders.sort_by_key(|a| Reverse(a.size));
    folders
}

fn named_system_space(root: &Path) -> Vec<DirUsage> {
    let mut named: Vec<DirUsage> = SYSTEM_SPACE
        .iter()
        .filter_map(|(rel, note)| {
            let path = root.join(rel);
            if !path.is_dir() {
                return None;
            }
            let usage = dir_usage(&path);
            (usage.bytes > 0 || usage.unreadable).then(|| DirUsage {
                path: format!("/{rel}"),
                size: usage.bytes,
                unreadable: usage.unreadable,
                note: Some(note),
            })
        })
        .collect();
    named.sort_by_key(|a| Reverse(a.size));
    named
}

fn data_volume() -> Option<DataVolume> {
    let root = Path::new(DATA_ROOT);
    let used = df(root)?.used;
    let folders = folder_breakdown(root);
    let attributed: u64 = folders.iter().map(|f| f.size).sum();
    Some(DataVolume {
        used,
        unattributed: used.saturating_sub(attributed),
        system: named_system_space(root),
        folders,
    })
}

/// Read-only snapshot of where space is going: the APFS container volume by
/// volume, purgeable space, a stalled macOS update, local snapshots, and the
/// heaviest sub-directories of `~/Library`.
pub fn diagnose() -> Diagnosis {
    let container = apfs_container();

    let capacity = finder_capacity();

    let mut library_dirs = Vec::new();
    if let Some(lib) = dirs::home_dir().map(|h| h.join("Library")) {
        for sub in [
            "Caches",
            "Containers",
            "Application Support",
            "Group Containers",
            "Developer",
            "Logs",
        ] {
            let dir = lib.join(sub);
            if dir.is_dir() {
                let usage = dir_usage(&dir);
                if usage.bytes > 0 || usage.unreadable {
                    library_dirs.push(DirUsage {
                        path: format!("~/Library/{sub}"),
                        size: usage.bytes,
                        unreadable: usage.unreadable,
                        note: None,
                    });
                }
            }
        }
        library_dirs.sort_by_key(|a| Reverse(a.size));
    }

    Diagnosis {
        data_volume: data_volume(),
        free_space: free_space_root(),
        local_snapshots: local_snapshots(),
        library_dirs,
        stalled_update: stalled_update(container.as_ref()),
        finder_free: capacity.map(|c| c.important),
        purgeable: capacity.map(|c| c.important.saturating_sub(c.available)),
        container,
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn size_then_empty() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("a.bin"), vec![0u8; 200_000]).unwrap();
        fs::create_dir(dir.path().join("sub")).unwrap();
        fs::write(dir.path().join("sub/b.bin"), vec![0u8; 200_000]).unwrap();

        // On-disk size: at least the bytes written, rounded up to whole blocks.
        assert!(dir_size(dir.path()) >= 400_000);

        empty_dir(dir.path()).unwrap();
        assert_eq!(dir_size(dir.path()), 0);
        assert!(dir.path().is_dir());
    }

    /// A directory nobody can list, restored on drop so the tempdir can go.
    /// `None` when running as root, where permissions don't bite.
    pub(crate) struct Locked(PathBuf);

    impl Locked {
        pub(crate) fn new(path: &Path) -> Option<Self> {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, fs::Permissions::from_mode(0o000)).unwrap();
            let locked = Self(path.to_path_buf());
            fs::read_dir(path).is_err().then_some(locked)
        }
    }

    impl Drop for Locked {
        fn drop(&mut self) {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&self.0, fs::Permissions::from_mode(0o755));
        }
    }

    #[test]
    fn a_refused_folder_is_flagged_not_read_as_empty() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("seen.bin"), vec![0u8; 200_000]).unwrap();
        let hidden = dir.path().join("Mail");
        fs::create_dir(&hidden).unwrap();
        fs::write(hidden.join("inbox.mbox"), vec![0u8; 200_000]).unwrap();
        let Some(_lock) = Locked::new(&hidden) else {
            return;
        };

        let usage = dir_usage(dir.path());
        // The readable part still counts; the total is just known to be short.
        assert!(usage.bytes >= 200_000 && usage.bytes < 400_000);
        assert!(usage.unreadable);

        // Pointed straight at the refused folder: zero bytes, but not "empty".
        assert_eq!(
            dir_usage(&hidden),
            Usage {
                bytes: 0,
                unreadable: true
            }
        );
        assert!(!dir_usage(&dir.path().join("seen.bin")).unreadable);
    }

    #[test]
    fn hidden_files_are_counted() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join(".next")).unwrap();
        fs::write(dir.path().join(".next/chunk.js"), vec![0u8; 200_000]).unwrap();
        fs::write(dir.path().join(".DS_Store"), vec![0u8; 200_000]).unwrap();

        assert!(dir_size(dir.path()) >= 400_000);
    }

    #[test]
    fn breakdown_lists_every_root_entry_it_can_weigh() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("Users/me")).unwrap();
        fs::write(root.path().join("Users/me/big.bin"), vec![0u8; 300_000]).unwrap();
        fs::create_dir(root.path().join("opt")).unwrap();
        fs::write(root.path().join("opt/tool"), vec![0u8; 100_000]).unwrap();
        fs::create_dir(root.path().join("mnt")).unwrap();

        let folders = folder_breakdown(root.path());

        // Heaviest first, nothing picked by name, empty folders left out.
        let paths: Vec<&str> = folders.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, ["/Users", "/opt"]);
        assert!(folders[0].note.is_some());
    }

    #[test]
    fn reads_the_same_file_facts_as_lstat() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.bin");
        fs::write(&file, vec![1u8; 300_000]).unwrap();
        let m = fs::symlink_metadata(&file).unwrap();

        let f = file_blocks(&file).unwrap();
        assert_eq!(
            (f.dev, f.ino, f.bytes),
            (m.dev(), m.ino(), m.blocks() * 512)
        );
        assert!(f.clone.is_none());
    }

    #[cfg(target_os = "macos")]
    fn clone_file(from: &Path, to: &Path) -> bool {
        use std::os::unix::ffi::OsStrExt;
        let from = std::ffi::CString::new(from.as_os_str().as_bytes()).unwrap();
        let to = std::ffi::CString::new(to.as_os_str().as_bytes()).unwrap();
        // SAFETY: both paths are valid NUL-terminated strings for the call.
        unsafe { libc::clonefile(from.as_ptr(), to.as_ptr(), 0) == 0 }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn an_apfs_clone_is_counted_once() {
        let dir = tempfile::tempdir().unwrap();
        let original = dir.path().join("original.bin");
        fs::write(&original, vec![7u8; 1_000_000]).unwrap();
        let single = dir_size(dir.path());
        // Only APFS can clone; elsewhere there is nothing to test.
        if !clone_file(&original, &dir.path().join("copy.bin")) {
            return;
        }

        assert_eq!(dir_size(dir.path()), single);

        // Rewrite part of the copy. APFS splits it from the family and the
        // shared part can't be matched any more: the total may rise to what
        // `du` says, but never past it and never below the bytes really used.
        use std::io::{Seek, SeekFrom, Write};
        let mut copy = fs::OpenOptions::new()
            .write(true)
            .open(dir.path().join("copy.bin"))
            .unwrap();
        copy.seek(SeekFrom::Start(0)).unwrap();
        copy.write_all(&vec![9u8; 200_000]).unwrap();
        copy.sync_all().unwrap();
        drop(copy);

        let edited = dir_size(dir.path());
        assert!(
            edited > single && edited <= single * 2,
            "{single} → {edited}"
        );
    }

    #[test]
    fn parses_both_free_space_figures() {
        assert_eq!(
            parse_capacity("16171790336 17254903872\n"),
            Some(Capacity {
                available: 16_171_790_336,
                important: 17_254_903_872,
            })
        );
        // A key Foundation didn't return comes back as "undefined".
        assert_eq!(parse_capacity("16171790336 undefined"), None);
        assert_eq!(parse_capacity(""), None);
    }

    #[test]
    fn hardlinks_counted_once() {
        let dir = tempfile::tempdir().unwrap();
        let original = dir.path().join("original.bin");
        fs::write(&original, vec![0u8; 200_000]).unwrap();
        let single = dir_size(dir.path());

        // A second hardlink to the same inode must not double the total.
        fs::hard_link(&original, dir.path().join("clone.bin")).unwrap();
        assert_eq!(dir_size(dir.path()), single);
    }

    #[test]
    fn snapshot_id_falls_back_to_the_whole_name() {
        assert_eq!(
            snapshot_id("com.apple.TimeMachine.2024-06-19-120000.local").as_deref(),
            Some("2024-06-19-120000")
        );
        // Update snapshots carry no date, so the name itself is the handle.
        let update = "com.apple.os.update-MSUPrepareUpdate";
        assert_eq!(snapshot_id(update).as_deref(), Some(update));
        assert!(is_update_snapshot(update));
        assert!(!is_update_snapshot(
            "com.apple.TimeMachine.2024-06-19-120000.local"
        ));
        assert_eq!(snapshot_id("garbage line").as_deref(), None);
    }

    const APFS_LIST: &str = "APFS Containers (2 found)
|
+-- Container disk1 AAAA
    Size (Capacity Ceiling):      100000000000 B (100.0 GB)
    Capacity In Use By Volumes:   1000000000 B (1.0 GB)
    Capacity Not Allocated:       99000000000 B (99.0 GB)
    |
    +-> Volume disk1s1 BBBB
        APFS Volume Disk (Role):   disk1s1 (Data)
        Name:                      Elsewhere (Case-insensitive)
        Mount Point:               /Volumes/Elsewhere
        Capacity Consumed:         1000000000 B (1.0 GB)
|
+-- Container disk3 CCCC
    Size (Capacity Ceiling):      245107195904 B (245.1 GB)
    Capacity In Use By Volumes:   227290148864 B (227.3 GB) (92.7% used)
    Capacity Not Allocated:       17817047040 B (17.8 GB) (7.3% free)
    |
    +-> Volume disk3s1 DDDD
    |   APFS Volume Disk (Role):   disk3s1 (System)
    |   Name:                      Macintosh HD (Case-insensitive)
    |   Capacity Consumed:         17086660608 B (17.1 GB)
    |   Sealed:                    Broken
    |
    +-> Volume disk3s2 EEEE
    |   APFS Volume Disk (Role):   disk3s2 (Preboot)
    |   Name:                      Preboot (Case-insensitive)
    |   Capacity Consumed:         18041266176 B (18.0 GB)
    |   Sealed:                    No
    |
    +-> Volume disk3s5 FFFF
        APFS Volume Disk (Role):   disk3s5 (Data)
        Name:                      Data (Case-insensitive)
        Mount Point:               /System/Volumes/Data
        Capacity Consumed:         179942858752 B (179.9 GB)
        Sealed:                    No
";

    #[test]
    fn parses_the_startup_container_only() {
        let c = parse_container(APFS_LIST).expect("container");
        assert_eq!(c.capacity, 245_107_195_904);
        assert_eq!(c.used, 227_290_148_864);
        assert_eq!(c.free, 17_817_047_040);
        // The external container must not win just by coming first.
        assert_eq!(c.volume("Data").unwrap().consumed, 179_942_858_752);
        assert_eq!(c.volume("Preboot").unwrap().consumed, 18_041_266_176);
        // Volumes are sorted heaviest first, and the broken seal is picked up.
        assert_eq!(c.volumes[0].role, "Data");
        assert!(c.seal_broken);
    }

    #[test]
    fn no_container_when_data_volume_is_absent() {
        assert!(parse_container("APFS Containers (0 found)\n").is_none());
    }

    #[test]
    fn protects_toolchain_and_descendants() {
        let roots = vec![PathBuf::from("/Users/x/.nvm/versions/node/v20")];

        // The exact global node_modules that caused the incident.
        assert!(is_protected(
            Path::new("/Users/x/.nvm/versions/node/v20/lib/node_modules"),
            &roots
        ));
        // An ancestor whose removal would take the toolchain with it.
        assert!(is_protected(Path::new("/Users/x/.nvm"), &roots));
        // Unrelated project deps stay removable.
        assert!(!is_protected(
            Path::new("/Users/x/code/app/node_modules"),
            &roots
        ));

        // A regenerable cache deep in a prefix is still removable.
        let cargo = vec![PathBuf::from("/Users/x/.cargo")];
        assert!(!is_protected(
            Path::new("/Users/x/.cargo/registry/cache/pkg"),
            &cargo
        ));
        assert!(is_protected(Path::new("/Users/x/.cargo/bin"), &cargo));
    }
}
