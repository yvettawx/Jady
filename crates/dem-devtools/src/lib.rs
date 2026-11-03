//! Development tools (`dem-dev`, P0-30 to P0-42). Never shipped.
//!
//! Rule (P0 plan, Q2): tools may bypass `dem-core`, but every read, write,
//! decryption and format parse goes through `dem-store` / `dem-crypto`. A tool
//! that needs something those crates do not offer gets a new public function
//! there, never its own parser. `cargo xtask check-layers` enforces that this
//! crate has no direct dependency on crypto, CRDT or SQLite libraries.

#![allow(clippy::print_stdout, clippy::print_stderr)]

use std::path::PathBuf;
use std::process::ExitCode;

use clap::{Parser, Subcommand};

pub mod ai_regress;
pub mod bench;
pub mod convert;
pub mod drill;
pub mod gateway_sim;
pub mod gen_cmd;
pub mod index_diff;
pub mod inspect;
pub mod logs;
pub mod migrate_test;
pub mod search_eval;
pub mod unlock;
pub mod validate;

#[derive(Debug, Parser)]
#[command(name = "dem-dev", about = "Jady development tools (not shipped)")]
pub struct Cli {
    #[command(subcommand)]
    pub command: Command,
}

#[derive(Debug, Subcommand)]
pub enum Command {
    /// Generate a synthetic library or JSON from a seed (P0-34).
    Gen(gen_cmd::Args),
    /// Decrypt and print items, structure, logs and history (P0-36).
    Inspect(inspect::Args),
    /// Check a library against the format spec (P0-38).
    Validate(validate::Args),
    /// Convert items between the library and JSON / Markdown (P0-35).
    Convert(convert::Args),
    /// View local diagnostic logs (P0-31).
    Logs(logs::Args),
    /// Corruption and recovery drill (P0-39).
    Drill(drill::Args),
    /// Performance benchmark (P0-40).
    Bench(bench::Args),
    /// Compare two index databases (P0-41).
    IndexDiff(index_diff::Args),
    /// Format migration test runner (P0-42, framework).
    MigrateTest(migrate_test::Args),
    /// AI gateway simulator: privacy matrix without using any quota (P0-32, framework).
    GatewaySim(gateway_sim::Args),
    /// AI regression scenarios; uses quota, manual only (P0-33, framework).
    AiRegress(ai_regress::Args),
    /// Search evaluation set runner (P0-37, framework).
    SearchEval(search_eval::Args),
}

pub fn run(cli: Cli) -> anyhow::Result<ExitCode> {
    match cli.command {
        Command::Gen(a) => gen_cmd::run(a),
        Command::Inspect(a) => inspect::run(a),
        Command::Validate(a) => validate::run(a),
        Command::Convert(a) => convert::run(a),
        Command::Logs(a) => logs::run(a),
        Command::Drill(a) => drill::run(a),
        Command::Bench(a) => bench::run(a),
        Command::IndexDiff(a) => index_diff::run(a),
        Command::MigrateTest(a) => migrate_test::run(a),
        Command::GatewaySim(a) => gateway_sim::run(a),
        Command::AiRegress(a) => ai_regress::run(a),
        Command::SearchEval(a) => search_eval::run(a),
    }
}

/// Common library location and unlock options.
#[derive(Debug, Clone, clap::Args)]
pub struct LibraryArgs {
    /// Library root directory.
    #[arg(long)]
    pub library: PathBuf,
    /// Password; if neither this nor --recovery is given, read from DEM_PASSWORD.
    #[arg(long, conflicts_with = "recovery")]
    pub password: Option<String>,
    /// Recovery code.
    #[arg(long)]
    pub recovery: Option<String>,
}
