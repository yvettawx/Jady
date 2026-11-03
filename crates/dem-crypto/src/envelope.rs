//! Whole-file envelope for small library files (format spec §5).
//!
//! ```text
//! offset  size  field
//! 0       4     magic "DEXF"
//! 4       2     envelope version, u16 little-endian (1)
//! 6       2     file key id, u16 little-endian
//! 8       24    XChaCha20 nonce (random)
//! 32      n+16  XChaCha20-Poly1305 ciphertext and tag
//! ```
//!
//! Associated data = the 32 header bytes ‖ 0x00 ‖ canonical library-relative path.
//! Authenticating the header prevents version/key-id tampering; authenticating the
//! path prevents moving a file to another location.

use chacha20poly1305::XNonce;
use chacha20poly1305::aead::{Aead, Payload};

use crate::keys::{FileKey, NONCE_LEN};
use crate::{CryptoError, Result, path, random_bytes};

pub const MAGIC: [u8; 4] = *b"DEXF";
pub const VERSION: u16 = 1;
pub const HEADER_LEN: usize = 32;
pub const TAG_LEN: usize = 16;

/// Header fields readable without a key (used by the format validator).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Header {
    pub version: u16,
    pub key_id: u16,
    pub nonce: [u8; NONCE_LEN],
}

impl Header {
    pub fn to_bytes(&self) -> [u8; HEADER_LEN] {
        let mut h = [0u8; HEADER_LEN];
        h[0..4].copy_from_slice(&MAGIC);
        h[4..6].copy_from_slice(&self.version.to_le_bytes());
        h[6..8].copy_from_slice(&self.key_id.to_le_bytes());
        h[8..32].copy_from_slice(&self.nonce);
        h
    }

    /// Parses and checks the header of an envelope. Does not authenticate anything.
    pub fn parse(data: &[u8]) -> Result<Header> {
        if data.len() < 4 || data[0..4] != MAGIC {
            return Err(CryptoError::BadMagic);
        }
        if data.len() < HEADER_LEN + TAG_LEN {
            return Err(CryptoError::Truncated);
        }
        let version = u16::from_le_bytes([data[4], data[5]]);
        if version != VERSION {
            return Err(CryptoError::UnsupportedVersion(version));
        }
        let key_id = u16::from_le_bytes([data[6], data[7]]);
        let mut nonce = [0u8; NONCE_LEN];
        nonce.copy_from_slice(&data[8..32]);
        Ok(Header {
            version,
            key_id,
            nonce,
        })
    }
}

pub(crate) fn associated_data(header: &[u8], canonical_path: &str) -> Vec<u8> {
    let mut aad = Vec::with_capacity(header.len() + 1 + canonical_path.len());
    aad.extend_from_slice(header);
    aad.push(0);
    aad.extend_from_slice(canonical_path.as_bytes());
    aad
}

/// Encrypts `plaintext` for storage at `path` (library-relative).
pub fn seal(key: &FileKey, path: &str, plaintext: &[u8]) -> Result<Vec<u8>> {
    let mut nonce = [0u8; NONCE_LEN];
    random_bytes(&mut nonce);
    seal_with_nonce(key, path, plaintext, nonce)
}

/// Deterministic variant for test vectors only. Reusing a nonce with the same key
/// breaks confidentiality; production code must call [`seal`].
#[doc(hidden)]
pub fn seal_with_nonce(
    key: &FileKey,
    path: &str,
    plaintext: &[u8],
    nonce: [u8; NONCE_LEN],
) -> Result<Vec<u8>> {
    let path = path::canonical(path)?;
    let header = Header {
        version: VERSION,
        key_id: key.id(),
        nonce,
    }
    .to_bytes();
    let aad = associated_data(&header, &path);
    let ct = key
        .cipher()
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: plaintext,
                aad: &aad,
            },
        )
        .map_err(|_| CryptoError::RecordTooLarge)?;
    let mut out = Vec::with_capacity(HEADER_LEN + ct.len());
    out.extend_from_slice(&header);
    out.extend_from_slice(&ct);
    Ok(out)
}

/// Decrypts a file read from `path`. Fails if the key, the path or any byte differs.
pub fn open(key: &FileKey, path: &str, data: &[u8]) -> Result<Vec<u8>> {
    let path = path::canonical(path)?;
    let header = Header::parse(data)?;
    if header.key_id != key.id() {
        return Err(CryptoError::UnknownKeyId(header.key_id));
    }
    let aad = associated_data(&data[..HEADER_LEN], &path);
    key.cipher()
        .decrypt(
            XNonce::from_slice(&header.nonce),
            Payload {
                msg: &data[HEADER_LEN..],
                aad: &aad,
            },
        )
        .map_err(|_| CryptoError::Decrypt)
}

#[cfg(test)]
mod tests {
    use proptest::prelude::*;

    use super::*;

    fn key() -> FileKey {
        FileKey::from_parts(1, [0x42; 32])
    }

    #[test]
    fn round_trip() {
        let sealed = seal(&key(), "items/ab/cd/x.dexm", b"hello").unwrap();
        assert_eq!(sealed.len(), HEADER_LEN + 5 + TAG_LEN);
        assert_eq!(
            open(&key(), "items/ab/cd/x.dexm", &sealed).unwrap(),
            b"hello"
        );
    }

    #[test]
    fn same_plaintext_encrypts_differently() {
        let a = seal(&key(), "a", b"same").unwrap();
        let b = seal(&key(), "a", b"same").unwrap();
        assert_ne!(a, b);
    }

    #[test]
    fn moved_file_fails() {
        let sealed = seal(&key(), "items/aa/x.dexm", b"hello").unwrap();
        assert_eq!(
            open(&key(), "items/bb/x.dexm", &sealed),
            Err(CryptoError::Decrypt)
        );
    }

    #[test]
    fn windows_path_spelling_is_equivalent() {
        let sealed = seal(&key(), r"items\aa\x.dexm", b"hello").unwrap();
        assert_eq!(open(&key(), "items/aa/x.dexm", &sealed).unwrap(), b"hello");
    }

    #[test]
    fn wrong_key_and_header_tampering_fail() {
        let sealed = seal(&key(), "a", b"hello").unwrap();
        let other = FileKey::from_parts(1, [0x43; 32]);
        assert_eq!(open(&other, "a", &sealed), Err(CryptoError::Decrypt));
        let rotated = FileKey::from_parts(2, [0x42; 32]);
        assert_eq!(
            open(&rotated, "a", &sealed),
            Err(CryptoError::UnknownKeyId(1))
        );
        let mut bad = sealed.clone();
        bad[0] = b'X';
        assert_eq!(open(&key(), "a", &bad), Err(CryptoError::BadMagic));
        assert_eq!(
            open(&key(), "a", &sealed[..20]),
            Err(CryptoError::Truncated)
        );
    }

    /// Known-answer test vector (also in the format spec appendix), computed
    /// independently with Python `cryptography` plus HChaCha20.
    #[test]
    fn known_answer() {
        let sealed = seal_with_nonce(&key(), "items/00/01/test.dexm", b"dem", [0x24; 24]).unwrap();
        assert_eq!(data_encoding::HEXLOWER.encode(&sealed), KAT_ENVELOPE);
    }

    const KAT_ENVELOPE: &str = "4445584601000100242424242424242424242424242424242424242424242424c13bbac9ae01175b3803d6c8e7084bc4b10775";

    proptest! {
        #[test]
        fn any_plaintext_round_trips(data in proptest::collection::vec(any::<u8>(), 0..4096)) {
            let sealed = seal(&key(), "p", &data).unwrap();
            prop_assert_eq!(open(&key(), "p", &sealed).unwrap(), data);
        }

        #[test]
        fn any_single_byte_change_is_detected(
            data in proptest::collection::vec(any::<u8>(), 0..256),
            pos in any::<prop::sample::Index>(),
            flip in 1u8..=255,
        ) {
            let mut sealed = seal(&key(), "p", &data).unwrap();
            let i = pos.index(sealed.len());
            sealed[i] ^= flip;
            prop_assert!(open(&key(), "p", &sealed).is_err());
        }
    }
}
