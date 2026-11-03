//! `dem-dev migrate-test` (P0-42, framework): format migration runner.
//!
//! A sample library of format version N lives in `testdata/migrations/v<N>/library/`
//! together with `dump.json`, its canonical JSON dump (format spec §17). The runner
//! never touches the sample in place: it copies the library into a temporary
//! directory, then
//!
//! 1. checks that this build still reads the sample exactly as recorded in
//!    `dump.json` (catches a dependency upgrade that silently misreads old files);
//! 2. applies the migration steps in chain order (`from` N → … → target); for each
//!    step it dumps the library, runs the migration, reopens the library and requires
//!    the new dump to equal [`Migration::expected`] of the old one, i.e. identical
//!    except for the changes the migration declares.
//!
//! The dump covers the manifest, every item document (content and the origins of
//! its history), the structure tree, every log record and every attachment. All
//! reads go through `dem-store`.
//!
//! P0 has no real migration yet: [`registered`] is empty and the tests use fake
//! v1 → v2 steps.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use anyhow::{Context, bail};
use dem_crypto::keys::KdfParams;
use dem_model::ChangeOrigin;
use dem_store::logs::LogKind;
use dem_store::{FileKind, Library, NodeKind, Unlock, layout};
use dem_testkit::{GenConfig, generate};
use serde_json::{Value as J, json};

/// Canonical dump: record name → JSON. Record names: `manifest`, `structure`,
/// `item/<id>`, `log/<kind>`, `blob/<name>`.
pub type Dump = BTreeMap<String, J>;

/// One migration step between two format versions.
pub trait Migration {
    fn name(&self) -> &str;
    fn from(&self) -> u32;
    fn to(&self) -> u32;
    /// Whether the step writes `to()` into `manifest.json`. Real migrations must;
    /// fake test steps that cannot change the version return false.
    fn writes_format_version(&self) -> bool {
        true
    }
    /// Migrates the library at `root`, which is open as `library`.
    fn migrate(&self, root: &Path, library: &Library) -> anyhow::Result<()>;
    /// The dump the migrated library must produce: `before` with exactly the
    /// declared changes applied. Default: no content change.
    fn expected(&self, before: &Dump) -> Dump {
        before.clone()
    }
}

/// Migrations shipped with this build, in any order. None exist in P0.
pub fn registered() -> Vec<Box<dyn Migration>> {
    Vec::new()
}

/// One difference between an expected and an actual dump.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Difference {
    pub record: String,
    /// JSON pointer inside the record ("" for the whole record).
    pub pointer: String,
    pub detail: String,
}

impl std::fmt::Display for Difference {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}{}: {}", self.record, self.pointer, self.detail)
    }
}

#[derive(Debug, Clone)]
pub struct StepOutcome {
    pub name: String,
    pub from: u32,
    pub to: u32,
    pub differences: Vec<Difference>,
}

#[derive(Debug, Clone)]
pub struct Outcome {
    /// Differences between `dump.json` and what this build reads from the sample.
    pub sample: Vec<Difference>,
    pub steps: Vec<StepOutcome>,
}

impl Outcome {
    pub fn passed(&self) -> bool {
        self.sample.is_empty() && self.steps.iter().all(|s| s.differences.is_empty())
    }
}

#[derive(Debug, Clone, clap::Args)]
pub struct Args {
    #[command(subcommand)]
    pub command: Cmd,
}

#[derive(Debug, Clone, clap::Subcommand)]
pub enum Cmd {
    /// Check a sample library and run the registered migrations on a copy of it.
    Run {
        /// Sample directory, e.g. testdata/migrations/v1.
        #[arg(long)]
        sample: PathBuf,
        /// Password of the sample library.
        #[arg(long, default_value = "test")]
        password: String,
    },
    /// Write a new sample library and its dump (when a format version is released).
    Generate {
        /// Sample directory to create; must not exist yet.
        #[arg(long)]
        out: PathBuf,
        #[arg(long, default_value_t = 2027)]
        seed: u64,
        #[arg(long, default_value_t = 20)]
        items: usize,
        #[arg(long, default_value = "test")]
        password: String,
    },
}

// ---- dump -------------------------------------------------------------------

fn kind_str(k: NodeKind) -> &'static str {
    match k {
        NodeKind::Domain => "domain",
        NodeKind::Project => "project",
    }
}

/// Canonical JSON dump of everything stored in the library.
pub fn dump(library: &Library) -> anyhow::Result<Dump> {
    let mut out = Dump::new();
    out.insert("manifest".into(), serde_json::to_value(library.manifest())?);

    for id in library.item_ids()? {
        let doc = library.load_item(id)?;
        let history: Vec<J> = doc
            .history()
            .into_iter()
            .map(|c| c.message.map_or(J::Null, J::String))
            .collect();
        out.insert(
            format!("item/{id}"),
            json!({ "doc": doc.to_json(), "history": history }),
        );
    }

    let nodes: Vec<J> = library
        .load_structure()?
        .nodes()
        .into_iter()
        .map(|n| {
            json!({
                "item": n.item.to_string(),
                "kind": kind_str(n.kind),
                "parent": n.parent.map(|p| p.to_string()),
            })
        })
        .collect();
    out.insert("structure".into(), J::Array(nodes));

    for kind in [LogKind::Activity, LogKind::Review, LogKind::AiAccess] {
        let logs = library.read_logs(kind)?;
        if logs.records.is_empty() && logs.damaged == 0 {
            continue;
        }
        let records = logs
            .records
            .iter()
            .map(serde_json::to_value)
            .collect::<Result<Vec<_>, _>>()?;
        out.insert(
            format!("log/{}", kind.as_str()),
            json!({ "records": records, "damaged": logs.damaged }),
        );
    }

    for f in layout::scan(library.root())? {
        if let FileKind::Blob { name } = f.kind {
            let mut content = Vec::new();
            library.read_blob(&name, &mut content)?;
            let text = String::from_utf8(content.clone()).ok();
            let mut rec = json!({ "len": content.len(), "utf8": text });
            // Only present when needed, so dumps of existing samples stay valid:
            // binary content in full, and a name that no longer matches the content.
            if text.is_none() {
                rec["hex"] = J::String(hex(&content));
            }
            if !library.verify_blob(&name)? {
                rec["name_mismatch"] = J::Bool(true);
            }
            out.insert(format!("blob/{name}"), rec);
        }
    }
    Ok(out)
}

fn hex(b: &[u8]) -> String {
    use std::fmt::Write;
    b.iter()
        .fold(String::with_capacity(b.len() * 2), |mut s, x| {
            let _ = write!(s, "{x:02x}");
            s
        })
}

/// All differences between two dumps (`expected` vs `actual`), record by record.
pub fn compare_dumps(expected: &Dump, actual: &Dump) -> Vec<Difference> {
    let mut out = Vec::new();
    for (k, e) in expected {
        match actual.get(k) {
            None => out.push(Difference {
                record: k.clone(),
                pointer: String::new(),
                detail: "missing after migration".into(),
            }),
            Some(a) => json_diff(k, "", e, a, &mut out),
        }
    }
    for k in actual.keys().filter(|k| !expected.contains_key(*k)) {
        out.push(Difference {
            record: k.clone(),
            pointer: String::new(),
            detail: "unexpected new record".into(),
        });
    }
    out
}

fn short(v: &J) -> String {
    let s = v.to_string();
    if s.chars().count() > 80 {
        format!("{}…", s.chars().take(80).collect::<String>())
    } else {
        s
    }
}

fn escape_pointer(key: &str) -> String {
    key.replace('~', "~0").replace('/', "~1")
}

fn push_diff(out: &mut Vec<Difference>, record: &str, pointer: String, detail: String) {
    out.push(Difference {
        record: record.to_owned(),
        pointer,
        detail,
    });
}

fn json_diff(record: &str, ptr: &str, e: &J, a: &J, out: &mut Vec<Difference>) {
    match (e, a) {
        (J::Object(eo), J::Object(ao)) => {
            for (k, ev) in eo {
                let p = format!("{ptr}/{}", escape_pointer(k));
                match ao.get(k) {
                    Some(av) => json_diff(record, &p, ev, av, out),
                    None => push_diff(out, record, p, format!("removed (was {})", short(ev))),
                }
            }
            for (k, av) in ao.iter().filter(|(k, _)| !eo.contains_key(*k)) {
                let p = format!("{ptr}/{}", escape_pointer(k));
                push_diff(out, record, p, format!("added {}", short(av)));
            }
        }
        (J::Array(ea), J::Array(aa)) => {
            for (i, (ev, av)) in ea.iter().zip(aa).enumerate() {
                json_diff(record, &format!("{ptr}/{i}"), ev, av, out);
            }
            if ea.len() != aa.len() {
                let detail = format!("array length {} -> {}", ea.len(), aa.len());
                push_diff(out, record, ptr.to_owned(), detail);
            }
        }
        _ if e != a => {
            let detail = format!("{} -> {}", short(e), short(a));
            push_diff(out, record, ptr.to_owned(), detail);
        }
        _ => {}
    }
}

// ---- runner -----------------------------------------------------------------

/// Copies a directory tree, skipping the process lock and temporary files.
pub fn copy_library(from: &Path, to: &Path) -> anyhow::Result<()> {
    fs::create_dir_all(to).with_context(|| format!("creating {}", to.display()))?;
    for entry in fs::read_dir(from).with_context(|| format!("reading {}", from.display()))? {
        let entry = entry?;
        let name = entry.file_name();
        if name == layout::LOCK || name == "tmp" {
            continue;
        }
        let (src, dst) = (entry.path(), to.join(&name));
        if entry.file_type()?.is_dir() {
            copy_library(&src, &dst)?;
        } else {
            fs::copy(&src, &dst).with_context(|| format!("copying {}", src.display()))?;
        }
    }
    Ok(())
}

/// Format version of a sample directory named `v<N>`.
pub fn sample_version(sample: &Path) -> anyhow::Result<u32> {
    sample
        .file_name()
        .and_then(|n| n.to_str())
        .and_then(|n| n.strip_prefix('v'))
        .and_then(|n| n.parse().ok())
        .with_context(|| format!("{} is not named v<N>", sample.display()))
}

/// Puts the steps in chain order starting at `start`. Every step must be used
/// exactly once and the versions must be contiguous.
pub fn chain<'a>(
    start: u32,
    steps: &[&'a dyn Migration],
) -> anyhow::Result<Vec<&'a dyn Migration>> {
    let mut left: Vec<&dyn Migration> = steps.to_vec();
    let mut out = Vec::with_capacity(left.len());
    let mut version = start;
    while !left.is_empty() {
        let found: Vec<usize> = (0..left.len())
            .filter(|&i| left[i].from() == version)
            .collect();
        match found.as_slice() {
            [i] => {
                let m = left.remove(*i);
                if m.to() <= m.from() {
                    bail!("migration {} does not raise the version", m.name());
                }
                version = m.to();
                out.push(m);
            }
            [] => bail!(
                "no migration from version {version}; left: {}",
                left.iter()
                    .map(|m| format!("{} ({}->{})", m.name(), m.from(), m.to()))
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
            _ => bail!("more than one migration from version {version}"),
        }
    }
    Ok(out)
}

/// Runs the sample check and the migration chain on a copy of the sample in `work`.
pub fn run_on_sample(
    sample: &Path,
    password: &str,
    steps: &[&dyn Migration],
    work: &Path,
) -> anyhow::Result<Outcome> {
    let start = sample_version(sample)?;
    let ordered = chain(start, steps)?;
    let root = work.join("library");
    copy_library(&sample.join("library"), &root)?;
    let open = || -> anyhow::Result<Library> {
        Library::open(&root, Unlock::Password(password.as_bytes()))
            .with_context(|| format!("opening the copy of {}", sample.display()))
    };

    let recorded: Dump = serde_json::from_slice(
        &fs::read(sample.join("dump.json")).context("reading the sample's dump.json")?,
    )?;
    let mut current = dump(&open()?)?;
    let sample_diffs = compare_dumps(&recorded, &current);

    let mut outcomes = Vec::new();
    for m in ordered {
        let library = open()?;
        m.migrate(&root, &library)
            .with_context(|| format!("migration {}", m.name()))?;
        drop(library);
        let library = open()?;
        let after = dump(&library)?;
        let mut differences = compare_dumps(&m.expected(&current), &after);
        let version = library.manifest().format_version;
        if m.writes_format_version() && version != m.to() {
            differences.push(Difference {
                record: "manifest".into(),
                pointer: "/format_version".into(),
                detail: format!("is {version}, migration should have written {}", m.to()),
            });
        }
        outcomes.push(StepOutcome {
            name: m.name().to_owned(),
            from: m.from(),
            to: m.to(),
            differences,
        });
        current = after;
    }
    Ok(Outcome {
        sample: sample_diffs,
        steps: outcomes,
    })
}

// ---- sample generation --------------------------------------------------------

/// Writes a new sample: a small seeded library (insecure test KDF) in `out/library`
/// and its dump in `out/dump.json`. Keys, nonces and peer ids are random, so the
/// files differ between runs; the content does not.
pub fn generate_sample(out: &Path, seed: u64, items: usize, password: &str) -> anyhow::Result<()> {
    if out.exists() {
        bail!("{} already exists", out.display());
    }
    let root = out.join("library");
    let mut cfg = GenConfig::new(seed, items);
    cfg.containers = 5;
    let data = generate(&cfg);
    {
        let (library, _code) =
            Library::create(&root, password.as_bytes(), KdfParams::INSECURE_FOR_TESTS)?;
        crate::gen_cmd::write_library(&library, &data, true)?;
        let ids: Vec<_> = data.items.iter().map(|i| i.meta.id).collect();
        // Both layouts: folded snapshots for even items, snapshot + update for odd.
        for (i, id) in ids.iter().enumerate() {
            if i % 2 == 0 {
                let mut doc = library.load_item(*id)?;
                library.compact_item(&mut doc)?;
            }
        }
        // Edits by me and an accepted AI proposal on the first item.
        if let Some(id) = ids.first() {
            let mut doc = library.load_item(*id)?;
            doc.append_paragraph("我后来加的一段。")?;
            doc.commit(ChangeOrigin::Me, None);
            library.save_item(&mut doc)?;
            doc.append_paragraph("AI 建议补充的一段。")?;
            doc.commit(
                ChangeOrigin::Ai,
                Some("0192f3c4-0000-7000-8000-000000000001"),
            );
            library.save_item(&mut doc)?;
        }
        library.put_blob("附件一：纯文本。".as_bytes())?;
        library.put_blob(b"attachment two, plain text")?;
        let d = dump(&library)?;
        fs::write(out.join("dump.json"), serde_json::to_vec_pretty(&d)?)?;
    }
    // Neither belongs in a committed sample.
    let _ = fs::remove_file(root.join(layout::LOCK));
    let _ = fs::remove_dir_all(root.join("tmp"));
    Ok(())
}

// ---- command ----------------------------------------------------------------

fn print_outcome(o: &Outcome) {
    const MAX: usize = 20;
    let show = |diffs: &[Difference]| {
        for d in diffs.iter().take(MAX) {
            println!("    {d}");
        }
        if diffs.len() > MAX {
            println!("    … {} more", diffs.len() - MAX);
        }
    };
    if o.sample.is_empty() {
        println!("sample: read back exactly as recorded in dump.json");
    } else {
        println!("sample: {} differences from dump.json", o.sample.len());
        show(&o.sample);
    }
    if o.steps.is_empty() {
        println!("no migrations registered");
    }
    for s in &o.steps {
        let verdict = if s.differences.is_empty() {
            "ok"
        } else {
            "FAILED"
        };
        println!("{} ({} -> {}): {verdict}", s.name, s.from, s.to);
        show(&s.differences);
    }
}

pub fn run(args: Args) -> anyhow::Result<ExitCode> {
    match args.command {
        Cmd::Generate {
            out,
            seed,
            items,
            password,
        } => {
            generate_sample(&out, seed, items, &password)?;
            println!("wrote {}", out.display());
            Ok(ExitCode::SUCCESS)
        }
        Cmd::Run { sample, password } => {
            let work = std::env::temp_dir().join(format!(
                "dem-migrate-{}-{:08x}",
                std::process::id(),
                dem_crypto::random_u64() as u32
            ));
            let migrations = registered();
            let steps: Vec<&dyn Migration> = migrations.iter().map(|m| m.as_ref()).collect();
            let result = run_on_sample(&sample, &password, &steps, &work);
            let _ = fs::remove_dir_all(&work);
            let outcome = result?;
            print_outcome(&outcome);
            Ok(if outcome.passed() {
                ExitCode::SUCCESS
            } else {
                ExitCode::from(1)
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_differences_have_pointers() {
        let mut e = Dump::new();
        let mut a = Dump::new();
        e.insert("r".into(), json!({"x": [1, 2, 3], "a/b": 1, "gone": true}));
        a.insert("r".into(), json!({"x": [1, 5], "a/b": 2, "new": null}));
        a.insert("extra".into(), json!(1));
        let mut d: Vec<String> = compare_dumps(&e, &a)
            .iter()
            .map(|d| d.to_string())
            .collect();
        d.sort();
        assert_eq!(
            d,
            [
                "extra: unexpected new record",
                "r/a~1b: 1 -> 2",
                "r/gone: removed (was true)",
                "r/new: added null",
                "r/x/1: 2 -> 5",
                "r/x: array length 3 -> 2",
            ]
        );
    }

    #[test]
    fn sample_directories_are_versioned() {
        assert_eq!(
            sample_version(Path::new("testdata/migrations/v1")).unwrap(),
            1
        );
        assert!(sample_version(Path::new("testdata/migrations/latest")).is_err());
    }
}
