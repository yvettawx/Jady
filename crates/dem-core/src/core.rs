//! The facade the shell talks to: which library is open, and every operation on it. One lock
//! around one session keeps the rules simple; nothing here takes long enough to matter except
//! unlocking, which the shell runs off the interface thread.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use dem_crypto::keys::{KdfParams, MasterKey, RecoveryCode};
use dem_store::{Library, Unlock};
use serde::{Deserialize, Serialize};

use crate::dto::{LibraryRef, StartState};
use crate::error::{CoreError, CoreResult};
use crate::session::Session;

#[derive(Debug, thiserror::Error)]
pub enum KeychainError {
    #[error("no entry")]
    NotFound,
    #[error("{0}")]
    Other(String),
}

/// The system keychain. The shell provides the real one; tests use [`MemoryKeychain`].
pub trait Keychain: Send + Sync {
    fn read(&self, account: &str) -> Result<Vec<u8>, KeychainError>;
    fn write(&self, account: &str, secret: &[u8]) -> Result<(), KeychainError>;
    fn delete(&self, account: &str) -> Result<(), KeychainError>;
}

/// Format spec §4.1: the account for a library's master key.
pub fn keychain_account(library_id: &str) -> String {
    format!("library:{library_id}:master")
}

#[derive(Debug, Default)]
pub struct MemoryKeychain(Mutex<std::collections::HashMap<String, Vec<u8>>>);

impl Keychain for MemoryKeychain {
    fn read(&self, account: &str) -> Result<Vec<u8>, KeychainError> {
        self.0
            .lock()
            .map_err(|_| KeychainError::Other("poisoned".into()))?
            .get(account)
            .cloned()
            .ok_or(KeychainError::NotFound)
    }
    fn write(&self, account: &str, secret: &[u8]) -> Result<(), KeychainError> {
        self.0
            .lock()
            .map_err(|_| KeychainError::Other("poisoned".into()))?
            .insert(account.to_owned(), secret.to_vec());
        Ok(())
    }
    fn delete(&self, account: &str) -> Result<(), KeychainError> {
        self.0
            .lock()
            .map_err(|_| KeychainError::Other("poisoned".into()))?
            .remove(account);
        Ok(())
    }
}

/// Which library was open last. Holds a name and a path, nothing from inside the library.
#[derive(Debug, Default, Serialize, Deserialize)]
struct Known {
    library: Option<KnownLibrary>,
}

#[derive(Debug, Serialize, Deserialize)]
struct KnownLibrary {
    name: String,
    path: PathBuf,
}

/// A library made but not yet confirmed: it lives under a temporary name until the user has
/// shown they kept the recovery code.
struct Pending {
    name: String,
    temp: PathBuf,
    target: PathBuf,
    master: [u8; 32],
}

pub struct Core {
    config_dir: PathBuf,
    documents_dir: PathBuf,
    keychain: Arc<dyn Keychain>,
    kdf: KdfParams,
    session: Arc<Mutex<Option<Session>>>,
    pending: Mutex<Option<Pending>>,
    vault: crate::vault::VaultDoor,
    /// A sync target chosen while joining, before the library that will hold the setting is open.
    pending_sync: Mutex<Option<String>>,
}

const SYNC_TOKEN_ACCOUNT: &str = "sync:token";

fn sync_failure(e: dem_sync::SyncError) -> CoreError {
    let code = match e {
        dem_sync::SyncError::Unauthorized => "sync-unauthorized",
        dem_sync::SyncError::TooManyGone { .. } => "sync-storage-lost",
        dem_sync::SyncError::NothingToJoin => "sync-nothing",
        _ => "sync",
    };
    CoreError::new(code, e.to_string())
}

/// See [`Core::secret_reader`].
pub type SecretReader = Arc<dyn Fn(&str) -> Option<Vec<u8>> + Send + Sync>;

/// See [`Core::handle`].
#[derive(Clone)]
pub struct CoreHandle(Arc<Mutex<Option<Session>>>);

impl std::fmt::Debug for CoreHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("CoreHandle")
    }
}

impl CoreHandle {
    pub fn with<T>(&self, f: impl FnOnce(&mut Session) -> CoreResult<T>) -> CoreResult<T> {
        let mut guard = self.0.lock().map_err(|_| CoreError::locked())?;
        let session = guard.as_mut().ok_or_else(CoreError::locked)?;
        f(session)
    }
}

impl std::fmt::Debug for Core {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Core").finish_non_exhaustive()
    }
}

fn io(path: &Path) -> impl Fn(std::io::Error) -> CoreError + '_ {
    move |e| CoreError::new("io", format!("{}: {e}", path.display()))
}

impl Core {
    pub fn new(config_dir: PathBuf, documents_dir: PathBuf, keychain: Box<dyn Keychain>) -> Core {
        Core::with_kdf(config_dir, documents_dir, keychain, KdfParams::DEFAULT)
    }

    /// Cheaper key derivation, for tests.
    pub fn with_kdf(
        config_dir: PathBuf,
        documents_dir: PathBuf,
        keychain: Box<dyn Keychain>,
        kdf: KdfParams,
    ) -> Core {
        Core {
            config_dir,
            documents_dir,
            keychain: keychain.into(),
            kdf,
            session: Arc::new(Mutex::new(None)),
            pending: Mutex::new(None),
            vault: Default::default(),
            pending_sync: Mutex::new(None),
        }
    }

    fn known_path(&self) -> PathBuf {
        self.config_dir.join("libraries.json")
    }

    fn known(&self) -> Known {
        std::fs::read(self.known_path())
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default()
    }

    fn remember(&self, name: &str, path: &Path) -> CoreResult<()> {
        std::fs::create_dir_all(&self.config_dir).map_err(io(&self.config_dir))?;
        let known = Known {
            library: Some(KnownLibrary {
                name: name.to_owned(),
                path: path.to_owned(),
            }),
        };
        let json =
            serde_json::to_vec_pretty(&known).map_err(|e| CoreError::new("io", e.to_string()))?;
        let p = self.known_path();
        std::fs::write(&p, json).map_err(io(&p))
    }

    pub fn default_location(&self) -> PathBuf {
        self.documents_dir.join("Jady")
    }

    /// What to show first: nothing known, a library to unlock, or one that has gone astray.
    pub fn start_state(&self) -> StartState {
        let default_location = self.default_location().display().to_string();
        let Some(k) = self.known().library else {
            return StartState {
                mode: "first-run".into(),
                library: None,
                details: None,
                default_location,
            };
        };
        let library = Some(LibraryRef {
            name: k.name.clone(),
            path: k.path.display().to_string(),
        });
        if !k.path.exists() {
            return StartState {
                mode: "missing".into(),
                library,
                details: None,
                default_location,
            };
        }
        match std::fs::read(k.path.join("manifest.json"))
            .map_err(|e| e.to_string())
            .and_then(|b| dem_store::manifest::Manifest::parse(&b).map_err(|e| e.to_string()))
        {
            Ok(_) => StartState {
                mode: "unlock".into(),
                library,
                details: None,
                default_location,
            },
            Err(details) => StartState {
                mode: "broken".into(),
                library,
                details: Some(details),
                default_location,
            },
        }
    }

    /// Makes a library under a temporary name and returns the recovery code to show. Nothing is
    /// final until [`commit_library`](Self::commit_library), once the user has confirmed the code.
    pub fn prepare_library(&self, name: &str, dir: &str, password: &str) -> CoreResult<String> {
        let name = name.trim();
        if name.is_empty() || name.contains(['/', '\\', ':']) || name.starts_with('.') {
            return Err(CoreError::invalid("library name"));
        }
        let target = PathBuf::from(dir).join(name);
        if target.exists()
            && std::fs::read_dir(&target)
                .map_err(io(&target))?
                .next()
                .is_some()
        {
            return Err(CoreError::new("exists", "that folder is not empty"));
        }
        self.cancel_library();
        let parent = PathBuf::from(dir);
        std::fs::create_dir_all(&parent).map_err(io(&parent))?;
        let temp = parent.join(format!(".{name}.creating-{}", uuid::Uuid::now_v7()));
        let (lib, code) = Library::create(&temp, password.as_bytes(), self.kdf)?;
        let master = *lib.master_key().expose_bytes();
        let text = code
            .display_text()
            .map_err(|e| CoreError::new("crypto", e.to_string()))?
            .to_string();
        drop(lib);
        let mut pending = self.pending.lock().map_err(|_| CoreError::locked())?;
        *pending = Some(Pending {
            name: name.to_owned(),
            temp,
            target,
            master,
        });
        Ok(text)
    }

    /// The user kept the code: the library takes its real name and opens.
    pub fn commit_library(&self) -> CoreResult<()> {
        let p = self
            .pending
            .lock()
            .map_err(|_| CoreError::locked())?
            .take()
            .ok_or_else(|| CoreError::invalid("nothing to commit"))?;
        if p.target.exists() {
            std::fs::remove_dir(&p.target).map_err(io(&p.target))?;
        }
        std::fs::rename(&p.temp, &p.target).map_err(io(&p.target))?;
        let lib = Library::open(
            &p.target,
            Unlock::MasterKey(MasterKey::from_bytes(p.master)),
        )?;
        self.remember(&p.name, &p.target)?;
        self.save_to_keychain(&lib);
        self.begin(lib)
    }

    /// Throws away a library that was prepared but never confirmed.
    pub fn cancel_library(&self) {
        if let Ok(mut pending) = self.pending.lock()
            && let Some(p) = pending.take()
            && std::fs::remove_dir_all(&p.temp).is_err()
        {
            tracing::warn!("could not remove an unfinished library");
        }
    }

    /// Asked to open what is already open here: the library's lock would refuse a second handle.
    fn is_open_at(&self, root: &Path) -> bool {
        self.session.lock().is_ok_and(|g| {
            g.as_ref()
                .is_some_and(|s| Path::new(&s.library_path()) == root)
        })
    }

    fn begin(&self, lib: Library) -> CoreResult<()> {
        let session = Session::open(lib)?;
        if let Some(target) = self.pending_sync.lock().ok().and_then(|mut p| p.take()) {
            session.local_set("sync-config", &target)?;
        }
        let mut guard = self.session.lock().map_err(|_| CoreError::locked())?;
        *guard = Some(session);
        Ok(())
    }

    fn save_to_keychain(&self, lib: &Library) {
        let account = keychain_account(&lib.manifest().library_id.to_string());
        // Only makes daily opening easier: losing it just means typing the password.
        if let Err(e) = self
            .keychain
            .write(&account, lib.master_key().expose_bytes())
        {
            tracing::warn!(error = %e, "could not save to the keychain");
        }
    }

    fn manifest_id(path: &Path) -> CoreResult<String> {
        let m = path.join("manifest.json");
        let bytes = std::fs::read(&m).map_err(io(&m))?;
        Ok(dem_store::manifest::Manifest::parse(&bytes)?
            .library_id
            .to_string())
    }

    /// Daily opening. Returns false when the keychain has nothing usable, so the password is asked.
    pub fn unlock_keychain(&self, path: &str) -> CoreResult<bool> {
        let root = PathBuf::from(path);
        if self.is_open_at(&root) {
            return Ok(true);
        }
        let account = keychain_account(&Self::manifest_id(&root)?);
        let Ok(bytes) = self.keychain.read(&account) else {
            return Ok(false);
        };
        let Ok(raw) = <[u8; 32]>::try_from(bytes.as_slice()) else {
            return Ok(false);
        };
        match Library::open(&root, Unlock::MasterKey(MasterKey::from_bytes(raw))) {
            Ok(lib) => {
                self.begin(lib)?;
                Ok(true)
            }
            Err(dem_store::StoreError::Locked) => Err(dem_store::StoreError::Locked.into()),
            Err(_) => Ok(false),
        }
    }

    /// Returns false when the password is wrong.
    pub fn unlock_password(&self, path: &str, password: &str) -> CoreResult<bool> {
        let root = PathBuf::from(path);
        if self.is_open_at(&root) {
            return self.with(|s| Ok(s.verify_password(password)));
        }
        match Library::open(&root, Unlock::Password(password.as_bytes())) {
            Ok(lib) => {
                self.save_to_keychain(&lib);
                self.begin(lib)?;
                Ok(true)
            }
            Err(dem_store::StoreError::Crypto(_)) => Ok(false),
            Err(e) => Err(e.into()),
        }
    }

    /// Returns false when the code is wrong. Sets the new master password and opens.
    pub fn recover(&self, path: &str, code: &str, new_password: &str) -> CoreResult<bool> {
        let Ok(code) = RecoveryCode::parse(code) else {
            return Ok(false);
        };
        let root = PathBuf::from(path);
        match Library::open(&root, Unlock::Recovery(&code)) {
            Ok(mut lib) => {
                lib.set_password(new_password.as_bytes())?;
                self.save_to_keychain(&lib);
                self.begin(lib)?;
                Ok(true)
            }
            Err(dem_store::StoreError::Crypto(_)) => Ok(false),
            Err(e) => Err(e.into()),
        }
    }

    /// Opens a library the app has not seen, from its folder.
    pub fn adopt_library(&self, path: &str) -> CoreResult<LibraryRef> {
        let root = PathBuf::from(path);
        Self::manifest_id(&root)?;
        let name = root
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        self.remember(&name, &root)?;
        Ok(LibraryRef {
            name,
            path: root.display().to_string(),
        })
    }

    /// Closes the library: keys leave memory with the session.
    pub fn lock(&self) -> CoreResult<()> {
        // Locking the library locks the vault too, even though it has its own password.
        self.vault.lock();
        let mut guard = self.session.lock().map_err(|_| CoreError::locked())?;
        if let Some(s) = guard.as_mut() {
            s.flush();
        }
        *guard = None;
        Ok(())
    }

    pub fn remember_pending_sync(&self, target_json: String) {
        if let Ok(mut p) = self.pending_sync.lock() {
            *p = Some(target_json);
        }
    }

    /// The sync server's token, kept in the keychain like any other secret.
    pub fn sync_token(&self) -> Option<String> {
        let raw = self.keychain.read(SYNC_TOKEN_ACCOUNT).ok()?;
        String::from_utf8(raw).ok()
    }

    pub fn set_sync_token(&self, token: Option<&str>) -> CoreResult<()> {
        let failed = |e: KeychainError| CoreError::new("keychain", e.to_string());
        match token {
            Some(t) => self
                .keychain
                .write(SYNC_TOKEN_ACCOUNT, t.as_bytes())
                .map_err(failed),
            None => match self.keychain.delete(SYNC_TOKEN_ACCOUNT) {
                Ok(()) | Err(KeychainError::NotFound) => Ok(()),
                Err(e) => Err(failed(e)),
            },
        }
    }

    /// One round of sync (F3, M10). The session is free while files travel, so the app stays usable
    /// on a slow connection; new edits simply wait for the next round.
    pub fn sync_now(&self, backend: &dyn dem_sync::Backend) -> CoreResult<crate::SyncSummary> {
        let mut begun = self.with(|s| s.sync_begin())?;
        let mut seq = begun.first_seq;
        let mut next = || {
            seq += 1;
            seq
        };
        let mut me = dem_sync::Identity {
            device: &begun.device,
            key: &begun.key,
            next_seq: &mut next,
        };
        let report =
            dem_sync::run(&begun.root, backend, &mut begun.state, &mut me).map_err(sync_failure)?;
        let items = self.with(|s| s.sync_finish(&begun.state, &report.changed))?;
        Ok(crate::SyncSummary {
            uploaded: report.uploaded,
            downloaded: report.downloaded,
            merged: report.merged,
            deleted: report.deleted,
            items,
        })
    }

    /// A new computer: fills an empty folder from the storage and remembers the library. Opening it
    /// then asks for the master password, like any library found on disk.
    pub fn sync_join(
        &self,
        backend: &dyn dem_sync::Backend,
        folder: &str,
    ) -> CoreResult<LibraryRef> {
        let root = PathBuf::from(folder);
        if root.join("manifest.json").exists() {
            return Err(CoreError::invalid("this folder already has a library"));
        }
        std::fs::create_dir_all(&root).map_err(|e| CoreError::new("io", e.to_string()))?;
        dem_sync::join(&root, backend).map_err(sync_failure)?;
        self.adopt_library(folder)
    }

    /// The 密码库. Needs an open library only to know where it lives.
    pub fn vault(&self) -> &crate::vault::VaultDoor {
        &self.vault
    }

    pub fn vault_kdf(&self) -> KdfParams {
        self.kdf
    }

    pub fn library_root(&self) -> CoreResult<PathBuf> {
        self.with(|s| Ok(PathBuf::from(s.library_path())))
    }

    pub fn is_open(&self) -> bool {
        self.session.lock().is_ok_and(|g| g.is_some())
    }

    /// Runs `f` on the open library.
    /// For what runs apart from the app's commands (the AI gateway, the command line): the same
    /// open library, the same lock.
    pub fn handle(&self) -> CoreHandle {
        CoreHandle(self.session.clone())
    }

    /// Where this device's settings live, next to the library's own.
    pub fn config_dir(&self) -> &Path {
        &self.config_dir
    }

    /// A secret the user gave for this device (an AI key). Only ever in the keychain.
    pub fn secret_set(&self, account: &str, value: Option<&[u8]>) -> CoreResult<()> {
        let done = match value {
            Some(v) => self.keychain.write(account, v),
            None => self.keychain.delete(account),
        };
        done.map_err(|e| CoreError::new("keychain", format!("{e:?}")))
    }

    /// Reads a secret when needed. Keychain is shared so this can outlive the borrow of Core.
    pub fn secret_reader(&self) -> SecretReader {
        let keychain = self.keychain.clone();
        Arc::new(move |account| keychain.read(account).ok())
    }

    pub fn with<T>(&self, f: impl FnOnce(&mut Session) -> CoreResult<T>) -> CoreResult<T> {
        let mut guard = self.session.lock().map_err(|_| CoreError::locked())?;
        let session = guard.as_mut().ok_or_else(CoreError::locked)?;
        f(session)
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    pub(crate) fn core(dir: &Path) -> Core {
        Core::with_kdf(
            dir.join("config"),
            dir.join("docs"),
            Box::new(MemoryKeychain::default()),
            KdfParams::INSECURE_FOR_TESTS,
        )
    }

    fn make(c: &Core, dir: &Path) -> String {
        let code = c
            .prepare_library("我的资料库", dir.to_str().unwrap(), "correct horse")
            .unwrap();
        c.commit_library().unwrap();
        code
    }

    #[test]
    fn first_run_then_create_then_unlock_from_the_keychain() {
        let d = tempfile::tempdir().unwrap();
        let c = core(d.path());
        assert_eq!(c.start_state().mode, "first-run");
        make(&c, d.path());
        assert!(c.is_open());
        let st = c.start_state();
        assert_eq!(st.mode, "unlock");
        let path = st.library.unwrap().path;
        c.lock().unwrap();
        assert!(!c.is_open());
        assert!(c.unlock_keychain(&path).unwrap());
        assert!(c.is_open());
    }

    #[test]
    fn an_unconfirmed_library_leaves_nothing_behind() {
        let d = tempfile::tempdir().unwrap();
        let c = core(d.path());
        c.prepare_library("甲", d.path().to_str().unwrap(), "correct horse")
            .unwrap();
        assert_eq!(c.start_state().mode, "first-run");
        c.cancel_library();
        let names: Vec<_> = std::fs::read_dir(d.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| n != "config")
            .collect();
        assert!(names.is_empty(), "{names:?}");
    }

    #[test]
    fn password_and_recovery_code() {
        let d = tempfile::tempdir().unwrap();
        let c = core(d.path());
        let code = make(&c, d.path());
        let path = c.start_state().library.unwrap().path;
        c.lock().unwrap();
        assert!(!c.unlock_password(&path, "wrong one").unwrap());
        assert!(c.unlock_password(&path, "correct horse").unwrap());
        c.lock().unwrap();
        assert!(!c.recover(&path, "not a code", "new password").unwrap());
        assert!(c.recover(&path, &code, "new password").unwrap());
        c.lock().unwrap();
        assert!(!c.unlock_password(&path, "correct horse").unwrap());
        assert!(c.unlock_password(&path, "new password").unwrap());
    }

    #[test]
    fn says_when_the_library_has_gone_or_broken() {
        let d = tempfile::tempdir().unwrap();
        let c = core(d.path());
        make(&c, d.path());
        let path = PathBuf::from(c.start_state().library.unwrap().path);
        c.lock().unwrap();
        std::fs::write(path.join("manifest.json"), "not json").unwrap();
        assert_eq!(c.start_state().mode, "broken");
        std::fs::remove_dir_all(&path).unwrap();
        assert_eq!(c.start_state().mode, "missing");
    }

    #[test]
    fn refuses_a_folder_with_something_in_it_and_odd_names() {
        let d = tempfile::tempdir().unwrap();
        let c = core(d.path());
        let dir = d.path().join("x");
        std::fs::create_dir_all(dir.join("有东西")).unwrap();
        std::fs::write(dir.join("有东西/文件"), "x").unwrap();
        let e = c
            .prepare_library("有东西", dir.to_str().unwrap(), "correct horse")
            .unwrap_err();
        assert_eq!(e.code, "exists");
        assert_eq!(
            c.prepare_library("../外面", dir.to_str().unwrap(), "correct horse")
                .unwrap_err()
                .code,
            "invalid"
        );
    }

    #[test]
    fn operations_need_an_open_library() {
        let d = tempfile::tempdir().unwrap();
        let c = core(d.path());
        assert_eq!(c.with(|_| Ok(())).unwrap_err().code, "locked");
    }
}
