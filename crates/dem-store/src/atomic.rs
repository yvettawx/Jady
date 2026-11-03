//! Atomic file replacement (format spec §8): write to `tmp/`, fsync, rename over
//! the target in the same volume, then fsync the directory (Unix). Readers never
//! observe a partially written file.

use std::fs::{self, File};
use std::io::Write;
use std::path::Path;

use crate::{Result, io_err};

pub(crate) fn write(root: &Path, rel: &str, bytes: &[u8]) -> Result<()> {
    let target = root.join(rel);
    if let Some(dir) = target.parent() {
        fs::create_dir_all(dir).map_err(io_err(dir))?;
    }
    let tmp_dir = root.join("tmp");
    fs::create_dir_all(&tmp_dir).map_err(io_err(&tmp_dir))?;
    let tmp = tmp_dir.join(format!("{:016x}.tmp", dem_crypto::random_u64()));

    let result = (|| {
        let mut f = File::create(&tmp).map_err(io_err(&tmp))?;
        f.write_all(bytes).map_err(io_err(&tmp))?;
        f.sync_all().map_err(io_err(&tmp))?;
        drop(f);
        // On Windows std::fs::rename uses MoveFileExW(MOVEFILE_REPLACE_EXISTING).
        rename_with_retry(&tmp, &target).map_err(io_err(&target))?;
        sync_dir(target.parent().unwrap_or(root));
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// Windows reports transient sharing conflicts (access denied, sharing or lock
/// violation) when antivirus or the search indexer briefly holds the target; back
/// off and retry for up to ~2 s (docs/spikes/04-windows.md). Elsewhere: one try.
pub(crate) fn rename_with_retry(from: &Path, to: &Path) -> std::io::Result<()> {
    let mut delay_ms = 5u64;
    let mut waited = 0u64;
    loop {
        match fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(e)
                if cfg!(windows)
                    && matches!(e.raw_os_error(), Some(5 | 32 | 33))
                    && waited < 2000 =>
            {
                std::thread::sleep(std::time::Duration::from_millis(delay_ms));
                waited += delay_ms;
                delay_ms = (delay_ms * 2).min(250);
            }
            Err(e) => return Err(e),
        }
    }
}

#[cfg(unix)]
fn sync_dir(dir: &Path) {
    // Best effort: persists the rename itself across power loss.
    if let Ok(d) = File::open(dir) {
        let _ = d.sync_all();
    }
}

#[cfg(not(unix))]
fn sync_dir(_dir: &Path) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replaces_existing_file_and_leaves_no_temp() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "items/ab/x.dexm", b"one").unwrap();
        write(dir.path(), "items/ab/x.dexm", b"two").unwrap();
        assert_eq!(
            fs::read(dir.path().join("items/ab/x.dexm")).unwrap(),
            b"two"
        );
        assert_eq!(fs::read_dir(dir.path().join("tmp")).unwrap().count(), 0);
    }

    #[test]
    fn replaces_a_file_that_is_open_for_reading() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "a/x", b"one").unwrap();
        let _reader = File::open(dir.path().join("a/x")).unwrap();
        // On Windows this needs FILE_SHARE_DELETE on the reader, which std sets.
        write(dir.path(), "a/x", b"two").unwrap();
        assert_eq!(fs::read(dir.path().join("a/x")).unwrap(), b"two");
    }
}
