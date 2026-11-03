//! Sync between one's own computers (F3, M10). Library files are already encrypted and never need
//! rewriting to be shared: each computer writes update files under its own device id, so sync moves
//! files, and a backend only ever holds what is on disk: ciphertext. Merging is the CRDT's job once
//! the files have arrived. `dem-core` opens the changed documents afterwards.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

mod backend;
pub use backend::{Backend, FolderBackend, HttpBackend, RemoteFile, url_is_safe};

#[derive(Debug, thiserror::Error)]
pub enum SyncError {
    #[error("the sync storage could not be reached: {0}")]
    Remote(String),
    #[error("the sync storage refused the token")]
    Unauthorized,
    #[error("file error at {path}: {source}")]
    Io {
        path: String,
        #[source]
        source: std::io::Error,
    },
    #[error("{0}")]
    Crypto(#[from] dem_crypto::CryptoError),
    /// Most of what was shared has disappeared from the storage. That looks like a wrong folder or
    /// a wiped server, not like deliberate deletes, so nothing here is touched.
    #[error("the sync storage lost {gone} of {known} files; nothing was changed")]
    TooManyGone { gone: usize, known: usize },
    #[error("no library at this sync storage")]
    NothingToJoin,
}

pub type Result<T> = std::result::Result<T, SyncError>;

pub const MANIFEST: &str = "manifest.json";
const MASS_DELETE_FLOOR: usize = 20;

/// What one computer last agreed with the storage on: path to content hash.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct SyncState {
    pub files: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Report {
    pub uploaded: u32,
    pub downloaded: u32,
    /// Two computers rewrote one snapshot; both versions were kept and will merge.
    pub merged: u32,
    pub deleted: u32,
    /// Local paths whose content changed: what `dem-core` must open again.
    pub changed: Vec<String>,
}

/// What sync carries. `local/`, the index, the lock and `tmp/` belong to this computer.
pub fn is_synced(rel: &str) -> bool {
    let mut parts = rel.split('/');
    let top = parts.next().unwrap_or_default();
    if rel
        .split('/')
        .any(|p| p == ".." || p == "." || p.is_empty())
    {
        return false;
    }
    matches!(
        top,
        "items" | "types" | "structure" | "logs" | "blobs" | "vault"
    ) && parts.next().is_some()
}

fn walk(root: &Path, dir: &Path, out: &mut Vec<String>) -> Result<()> {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(source) => {
            return Err(SyncError::Io {
                path: dir.display().to_string(),
                source,
            });
        }
    };
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            walk(root, &p, out)?;
        } else if let Ok(rel) = p.strip_prefix(root) {
            let rel = rel.to_string_lossy().replace('\\', "/");
            if is_synced(&rel) {
                out.push(rel);
            }
        }
    }
    Ok(())
}

pub(crate) fn scan(root: &Path) -> Result<BTreeMap<String, (u64, String)>> {
    let mut paths = Vec::new();
    for top in ["items", "types", "structure", "logs", "blobs", "vault"] {
        walk(root, &root.join(top), &mut paths)?;
    }
    let mut out = BTreeMap::new();
    for rel in paths {
        let bytes = read(root, &rel)?;
        out.insert(rel, (bytes.len() as u64, dem_crypto::content_hash(&bytes)));
    }
    Ok(out)
}

fn read(root: &Path, rel: &str) -> Result<Vec<u8>> {
    let p = root.join(rel);
    fs::read(&p).map_err(|source| SyncError::Io {
        path: p.display().to_string(),
        source,
    })
}

fn write(root: &Path, rel: &str, bytes: &[u8]) -> Result<()> {
    let p = root.join(rel);
    let io = |source| SyncError::Io {
        path: p.display().to_string(),
        source,
    };
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(io)?;
    }
    // Into the library's own tmp/, so it is the same volume and a crash leaves nothing half written.
    let tmp_dir = root.join("tmp");
    fs::create_dir_all(&tmp_dir).map_err(io)?;
    let mut name = [0u8; 16];
    dem_crypto::random_bytes(&mut name);
    let tmp: PathBuf = tmp_dir.join(dem_crypto::content_hash(&name));
    fs::write(&tmp, bytes).map_err(io)?;
    fs::rename(&tmp, &p).map_err(io)
}

fn remove(root: &Path, rel: &str) -> Result<()> {
    let p = root.join(rel);
    match fs::remove_file(&p) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(source) => Err(SyncError::Io {
            path: p.display().to_string(),
            source,
        }),
    }
}

/// A document snapshot: the one kind of file two computers can both rewrite.
fn is_snapshot(rel: &str) -> bool {
    rel.ends_with(".dexm")
}

#[allow(missing_debug_implementations)] // Holds a key; nothing to print.
pub struct Identity<'a> {
    /// This computer's device id, as it appears in file names.
    pub device: &'a str,
    pub key: &'a dem_crypto::FileKey,
    /// A number that never repeats on this device; the next update file's sequence.
    pub next_seq: &'a mut dyn FnMut() -> u64,
}

/// The remote snapshot under a new name, as an update file of this computer. Snapshots import like
/// any update, so nothing in either version is lost.
fn keep_as_update(root: &Path, rel: &str, remote: &[u8], me: &mut Identity<'_>) -> Result<String> {
    let plain = dem_crypto::envelope::open(me.key, rel, remote)?;
    let stem = rel.trim_end_matches(".dexm");
    let new_rel = format!("{stem}.{}-{}.dexu", me.device, (me.next_seq)());
    let sealed = dem_crypto::envelope::seal(me.key, &new_rel, &plain)?;
    write(root, &new_rel, &sealed)?;
    Ok(new_rel)
}

/// One round. The caller has written everything out first and opens `changed` afterwards. Safe to
/// interrupt at any point: files only appear whole, and `state` moves on only for finished ones.
pub fn run(
    root: &Path,
    backend: &dyn Backend,
    state: &mut SyncState,
    me: &mut Identity<'_>,
) -> Result<Report> {
    // The manifest is how another computer joins. It stays as it is once there: each computer can
    // keep its own password over the same master key.
    if backend.get(MANIFEST)?.is_none() {
        backend.put(MANIFEST, &read(root, MANIFEST)?)?;
    }
    let local = scan(root)?;
    let remote: BTreeMap<String, RemoteFile> = backend
        .list()?
        .into_iter()
        .filter(|f| is_synced(&f.path))
        .map(|f| (f.path.clone(), f))
        .collect();

    let gone = state
        .files
        .keys()
        .filter(|p| !remote.contains_key(*p) && local.contains_key(*p))
        .count();
    if gone > MASS_DELETE_FLOOR && gone * 2 > state.files.len() {
        return Err(SyncError::TooManyGone {
            gone,
            known: state.files.len(),
        });
    }

    let mut report = Report::default();
    let mut paths: Vec<&String> = local.keys().chain(remote.keys()).collect();
    paths.sort();
    paths.dedup();
    let mut extra_uploads = Vec::new();
    for rel in paths {
        let l = local.get(rel).map(|(_, h)| h.as_str());
        let r = remote.get(rel).map(|f| f.hash.as_str());
        let base = state.files.get(rel).map(String::as_str);
        match (l, r) {
            (Some(a), Some(b)) if a == b => {
                state.files.insert(rel.clone(), a.to_owned());
            }
            (None, None) => {}
            (None, Some(b)) => {
                if base == Some(b) {
                    // Deleted here since we last agreed.
                    backend.delete(rel)?;
                    state.files.remove(rel);
                    report.deleted += 1;
                } else if let Some(bytes) = backend.get(rel)? {
                    write(root, rel, &bytes)?;
                    state
                        .files
                        .insert(rel.clone(), dem_crypto::content_hash(&bytes));
                    report.downloaded += 1;
                    report.changed.push(rel.clone());
                }
            }
            (Some(a), None) => {
                if base == Some(a) {
                    // Deleted elsewhere: folded into a snapshot, or the item was purged.
                    remove(root, rel)?;
                    state.files.remove(rel);
                    report.deleted += 1;
                    report.changed.push(rel.clone());
                } else {
                    backend.put(rel, &read(root, rel)?)?;
                    state.files.insert(rel.clone(), a.to_owned());
                    report.uploaded += 1;
                }
            }
            (Some(a), Some(b)) => {
                if base == Some(b) {
                    backend.put(rel, &read(root, rel)?)?;
                    state.files.insert(rel.clone(), a.to_owned());
                    report.uploaded += 1;
                    continue;
                }
                let Some(bytes) = backend.get(rel)? else {
                    continue;
                };
                if base == Some(a) {
                    write(root, rel, &bytes)?;
                    state.files.insert(rel.clone(), b.to_owned());
                    report.downloaded += 1;
                    report.changed.push(rel.clone());
                } else if is_snapshot(rel) {
                    let kept = keep_as_update(root, rel, &bytes, me)?;
                    backend.put(rel, &read(root, rel)?)?;
                    state.files.insert(rel.clone(), a.to_owned());
                    extra_uploads.push(kept.clone());
                    report.merged += 1;
                    report.changed.push(kept);
                } else if rel.ends_with(".dexl") && !rel.ends_with(&format!("/{}.dexl", me.device))
                {
                    // Another computer's own log: only it writes there, so its copy is the truth.
                    write(root, rel, &bytes)?;
                    state.files.insert(rel.clone(), b.to_owned());
                    report.downloaded += 1;
                    report.changed.push(rel.clone());
                } else {
                    // This computer's log, or one vault entry changed in two places. The one
                    // syncing now wins; the vault has no history to merge from.
                    backend.put(rel, &read(root, rel)?)?;
                    state.files.insert(rel.clone(), a.to_owned());
                    report.uploaded += 1;
                }
            }
        }
    }
    for rel in extra_uploads {
        let bytes = read(root, &rel)?;
        backend.put(&rel, &bytes)?;
        state.files.insert(rel, dem_crypto::content_hash(&bytes));
        report.uploaded += 1;
    }
    Ok(report)
}

/// Fills an empty folder from the storage, so a new computer can open the library with its password.
pub fn join(root: &Path, backend: &dyn Backend) -> Result<SyncState> {
    let Some(manifest) = backend.get(MANIFEST)? else {
        return Err(SyncError::NothingToJoin);
    };
    let mut state = SyncState::default();
    for f in backend.list()? {
        if !is_synced(&f.path) {
            continue;
        }
        if let Some(bytes) = backend.get(&f.path)? {
            write(root, &f.path, &bytes)?;
            state.files.insert(f.path, dem_crypto::content_hash(&bytes));
        }
    }
    // Last: a folder with a manifest in it is a complete library.
    write(root, MANIFEST, &manifest)?;
    Ok(state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use dem_crypto::{MasterKey, keys};

    struct Rig {
        dir: tempfile::TempDir,
        store: tempfile::TempDir,
        key: dem_crypto::FileKey,
        state: SyncState,
        device: String,
        seq: u64,
    }

    fn rig(device: &str, _store: Option<&Path>) -> Rig {
        let dir = tempfile::tempdir().unwrap();
        let own_store = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(MANIFEST), "{}").unwrap();
        let key = keys::file_key(&MasterKey::from_bytes([7; 32]), &[1; 16], 1);
        Rig {
            dir,
            store: own_store,
            key,
            state: SyncState::default(),
            device: device.into(),
            seq: 0,
        }
    }

    fn once(r: &mut Rig, store: &Path) -> Report {
        let backend = FolderBackend::new(store);
        let mut seq = r.seq;
        let mut next = || {
            seq += 1;
            seq
        };
        let mut me = Identity {
            device: &r.device,
            key: &r.key,
            next_seq: &mut next,
        };
        let report = run(r.dir.path(), &backend, &mut r.state, &mut me).unwrap();
        r.seq = seq;
        report
    }

    fn put(r: &Rig, rel: &str, text: &str) {
        let sealed = dem_crypto::envelope::seal(&r.key, rel, text.as_bytes()).unwrap();
        write(r.dir.path(), rel, &sealed).unwrap();
    }

    fn get(r: &Rig, rel: &str) -> Option<String> {
        let raw = fs::read(r.dir.path().join(rel)).ok()?;
        let plain = dem_crypto::envelope::open(&r.key, rel, &raw).ok()?;
        Some(String::from_utf8(plain).unwrap())
    }

    #[test]
    fn updates_from_both_sides_reach_both_and_settle() {
        let (mut a, mut b) = (rig("aaaa", None), rig("bbbb", None));
        let store = a.store.path().to_owned();
        put(&a, "items/x/1.aaaa-1.dexu", "from a");
        put(&b, "items/x/1.bbbb-1.dexu", "from b");
        once(&mut a, &store);
        let got = once(&mut b, &store);
        assert_eq!(got.downloaded, 1);
        assert_eq!(got.changed, ["items/x/1.aaaa-1.dexu"]);
        once(&mut a, &store);
        assert_eq!(get(&a, "items/x/1.bbbb-1.dexu").unwrap(), "from b");
        assert_eq!(get(&b, "items/x/1.aaaa-1.dexu").unwrap(), "from a");
        // Nothing left to do on either side.
        assert_eq!(once(&mut a, &store), Report::default());
        assert_eq!(once(&mut b, &store), Report::default());
    }

    #[test]
    fn local_only_files_stay_home() {
        let mut a = rig("aaaa", None);
        let store = a.store.path().to_owned();
        put(&a, "items/x/1.dexm", "synced");
        fs::create_dir_all(a.dir.path().join("local")).unwrap();
        fs::write(a.dir.path().join("local/device.json"), "secret").unwrap();
        fs::write(a.dir.path().join("index.sqlite"), "index").unwrap();
        once(&mut a, &store);
        let names = FolderBackend::new(&store).list().unwrap();
        assert_eq!(names.len(), 1);
        assert_eq!(names[0].path, "items/x/1.dexm");
    }

    #[test]
    fn the_storage_only_ever_sees_ciphertext() {
        let mut a = rig("aaaa", None);
        let store = a.store.path().to_owned();
        put(&a, "items/x/1.dexm", "zzcanaryzz");
        once(&mut a, &store);
        let raw = fs::read(store.join("items/x/1.dexm")).unwrap();
        assert!(!String::from_utf8_lossy(&raw).contains("zzcanaryzz"));
    }

    #[test]
    fn a_snapshot_rewritten_in_two_places_keeps_both() {
        let (mut a, mut b) = (rig("aaaa", None), rig("bbbb", None));
        let store = a.store.path().to_owned();
        put(&a, "items/x/1.dexm", "base");
        once(&mut a, &store);
        once(&mut b, &store);
        put(&a, "items/x/1.dexm", "a folded");
        put(&b, "items/x/1.dexm", "b folded");
        once(&mut a, &store);
        let got = once(&mut b, &store);
        assert_eq!(got.merged, 1);
        // B's snapshot wins the name; A's content is kept beside it as an update.
        assert_eq!(get(&b, "items/x/1.dexm").unwrap(), "b folded");
        assert_eq!(get(&b, "items/x/1.bbbb-1.dexu").unwrap(), "a folded");
        once(&mut a, &store);
        assert_eq!(get(&a, "items/x/1.dexm").unwrap(), "b folded");
        assert_eq!(get(&a, "items/x/1.bbbb-1.dexu").unwrap(), "a folded");
    }

    #[test]
    fn a_delete_travels_but_a_new_file_is_never_taken_for_one() {
        let (mut a, mut b) = (rig("aaaa", None), rig("bbbb", None));
        let store = a.store.path().to_owned();
        put(&a, "items/x/1.aaaa-1.dexu", "folded away soon");
        once(&mut a, &store);
        once(&mut b, &store);
        fs::remove_file(a.dir.path().join("items/x/1.aaaa-1.dexu")).unwrap();
        assert_eq!(once(&mut a, &store).deleted, 1);
        assert_eq!(once(&mut b, &store).deleted, 1);
        assert!(!b.dir.path().join("items/x/1.aaaa-1.dexu").exists());
        // Unseen by the storage and not in the state: an upload, not a delete.
        put(&b, "items/y/2.bbbb-1.dexu", "new");
        assert_eq!(once(&mut b, &store).uploaded, 1);
    }

    #[test]
    fn a_wiped_storage_does_not_wipe_the_library() {
        let mut a = rig("aaaa", None);
        let store = a.store.path().to_owned();
        for i in 0..30 {
            put(&a, &format!("items/x/{i}.dexm"), "x");
        }
        once(&mut a, &store);
        fs::remove_dir_all(store.join("items")).unwrap();
        let backend = FolderBackend::new(&store);
        let mut n = 0;
        let mut next = || {
            n += 1;
            n
        };
        let mut me = Identity {
            device: "aaaa",
            key: &a.key,
            next_seq: &mut next,
        };
        let got = run(a.dir.path(), &backend, &mut a.state, &mut me);
        assert!(matches!(got, Err(SyncError::TooManyGone { .. })));
        assert!(a.dir.path().join("items/x/0.dexm").exists());
    }

    #[test]
    fn another_computers_log_is_taken_and_paths_cannot_escape() {
        assert!(is_synced("logs/activity/2026-11/aaaa.dexl"));
        for bad in [
            "manifest.json",
            "local/device.json",
            "index.sqlite",
            "items/../../etc",
            "/etc/passwd",
            "items",
            ".lock",
            "tmp/x",
        ] {
            assert!(!is_synced(bad), "{bad}");
        }
    }

    #[test]
    fn a_new_computer_joins_from_the_storage() {
        let mut a = rig("aaaa", None);
        let store = a.store.path().to_owned();
        put(&a, "items/x/1.dexm", "hello");
        once(&mut a, &store);
        let fresh = tempfile::tempdir().unwrap();
        let state = join(fresh.path(), &FolderBackend::new(&store)).unwrap();
        assert_eq!(state.files.len(), 1);
        assert!(fresh.path().join(MANIFEST).exists());
        assert!(fresh.path().join("items/x/1.dexm").exists());
        let empty = tempfile::tempdir().unwrap();
        let nowhere = tempfile::tempdir().unwrap();
        assert!(matches!(
            join(nowhere.path(), &FolderBackend::new(empty.path())),
            Err(SyncError::NothingToJoin)
        ));
    }
}
