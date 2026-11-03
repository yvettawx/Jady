//! `dem-dev logs` (P0-31): view the local diagnostic log files written by
//! `dem-diag`. Reading and parsing is `dem_diag::read_entries`; this module only
//! filters and prints.

use std::io::Write;
use std::path::PathBuf;
use std::process::ExitCode;

use anyhow::{Context, bail};
use dem_diag::LogEntry;

#[derive(Debug, Clone, clap::Args)]
pub struct Args {
    /// Directory holding the `dem.*.log` files.
    #[arg(long)]
    pub dir: PathBuf,
    /// Minimum level to show: trace, debug, info, warn or error.
    #[arg(long)]
    pub level: Option<String>,
    /// Only entries whose target starts with this (e.g. `dem_store`).
    #[arg(long)]
    pub target: Option<String>,
    /// One JSON object per line instead of text.
    #[arg(long)]
    pub json: bool,
}

/// Severity rank; unknown levels rank lowest so they are hidden by any filter.
pub fn level_rank(level: &str) -> u8 {
    match level.to_ascii_lowercase().as_str() {
        "trace" => 1,
        "debug" => 2,
        "info" => 3,
        "warn" | "warning" => 4,
        "error" => 5,
        _ => 0,
    }
}

/// Entries that pass the level and target filters, in file order.
pub fn filter<'a>(
    entries: &'a [LogEntry],
    min_level: Option<&str>,
    target: Option<&str>,
) -> anyhow::Result<Vec<&'a LogEntry>> {
    let min = match min_level {
        Some(l) => match level_rank(l) {
            0 => bail!("unknown level {l:?}"),
            r => r,
        },
        None => 0,
    };
    Ok(entries
        .iter()
        .filter(|e| level_rank(&e.level) >= min)
        .filter(|e| target.is_none_or(|t| e.target.starts_with(t)))
        .collect())
}

/// One human-readable line: `ts LEVEL target: message k=v ...`.
pub fn format_line(e: &LogEntry) -> String {
    let mut line = format!("{} {:5} {}:", e.ts, e.level, e.target);
    if let Some(m) = &e.message {
        line.push(' ');
        line.push_str(m);
    }
    for (k, v) in &e.fields {
        match v {
            serde_json::Value::String(s) => line.push_str(&format!(" {k}={s}")),
            other => line.push_str(&format!(" {k}={other}")),
        }
    }
    line
}

fn entry_json(e: &LogEntry) -> serde_json::Value {
    serde_json::json!({
        "ts": e.ts,
        "level": e.level,
        "target": e.target,
        "message": e.message,
        "fields": e.fields,
    })
}

pub fn run(args: Args) -> anyhow::Result<ExitCode> {
    let entries = dem_diag::read_entries(&args.dir)
        .with_context(|| format!("reading logs in {}", args.dir.display()))?;
    let shown = filter(&entries, args.level.as_deref(), args.target.as_deref())?;
    let mut out = std::io::stdout().lock();
    for e in &shown {
        if args.json {
            writeln!(out, "{}", entry_json(e))?;
        } else {
            writeln!(out, "{}", format_line(e))?;
        }
    }
    if !args.json {
        eprintln!("{} of {} entries", shown.len(), entries.len());
    }
    Ok(ExitCode::SUCCESS)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn levels_rank_in_order() {
        let ranks: Vec<u8> = ["TRACE", "debug", "Info", "WARN", "error"]
            .iter()
            .map(|l| level_rank(l))
            .collect();
        assert!(ranks.windows(2).all(|w| w[0] < w[1]));
        assert_eq!(level_rank("nonsense"), 0);
    }
}
