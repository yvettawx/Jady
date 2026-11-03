//! Attachments (format spec §13): content-addressed by a keyed hash, encrypted in
//! chunks, immutable.

/// Attachment name: 64 lowercase hex characters.
pub type BlobName = String;
