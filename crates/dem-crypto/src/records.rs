//! Per-record encryption for append-only log segments (format spec §12).
//!
//! ```text
//! segment header (32 bytes):
//!   0   4   magic "DEXL"
//!   4   2   version, u16 LE (1)
//!   6   2   file key id, u16 LE
//!   8   24  segment salt (random, written once when the segment is created)
//! then records, each:
//!   0   4   length n of the rest of the record, u32 LE
//!   4   24  XChaCha20 nonce (random)
//!   28  n-24 ciphertext and tag
//! ```
//!
//! Record associated data = segment header ‖ 0x00 ‖ canonical path ‖ 0x00 ‖ record
//! sequence number (u64 LE, 0-based). Records can be appended without rewriting the
//! file, cannot be moved to another segment or position, and a record cut short by a
//! crash is recognised as a torn tail rather than corruption.

use chacha20poly1305::XNonce;
use chacha20poly1305::aead::{Aead, Payload};

use crate::envelope::{TAG_LEN, associated_data};
use crate::keys::{FileKey, NONCE_LEN};
use crate::{CryptoError, Result, path, random_bytes};

pub const MAGIC: [u8; 4] = *b"DEXL";
pub const VERSION: u16 = 1;
pub const HEADER_LEN: usize = 32;
pub const MAX_RECORD_LEN: usize = 16 * 1024 * 1024;

/// Creates the header bytes of a new segment.
pub fn new_segment_header(key: &FileKey) -> [u8; HEADER_LEN] {
    let mut h = [0u8; HEADER_LEN];
    h[0..4].copy_from_slice(&MAGIC);
    h[4..6].copy_from_slice(&VERSION.to_le_bytes());
    h[6..8].copy_from_slice(&key.id().to_le_bytes());
    random_bytes(&mut h[8..32]);
    h
}

/// Header fields readable without a key.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SegmentHeader {
    pub version: u16,
    pub key_id: u16,
}

pub fn parse_segment_header(data: &[u8]) -> Result<SegmentHeader> {
    if data.len() < 4 || data[0..4] != MAGIC {
        return Err(CryptoError::BadMagic);
    }
    if data.len() < HEADER_LEN {
        return Err(CryptoError::Truncated);
    }
    let version = u16::from_le_bytes([data[4], data[5]]);
    if version != VERSION {
        return Err(CryptoError::UnsupportedVersion(version));
    }
    Ok(SegmentHeader {
        version,
        key_id: u16::from_le_bytes([data[6], data[7]]),
    })
}

fn record_aad(header: &[u8], path: &str, seq: u64) -> Vec<u8> {
    let mut aad = associated_data(header, path);
    aad.push(0);
    aad.extend_from_slice(&seq.to_le_bytes());
    aad
}

/// Encrypts one record for appending as record number `seq` of the segment.
pub fn seal_record(
    key: &FileKey,
    header: &[u8; HEADER_LEN],
    path: &str,
    seq: u64,
    plaintext: &[u8],
) -> Result<Vec<u8>> {
    let path = path::canonical(path)?;
    if plaintext.len() + NONCE_LEN + TAG_LEN > MAX_RECORD_LEN {
        return Err(CryptoError::RecordTooLarge);
    }
    let mut nonce = [0u8; NONCE_LEN];
    random_bytes(&mut nonce);
    let aad = record_aad(header, &path, seq);
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
    let body_len = (NONCE_LEN + ct.len()) as u32;
    let mut out = Vec::with_capacity(4 + body_len as usize);
    out.extend_from_slice(&body_len.to_le_bytes());
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ct);
    Ok(out)
}

/// Result of reading a whole segment.
#[derive(Debug)]
pub struct Segment {
    /// One entry per complete record, in order. A damaged record yields an error at
    /// its position; the records around it are still readable.
    pub records: Vec<Result<Vec<u8>>>,
    /// Bytes at the end that do not form a complete record (an interrupted append).
    pub torn_tail_bytes: usize,
}

pub fn open_segment(key: &FileKey, path: &str, data: &[u8]) -> Result<Segment> {
    let path = path::canonical(path)?;
    let header = parse_segment_header(data)?;
    if header.key_id != key.id() {
        return Err(CryptoError::UnknownKeyId(header.key_id));
    }
    let head = &data[..HEADER_LEN];
    let cipher = key.cipher();
    let mut records = Vec::new();
    let mut pos = HEADER_LEN;
    let mut seq = 0u64;
    while pos < data.len() {
        let rest = &data[pos..];
        if rest.len() < 4 {
            break;
        }
        let len = u32::from_le_bytes([rest[0], rest[1], rest[2], rest[3]]) as usize;
        if !(NONCE_LEN + TAG_LEN..=MAX_RECORD_LEN).contains(&len) {
            // A corrupted length makes the rest of the segment unparseable.
            records.push(Err(CryptoError::Decrypt));
            pos = data.len();
            break;
        }
        if rest.len() < 4 + len {
            break;
        }
        let body = &rest[4..4 + len];
        let aad = record_aad(head, &path, seq);
        records.push(
            cipher
                .decrypt(
                    XNonce::from_slice(&body[..NONCE_LEN]),
                    Payload {
                        msg: &body[NONCE_LEN..],
                        aad: &aad,
                    },
                )
                .map_err(|_| CryptoError::Decrypt),
        );
        pos += 4 + len;
        seq += 1;
    }
    Ok(Segment {
        records,
        torn_tail_bytes: data.len() - pos,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key() -> FileKey {
        FileKey::from_parts(1, [0x42; 32])
    }

    fn segment(n: usize) -> Vec<u8> {
        let k = key();
        let header = new_segment_header(&k);
        let mut data = header.to_vec();
        for i in 0..n {
            let msg = format!("record {i}");
            data.extend(
                seal_record(
                    &k,
                    &header,
                    "logs/activity/2026-10",
                    i as u64,
                    msg.as_bytes(),
                )
                .unwrap(),
            );
        }
        data
    }

    fn ok_records(s: &Segment) -> Vec<String> {
        s.records
            .iter()
            .map(|r| String::from_utf8(r.clone().unwrap()).unwrap())
            .collect()
    }

    #[test]
    fn append_and_read_back() {
        let s = open_segment(&key(), "logs/activity/2026-10", &segment(3)).unwrap();
        assert_eq!(ok_records(&s), ["record 0", "record 1", "record 2"]);
        assert_eq!(s.torn_tail_bytes, 0);
    }

    #[test]
    fn torn_tail_is_not_corruption() {
        let full = segment(3);
        let cut = &full[..full.len() - 5];
        let s = open_segment(&key(), "logs/activity/2026-10", cut).unwrap();
        assert_eq!(ok_records(&s), ["record 0", "record 1"]);
        assert!(s.torn_tail_bytes > 0);
    }

    #[test]
    fn damaged_record_is_isolated() {
        let mut data = segment(3);
        // Flip a ciphertext byte inside the second record.
        let first_len = 4 + u32::from_le_bytes(data[32..36].try_into().unwrap()) as usize;
        data[32 + first_len + 40] ^= 1;
        let s = open_segment(&key(), "logs/activity/2026-10", &data).unwrap();
        assert!(s.records[0].is_ok());
        assert!(s.records[1].is_err());
        assert!(s.records[2].is_ok());
    }

    #[test]
    fn records_cannot_be_reordered_or_moved() {
        let k = key();
        let header = new_segment_header(&k);
        let r0 = seal_record(&k, &header, "logs/a", 0, b"zero").unwrap();
        let r1 = seal_record(&k, &header, "logs/a", 1, b"one").unwrap();
        let swapped = [header.to_vec(), r1.clone(), r0.clone()].concat();
        let s = open_segment(&k, "logs/a", &swapped).unwrap();
        assert!(s.records.iter().all(Result::is_err));
        // Same records under another segment header (another segment).
        let other = new_segment_header(&k);
        let moved = [other.to_vec(), r0, r1].concat();
        let s = open_segment(&k, "logs/a", &moved).unwrap();
        assert!(s.records.iter().all(Result::is_err));
    }
}
