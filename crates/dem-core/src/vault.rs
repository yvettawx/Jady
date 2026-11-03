//! 密码库, the app's only door to it (F1, M9). Deliberately not on `Session`: search, lists, export,
//! the command line and the AI's restricted view are all built on `Session`, so they have no way in.
//! Lists carry no passwords; a password crosses to the interface only when one is asked for by id.

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use dem_crypto::KdfParams;
use dem_store::vault::{Vault, VaultEntry};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::error::{CoreError, CoreResult};

/// Locks by itself after this long without use.
pub const AUTO_LOCK: Duration = Duration::from_secs(5 * 60);
const MIN_PASSWORD: usize = 8;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct VaultStatus {
    pub exists: bool,
    pub open: bool,
}

/// One row of the list: no password, no notes.
#[derive(Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct VaultRow {
    pub id: String,
    pub title: String,
    pub username: String,
    pub url: String,
}

/// An entry being saved or shown in full. An empty `id` makes a new one.
#[derive(Clone, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct VaultItem {
    pub id: String,
    pub title: String,
    pub username: String,
    pub password: String,
    pub url: String,
    pub notes: String,
}

impl std::fmt::Debug for VaultRow {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("VaultRow")
            .field("id", &self.id)
            .finish_non_exhaustive()
    }
}

impl std::fmt::Debug for VaultItem {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("VaultItem")
            .field("id", &self.id)
            .finish_non_exhaustive()
    }
}

struct Open {
    vault: Vault,
    last_used: Instant,
}

/// The open vault, if any. Shared by the commands; dropped on lock.
#[derive(Clone, Default)]
pub struct VaultDoor(Arc<Mutex<Option<Open>>>);

impl std::fmt::Debug for VaultDoor {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("VaultDoor").finish_non_exhaustive()
    }
}

fn store(e: dem_store::StoreError) -> CoreError {
    CoreError::new("vault", e.to_string())
}

fn wrong_password() -> CoreError {
    CoreError::new("wrong-password", "wrong password")
}

impl VaultDoor {
    fn guarded<T>(&self, f: impl FnOnce(&mut Open) -> CoreResult<T>) -> CoreResult<T> {
        let mut guard = self.0.lock().map_err(|_| CoreError::locked())?;
        let expired = guard
            .as_ref()
            .is_some_and(|o| o.last_used.elapsed() > AUTO_LOCK);
        if expired {
            *guard = None;
        }
        let open = guard
            .as_mut()
            .ok_or_else(|| CoreError::new("vault-locked", "the vault is locked"))?;
        open.last_used = Instant::now();
        f(open)
    }

    pub fn status(&self, root: &Path) -> VaultStatus {
        let mut guard = self.0.lock().ok();
        if let Some(g) = guard.as_mut()
            && g.as_ref()
                .is_some_and(|o| o.last_used.elapsed() > AUTO_LOCK)
        {
            **g = None;
        }
        VaultStatus {
            exists: Vault::exists(root),
            open: guard.is_some_and(|g| g.is_some()),
        }
    }

    pub fn lock(&self) {
        if let Ok(mut g) = self.0.lock() {
            *g = None;
        }
    }

    fn set(&self, vault: Vault) -> CoreResult<()> {
        let mut g = self.0.lock().map_err(|_| CoreError::locked())?;
        *g = Some(Open {
            vault,
            last_used: Instant::now(),
        });
        Ok(())
    }

    pub fn create(&self, root: &Path, password: &str, kdf: KdfParams) -> CoreResult<()> {
        if password.chars().count() < MIN_PASSWORD {
            return Err(CoreError::invalid("password too short"));
        }
        self.set(Vault::create(root, password.as_bytes(), kdf).map_err(store)?)
    }

    pub fn unlock(&self, root: &Path, password: &str) -> CoreResult<()> {
        let vault = Vault::open(root, password.as_bytes()).map_err(|e| match e {
            dem_store::StoreError::Crypto(_) => wrong_password(),
            other => store(other),
        })?;
        self.set(vault)
    }

    pub fn rows(&self) -> CoreResult<Vec<VaultRow>> {
        self.guarded(|o| {
            Ok(o.vault
                .entries()
                .map_err(store)?
                .iter()
                .map(|e| VaultRow {
                    id: e.id.clone(),
                    title: e.title.clone(),
                    username: e.username.clone(),
                    url: e.url.clone(),
                })
                .collect())
        })
    }

    fn find(o: &Open, id: &str) -> CoreResult<VaultEntry> {
        o.vault
            .entries()
            .map_err(store)?
            .into_iter()
            .find(|e| e.id == id)
            .ok_or_else(|| CoreError::new("not-found", "entry"))
    }

    pub fn item(&self, id: &str) -> CoreResult<VaultItem> {
        self.guarded(|o| {
            let e = Self::find(o, id)?;
            Ok(VaultItem {
                id: e.id.clone(),
                title: e.title.clone(),
                username: e.username.clone(),
                password: e.password.clone(),
                url: e.url.clone(),
                notes: e.notes.clone(),
            })
        })
    }

    /// Just the password, for the clipboard, so it never passes through the interface.
    pub fn password(&self, id: &str) -> CoreResult<Zeroizing<String>> {
        self.guarded(|o| Ok(Zeroizing::new(Self::find(o, id)?.password.clone())))
    }

    pub fn save(&self, item: VaultItem) -> CoreResult<String> {
        self.guarded(|o| put(&o.vault, item))
    }

    pub fn remove(&self, id: &str) -> CoreResult<()> {
        self.guarded(|o| o.vault.remove(id).map_err(store))
    }

    /// From a CSV of the common shape; KeePass, Bitwarden and browsers all export one. Says how many
    /// came in. The file is the user's to delete afterwards.
    pub fn import_csv(&self, path: &Path) -> CoreResult<u32> {
        self.guarded(|o| {
            let mut r = csv::ReaderBuilder::new()
                .flexible(true)
                .from_path(path)
                .map_err(|e| CoreError::new("io", e.to_string()))?;
            let heads: Vec<String> = r
                .headers()
                .map_err(|e| CoreError::new("io", e.to_string()))?
                .iter()
                .map(str::to_lowercase)
                .collect();
            let column = |names: &[&str]| heads.iter().position(|h| names.contains(&h.as_str()));
            let title = column(&["title", "account", "name"]);
            let user = column(&[
                "username",
                "user name",
                "login name",
                "login_username",
                "login",
            ]);
            let pass = column(&["password", "login_password"]);
            let url = column(&["url", "web site", "website", "login_uri"]);
            let notes = column(&["notes", "comments", "note"]);
            let Some(pass) = pass else {
                return Err(CoreError::invalid("no password column"));
            };
            let mut n = 0;
            for row in r.records().flatten() {
                let cell =
                    |c: Option<usize>| c.and_then(|i| row.get(i)).unwrap_or_default().to_owned();
                put(
                    &o.vault,
                    VaultItem {
                        id: String::new(),
                        title: cell(title),
                        username: cell(user),
                        password: cell(Some(pass)),
                        url: cell(url),
                        notes: cell(notes),
                    },
                )?;
                n += 1;
            }
            Ok(n)
        })
    }

    /// Everything in the clear, in the columns KeePass can read. The interface asks first.
    pub fn export_csv(&self, path: &Path) -> CoreResult<u32> {
        self.guarded(|o| {
            let mut w =
                csv::Writer::from_path(path).map_err(|e| CoreError::new("io", e.to_string()))?;
            let io = |e: csv::Error| CoreError::new("io", e.to_string());
            w.write_record(["Title", "Username", "Password", "URL", "Notes"])
                .map_err(io)?;
            let entries = o.vault.entries().map_err(store)?;
            for e in &entries {
                w.write_record([&e.title, &e.username, &e.password, &e.url, &e.notes])
                    .map_err(io)?;
            }
            w.flush().map_err(|e| CoreError::new("io", e.to_string()))?;
            Ok(entries.len() as u32)
        })
    }
}

fn put(vault: &Vault, item: VaultItem) -> CoreResult<String> {
    let id = if item.id.is_empty() {
        uuid::Uuid::now_v7().to_string()
    } else {
        item.id.clone()
    };
    let mut e = VaultEntry::default();
    e.id.clone_from(&id);
    e.title = item.title;
    e.username = item.username;
    e.password = item.password;
    e.url = item.url;
    e.notes = item.notes;
    e.updated = jiff::Timestamp::now().as_millisecond();
    vault.put(&e).map_err(store)?;
    Ok(id)
}

/// A strong random password, from the system's random source.
pub fn generate_password(length: u32) -> String {
    const ALPHABET: &[u8] = b"abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789-_!@#$%^&*";
    let length = length.clamp(8, 128) as usize;
    let mut out = String::with_capacity(length);
    // Rejection sampling, so every character is equally likely.
    let limit = 256 - (256 % ALPHABET.len());
    while out.len() < length {
        let mut byte = [0u8; 1];
        dem_crypto::random_bytes(&mut byte);
        if (byte[0] as usize) < limit {
            out.push(ALPHABET[byte[0] as usize % ALPHABET.len()] as char);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const FAST: KdfParams = KdfParams::INSECURE_FOR_TESTS;

    fn item(title: &str, password: &str) -> VaultItem {
        VaultItem {
            title: title.into(),
            password: password.into(),
            ..Default::default()
        }
    }

    #[test]
    fn locked_means_no_access_and_lists_carry_no_passwords() {
        let dir = tempfile::tempdir().unwrap();
        let door = VaultDoor::default();
        assert!(door.rows().is_err());
        assert!(door.create(dir.path(), "short", FAST).is_err());
        door.create(dir.path(), "long-enough-pw", FAST).unwrap();
        let id = door.save(item("Bank", "zzsecretzz")).unwrap();
        let rows = serde_json::to_string(&door.rows().unwrap()).unwrap();
        assert!(rows.contains("Bank") && !rows.contains("zzsecretzz"));
        assert_eq!(door.item(&id).unwrap().password, "zzsecretzz");
        door.lock();
        assert_eq!(
            door.rows().err().map(|e| e.code),
            Some("vault-locked".into())
        );
        assert_eq!(
            door.unlock(dir.path(), "nope").err().map(|e| e.code),
            Some("wrong-password".into())
        );
        door.unlock(dir.path(), "long-enough-pw").unwrap();
        assert_eq!(door.password(&id).unwrap().as_str(), "zzsecretzz");
    }

    #[test]
    fn it_locks_itself_after_a_while() {
        let dir = tempfile::tempdir().unwrap();
        let door = VaultDoor::default();
        door.create(dir.path(), "long-enough-pw", FAST).unwrap();
        if let Ok(mut g) = door.0.lock()
            && let Some(o) = g.as_mut()
        {
            o.last_used = Instant::now() - AUTO_LOCK - Duration::from_secs(1);
        }
        assert!(!door.status(dir.path()).open);
        assert!(door.rows().is_err());
    }

    #[test]
    fn csv_goes_out_and_comes_back() {
        let dir = tempfile::tempdir().unwrap();
        let door = VaultDoor::default();
        door.create(dir.path(), "long-enough-pw", FAST).unwrap();
        door.save(item("Bank, Inc", "p\"w,1")).unwrap();
        let file = dir.path().join("out.csv");
        assert_eq!(door.export_csv(&file).unwrap(), 1);
        let other = tempfile::tempdir().unwrap();
        let second = VaultDoor::default();
        second.create(other.path(), "long-enough-pw", FAST).unwrap();
        assert_eq!(second.import_csv(&file).unwrap(), 1);
        let rows = second.rows().unwrap();
        assert_eq!(rows[0].title, "Bank, Inc");
        assert_eq!(second.item(&rows[0].id).unwrap().password, "p\"w,1");
    }

    #[test]
    fn generated_passwords_differ_and_have_the_length_asked() {
        let a = generate_password(24);
        assert_eq!(a.chars().count(), 24);
        assert_ne!(a, generate_password(24));
        assert_eq!(generate_password(1).len(), 8);
    }

    /// The AI's tools and the command line are built on `Session`. If one of them ever gains a path
    /// to the vault, this fails and someone has to look.
    #[test]
    fn nothing_the_ai_or_the_command_line_uses_mentions_the_vault() {
        for (name, source) in [
            ("ai_tools.rs", include_str!("ai_tools.rs")),
            ("ai_view.rs", include_str!("ai_view.rs")),
            ("cli.rs", include_str!("cli.rs")),
            ("session.rs", include_str!("session.rs")),
            ("export.rs", include_str!("export.rs")),
        ] {
            assert!(!source.contains("vault::"), "{name} reaches the vault");
            assert!(!source.contains("VaultDoor"), "{name} reaches the vault");
        }
    }
}
