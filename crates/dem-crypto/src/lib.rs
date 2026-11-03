//! Key hierarchy and encryption envelopes (format: `docs/format-spec.md` §4, §5,
//! §12, §13). Wraps audited RustCrypto libraries only; implements no primitives.
//!
//! - [`keys`]: library master key, password and recovery-code wrapping, subkeys.
//! - [`envelope`]: whole-file encryption for small files (items, types, links).
//! - [`stream`]: chunked encryption for large attachments.
//! - [`records`]: per-record encryption for append-only log segments.
//! - [`path`]: the canonical library-relative path that is bound into every envelope.

pub mod envelope;
pub mod keys;
pub mod path;
pub mod records;
pub mod shape;
pub mod stream;

pub use keys::{
    BlobNameKey, FileKey, IndexKey, KdfParams, MasterKey, RecoveryCode, Subkeys, WrappedKey,
};

#[derive(Debug, Clone, thiserror::Error, PartialEq, Eq)]
pub enum CryptoError {
    /// Wrong key, wrong path, or the data was modified. Deliberately undistinguished.
    #[error("decryption failed: wrong key or corrupted data")]
    Decrypt,
    #[error("not an encrypted library file (bad magic)")]
    BadMagic,
    #[error("unsupported envelope version {0}")]
    UnsupportedVersion(u16),
    #[error("unknown key id {0}")]
    UnknownKeyId(u16),
    #[error("file is truncated")]
    Truncated,
    #[error("invalid library path: {0}")]
    InvalidPath(&'static str),
    #[error("invalid recovery code")]
    InvalidRecoveryCode,
    #[error("key derivation failed: {0}")]
    Kdf(String),
    #[error("record too large")]
    RecordTooLarge,
    #[error("io error: {0}")]
    Io(String),
}

impl From<std::io::Error> for CryptoError {
    fn from(e: std::io::Error) -> Self {
        CryptoError::Io(e.to_string())
    }
}

pub type Result<T> = std::result::Result<T, CryptoError>;

/// Fills `buf` from the operating system's CSPRNG.
/// A fingerprint of some bytes, to tell whether two copies are the same. Hex SHA-256.
pub fn content_hash(data: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    data_encoding::HEXLOWER.encode(&Sha256::digest(data))
}

pub fn random_bytes(buf: &mut [u8]) {
    use rand_core::RngCore;
    rand_core::OsRng.fill_bytes(buf);
}

pub fn random_u64() -> u64 {
    let mut b = [0u8; 8];
    random_bytes(&mut b);
    u64::from_le_bytes(b)
}

/// Shard directory for a file stem (format spec §2.1): the first byte of
/// SHA-256(stem) as two lowercase hex digits. Not a secret; it only spreads files.
pub fn shard(stem: &str) -> String {
    use sha2::{Digest, Sha256};
    let h = Sha256::digest(stem.as_bytes());
    format!("{:02x}", h[0])
}

#[cfg(test)]
mod tests {
    #[test]
    fn shard_is_stable() {
        // SHA-256("abc") = ba7816bf...
        assert_eq!(super::shard("abc"), "ba");
    }
}
