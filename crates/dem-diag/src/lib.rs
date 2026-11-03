//! Local diagnostic logging that never records content or secrets.
//!
//! Logs are JSON lines in daily-rotated files on this machine only; nothing is
//! uploaded. Two independent mechanisms keep content and secrets out:
//!
//! 1. [`Sensitive`] wraps a value so its `Debug` and `Display` print `[redacted]`.
//!    Content types (item bodies, titles) and key material implement their own
//!    `Debug` the same way.
//! 2. The writer layer replaces the value of any field whose *name* looks like
//!    content or a secret (`body`, `title`, `password`, `*_key`, ...) with
//!    `[redacted]`, so `info!(title = %t)` is safe even without a wrapper.
//!
//! What this cannot catch: content interpolated into the message string itself
//! (`info!("opened {}", title)`). The convention is that messages are constant
//! text and all variable data goes into named fields.

mod layer;
mod read;

use std::fmt;
use std::path::PathBuf;

pub use layer::JsonLayer;
pub use read::{LogEntry, read_entries};

/// Wraps a value that must never appear in logs.
#[derive(Clone, Copy, PartialEq, Eq, Default)]
pub struct Sensitive<T>(pub T);

impl<T> fmt::Debug for Sensitive<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(REDACTED)
    }
}

impl<T> fmt::Display for Sensitive<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(REDACTED)
    }
}

/// Placeholder written instead of any redacted value.
pub const REDACTED: &str = "[redacted]";

/// Field names whose values are always redacted, matched case-insensitively
/// as the whole name, a `_`-separated prefix, or a `_`-separated suffix.
const REDACTED_FIELD_WORDS: &[&str] = &[
    "body",
    "content",
    "text",
    "title",
    "plaintext",
    "password",
    "passphrase",
    "secret",
    "key",
    "token",
    "recovery",
    "query",
];

pub(crate) fn is_redacted_field(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    REDACTED_FIELD_WORDS.iter().any(|w| {
        name == *w
            || name.starts_with(&format!("{w}_"))
            || name.ends_with(&format!("_{w}"))
            || name.contains(&format!("_{w}_"))
    })
}

#[derive(Debug, thiserror::Error)]
pub enum DiagError {
    #[error("cannot create log directory: {0}")]
    CreateDir(#[source] std::io::Error),
    #[error("cannot open log file: {0}")]
    Appender(String),
    #[error("a global logger is already installed")]
    AlreadyInstalled,
}

#[derive(Debug, Clone)]
pub struct DiagConfig {
    /// Directory for log files; it lives in the per-machine app data directory.
    pub dir: PathBuf,
    /// Number of daily files kept; older ones are deleted.
    pub max_files: usize,
    pub level: tracing::Level,
}

impl DiagConfig {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self {
            dir: dir.into(),
            max_files: 14,
            level: tracing::Level::INFO,
        }
    }
}

/// Keeps the background log writer alive; dropping it flushes pending lines.
#[must_use = "dropping the guard stops logging"]
pub struct DiagGuard {
    _worker: tracing_appender::non_blocking::WorkerGuard,
}

impl fmt::Debug for DiagGuard {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("DiagGuard")
    }
}

/// Installs the process-wide logger and a panic hook that records where a panic
/// happened. Call once at startup, from the binary (app, CLI), never from libraries.
pub fn init(cfg: &DiagConfig) -> Result<DiagGuard, DiagError> {
    use tracing_subscriber::layer::SubscriberExt;

    std::fs::create_dir_all(&cfg.dir).map_err(DiagError::CreateDir)?;
    let appender = tracing_appender::rolling::Builder::new()
        .rotation(tracing_appender::rolling::Rotation::DAILY)
        .filename_prefix("dem")
        .filename_suffix("log")
        .max_log_files(cfg.max_files)
        .build(&cfg.dir)
        .map_err(|e| DiagError::Appender(e.to_string()))?;
    let (writer, worker) = tracing_appender::non_blocking(appender);

    let subscriber = tracing_subscriber::registry()
        .with(tracing_subscriber::filter::LevelFilter::from_level(
            cfg.level,
        ))
        .with(JsonLayer::new(writer));
    tracing::subscriber::set_global_default(subscriber).map_err(|_| DiagError::AlreadyInstalled)?;

    install_panic_hook();
    Ok(DiagGuard { _worker: worker })
}

/// Records panics with location and thread only. The panic message is deliberately
/// not logged: `expect` messages and formatted payloads may contain content.
fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let location = info
            .location()
            .map(|l| format!("{}:{}", l.file(), l.line()));
        let thread = std::thread::current().name().map(str::to_owned);
        tracing::error!(target: "panic", location, thread, "panic");
        previous(info);
    }));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sensitive_never_prints_its_value() {
        let s = Sensitive("my secret body");
        assert_eq!(format!("{s:?}"), REDACTED);
        assert_eq!(format!("{s}"), REDACTED);
        assert_eq!(format!("{:?}", Some(Sensitive(42))), "Some([redacted])");
    }

    #[test]
    fn field_names_matching_content_or_secrets_are_redacted() {
        for name in [
            "body",
            "Title",
            "master_key",
            "key_id",
            "recovery_code",
            "item_body_len",
        ] {
            assert!(is_redacted_field(name), "{name} should be redacted");
        }
        for name in [
            "item_id",
            "count",
            "monkey",
            "duration_ms",
            "keyboard",
            "path",
        ] {
            assert!(!is_redacted_field(name), "{name} should be kept");
        }
    }
}
