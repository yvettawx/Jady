//! Repository automation. Run with `cargo xtask <command>`.
//!
//! - `check-layers`: enforce the crate layering rules (see `layers.rs`).
//! - `ci`: run every check the cloud pipeline runs, locally.

#![allow(clippy::print_stdout, clippy::print_stderr)]

mod layers;

use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{Context, Result, bail};
use cargo_metadata::{DependencyKind, MetadataCommand};

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("check-layers") => check_layers(),
        Some("ci") => ci(&args[1..]),
        _ => {
            eprintln!("usage: cargo xtask <check-layers | ci [--no-frontend] [--require-deny]>");
            std::process::exit(2);
        }
    }
}

fn repo_root() -> PathBuf {
    // xtask/ is one level below the repository root.
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn check_layers() -> Result<()> {
    let root = repo_root();
    let meta = MetadataCommand::new()
        .manifest_path(root.join("Cargo.toml"))
        .no_deps()
        .exec()
        .context("cargo metadata failed")?;

    let mut members = Vec::new();
    let mut edges = Vec::new();
    for pkg in meta.workspace_packages() {
        members.push(pkg.name.to_string());
        for dep in &pkg.dependencies {
            let kind = match dep.kind {
                DependencyKind::Normal => "normal",
                DependencyKind::Development => "dev",
                DependencyKind::Build => "build",
                _ => "unknown",
            };
            edges.push(layers::Edge {
                from: pkg.name.to_string(),
                to: dep.name.clone(),
                kind: kind.into(),
            });
        }
    }

    let violations = layers::check(&members, &edges);
    if violations.is_empty() {
        println!("check-layers: {} workspace members OK", members.len());
        Ok(())
    } else {
        for v in &violations {
            eprintln!("layer violation: {v}");
        }
        bail!("{} layer violation(s)", violations.len())
    }
}

/// pnpm is a `.cmd` shim on Windows, and `Command` does not add the extension.
const PNPM: &str = if cfg!(windows) { "pnpm.cmd" } else { "pnpm" };

fn run(dir: &Path, program: &str, args: &[&str]) -> Result<()> {
    println!("==> {program} {}", args.join(" "));
    let status = Command::new(program)
        .args(args)
        .current_dir(dir)
        .status()
        .with_context(|| format!("failed to start {program}"))?;
    if !status.success() {
        bail!("`{program} {}` failed with {status}", args.join(" "));
    }
    Ok(())
}

fn has_program(program: &str, version_arg: &str) -> bool {
    Command::new(program)
        .arg(version_arg)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn ci(flags: &[String]) -> Result<()> {
    let root = repo_root();
    let no_frontend = flags.iter().any(|f| f == "--no-frontend");
    let require_deny = flags.iter().any(|f| f == "--require-deny");

    run(&root, "cargo", &["fmt", "--all", "--check"])?;
    run(
        &root,
        "cargo",
        &[
            "clippy",
            "--workspace",
            "--all-targets",
            "--locked",
            "--",
            "-D",
            "warnings",
        ],
    )?;
    // Run every test binary even after a failure, so one CI round shows all of them.
    run(
        &root,
        "cargo",
        &["test", "--workspace", "--locked", "--no-fail-fast"],
    )?;
    check_layers()?;

    // `cargo test` regenerated the TypeScript bindings; they must match the committed file.
    run(
        &root,
        "git",
        &["diff", "--exit-code", "--", "apps/desktop/src/bindings.ts"],
    )
    .context("apps/desktop/src/bindings.ts is out of date: commit the regenerated file")?;

    if has_program("cargo-deny", "--version") {
        run(&root, "cargo", &["deny", "check"])?;
    } else if require_deny {
        bail!("cargo-deny is not installed (cargo install --locked cargo-deny)");
    } else {
        println!("==> skipping cargo deny (not installed)");
    }

    let app = root.join("apps/desktop");
    if !no_frontend && app.join("package.json").exists() {
        run(&app, PNPM, &["install", "--frozen-lockfile"])?;
        // Downloads the bundled fonts once and checks their SHA-256 (apps/desktop/fonts.json).
        run(&app, PNPM, &["run", "fonts"])?;
        run(&app, PNPM, &["run", "check"])?;
    }

    println!("ci: all checks passed");
    Ok(())
}
