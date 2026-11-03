//! What can go wrong, in a form the interface can act on. A message never carries content: it can
//! end up on screen and in the diagnostic log.

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, thiserror::Error)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
#[error("{code}: {message}")]
pub struct CoreError {
    /// `locked`, `not-found`, `exists`, `in-use`, `invalid`, `wrong-password`, `io`, `import`…
    pub code: String,
    pub message: String,
}

impl CoreError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_owned(),
            message: message.into(),
        }
    }
    pub fn locked() -> Self {
        Self::new("locked", "the library is not open")
    }
    pub fn invalid(what: &str) -> Self {
        Self::new("invalid", what)
    }
}

pub type CoreResult<T> = Result<T, CoreError>;

impl From<dem_store::StoreError> for CoreError {
    fn from(e: dem_store::StoreError) -> Self {
        use dem_store::StoreError as S;
        let code = match &e {
            S::Locked => "in-use",
            S::NotFound(_) => "not-found",
            S::AlreadyExists(_) => "exists",
            S::TooNew(_) => "too-new",
            S::Manifest(_) | S::InvalidDocument(_) | S::Crdt(_) => "broken",
            S::Crypto(_) => "crypto",
            S::Io { .. } => "io",
        };
        Self::new(code, e.to_string())
    }
}

impl From<dem_index::IndexError> for CoreError {
    fn from(e: dem_index::IndexError) -> Self {
        Self::new("index", e.to_string())
    }
}

impl From<dem_io::IoError> for CoreError {
    fn from(e: dem_io::IoError) -> Self {
        Self::new("import", e.to_string())
    }
}
