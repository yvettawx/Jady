//! `dem-dev`: development tools (P0). Never shipped.

#![allow(clippy::print_stdout, clippy::print_stderr)]

use std::process::ExitCode;

use clap::Parser;

fn main() -> ExitCode {
    let cli = dem_devtools::Cli::parse();
    match dem_devtools::run(cli) {
        Ok(code) => code,
        Err(e) => {
            eprintln!("error: {e:#}");
            ExitCode::from(2)
        }
    }
}
