//! `dem-dev gen` (P0-34): write the synthetic data of `dem_testkit::generate`
//! as a real library (through `dem-store`) or as JSON.
//!
//! The generated content is deterministic for a seed; only keys, nonces, peer ids
//! and file sequence numbers differ between runs.

use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use anyhow::Context;
use dem_crypto::keys::KdfParams;
use dem_model::ChangeOrigin;
use dem_store::logs::{LogKind, LogRecord};
use dem_store::{Library, NodeKind};
use dem_testkit::{GenConfig, GenLibrary, generate};

#[derive(Debug, Clone, clap::Args)]
#[command(group(clap::ArgGroup::new("target").required(true).args(["library", "json"])))]
pub struct Args {
    /// Seed; the same seed always yields the same content.
    #[arg(long, default_value_t = 1)]
    pub seed: u64,
    /// Number of ordinary items (domains and projects come on top).
    #[arg(long, default_value_t = 1000)]
    pub items: usize,
    /// Number of domains and projects (default: items / 200, between 5 and 300).
    #[arg(long)]
    pub containers: Option<usize>,
    /// Create a new library in this (empty or missing) directory.
    #[arg(long, requires = "password")]
    pub library: Option<PathBuf>,
    /// Password for the new library.
    #[arg(long)]
    pub password: Option<String>,
    /// Use fast, insecure key derivation parameters (tests only).
    #[arg(long)]
    pub kdf_test: bool,
    /// Fold each item's update into its snapshot (one file per item).
    #[arg(long)]
    pub compact: bool,
    /// Write the generated data as JSON to this file instead.
    #[arg(long)]
    pub json: Option<PathBuf>,
    /// No progress output.
    #[arg(long)]
    pub quiet: bool,
}

/// What [`write_library`] wrote.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GenStats {
    pub containers: usize,
    pub items: usize,
    pub links: usize,
}

/// Commit message batch of a generated library: `import:gen-<seed>`.
pub fn batch_id(seed: u64) -> String {
    format!("gen-{seed}")
}

/// Generated bodies separate paragraphs with blank lines; item bodies hold one
/// paragraph per line.
pub fn body_lines(body: &str) -> String {
    body.split("\n\n").collect::<Vec<_>>().join("\n")
}

fn activity(item: &dem_model::ItemMeta) -> LogRecord {
    let mut fields = serde_json::Map::new();
    fields.insert("item".into(), item.id.to_string().into());
    fields.insert("type".into(), item.type_id.0.clone().into());
    fields.insert("action".into(), "import".into());
    fields.insert("origin".into(), "import".into());
    let mut rec = LogRecord::new(LogKind::Activity, fields);
    // The creation time keeps the logs deterministic and spread over months.
    rec.ts = item.created;
    rec
}

struct Progress {
    total: usize,
    done: usize,
    step: usize,
    quiet: bool,
}

impl Progress {
    fn new(total: usize, quiet: bool) -> Self {
        Self {
            total,
            done: 0,
            step: (total / 20).max(1000),
            quiet,
        }
    }

    fn tick(&mut self) {
        self.done += 1;
        if !self.quiet && (self.done.is_multiple_of(self.step) || self.done == self.total) {
            eprintln!("  {}/{} items", self.done, self.total);
        }
    }
}

/// Writes a generated data set into an open (normally fresh) library.
pub fn write_library(
    library: &Library,
    data: &GenLibrary,
    quiet: bool,
) -> anyhow::Result<GenStats> {
    write_library_with(library, data, quiet, false)
}

fn write_library_with(
    library: &Library,
    data: &GenLibrary,
    quiet: bool,
    compact: bool,
) -> anyhow::Result<GenStats> {
    let batch = batch_id(data.seed);
    let mut progress = Progress::new(data.containers.len() + data.items.len(), quiet);

    let mut structure = library.load_structure()?;
    for c in &data.containers {
        let kind = if c.is_project {
            NodeKind::Project
        } else {
            NodeKind::Domain
        };
        structure.add(c.meta.id, kind, c.parent)?;
        library.create_item(&c.meta)?;
        library.append_log(LogKind::Activity, &activity(&c.meta))?;
        progress.tick();
    }
    structure.commit(&format!("import:{batch}"));
    library.save_structure(&mut structure)?;

    let mut links = 0;
    for it in &data.items {
        let mut doc = library.create_item(&it.meta)?;
        doc.set_body_text(&body_lines(&it.body))?;
        for (k, v) in &it.fields {
            doc.set_field(k, v)?;
        }
        for to in &it.links {
            doc.add_link(*to, "reference")?;
            links += 1;
        }
        doc.commit(ChangeOrigin::Import, Some(&batch));
        library.save_item(&mut doc)?;
        if compact {
            library.compact_item(&mut doc)?;
        }
        library.append_log(LogKind::Activity, &activity(&it.meta))?;
        progress.tick();
    }
    Ok(GenStats {
        containers: data.containers.len(),
        items: data.items.len(),
        links,
    })
}

fn write_json(path: &Path, data: &GenLibrary) -> anyhow::Result<()> {
    let f = File::create(path).with_context(|| format!("creating {}", path.display()))?;
    let mut w = BufWriter::new(f);
    serde_json::to_writer(&mut w, data)?;
    w.write_all(b"\n")?;
    w.flush()?;
    Ok(())
}

pub fn run(args: Args) -> anyhow::Result<ExitCode> {
    let mut cfg = GenConfig::new(args.seed, args.items);
    if let Some(c) = args.containers {
        cfg.containers = c;
    }
    if !args.quiet {
        eprintln!(
            "generating seed {} ({} items, {} containers)",
            cfg.seed, cfg.items, cfg.containers
        );
    }
    let data = generate(&cfg);

    if let Some(path) = &args.json {
        write_json(path, &data)?;
        if !args.quiet {
            eprintln!("wrote {}", path.display());
        }
        return Ok(ExitCode::SUCCESS);
    }

    let (Some(root), Some(pw)) = (&args.library, &args.password) else {
        anyhow::bail!("give --library with --password, or --json");
    };
    let params = if args.kdf_test {
        KdfParams::INSECURE_FOR_TESTS
    } else {
        KdfParams::DEFAULT
    };
    let (library, code) = Library::create(root, pw.as_bytes(), params)
        .with_context(|| format!("creating library at {}", root.display()))?;
    let stats = write_library_with(&library, &data, args.quiet, args.compact)?;
    eprintln!(
        "wrote {} containers, {} items, {} links to {}",
        stats.containers,
        stats.items,
        stats.links,
        root.display()
    );
    // Shown exactly once; it is the only way in without the password.
    let text = code.display_text()?;
    println!("recovery code: {}", text.as_str());
    Ok(ExitCode::SUCCESS)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blank_lines_separate_paragraphs() {
        assert_eq!(body_lines("a\n\nb c\n\nd"), "a\nb c\nd");
        assert_eq!(body_lines("one"), "one");
    }
}
