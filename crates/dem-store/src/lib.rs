//! Library directory layout, CRDT item documents, attachments, logs and version
//! history. Implements `docs/format-spec.md`; the spec wins on any disagreement.
//!
//! Only `dem-core` (and, for debugging, `dem-devtools`) may use this crate; the UI
//! and the AI gateway go through `dem-core`.

mod atomic;
pub mod blobs;
pub mod check;
pub mod export;
pub mod item;
pub mod layout;
pub mod library;
pub mod logs;
pub mod manifest;
mod markdown;
pub mod structure;
pub mod vault;

pub use item::{ChangeInfo, ItemDoc};
pub use layout::{FileKind, LibraryFile};
pub use library::{Library, Unlock};
pub use structure::{NodeKind, StructureDoc};

/// Storage format version written to `manifest.json`. Bumping it requires a migration
/// (see `docs/format-spec.md` §17).
pub const FORMAT_VERSION: u32 = 1;

/// Logical schema version inside every CRDT document (`dem.schema`).
pub const DOC_SCHEMA: i64 = 1;

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("io error at {path}: {source}")]
    Io {
        path: String,
        #[source]
        source: std::io::Error,
    },
    #[error(transparent)]
    Crypto(#[from] dem_crypto::CryptoError),
    #[error("CRDT error: {0}")]
    Crdt(String),
    #[error("invalid manifest: {0}")]
    Manifest(String),
    #[error("library format version {0} is newer than this build supports")]
    TooNew(u32),
    #[error("library is already open in another process")]
    Locked,
    #[error("not found: {0}")]
    NotFound(String),
    #[error("a library already exists at {0}")]
    AlreadyExists(String),
    #[error("invalid document: {0}")]
    InvalidDocument(String),
}

pub type Result<T> = std::result::Result<T, StoreError>;

pub(crate) fn io_err(path: &std::path::Path) -> impl FnOnce(std::io::Error) -> StoreError + '_ {
    move |source| StoreError::Io {
        path: path.display().to_string(),
        source,
    }
}

impl From<loro::LoroError> for StoreError {
    fn from(e: loro::LoroError) -> Self {
        StoreError::Crdt(e.to_string())
    }
}

impl From<loro::LoroEncodeError> for StoreError {
    fn from(e: loro::LoroEncodeError) -> Self {
        StoreError::Crdt(e.to_string())
    }
}
