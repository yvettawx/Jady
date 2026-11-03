//! `dem-dev index-diff` (P0-41, framework): compares two index databases with
//! `dem_index::compare` and prints the differing pragmas, schema objects and rows.
//!
//! The SQLCipher key is the library's index key (format spec §4.2, §14): give it as
//! 64 hex digits (`--key-hex` or `DEM_INDEX_KEY_HEX`), or let the tool derive it by
//! unlocking a library (`--library` with `--password` / `--recovery` / `DEM_PASSWORD`).
//! Rebuilding an index from the library and comparing it with the stored one comes
//! with `dem-index` in P1 (decision Q9).
//!
//! Exit code: 0 identical, 1 differences found, 2 error.

use std::path::PathBuf;
use std::process::ExitCode;

use anyhow::{Context, bail};
use dem_index::compare::{self, Diff, Options, RowChange, SchemaChange};

use crate::LibraryArgs;

#[derive(Debug, Clone, clap::Args)]
pub struct Args {
    /// First (reference) database.
    pub a: PathBuf,
    /// Second database; "added" means present here but not in A.
    pub b: PathBuf,
    /// Raw SQLCipher key as 64 hex digits (or set DEM_INDEX_KEY_HEX). Without a key
    /// the files are opened as plain SQLite.
    #[arg(long, conflicts_with = "library")]
    pub key_hex: Option<String>,
    /// Derive the key from this library's master key.
    #[arg(long)]
    pub library: Option<PathBuf>,
    /// Password for --library (or set DEM_PASSWORD).
    #[arg(long, requires = "library", conflicts_with = "recovery")]
    pub password: Option<String>,
    /// Recovery code for --library.
    #[arg(long, requires = "library")]
    pub recovery: Option<String>,
    /// Row changes shown per table (counts are always complete).
    #[arg(long, default_value_t = 10)]
    pub samples: usize,
    /// Do not compare the rows of this table (repeatable).
    #[arg(long = "skip-table")]
    pub skip_tables: Vec<String>,
    /// Print the result as JSON.
    #[arg(long)]
    pub json: bool,
}

/// Parses 64 hex digits into a 32-byte key.
pub fn parse_key_hex(text: &str) -> anyhow::Result<[u8; 32]> {
    let t = text.trim();
    // `from_str_radix` alone would also accept a sign ("+f").
    if t.len() != 64 || !t.bytes().all(|b| b.is_ascii_hexdigit()) {
        bail!("the key must be exactly 64 hex digits");
    }
    let mut key = [0u8; 32];
    for (i, b) in key.iter_mut().enumerate() {
        *b = u8::from_str_radix(&t[2 * i..2 * i + 2], 16)
            .map_err(|_| anyhow::anyhow!("the key must be exactly 64 hex digits"))?;
    }
    Ok(key)
}

fn key_of(args: &Args) -> anyhow::Result<Option<[u8; 32]>> {
    if let Some(root) = &args.library {
        let library = crate::unlock::open(&LibraryArgs {
            library: root.clone(),
            password: args.password.clone(),
            recovery: args.recovery.clone(),
        })
        .context("unlocking the library for its index key")?;
        return Ok(Some(*library.index_key().expose_bytes()));
    }
    let hex = match &args.key_hex {
        Some(h) => Some(h.clone()),
        None => std::env::var("DEM_INDEX_KEY_HEX").ok(),
    };
    hex.as_deref().map(parse_key_hex).transpose()
}

/// Human-readable report; empty diff gives a single line.
pub fn render(d: &Diff) -> String {
    use std::fmt::Write;
    let mut out = String::new();
    if d.is_empty() {
        let _ = writeln!(
            out,
            "no differences ({} tables compared, {} skipped)",
            d.tables_compared.len(),
            d.tables_skipped.len()
        );
        return out;
    }
    for p in &d.pragmas {
        let _ = writeln!(out, "pragma {}: {} -> {}", p.pragma, p.a, p.b);
    }
    for s in &d.schema {
        let _ = match s {
            SchemaChange::OnlyInA { object } => {
                writeln!(out, "schema: {} {} only in A", object.kind, object.name)
            }
            SchemaChange::OnlyInB { object } => {
                writeln!(out, "schema: {} {} only in B", object.kind, object.name)
            }
            SchemaChange::Changed { a, b } => writeln!(
                out,
                "schema: {} {} changed\n  A: {}\n  B: {}",
                a.kind,
                a.name,
                a.sql.as_deref().unwrap_or("-"),
                b.sql.as_deref().unwrap_or("-")
            ),
        };
    }
    let cells = |c: &[compare::Cell]| {
        c.iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join(", ")
    };
    for t in &d.tables {
        let _ = writeln!(
            out,
            "table {}: {} rows in A, {} in B; +{} added, -{} removed, ~{} changed",
            t.table, t.rows_a, t.rows_b, t.added, t.removed, t.changed
        );
        for s in &t.samples {
            let _ = match s {
                RowChange::Added { row, .. } => writeln!(out, "  + ({})", cells(row)),
                RowChange::Removed { row, .. } => writeln!(out, "  - ({})", cells(row)),
                RowChange::Changed { key, columns } => {
                    let cols = columns
                        .iter()
                        .map(|c| format!("{}: {} -> {}", c.column, c.a, c.b))
                        .collect::<Vec<_>>()
                        .join("; ");
                    writeln!(out, "  ~ [{}] {cols}", cells(key))
                }
            };
        }
        let shown = t.samples.len() as u64;
        let total = t.added + t.removed + t.changed;
        if total > shown {
            let _ = writeln!(out, "  … {} more", total - shown);
        }
    }
    out
}

pub fn run(args: Args) -> anyhow::Result<ExitCode> {
    let key = key_of(&args)?;
    let opts = Options {
        max_samples: args.samples,
        skip_tables: args.skip_tables.clone(),
    };
    let d = compare::diff_with(&args.a, &args.b, key.as_ref(), &opts)?;
    if args.json {
        println!("{}", serde_json::to_string_pretty(&d)?);
    } else {
        print!("{}", render(&d));
    }
    Ok(if d.is_empty() {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(1)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_hex_parsing() {
        let k = parse_key_hex(&"0a".repeat(32)).unwrap();
        assert_eq!(k, [0x0a; 32]);
        assert!(parse_key_hex("0a").is_err());
        assert!(parse_key_hex(&"zz".repeat(32)).is_err());
        assert!(parse_key_hex(&"é".repeat(32)).is_err());
        assert!(parse_key_hex(&"+a".repeat(32)).is_err());
    }
}
