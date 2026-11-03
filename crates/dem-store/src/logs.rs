//! Append-only logs (format spec §12): one segment per kind, month and device,
//! each record encrypted on its own.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::{Result, StoreError};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogKind {
    Activity,
    Review,
    AiAccess,
}

impl LogKind {
    pub fn as_str(self) -> &'static str {
        match self {
            LogKind::Activity => "activity",
            LogKind::Review => "review",
            LogKind::AiAccess => "ai-access",
        }
    }
}

/// Fields that must never appear in a log record (no content in logs).
pub const FORBIDDEN_FIELDS: &[&str] = &[
    "body", "title", "text", "content", "query", "password", "key", "secret",
];

/// One log record: common fields plus kind-specific ones.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LogRecord {
    pub v: u32,
    pub ts: jiff::Timestamp,
    pub kind: String,
    #[serde(flatten)]
    pub fields: Map<String, Value>,
}

impl LogRecord {
    pub fn new(kind: LogKind, fields: Map<String, Value>) -> LogRecord {
        LogRecord {
            v: 1,
            ts: jiff::Timestamp::now(),
            kind: kind.as_str().to_owned(),
            fields,
        }
    }

    /// Rejects records carrying content-like fields before they reach the disk.
    pub fn check(&self) -> Result<()> {
        match self
            .fields
            .keys()
            .find(|k| FORBIDDEN_FIELDS.contains(&k.as_str()))
        {
            Some(k) => Err(StoreError::InvalidDocument(format!(
                "log record must not contain {k:?}"
            ))),
            None => Ok(()),
        }
    }
}

/// `yyyy-mm` of a timestamp in UTC.
pub fn month_of(ts: jiff::Timestamp) -> String {
    let dt = ts.to_zoned(jiff::tz::TimeZone::UTC);
    format!("{:04}-{:02}", dt.year(), dt.month())
}
