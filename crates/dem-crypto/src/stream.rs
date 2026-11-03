//! Chunked encryption for large attachments (format spec §13), so a file never has
//! to fit in memory. Uses the STREAM construction (Hoang, Reyhanitabar, Rogaway,
//! Vizár) as implemented by RustCrypto's `aead::stream` (big-endian 32-bit counter
//! plus last-chunk flag), which detects reordered, dropped and truncated chunks.
//!
//! ```text
//! offset  size  field
//! 0       4     magic "DEXS"
//! 4       2     version, u16 LE (1)
//! 6       2     file key id, u16 LE
//! 8       4     plaintext chunk size, u32 LE (65536)
//! 12      19    nonce prefix (random)
//! 31      1     reserved, 0
//! 32      ...   chunks: each min(chunk size, remaining) + 16 bytes; the last chunk
//!               may be shorter, and an empty file has one empty last chunk
//! ```
//!
//! Every chunk's associated data = the 32 header bytes ‖ 0x00 ‖ canonical path.

use std::io::{Read, Write};

use chacha20poly1305::XChaCha20Poly1305;
use chacha20poly1305::aead::Payload;
use chacha20poly1305::aead::stream::{DecryptorBE32, EncryptorBE32};

use crate::envelope::{TAG_LEN, associated_data};
use crate::keys::FileKey;
use crate::{CryptoError, Result, path, random_bytes};

pub const MAGIC: [u8; 4] = *b"DEXS";
pub const VERSION: u16 = 1;
pub const HEADER_LEN: usize = 32;
pub const CHUNK_SIZE: u32 = 64 * 1024;
const PREFIX_LEN: usize = 19;
/// Refuse absurd chunk sizes from a corrupted header before allocating.
const MAX_CHUNK_SIZE: u32 = 16 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StreamHeader {
    pub version: u16,
    pub key_id: u16,
    pub chunk_size: u32,
    pub nonce_prefix: [u8; PREFIX_LEN],
}

impl StreamHeader {
    fn to_bytes(self) -> [u8; HEADER_LEN] {
        let mut h = [0u8; HEADER_LEN];
        h[0..4].copy_from_slice(&MAGIC);
        h[4..6].copy_from_slice(&self.version.to_le_bytes());
        h[6..8].copy_from_slice(&self.key_id.to_le_bytes());
        h[8..12].copy_from_slice(&self.chunk_size.to_le_bytes());
        h[12..31].copy_from_slice(&self.nonce_prefix);
        h
    }

    pub fn parse(h: &[u8]) -> Result<StreamHeader> {
        if h.len() < 4 || h[0..4] != MAGIC {
            return Err(CryptoError::BadMagic);
        }
        if h.len() < HEADER_LEN {
            return Err(CryptoError::Truncated);
        }
        let version = u16::from_le_bytes([h[4], h[5]]);
        if version != VERSION {
            return Err(CryptoError::UnsupportedVersion(version));
        }
        let chunk_size = u32::from_le_bytes([h[8], h[9], h[10], h[11]]);
        if chunk_size == 0 || chunk_size > MAX_CHUNK_SIZE || h[31] != 0 {
            return Err(CryptoError::Decrypt);
        }
        let mut nonce_prefix = [0u8; PREFIX_LEN];
        nonce_prefix.copy_from_slice(&h[12..31]);
        Ok(StreamHeader {
            version,
            key_id: u16::from_le_bytes([h[6], h[7]]),
            chunk_size,
            nonce_prefix,
        })
    }
}

/// Reads until `buf` is full or EOF; returns the number of bytes read.
fn read_full(r: &mut impl Read, buf: &mut [u8]) -> Result<usize> {
    let mut n = 0;
    while n < buf.len() {
        match r.read(&mut buf[n..]) {
            Ok(0) => break,
            Ok(k) => n += k,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e.into()),
        }
    }
    Ok(n)
}

/// Encrypts everything from `input` into `output`. Returns the plaintext length.
pub fn seal(
    key: &FileKey,
    path: &str,
    mut input: impl Read,
    mut output: impl Write,
) -> Result<u64> {
    let path = path::canonical(path)?;
    let mut nonce_prefix = [0u8; PREFIX_LEN];
    random_bytes(&mut nonce_prefix);
    let header = StreamHeader {
        version: VERSION,
        key_id: key.id(),
        chunk_size: CHUNK_SIZE,
        nonce_prefix,
    }
    .to_bytes();
    let aad = associated_data(&header, &path);
    output.write_all(&header)?;

    let mut enc =
        EncryptorBE32::<XChaCha20Poly1305>::from_aead(key.cipher(), (&nonce_prefix).into());
    let size = CHUNK_SIZE as usize;
    let mut cur = vec![0u8; size];
    let mut next = vec![0u8; size];
    let mut cur_len = read_full(&mut input, &mut cur)?;
    let mut total = 0u64;
    loop {
        // Look ahead one chunk to know whether the current one is the last.
        let next_len = if cur_len == size {
            read_full(&mut input, &mut next)?
        } else {
            0
        };
        total += cur_len as u64;
        if next_len == 0 {
            let ct = enc
                .encrypt_last(Payload {
                    msg: &cur[..cur_len],
                    aad: &aad,
                })
                .map_err(|_| CryptoError::RecordTooLarge)?;
            output.write_all(&ct)?;
            return Ok(total);
        }
        let ct = enc
            .encrypt_next(Payload {
                msg: &cur[..cur_len],
                aad: &aad,
            })
            .map_err(|_| CryptoError::RecordTooLarge)?;
        output.write_all(&ct)?;
        std::mem::swap(&mut cur, &mut next);
        cur_len = next_len;
    }
}

/// Decrypts a stream written by [`seal`]. Output written before an error must be
/// discarded by the caller (write to a temporary file, then rename on success).
pub fn open(
    key: &FileKey,
    path: &str,
    mut input: impl Read,
    mut output: impl Write,
) -> Result<u64> {
    let path = path::canonical(path)?;
    let mut header = [0u8; HEADER_LEN];
    let n = read_full(&mut input, &mut header)?;
    let parsed = StreamHeader::parse(&header[..n])?;
    if parsed.key_id != key.id() {
        return Err(CryptoError::UnknownKeyId(parsed.key_id));
    }
    let aad = associated_data(&header, &path);
    let mut dec =
        DecryptorBE32::<XChaCha20Poly1305>::from_aead(key.cipher(), (&parsed.nonce_prefix).into());

    let size = parsed.chunk_size as usize + TAG_LEN;
    let mut cur = vec![0u8; size];
    let mut next = vec![0u8; size];
    let mut cur_len = read_full(&mut input, &mut cur)?;
    let mut total = 0u64;
    loop {
        if cur_len < TAG_LEN {
            return Err(CryptoError::Truncated);
        }
        let next_len = if cur_len == size {
            read_full(&mut input, &mut next)?
        } else {
            0
        };
        if next_len == 0 {
            let pt = dec
                .decrypt_last(Payload {
                    msg: &cur[..cur_len],
                    aad: &aad,
                })
                .map_err(|_| CryptoError::Decrypt)?;
            output.write_all(&pt)?;
            return Ok(total + pt.len() as u64);
        }
        let pt = dec
            .decrypt_next(Payload {
                msg: &cur[..cur_len],
                aad: &aad,
            })
            .map_err(|_| CryptoError::Decrypt)?;
        output.write_all(&pt)?;
        total += pt.len() as u64;
        std::mem::swap(&mut cur, &mut next);
        cur_len = next_len;
    }
}

#[cfg(test)]
mod tests {
    use proptest::prelude::*;

    use super::*;

    fn key() -> FileKey {
        FileKey::from_parts(1, [0x42; 32])
    }

    fn roundtrip(data: &[u8]) -> Vec<u8> {
        let mut sealed = Vec::new();
        assert_eq!(
            seal(&key(), "blobs/ab/x", data, &mut sealed).unwrap(),
            data.len() as u64
        );
        let mut out = Vec::new();
        open(&key(), "blobs/ab/x", &sealed[..], &mut out).unwrap();
        out
    }

    #[test]
    fn boundary_sizes_round_trip() {
        let c = CHUNK_SIZE as usize;
        for len in [0, 1, c - 1, c, c + 1, 2 * c, 3 * c + 7] {
            let data: Vec<u8> = (0..len).map(|i| (i % 251) as u8).collect();
            assert_eq!(roundtrip(&data), data, "len {len}");
        }
    }

    #[test]
    fn truncation_and_reordering_are_detected() {
        let c = CHUNK_SIZE as usize;
        let data = vec![9u8; 3 * c];
        let mut sealed = Vec::new();
        seal(&key(), "b", &data[..], &mut sealed).unwrap();
        let chunk = c + TAG_LEN;

        // Drop the last chunk: the new final chunk is not marked "last".
        let cut = &sealed[..HEADER_LEN + 2 * chunk];
        assert!(open(&key(), "b", cut, &mut Vec::new()).is_err());

        // Swap the first two chunks.
        let mut swapped = sealed.clone();
        let (a, b) = (HEADER_LEN, HEADER_LEN + chunk);
        let first = sealed[a..b].to_vec();
        swapped[a..b].copy_from_slice(&sealed[b..b + chunk]);
        swapped[b..b + chunk].copy_from_slice(&first);
        assert!(open(&key(), "b", &swapped[..], &mut Vec::new()).is_err());

        // Wrong path.
        assert!(open(&key(), "c", &sealed[..], &mut Vec::new()).is_err());
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(32))]
        #[test]
        fn any_byte_change_is_detected(
            len in 0usize..(2 * CHUNK_SIZE as usize + 100),
            pos in any::<prop::sample::Index>(),
            flip in 1u8..=255,
        ) {
            let data = vec![1u8; len];
            let mut sealed = Vec::new();
            seal(&key(), "b", &data[..], &mut sealed).unwrap();
            let i = pos.index(sealed.len());
            sealed[i] ^= flip;
            prop_assert!(open(&key(), "b", &sealed[..], &mut Vec::new()).is_err());
        }
    }
}
