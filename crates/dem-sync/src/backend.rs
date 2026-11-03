//! Where the files go. The interface is small on purpose (M10): list, get, put, delete. A backend
//! gets paths and ciphertext; it has no keys and needs none.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::{MANIFEST, Result, SyncError, is_synced, scan};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RemoteFile {
    pub path: String,
    pub size: u64,
    pub hash: String,
}

pub trait Backend {
    fn list(&self) -> Result<Vec<RemoteFile>>;
    fn get(&self, path: &str) -> Result<Option<Vec<u8>>>;
    fn put(&self, path: &str, data: &[u8]) -> Result<()>;
    fn delete(&self, path: &str) -> Result<()>;
}

fn allowed(path: &str) -> Result<()> {
    if path == MANIFEST || is_synced(path) {
        Ok(())
    } else {
        Err(SyncError::Remote(format!("not a library path: {path}")))
    }
}

/// Any folder: a shared drive, a mounted server, iCloud Drive, Dropbox. Whatever moves that folder
/// between computers sees what this code sees.
#[derive(Debug, Clone)]
pub struct FolderBackend {
    root: PathBuf,
}

impl FolderBackend {
    pub fn new(root: &Path) -> Self {
        Self {
            root: root.to_owned(),
        }
    }
}

fn io(path: &Path) -> impl Fn(std::io::Error) -> SyncError + '_ {
    move |source| SyncError::Io {
        path: path.display().to_string(),
        source,
    }
}

impl Backend for FolderBackend {
    fn list(&self) -> Result<Vec<RemoteFile>> {
        Ok(scan(&self.root)?
            .into_iter()
            .map(|(path, (size, hash))| RemoteFile { path, size, hash })
            .collect())
    }

    fn get(&self, path: &str) -> Result<Option<Vec<u8>>> {
        allowed(path)?;
        let p = self.root.join(path);
        match fs::read(&p) {
            Ok(b) => Ok(Some(b)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(io(&p)(e)),
        }
    }

    fn put(&self, path: &str, data: &[u8]) -> Result<()> {
        allowed(path)?;
        let p = self.root.join(path);
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent).map_err(io(parent))?;
        }
        // Whole or not at all, also for whatever is syncing this folder.
        let mut name = [0u8; 8];
        dem_crypto::random_bytes(&mut name);
        let tmp = self
            .root
            .join(format!(".dem-tmp-{}", dem_crypto::content_hash(&name)));
        fs::write(&tmp, data).map_err(io(&tmp))?;
        fs::rename(&tmp, &p).map_err(io(&p))
    }

    fn delete(&self, path: &str) -> Result<()> {
        allowed(path)?;
        let p = self.root.join(path);
        match fs::remove_file(&p) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(io(&p)(e)),
        }
    }
}

/// `dem-sync-server`, or anything that speaks the same few routes.
pub struct HttpBackend {
    base: String,
    token: String,
    agent: ureq::Agent,
}

impl std::fmt::Debug for HttpBackend {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HttpBackend")
            .field("base", &self.base)
            .finish_non_exhaustive()
    }
}

/// The token must not cross a network in the clear; a server on this computer needs no TLS.
pub fn url_is_safe(url: &str) -> bool {
    url.starts_with("https://")
        || url.starts_with("http://127.0.0.1")
        || url.starts_with("http://localhost")
        || url.starts_with("http://[::1]")
}

impl HttpBackend {
    pub fn new(base: &str, token: &str) -> Result<Self> {
        if !url_is_safe(base) {
            return Err(SyncError::Remote("the address must use https".to_owned()));
        }
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .build()
            .into();
        Ok(Self {
            base: base.trim_end_matches('/').to_owned(),
            token: token.to_owned(),
            agent,
        })
    }

    fn url(&self, path: &str) -> String {
        format!("{}/v1/files/{path}", self.base)
    }

    fn bearer(&self) -> String {
        format!("Bearer {}", self.token)
    }
}

fn net(e: ureq::Error) -> SyncError {
    SyncError::Remote(e.to_string())
}

fn check(status: u16) -> Result<()> {
    match status {
        200..=299 => Ok(()),
        401 | 403 => Err(SyncError::Unauthorized),
        other => Err(SyncError::Remote(format!("status {other}"))),
    }
}

impl Backend for HttpBackend {
    fn list(&self) -> Result<Vec<RemoteFile>> {
        let mut r = self
            .agent
            .get(format!("{}/v1/list", self.base))
            .header("Authorization", self.bearer())
            .call()
            .map_err(net)?;
        check(r.status().as_u16())?;
        r.body_mut()
            .read_json()
            .map_err(|e| SyncError::Remote(e.to_string()))
    }

    fn get(&self, path: &str) -> Result<Option<Vec<u8>>> {
        allowed(path)?;
        let mut r = self
            .agent
            .get(self.url(path))
            .header("Authorization", self.bearer())
            .call()
            .map_err(net)?;
        if r.status().as_u16() == 404 {
            return Ok(None);
        }
        check(r.status().as_u16())?;
        let mut out = Vec::new();
        r.body_mut()
            .with_config()
            .limit(u64::MAX)
            .reader()
            .read_to_end(&mut out)
            .map_err(|e| SyncError::Remote(e.to_string()))?;
        Ok(Some(out))
    }

    fn put(&self, path: &str, data: &[u8]) -> Result<()> {
        allowed(path)?;
        let r = self
            .agent
            .put(self.url(path))
            .header("Authorization", self.bearer())
            .send(data)
            .map_err(net)?;
        check(r.status().as_u16())
    }

    fn delete(&self, path: &str) -> Result<()> {
        allowed(path)?;
        let r = self
            .agent
            .delete(self.url(path))
            .header("Authorization", self.bearer())
            .call()
            .map_err(net)?;
        let s = r.status().as_u16();
        if s == 404 { Ok(()) } else { check(s) }
    }
}
