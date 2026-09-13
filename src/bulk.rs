use std::cell::RefCell;
use std::collections::HashMap;
use std::ffi::{CStr, CString, OsStr};
use std::io;
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use rayon::prelude::*;

use crate::fsutil::{AttrReader, FileBlocks, Tally, Usage};

/// `sys/vnode.h` object types.
const VREG: u32 = 1;
const VDIR: u32 = 2;
const VLNK: u32 = 5;
/// `sys/stat.h`: the file may share blocks with another file.
const EF_MAY_SHARE_BLOCKS: u64 = 0x1;
/// `sys/stat.h`: an evicted iCloud file, a placeholder with no data here.
const SF_DATALESS: u32 = 0x4000_0000;
/// `sys/attr.h`: why an entry couldn't be described. Missing from `libc`.
const ATTR_CMN_ERROR: u32 = 0x2000_0000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    File,
    Dir,
    Symlink,
    Other,
}

/// One entry of a directory, with what sizing and judging it needs.
#[derive(Debug, Clone)]
pub struct Entry {
    pub name: std::ffi::OsString,
    pub kind: Kind,
    pub dev: u64,
    pub ino: u64,
    pub links: u32,
    /// Allocated on disk, shared blocks included. Zero for a directory.
    pub bytes: u64,
    pub clone_id: u64,
    pub may_share: bool,
    pub dataless: bool,
    pub modified: SystemTime,
}

/// A directory's entries. Entries macOS refused to describe are left out and
/// counted in `denied`, so a partial listing is never taken for a full one.
pub struct Listing {
    pub dev: u64,
    pub entries: Vec<Entry>,
    pub denied: bool,
}

thread_local! {
    static BUF: RefCell<Vec<u8>> = RefCell::new(vec![0; 128 * 1024]);
}

/// List `dir` with `getattrlistbulk`: a batch of entries per call, names,
/// types, sizes and clone ids included, where `readdir` plus a `getattrlist`
/// per entry costs a call and a path lookup from the root for every file.
pub fn list(dir: &Path) -> io::Result<Listing> {
    let c_dir = CString::new(dir.as_os_str().as_bytes())
        .map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?;
    // SAFETY: a valid NUL-terminated path; the descriptor is closed below.
    let fd = unsafe {
        libc::open(
            c_dir.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    let listing = read_all(fd);
    // SAFETY: `fd` was opened above and is not used again.
    unsafe { libc::close(fd) };
    listing
}

fn read_all(fd: libc::c_int) -> io::Result<Listing> {
    // The volume the directory itself is on, which `ATTR_CMN_DEVID` of a mount
    // point inside it doesn't tell: that reports the folder it covers.
    // SAFETY: `stat` is plain data and `fd` is open.
    let mut st: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstat(fd, &mut st) } != 0 {
        return Err(io::Error::last_os_error());
    }
    let mut listing = Listing {
        dev: st.st_dev as u64,
        entries: Vec::new(),
        denied: false,
    };
    let mut request = libc::attrlist {
        bitmapcount: libc::ATTR_BIT_MAP_COUNT,
        reserved: 0,
        commonattr: libc::ATTR_CMN_RETURNED_ATTRS
            | libc::ATTR_CMN_NAME
            | libc::ATTR_CMN_DEVID
            | libc::ATTR_CMN_OBJTYPE
            | libc::ATTR_CMN_MODTIME
            | libc::ATTR_CMN_FLAGS
            | libc::ATTR_CMN_FILEID
            | ATTR_CMN_ERROR,
        volattr: 0,
        dirattr: 0,
        fileattr: libc::ATTR_FILE_LINKCOUNT | libc::ATTR_FILE_ALLOCSIZE,
        forkattr: libc::ATTR_CMNEXT_CLONEID | libc::ATTR_CMNEXT_EXT_FLAGS,
    };
    BUF.with_borrow_mut(|buf| {
        loop {
            // SAFETY: `request` and `buf` outlive the call and the length
            // passed is the buffer's, so the kernel never writes past it.
            let count = unsafe {
                libc::getattrlistbulk(
                    fd,
                    (&mut request as *mut libc::attrlist).cast(),
                    buf.as_mut_ptr().cast(),
                    buf.len(),
                    0,
                )
            };
            if count < 0 {
                let e = io::Error::last_os_error();
                if e.kind() == io::ErrorKind::PermissionDenied {
                    listing.denied = true;
                    return Ok(listing);
                }
                return Err(e);
            }
            if count == 0 {
                return Ok(listing);
            }
            let mut at = 0;
            for _ in 0..count {
                let Some(len) = buf
                    .get(at..at + 4)
                    .map(|b| u32::from_ne_bytes(b.try_into().expect("4 bytes")) as usize)
                else {
                    break;
                };
                if let Some(parsed) = buf.get(at..at + len).and_then(parse) {
                    match parsed {
                        Ok(entry) => listing.entries.push(entry),
                        Err(denied) => listing.denied |= denied,
                    }
                }
                at += len;
            }
        }
    })
}

/// One packed entry. `Err(true)` for an entry macOS refused to describe,
/// `Err(false)` for one that failed some other way.
fn parse(record: &[u8]) -> Option<Result<Entry, bool>> {
    let mut r = AttrReader::new(record, 4);
    let common = r.u32()?;
    let _volume = r.u32()?;
    let _dir = r.u32()?;
    let file = r.u32()?;
    let extended = r.u32()?;

    let has = |group: u32, bit: u32| group & bit != 0;
    let name_at = r.at();
    let name = if has(common, libc::ATTR_CMN_NAME) {
        let offset = r.u32()? as i32 as isize;
        let len = r.u32()? as usize;
        let start = (name_at as isize + offset) as usize;
        let raw = record.get(start..start + len)?;
        Some(OsStr::from_bytes(CStr::from_bytes_until_nul(raw).ok()?.to_bytes()).to_os_string())
    } else {
        None
    };
    let dev = if has(common, libc::ATTR_CMN_DEVID) {
        r.u32()? as u64
    } else {
        0
    };
    let objtype = if has(common, libc::ATTR_CMN_OBJTYPE) {
        r.u32()?
    } else {
        0
    };
    let modified = if has(common, libc::ATTR_CMN_MODTIME) {
        let secs = r.u64()? as i64;
        let nanos = r.u64()? as u32;
        SystemTime::UNIX_EPOCH + Duration::new(secs.max(0) as u64, nanos)
    } else {
        SystemTime::UNIX_EPOCH
    };
    let flags = if has(common, libc::ATTR_CMN_FLAGS) {
        r.u32()?
    } else {
        0
    };
    let ino = if has(common, libc::ATTR_CMN_FILEID) {
        r.u64()?
    } else {
        0
    };
    let error = if has(common, ATTR_CMN_ERROR) {
        r.u32()?
    } else {
        0
    };
    let links = if has(file, libc::ATTR_FILE_LINKCOUNT) {
        r.u32()?
    } else {
        1
    };
    let bytes = if has(file, libc::ATTR_FILE_ALLOCSIZE) {
        r.u64()?
    } else {
        0
    };
    let clone_id = if has(extended, libc::ATTR_CMNEXT_CLONEID) {
        r.u64()?
    } else {
        0
    };
    let ext_flags = if has(extended, libc::ATTR_CMNEXT_EXT_FLAGS) {
        r.u64()?
    } else {
        0
    };

    let name = name?;
    if error != 0 {
        let code = error as i32;
        return Some(Err(code == libc::EACCES || code == libc::EPERM));
    }
    let kind = match objtype {
        VREG => Kind::File,
        VDIR => Kind::Dir,
        VLNK => Kind::Symlink,
        _ => Kind::Other,
    };
    Some(Ok(Entry {
        name,
        kind,
        dev,
        ino,
        links,
        bytes: if kind == Kind::File { bytes } else { 0 },
        clone_id,
        may_share: ext_flags & EF_MAY_SHARE_BLOCKS != 0,
        dataless: flags & SF_DATALESS != 0,
        modified,
    }))
}

/// What a subtree adds up to. A file with one link and no shared blocks is
/// simply added; one with several links, or one that may share blocks, is
/// kept until the whole tree is walked, since its other names or its clone
/// family may sit in another branch.
#[derive(Default)]
struct Walked {
    bytes: u64,
    linked: Vec<FileBlocks>,
    may_share: Vec<(FileBlocks, u64, PathBuf)>,
    unreadable: bool,
}

impl Walked {
    fn merge(mut self, other: Walked) -> Walked {
        self.bytes += other.bytes;
        self.linked.extend(other.linked);
        self.may_share.extend(other.may_share);
        self.unreadable |= other.unreadable;
        self
    }

    fn refused(e: &io::Error) -> Walked {
        Walked {
            unreadable: e.kind() == io::ErrorKind::PermissionDenied,
            ..Walked::default()
        }
    }
}

/// On-disk size of everything under `path`, directories listed in parallel.
/// Same accounting as a file-by-file walk: regular files only, never across
/// into another volume, a file with several links once, and the blocks an
/// APFS clone family shares once.
pub fn usage(path: &Path) -> Usage {
    let walked = match list(path) {
        Ok(listing) => walk(path, listing.dev, listing),
        Err(e) => Walked::refused(&e),
    };
    let mut families: HashMap<(u64, u64), usize> = HashMap::new();
    for (file, clone_id, _) in &walked.may_share {
        *families.entry((file.dev, *clone_id)).or_default() += 1;
    }
    // Working out a private size walks the file's extents; only a file whose
    // clone family has another member here can share anything with it.
    let may_share: Vec<FileBlocks> = walked
        .may_share
        .into_par_iter()
        .map(|(file, clone_id, path)| {
            if families[&(file.dev, clone_id)] < 2 {
                return file;
            }
            match crate::fsutil::private_size(&path).filter(|p| *p < file.bytes) {
                Some(private) => file.sharing(clone_id, file.bytes - private),
                None => file,
            }
        })
        .collect();
    let mut tally = Tally::default();
    for file in walked.linked.into_iter().chain(may_share) {
        tally.add(file);
    }
    Usage {
        bytes: walked.bytes + tally.bytes(),
        unreadable: walked.unreadable,
    }
}

fn walk(dir: &Path, dev: u64, listing: Listing) -> Walked {
    let mut walked = Walked {
        unreadable: listing.denied,
        ..Walked::default()
    };
    let mut subdirs = Vec::new();
    for entry in listing.entries {
        match entry.kind {
            Kind::File => {
                let file = FileBlocks::new(entry.dev, entry.ino, entry.bytes);
                if entry.may_share {
                    walked
                        .may_share
                        .push((file, entry.clone_id, dir.join(&entry.name)));
                } else if entry.links > 1 {
                    walked.linked.push(file);
                } else {
                    walked.bytes += entry.bytes;
                }
            }
            Kind::Dir => subdirs.push(dir.join(&entry.name)),
            Kind::Symlink | Kind::Other => {}
        }
    }
    subdirs
        .into_par_iter()
        .map(|sub| match list(&sub) {
            Ok(listing) if listing.dev == dev => walk(&sub, dev, listing),
            Ok(_) => Walked::default(),
            Err(e) => Walked::refused(&e),
        })
        .reduce(Walked::default, Walked::merge)
        .merge(walked)
}
