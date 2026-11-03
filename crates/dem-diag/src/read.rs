//! Reading log files back, for `dem-dev logs`.

use std::path::Path;

use serde::Deserialize;
use serde_json::{Map, Value};

#[derive(Debug, Clone, Deserialize)]
pub struct LogEntry {
    pub ts: String,
    pub level: String,
    pub target: String,
    pub message: Option<String>,
    #[serde(default)]
    pub fields: Map<String, Value>,
}

/// Reads every `dem.*.log` file in `dir`, oldest first. Lines that are not valid
/// entries (for example a line cut short by a crash) are skipped.
pub fn read_entries(dir: &Path) -> std::io::Result<Vec<LogEntry>> {
    let mut files: Vec<_> = std::fs::read_dir(dir)?
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("dem.") && n.ends_with(".log"))
        })
        .collect();
    // Daily files are named dem.YYYY-MM-DD.log, so name order is time order.
    files.sort();

    let mut entries = Vec::new();
    for file in files {
        let text = std::fs::read_to_string(&file)?;
        entries.extend(
            text.lines()
                .filter_map(|l| serde_json::from_str::<LogEntry>(l).ok()),
        );
    }
    Ok(entries)
}
