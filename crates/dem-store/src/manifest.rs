//! `manifest.json` (format spec §3): the only plaintext file, holding what is
//! needed to unlock the library. Unknown fields are preserved on rewrite.

use dem_crypto::keys::{KdfParams, NONCE_LEN, SALT_LEN, WrappedKey};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::{FORMAT_VERSION, Result, StoreError};

pub const FORMAT_NAME: &str = "dem-library";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KdfSection {
    pub alg: String,
    pub version: u32,
    pub m_kib: u32,
    pub t: u32,
    pub p: u32,
    pub salt: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WrappedKeyEntry {
    pub kind: String,
    pub nonce: String,
    pub ciphertext: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Manifest {
    pub format: String,
    pub format_version: u32,
    pub library_id: uuid::Uuid,
    pub created: jiff::Timestamp,
    pub kdf: KdfSection,
    pub wrapped_keys: Vec<WrappedKeyEntry>,
    pub file_key_ids: Vec<u16>,
    pub current_file_key_id: u16,
    /// Fields written by newer versions, kept verbatim.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

fn b64(bytes: &[u8]) -> String {
    data_encoding::BASE64.encode(bytes)
}

fn unb64(s: &str, what: &str) -> Result<Vec<u8>> {
    data_encoding::BASE64
        .decode(s.as_bytes())
        .map_err(|_| StoreError::Manifest(format!("bad base64 in {what}")))
}

impl Manifest {
    pub fn parse(bytes: &[u8]) -> Result<Manifest> {
        let m: Manifest =
            serde_json::from_slice(bytes).map_err(|e| StoreError::Manifest(e.to_string()))?;
        if m.format != FORMAT_NAME {
            return Err(StoreError::Manifest(format!(
                "unknown format {:?}",
                m.format
            )));
        }
        if m.format_version > FORMAT_VERSION {
            return Err(StoreError::TooNew(m.format_version));
        }
        if m.kdf.alg != "argon2id" || m.kdf.version != 0x13 {
            return Err(StoreError::Manifest("unsupported KDF".into()));
        }
        if !m.file_key_ids.contains(&m.current_file_key_id) {
            return Err(StoreError::Manifest(
                "current file key id not listed".into(),
            ));
        }
        m.salt()?;
        Ok(m)
    }

    pub fn to_json(&self) -> Result<Vec<u8>> {
        let mut v =
            serde_json::to_vec_pretty(self).map_err(|e| StoreError::Manifest(e.to_string()))?;
        v.push(b'\n');
        Ok(v)
    }

    pub fn library_id_bytes(&self) -> [u8; 16] {
        *self.library_id.as_bytes()
    }

    pub fn kdf_params(&self) -> KdfParams {
        KdfParams {
            m_kib: self.kdf.m_kib,
            t: self.kdf.t,
            p: self.kdf.p,
        }
    }

    pub fn salt(&self) -> Result<[u8; SALT_LEN]> {
        unb64(&self.kdf.salt, "kdf.salt")?
            .try_into()
            .map_err(|_| StoreError::Manifest("kdf.salt must be 16 bytes".into()))
    }

    /// Everything an attacker could alter that weakens or redirects unlocking
    /// (format spec §4.3): library id ‖ m ‖ t ‖ p ‖ salt.
    pub fn password_binding(&self) -> Result<Vec<u8>> {
        let mut b = self.library_id_bytes().to_vec();
        b.extend_from_slice(&self.kdf.m_kib.to_le_bytes());
        b.extend_from_slice(&self.kdf.t.to_le_bytes());
        b.extend_from_slice(&self.kdf.p.to_le_bytes());
        b.extend_from_slice(&self.salt()?);
        Ok(b)
    }

    pub fn recovery_binding(&self) -> Vec<u8> {
        self.library_id_bytes().to_vec()
    }

    pub fn wrapped(&self, kind: &str) -> Result<WrappedKey> {
        let e = self
            .wrapped_keys
            .iter()
            .find(|w| w.kind == kind)
            .ok_or_else(|| StoreError::Manifest(format!("no {kind} key")))?;
        let nonce: [u8; NONCE_LEN] = unb64(&e.nonce, "nonce")?
            .try_into()
            .map_err(|_| StoreError::Manifest("nonce must be 24 bytes".into()))?;
        Ok(WrappedKey {
            nonce,
            ciphertext: unb64(&e.ciphertext, "ciphertext")?,
        })
    }

    pub fn set_wrapped(&mut self, kind: &str, w: &WrappedKey) {
        self.wrapped_keys.retain(|e| e.kind != kind);
        self.wrapped_keys.push(WrappedKeyEntry {
            kind: kind.to_owned(),
            nonce: b64(&w.nonce),
            ciphertext: b64(&w.ciphertext),
        });
    }

    pub fn new(library_id: uuid::Uuid, params: KdfParams, salt: &[u8; SALT_LEN]) -> Manifest {
        Manifest {
            format: FORMAT_NAME.to_owned(),
            format_version: FORMAT_VERSION,
            library_id,
            created: jiff::Timestamp::now(),
            kdf: KdfSection {
                alg: "argon2id".into(),
                version: 0x13,
                m_kib: params.m_kib,
                t: params.t,
                p: params.p,
                salt: b64(salt),
            },
            wrapped_keys: Vec::new(),
            file_key_ids: vec![dem_crypto::keys::CURRENT_FILE_KEY_ID],
            current_file_key_id: dem_crypto::keys::CURRENT_FILE_KEY_ID,
            extra: Map::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_fields_survive_a_round_trip() {
        let mut m = Manifest::new(
            uuid::Uuid::now_v7(),
            KdfParams::INSECURE_FOR_TESTS,
            &[1; 16],
        );
        m.extra.insert("future_field".into(), Value::from(42));
        let parsed = Manifest::parse(&m.to_json().unwrap()).unwrap();
        assert_eq!(parsed.extra["future_field"], 42);
    }

    #[test]
    fn newer_format_is_refused() {
        let mut m = Manifest::new(
            uuid::Uuid::now_v7(),
            KdfParams::INSECURE_FOR_TESTS,
            &[1; 16],
        );
        m.format_version = FORMAT_VERSION + 1;
        assert!(matches!(
            Manifest::parse(&m.to_json().unwrap()),
            Err(StoreError::TooNew(_))
        ));
    }
}
