//! 密码库 (F1, M9): passwords live here and nowhere else. It has its own password and its own key,
//! so an unlocked library says nothing about it. Each entry is one sealed file named by a random id,
//! which keeps two computers from overwriting each other's entries when they sync. Nothing here
//! reaches the index, search, export or the AI: only the app's own vault commands call this.

use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};

use data_encoding::BASE64 as B64;
use dem_crypto::keys::{self, KdfParams, MasterKey, WrappedKey};
use dem_crypto::{FileKey, envelope};
use serde::{Deserialize, Serialize};
use zeroize::{Zeroize, ZeroizeOnDrop};

use crate::{Result, StoreError, atomic};

const SALT_LEN: usize = 16;

pub const VAULT_DIR: &str = "vault";
const HEADER: &str = "vault/vault.json";
const FORMAT: u32 = 1;
/// The vault has no library id to bind its key to; this stands in for it.
const VAULT_SALT: &[u8; 16] = b"dem/vault/key/v1";

#[derive(Serialize, Deserialize)]
struct Header {
    format: u32,
    salt: String,
    m_kib: u32,
    t: u32,
    p: u32,
    nonce: String,
    wrapped: String,
}

/// One entry. Wiped from memory when dropped; never logged.
#[derive(Clone, Default, Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
pub struct VaultEntry {
    pub id: String,
    pub title: String,
    pub username: String,
    pub password: String,
    pub url: String,
    pub notes: String,
    pub updated: i64,
}

impl fmt::Debug for VaultEntry {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("VaultEntry")
            .field("id", &self.id)
            .finish_non_exhaustive()
    }
}

pub struct Vault {
    root: PathBuf,
    key: FileKey,
}

impl fmt::Debug for Vault {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Vault").finish_non_exhaustive()
    }
}

/// Everything an attacker could alter in the header: changing it makes unwrapping fail.
fn binding(format: u32, kdf: &KdfParams) -> Vec<u8> {
    format!("dem-vault/{format}/{}/{}/{}", kdf.m_kib, kdf.t, kdf.p).into_bytes()
}

fn bad(e: impl fmt::Display) -> StoreError {
    StoreError::InvalidDocument(format!("vault: {e}"))
}

fn entry_path(id: &str) -> Result<String> {
    // Ids come back from the interface: only ever a file name, never a path.
    if id.is_empty() || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
        return Err(bad("entry id"));
    }
    Ok(format!("{VAULT_DIR}/{id}.dexv"))
}

impl Vault {
    pub fn exists(root: &Path) -> bool {
        root.join(HEADER).exists()
    }

    pub fn create(root: &Path, password: &[u8], kdf: KdfParams) -> Result<Vault> {
        if Self::exists(root) {
            return Err(StoreError::AlreadyExists(HEADER.to_owned()));
        }
        let master = MasterKey::generate();
        let salt = keys::new_salt();
        let wrapped =
            keys::wrap_with_password(&master, password, &salt, kdf, &binding(FORMAT, &kdf))?;
        let header = Header {
            format: FORMAT,
            salt: B64.encode(&salt),
            m_kib: kdf.m_kib,
            t: kdf.t,
            p: kdf.p,
            nonce: B64.encode(&wrapped.nonce),
            wrapped: B64.encode(&wrapped.ciphertext),
        };
        atomic::write(
            root,
            HEADER,
            &serde_json::to_vec_pretty(&header).map_err(bad)?,
        )?;
        Ok(Vault {
            root: root.to_owned(),
            key: keys::file_key(&master, VAULT_SALT, 1),
        })
    }

    /// A wrong password is `StoreError::Crypto(CryptoError::Decrypt)`.
    pub fn open(root: &Path, password: &[u8]) -> Result<Vault> {
        let raw = fs::read(root.join(HEADER)).map_err(crate::io_err(root))?;
        let h: Header = serde_json::from_slice(&raw).map_err(bad)?;
        if h.format != FORMAT {
            return Err(bad("format"));
        }
        let decode = |t: &str| B64.decode(t.as_bytes()).map_err(bad);
        let salt: [u8; SALT_LEN] = decode(&h.salt)?.try_into().map_err(|_| bad("salt"))?;
        let wrapped = WrappedKey {
            nonce: decode(&h.nonce)?.try_into().map_err(|_| bad("nonce"))?,
            ciphertext: decode(&h.wrapped)?,
        };
        let kdf = KdfParams {
            m_kib: h.m_kib,
            t: h.t,
            p: h.p,
        };
        let master =
            keys::unwrap_with_password(&wrapped, password, &salt, kdf, &binding(h.format, &kdf))?;
        Ok(Vault {
            root: root.to_owned(),
            key: keys::file_key(&master, VAULT_SALT, 1),
        })
    }

    /// Everything in it. A file that does not open is skipped: it may be from a vault this computer
    /// does not have the key for, and one bad file must not hide the rest.
    pub fn entries(&self) -> Result<Vec<VaultEntry>> {
        let dir = self.root.join(VAULT_DIR);
        let mut out = Vec::new();
        let Ok(files) = fs::read_dir(&dir) else {
            return Ok(out);
        };
        for f in files.flatten() {
            let name = f.file_name().to_string_lossy().into_owned();
            let Some(id) = name.strip_suffix(".dexv") else {
                continue;
            };
            let rel = format!("{VAULT_DIR}/{id}.dexv");
            let Ok(raw) = fs::read(f.path()) else {
                continue;
            };
            let Ok(plain) = envelope::open(&self.key, &rel, &raw) else {
                continue;
            };
            if let Ok(e) = serde_json::from_slice::<VaultEntry>(&plain) {
                out.push(e);
            }
        }
        out.sort_by_key(|e| e.title.to_lowercase());
        Ok(out)
    }

    pub fn put(&self, entry: &VaultEntry) -> Result<()> {
        let rel = entry_path(&entry.id)?;
        let mut plain = serde_json::to_vec(entry).map_err(bad)?;
        let sealed = envelope::seal(&self.key, &rel, &plain);
        plain.zeroize();
        atomic::write(&self.root, &rel, &sealed?)
    }

    pub fn remove(&self, id: &str) -> Result<()> {
        let rel = entry_path(id)?;
        match fs::remove_file(self.root.join(&rel)) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err(bad("remove")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FAST: KdfParams = KdfParams::INSECURE_FOR_TESTS;

    fn entry(id: &str, title: &str, password: &str) -> VaultEntry {
        let mut e = VaultEntry::default();
        e.id = id.into();
        e.title = title.into();
        e.password = password.into();
        e
    }

    #[test]
    fn entries_come_back_only_with_the_right_password() {
        let dir = tempfile::tempdir().unwrap();
        let v = Vault::create(dir.path(), b"vault-pw", FAST).unwrap();
        v.put(&entry("a-1", "Bank", "s3cret-zzcanary")).unwrap();
        let again = Vault::open(dir.path(), b"vault-pw").unwrap();
        let got = again.entries().unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].password, "s3cret-zzcanary");
        assert!(matches!(
            Vault::open(dir.path(), b"wrong"),
            Err(StoreError::Crypto(dem_crypto::CryptoError::Decrypt))
        ));
    }

    #[test]
    fn no_file_holds_a_title_or_a_password_in_the_clear() {
        let dir = tempfile::tempdir().unwrap();
        let v = Vault::create(dir.path(), b"vault-pw", FAST).unwrap();
        v.put(&entry("a-1", "zztitlecanary", "zzpasscanary"))
            .unwrap();
        for f in fs::read_dir(dir.path().join(VAULT_DIR)).unwrap().flatten() {
            let raw = String::from_utf8_lossy(&fs::read(f.path()).unwrap()).into_owned();
            assert!(!raw.contains("zztitlecanary") && !raw.contains("zzpasscanary"));
        }
    }

    #[test]
    fn a_tampered_or_renamed_file_does_not_open() {
        let dir = tempfile::tempdir().unwrap();
        let v = Vault::create(dir.path(), b"vault-pw", FAST).unwrap();
        v.put(&entry("a-1", "A", "x")).unwrap();
        v.put(&entry("a-2", "B", "y")).unwrap();
        let d = dir.path().join(VAULT_DIR);
        // Swapping two entries' files must not swap their contents silently.
        fs::rename(d.join("a-1.dexv"), d.join("tmp")).unwrap();
        fs::rename(d.join("a-2.dexv"), d.join("a-1.dexv")).unwrap();
        fs::rename(d.join("tmp"), d.join("a-2.dexv")).unwrap();
        assert!(v.entries().unwrap().is_empty());
    }

    #[test]
    fn an_id_cannot_leave_the_folder() {
        let dir = tempfile::tempdir().unwrap();
        let v = Vault::create(dir.path(), b"vault-pw", FAST).unwrap();
        assert!(v.put(&entry("../../manifest", "x", "y")).is_err());
        assert!(v.remove("../manifest").is_err());
    }

    #[test]
    fn creating_twice_is_refused_and_removing_works() {
        let dir = tempfile::tempdir().unwrap();
        let v = Vault::create(dir.path(), b"vault-pw", FAST).unwrap();
        assert!(Vault::create(dir.path(), b"other", FAST).is_err());
        v.put(&entry("a-1", "A", "x")).unwrap();
        v.remove("a-1").unwrap();
        v.remove("a-1").unwrap();
        assert!(v.entries().unwrap().is_empty());
    }
}
