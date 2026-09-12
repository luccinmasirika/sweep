use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

/// Past this the journal is rotated to `journal.log.1`, so a weekly schedule
/// can run for years without the log becoming the thing that fills the disk.
const MAX_BYTES: u64 = 5_000_000;

/// One thing a run did to the disk, or chose not to.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Entry {
    /// Seconds since the Unix epoch.
    pub ts: u64,
    /// Ties together the entries of one invocation.
    pub run: String,
    /// The command line that started the run.
    pub command: String,
    /// `deleted`, `trashed`, `emptied`, `ran`, `skipped`, `failed`.
    pub action: String,
    pub path: String,
    pub bytes: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

struct Journal {
    file: File,
    run: String,
    command: String,
}

static JOURNAL: Mutex<Option<Journal>> = Mutex::new(None);

/// Where the journal lives. Not under `~/Library/Logs`: sweep empties that
/// folder, and would wipe the record of what it just did.
pub fn path() -> Option<PathBuf> {
    dirs::data_dir().map(|d| d.join("sweep/journal.log"))
}

/// Start recording this invocation. A journal that can't be opened never stops
/// a clean — it just means this run goes unrecorded.
pub fn start() {
    let Some(path) = path() else { return };
    let command = std::env::args()
        .map(|a| if a.contains(' ') { format!("{a:?}") } else { a })
        .collect::<Vec<_>>()
        .join(" ");
    if let Some(journal) = open(&path, command) {
        *JOURNAL.lock().unwrap_or_else(|e| e.into_inner()) = Some(journal);
    }
}

fn open(path: &Path, command: String) -> Option<Journal> {
    fs::create_dir_all(path.parent()?).ok()?;
    if fs::metadata(path).is_ok_and(|m| m.len() > MAX_BYTES) {
        let _ = fs::rename(path, path.with_extension("log.1"));
    }
    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .ok()?;
    Some(Journal {
        file,
        run: format!("{}-{}", now(), std::process::id()),
        command,
    })
}

/// Record one action. Does nothing when no journal was started, as in tests or
/// read-only commands.
pub fn record(action: &str, path: &Path, bytes: u64, detail: Option<&str>) {
    let mut guard = JOURNAL.lock().unwrap_or_else(|e| e.into_inner());
    let Some(journal) = guard.as_mut() else {
        return;
    };
    let entry = Entry {
        ts: now(),
        run: journal.run.clone(),
        command: journal.command.clone(),
        action: action.to_string(),
        path: path.display().to_string(),
        bytes,
        detail: detail.map(str::to_string),
    };
    if let Ok(line) = serde_json::to_string(&entry) {
        let _ = writeln!(journal.file, "{line}");
    }
}

/// Every recorded entry, oldest first, including the rotated file.
pub fn read() -> Vec<Entry> {
    let Some(path) = path() else {
        return Vec::new();
    };
    let mut entries = read_file(&path.with_extension("log.1"));
    entries.extend(read_file(&path));
    entries
}

fn read_file(path: &Path) -> Vec<Entry> {
    let Ok(file) = File::open(path) else {
        return Vec::new();
    };
    BufReader::new(file)
        .lines()
        .map_while(Result::ok)
        .filter_map(|line| serde_json::from_str(&line).ok())
        .collect()
}

/// The last `n` runs, newest last, each as its entries in order.
pub fn last_runs(entries: &[Entry], n: usize) -> Vec<&[Entry]> {
    let mut runs: Vec<&[Entry]> = entries.chunk_by(|a, b| a.run == b.run).collect();
    let keep = runs.len().saturating_sub(n);
    runs.drain(..keep);
    runs
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

/// `2026-09-13 01:02` in the machine's own time zone — a run scheduled for the
/// night should read as the night.
pub fn format_ts(ts: u64) -> String {
    let secs = ts as libc::time_t;
    // SAFETY: `tm` is a plain C struct that `localtime_r` fills in; both
    // pointers are valid for the call.
    let tm = unsafe {
        let mut tm: libc::tm = std::mem::zeroed();
        if libc::localtime_r(&secs, &mut tm).is_null() {
            return ts.to_string();
        }
        tm
    };
    format!(
        "{:04}-{:02}-{:02} {:02}:{:02}",
        tm.tm_year + 1900,
        tm.tm_mon + 1,
        tm.tm_mday,
        tm.tm_hour,
        tm.tm_min
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(run: &str, action: &str) -> Entry {
        Entry {
            ts: 0,
            run: run.into(),
            command: "sweep smart --yes".into(),
            action: action.into(),
            path: "/x".into(),
            bytes: 1,
            detail: None,
        }
    }

    #[test]
    fn formats_local_timestamps() {
        // The hour depends on the time zone the tests run in; the shape doesn't.
        let shown = format_ts(1_789_261_380);
        assert_eq!(shown.len(), "2026-09-13 01:03".len(), "{shown}");
        assert!(shown.starts_with("2026-09-1"), "{shown}");
        assert_eq!(&shown[13..14], ":");
    }

    #[test]
    fn groups_entries_into_runs_and_keeps_the_latest() {
        let entries = vec![
            entry("a", "trashed"),
            entry("b", "emptied"),
            entry("b", "skipped"),
            entry("c", "ran"),
        ];
        let runs = last_runs(&entries, 2);
        assert_eq!(runs.len(), 2);
        assert_eq!(runs[0].len(), 2);
        assert_eq!(runs[0][0].run, "b");
        assert_eq!(runs[1][0].run, "c");
    }

    #[test]
    fn writes_and_reads_back_lines() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sweep/journal.log");
        let mut journal = open(&path, "sweep clean".into()).unwrap();
        let e = Entry {
            ts: 5,
            run: journal.run.clone(),
            command: journal.command.clone(),
            action: "deleted".into(),
            path: "/tmp/cache".into(),
            bytes: 42,
            detail: Some("open in ShipIt".into()),
        };
        writeln!(journal.file, "{}", serde_json::to_string(&e).unwrap()).unwrap();
        // A torn line from a crash mid-write is skipped, not fatal.
        writeln!(journal.file, "{{\"ts\": 1, \"ru").unwrap();

        assert_eq!(read_file(&path), vec![e]);
    }
}
