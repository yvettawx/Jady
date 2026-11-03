//! Keyless structural checks of encrypted files, for the format validator
//! (format spec §18 items 4–6). Nothing here authenticates data; it only tells
//! whether the framing is well-formed, so a damaged file can be reported without a
//! key and fault injection can find record boundaries without parsing bytes itself.

use crate::envelope::TAG_LEN;
use crate::keys::NONCE_LEN;
use crate::records::{self, MAX_RECORD_LEN, SegmentHeader};
use crate::stream::{self, StreamHeader};
use crate::{CryptoError, Result};

/// Byte range of one framed record in a log segment (length prefix included).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RecordSpan {
    /// Offset of the 4-byte length prefix.
    pub offset: usize,
    /// Length of the whole frame: 4 + nonce + ciphertext + tag.
    pub len: usize,
}

impl RecordSpan {
    /// Offset of the first ciphertext byte (after the length and the nonce).
    pub fn ciphertext_offset(&self) -> usize {
        self.offset + 4 + NONCE_LEN
    }
}

/// Framing of a log segment, read without a key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SegmentShape {
    pub header: SegmentHeader,
    /// Complete records, in order.
    pub records: Vec<RecordSpan>,
    /// Offset of a length field outside the allowed range; everything from here on
    /// cannot be framed (corruption, not a torn tail).
    pub bad_length_at: Option<usize>,
    /// Bytes at the end that do not form a complete record (an interrupted append).
    pub torn_tail_bytes: usize,
}

/// Walks the record frames of a segment exactly as [`records::open_segment`] does.
pub fn segment_shape(data: &[u8]) -> Result<SegmentShape> {
    let header = records::parse_segment_header(data)?;
    let mut spans = Vec::new();
    let mut pos = records::HEADER_LEN;
    let mut bad_length_at = None;
    while pos < data.len() {
        let rest = &data[pos..];
        if rest.len() < 4 {
            break;
        }
        let len = u32::from_le_bytes([rest[0], rest[1], rest[2], rest[3]]) as usize;
        if !(NONCE_LEN + TAG_LEN..=MAX_RECORD_LEN).contains(&len) {
            bad_length_at = Some(pos);
            pos = data.len();
            break;
        }
        if rest.len() < 4 + len {
            break;
        }
        spans.push(RecordSpan {
            offset: pos,
            len: 4 + len,
        });
        pos += 4 + len;
    }
    Ok(SegmentShape {
        header,
        records: spans,
        bad_length_at,
        torn_tail_bytes: data.len() - pos,
    })
}

/// Parses an attachment header and checks that the total file length matches the
/// chunking rule of format spec §13: full chunks of `chunk_size + 16` bytes and one
/// final chunk of 16 to `chunk_size + 16` bytes (exactly 16 only for an empty file).
pub fn stream_shape(data_prefix: &[u8], file_len: u64) -> Result<StreamHeader> {
    let header = StreamHeader::parse(data_prefix)?;
    let body = file_len
        .checked_sub(stream::HEADER_LEN as u64)
        .ok_or(CryptoError::Truncated)?;
    let full = u64::from(header.chunk_size) + TAG_LEN as u64;
    let tag = TAG_LEN as u64;
    let (whole, rest) = (body / full, body % full);
    let ok = match rest {
        0 => whole >= 1,
        r if r == tag => whole == 0,
        r => r > tag,
    };
    if ok {
        Ok(header)
    } else {
        Err(CryptoError::Truncated)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::FileKey;

    fn key() -> FileKey {
        FileKey::from_parts(1, [0x42; 32])
    }

    fn segment(n: usize) -> Vec<u8> {
        let k = key();
        let header = records::new_segment_header(&k);
        let mut data = header.to_vec();
        for i in 0..n {
            data.extend(records::seal_record(&k, &header, "logs/a", i as u64, b"rec").unwrap());
        }
        data
    }

    #[test]
    fn frames_match_open_segment() {
        let data = segment(3);
        let shape = segment_shape(&data).unwrap();
        assert_eq!(shape.records.len(), 3);
        assert_eq!(shape.torn_tail_bytes, 0);
        assert_eq!(shape.bad_length_at, None);
        let last = shape.records[2];
        assert_eq!(last.offset + last.len, data.len());

        let cut = &data[..data.len() - 3];
        let shape = segment_shape(cut).unwrap();
        assert_eq!(shape.records.len(), 2);
        let seg = records::open_segment(&key(), "logs/a", cut).unwrap();
        assert_eq!(shape.torn_tail_bytes, seg.torn_tail_bytes);
    }

    #[test]
    fn bad_length_is_reported() {
        let mut data = segment(2);
        let second = segment_shape(&data).unwrap().records[1].offset;
        data[second..second + 4].copy_from_slice(&3u32.to_le_bytes());
        let shape = segment_shape(&data).unwrap();
        assert_eq!(shape.records.len(), 1);
        assert_eq!(shape.bad_length_at, Some(second));
        assert!(segment_shape(b"XXXX").is_err());
    }

    #[test]
    fn stream_length_rule() {
        let c = stream::CHUNK_SIZE as usize;
        for len in [0, 1, c - 1, c, c + 1, 2 * c, 2 * c + 5] {
            let mut sealed = Vec::new();
            stream::seal(&key(), "b", &vec![7u8; len][..], &mut sealed).unwrap();
            let n = sealed.len() as u64;
            assert!(stream_shape(&sealed, n).is_ok(), "len {len}");
        }
        let mut sealed = Vec::new();
        stream::seal(&key(), "b", &b""[..], &mut sealed).unwrap();
        let full = (c + TAG_LEN) as u64;
        // A last chunk shorter than a tag, or an empty last chunk after full ones.
        for bad in [32 + 15, 32 + full + 3, 32 + full + 16, 31] {
            assert!(stream_shape(&sealed, bad).is_err(), "{bad}");
        }
        for good in [32 + 16, 32 + full, 32 + full + 17, 32 + 2 * full] {
            assert!(stream_shape(&sealed, good).is_ok(), "{good}");
        }
        assert!(stream_shape(&sealed[..10], 10).is_err());
    }
}
