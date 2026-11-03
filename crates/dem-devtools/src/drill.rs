//! Corruption and recovery drill (P0-39).
//!
//! Builds a small library with `dem-testkit` and `dem-store`, then, on a fresh copy
//! per fault, damages it the way disks, sync tools and crashes do and checks four
//! things:
//!
//! - **validator**: [`validate`](crate::validate::validate) reports the damaged file
//!   with the right category and exit code, and no corruption anywhere else;
//! - **isolation**: only the damaged items fail to load; every other item loads with
//!   its original title and body;
//! - **opens**: the library still opens;
//! - **recovery**: the recovery code alone unlocks it, plus fault-specific recovery
//!   (damaged log records skipped, a torn tail repaired by the next append, ...).
//!
//! Fault injection necessarily edits raw bytes; locating record boundaries and
//! reading the manifest still goes through `dem-store` / `dem-crypto`.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use anyhow::{Context, bail};
use dem_crypto::{KdfParams, RecoveryCode};
use dem_model::{ChangeOrigin, ItemId};
use dem_store::check;
use dem_store::layout::{self, DocDir, FileKind};
use dem_store::logs::{LogKind, LogRecord};
use dem_store::{Library, NodeKind, Unlock};
use dem_testkit::GenConfig;
use serde_json::{Map, Value};

use crate::validate::{self, Category, Report, Severity};

#[derive(Debug, Clone, clap::Args)]
pub struct Args {
    /// Keep the drill libraries in this directory (must be empty or missing).
    #[arg(long)]
    pub keep: Option<PathBuf>,
    /// Seed for the generated library.
    #[arg(long, default_value_t = 39)]
    pub seed: u64,
    /// Number of generated items (besides domains and projects).
    #[arg(long, default_value_t = 24)]
    pub items: usize,
}

pub fn run(args: Args) -> anyhow::Result<ExitCode> {
    let (dir, keep) = match &args.keep {
        Some(d) => {
            if d.exists() && fs::read_dir(d)?.next().is_some() {
                bail!("{} is not empty", d.display());
            }
            (d.clone(), true)
        }
        None => (
            std::env::temp_dir().join(format!("dem-drill-{:016x}", dem_crypto::random_u64())),
            false,
        ),
    };
    let cfg = DrillConfig {
        seed: args.seed,
        items: args.items,
        dir: dir.clone(),
    };
    let result = run_drill(&cfg);
    if !keep {
        let _ = fs::remove_dir_all(&dir);
    }
    let outcomes = result?;
    print!("{}", render_table(&outcomes));
    if keep {
        println!("drill libraries kept in {}", dir.display());
    }
    Ok(if outcomes.iter().all(Outcome::passed) {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(1)
    })
}

#[derive(Debug, Clone)]
pub struct DrillConfig {
    pub seed: u64,
    pub items: usize,
    /// Working directory; one sub-directory per fault is created in it.
    pub dir: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Verdict {
    pub ok: bool,
    pub detail: String,
}

impl Verdict {
    fn pass(detail: impl Into<String>) -> Verdict {
        Verdict {
            ok: true,
            detail: detail.into(),
        }
    }

    fn fail(detail: impl Into<String>) -> Verdict {
        Verdict {
            ok: false,
            detail: detail.into(),
        }
    }

    fn check(ok: bool, detail: impl Into<String>) -> Verdict {
        Verdict {
            ok,
            detail: detail.into(),
        }
    }

    fn and(self, other: Verdict) -> Verdict {
        Verdict {
            ok: self.ok && other.ok,
            detail: if other.detail.is_empty() {
                self.detail
            } else {
                format!("{}; {}", self.detail, other.detail)
            },
        }
    }
}

#[derive(Debug, Clone)]
pub struct Outcome {
    pub fault: &'static str,
    pub validator: Verdict,
    pub isolation: Verdict,
    pub opens: Verdict,
    pub recovery: Verdict,
}

impl Outcome {
    pub fn passed(&self) -> bool {
        self.validator.ok && self.isolation.ok && self.opens.ok && self.recovery.ok
    }
}

/// The pass/fail table, followed by the details of every failed check.
pub fn render_table(outcomes: &[Outcome]) -> String {
    let mark = |v: &Verdict| if v.ok { "pass" } else { "FAIL" };
    let mut out = format!(
        "{:<22} {:<9} {:<9} {:<6} {:<8} result\n",
        "fault", "validator", "isolation", "opens", "recovery"
    );
    for o in outcomes {
        out.push_str(&format!(
            "{:<22} {:<9} {:<9} {:<6} {:<8} {}\n",
            o.fault,
            mark(&o.validator),
            mark(&o.isolation),
            mark(&o.opens),
            mark(&o.recovery),
            if o.passed() { "PASS" } else { "FAIL" }
        ));
    }
    for o in outcomes.iter().filter(|o| !o.passed()) {
        for (name, v) in [
            ("validator", &o.validator),
            ("isolation", &o.isolation),
            ("opens", &o.opens),
            ("recovery", &o.recovery),
        ] {
            if !v.ok {
                out.push_str(&format!("  {} / {name}: {}\n", o.fault, v.detail));
            }
        }
    }
    let passed = outcomes.iter().filter(|o| o.passed()).count();
    out.push_str(&format!("{passed}/{} faults passed\n", outcomes.len()));
    out
}

// ---- the base library -----------------------------------------------------------

/// Test-only password of the generated library.
const PASSWORD: &[u8] = b"drill password";

struct Expected {
    title: Option<String>,
    body: String,
}

struct Base {
    root: PathBuf,
    code: RecoveryCode,
    expected: BTreeMap<ItemId, Expected>,
    /// Ordinary items (not domains or projects), each with a snapshot and an update.
    plain: Vec<ItemId>,
    small_blob: (String, Vec<u8>),
    large_blob: (String, Vec<u8>),
    segment: String,
    log_records: usize,
}

const LOG_RECORDS: usize = 5;

/// A crash leftover planted by the `leftover-tmp-file` fault.
const LEFTOVER_TMP: &str = "tmp/00000000deadbeef.tmp";

/// The local index (format spec §14). It is rebuilt from the items in P1 (P0 plan,
/// Q9); until then the base library carries a stand-in so that deleting it is real.
const INDEX_FILE: &str = "index.sqlite";

fn build_base(root: &Path, seed: u64, items: usize) -> anyhow::Result<Base> {
    let g = dem_testkit::generate(&GenConfig::new(seed, items.max(8)));
    let (library, code) = Library::create(root, PASSWORD, KdfParams::INSECURE_FOR_TESTS)?;
    let mut expected = BTreeMap::new();

    let mut structure = library.load_structure()?;
    for c in &g.containers {
        let doc = library.create_item(&c.meta)?;
        let kind = if c.is_project {
            NodeKind::Project
        } else {
            NodeKind::Domain
        };
        structure.add(c.meta.id, kind, c.parent)?;
        expected.insert(
            c.meta.id,
            Expected {
                title: c.meta.title.clone(),
                body: doc.body_text(),
            },
        );
    }
    structure.commit("system");
    library.save_structure(&mut structure)?;

    let mut plain = Vec::new();
    for (n, it) in g.items.iter().enumerate() {
        let mut doc = library.create_item(&it.meta)?;
        for (k, v) in &it.fields {
            doc.set_field(k, v)?;
        }
        doc.set_body_text(&it.body)?;
        for to in &it.links {
            doc.add_link(*to, "reference")?;
        }
        doc.commit(ChangeOrigin::Import, Some(&format!("drill-{seed}-{n}")));
        anyhow::ensure!(library.save_item(&mut doc)?, "item {n} wrote no update");
        expected.insert(
            it.meta.id,
            Expected {
                title: it.meta.title.clone(),
                body: doc.body_text(),
            },
        );
        plain.push(it.meta.id);
        if n < LOG_RECORDS {
            library.append_log(LogKind::Activity, &activity(it.meta.id, &it.meta.type_id.0))?;
        }
    }

    let small = b"drill attachment".to_vec();
    let large: Vec<u8> = (0..150_000u32).map(|i| (i * 31 % 251) as u8).collect();
    let small_blob = (library.put_blob(&small)?, small);
    let large_blob = (library.put_blob(&large)?, large);
    drop(library);
    // Atomic writes leave tmp/ behind (empty); make sure it exists either way, and
    // add the index stand-in. The validator ignores both by design (§2).
    fs::create_dir_all(root.join("tmp"))?;
    fs::write(root.join(INDEX_FILE), b"index stand-in, rebuilt in P1")?;

    let segment = layout::scan(root)?
        .into_iter()
        .find(|f| matches!(f.kind, FileKind::LogSegment { .. }))
        .map(|f| f.rel)
        .context("no log segment written")?;
    Ok(Base {
        root: root.to_path_buf(),
        code,
        expected,
        plain,
        small_blob,
        large_blob,
        segment,
        log_records: LOG_RECORDS,
    })
}

fn activity(item: ItemId, ty: &str) -> LogRecord {
    let mut f = Map::new();
    f.insert("item".into(), Value::from(item.to_string()));
    f.insert("type".into(), Value::from(ty));
    f.insert("action".into(), Value::from("import"));
    f.insert("origin".into(), Value::from("import"));
    LogRecord::new(LogKind::Activity, f)
}

// ---- faults -------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Secret {
    Password,
    Recovery,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Extra {
    None,
    /// Exactly one log record is lost; the others read.
    OneLogRecordLost,
    /// The torn tail is dropped by the next append; the validator is clean after.
    TornTailRepaired,
    /// The small attachment still reads; the damaged large one does not.
    OtherBlobReads,
    /// The leftover temporary file is gone after opening.
    TmpCleared,
    /// With `tmp/` and the index gone, an item can still be edited, saved and read
    /// back (the library recreates `tmp/` for atomic writes).
    WritesAfterDrop,
    /// The password no longer unlocks (tampered KDF parameters are detected).
    PasswordRefused,
}

struct Plan {
    /// Findings that must be reported, as (path, category).
    expect: Vec<(String, Category)>,
    /// Exit code the validator must return.
    exit: u8,
    /// Items that must fail to load.
    damaged: BTreeSet<ItemId>,
    validate_with: Secret,
    open_with: Secret,
    extra: Extra,
}

impl Plan {
    fn clean(secret: Secret) -> Plan {
        Plan {
            expect: Vec::new(),
            exit: 0,
            damaged: BTreeSet::new(),
            validate_with: secret,
            open_with: secret,
            extra: Extra::None,
        }
    }

    fn corrupt(expect: Vec<(String, Category)>, damaged: &[ItemId], extra: Extra) -> Plan {
        Plan {
            expect,
            exit: 2,
            damaged: damaged.iter().copied().collect(),
            validate_with: Secret::Password,
            open_with: Secret::Password,
            extra,
        }
    }
}

/// Every fault the drill injects, in table order.
pub const FAULTS: &[&str] = &[
    "healthy",
    "flip-snapshot-byte",
    "truncate-update",
    "delete-item",
    "swap-items",
    "corrupt-log-record",
    "torn-log-tail",
    "corrupt-blob",
    "leftover-tmp-file",
    "drop-tmp-and-index",
    "tamper-kdf-params",
    "recovery-code-only",
];

fn snapshot_of(id: ItemId) -> String {
    DocDir::Items.snapshot(&layout::item_stem(&id))
}

fn updates_of(root: &Path, id: ItemId) -> anyhow::Result<Vec<String>> {
    let stem = layout::item_stem(&id);
    Ok(layout::scan(root)?
        .into_iter()
        .filter(|f| matches!(&f.kind, FileKind::Update { stem: s, .. } if *s == stem))
        .map(|f| f.rel)
        .collect())
}

fn flip_byte(root: &Path, rel: &str, offset: usize) -> anyhow::Result<()> {
    let path = root.join(rel);
    let mut data = fs::read(&path)?;
    anyhow::ensure!(offset < data.len(), "{rel} is shorter than {offset}");
    data[offset] ^= 0x5a;
    fs::write(&path, data)?;
    Ok(())
}

/// Damages `root` (a copy of the base library) and says what must happen.
fn apply(fault: &str, root: &Path, base: &Base) -> anyhow::Result<Plan> {
    let victim = |i: usize| base.plain[i % base.plain.len()];
    Ok(match fault {
        "healthy" => Plan::clean(Secret::Password),
        "flip-snapshot-byte" => {
            let v = victim(0);
            let rel = snapshot_of(v);
            let len = fs::metadata(root.join(&rel))?.len() as usize;
            flip_byte(root, &rel, len / 2)?;
            Plan::corrupt(vec![(rel, Category::Decrypt)], &[v], Extra::None)
        }
        "truncate-update" => {
            let v = victim(1);
            let rel = updates_of(root, v)?
                .into_iter()
                .next()
                .context("victim has no update file")?;
            let path = root.join(&rel);
            let len = fs::metadata(&path)?.len();
            fs::OpenOptions::new()
                .write(true)
                .open(&path)?
                .set_len(len - 10)?;
            Plan::corrupt(vec![(rel, Category::Decrypt)], &[v], Extra::None)
        }
        "delete-item" => {
            let v = victim(2);
            let rel = snapshot_of(v);
            fs::remove_file(root.join(&rel))?;
            Plan::corrupt(vec![(rel, Category::MissingSnapshot)], &[v], Extra::None)
        }
        "swap-items" => {
            let (a, b) = (victim(3), victim(4));
            let (ra, rb) = (snapshot_of(a), snapshot_of(b));
            let da = fs::read(root.join(&ra))?;
            let db = fs::read(root.join(&rb))?;
            fs::write(root.join(&ra), db)?;
            fs::write(root.join(&rb), da)?;
            Plan::corrupt(
                vec![(ra, Category::Decrypt), (rb, Category::Decrypt)],
                &[a, b],
                Extra::None,
            )
        }
        "corrupt-log-record" => {
            let shape = check::segment_shape(root, &base.segment)?;
            let rec = shape.records.get(1).context("segment has < 2 records")?;
            flip_byte(root, &base.segment, rec.ciphertext_offset() + 3)?;
            Plan::corrupt(
                vec![(base.segment.clone(), Category::LogRecord)],
                &[],
                Extra::OneLogRecordLost,
            )
        }
        "torn-log-tail" => {
            // A length prefix promising 100 bytes, followed by only 10.
            let path = root.join(&base.segment);
            let mut data = fs::read(&path)?;
            data.extend_from_slice(&100u32.to_le_bytes());
            data.extend_from_slice(&[0xab; 10]);
            fs::write(&path, data)?;
            Plan {
                expect: vec![(base.segment.clone(), Category::TornTail)],
                exit: 1,
                extra: Extra::TornTailRepaired,
                ..Plan::clean(Secret::Password)
            }
        }
        "corrupt-blob" => {
            let rel = layout::blob_path(&base.large_blob.0);
            // Inside the second chunk.
            flip_byte(root, &rel, 32 + 65_536 + 16 + 100)?;
            Plan::corrupt(vec![(rel, Category::Decrypt)], &[], Extra::OtherBlobReads)
        }
        "leftover-tmp-file" => {
            // A crash in the middle of an atomic write left a temporary file.
            fs::create_dir_all(root.join("tmp"))?;
            fs::write(root.join(LEFTOVER_TMP), b"half a file")?;
            Plan {
                extra: Extra::TmpCleared,
                ..Plan::clean(Secret::Password)
            }
        }
        "drop-tmp-and-index" => {
            // The whole tmp/ directory and the rebuildable index are deleted.
            anyhow::ensure!(
                root.join("tmp").is_dir() && root.join(INDEX_FILE).is_file(),
                "base library lacks tmp/ or the index file"
            );
            fs::remove_dir_all(root.join("tmp"))?;
            for f in layout::scan(root)? {
                if f.kind == FileKind::Index {
                    fs::remove_file(root.join(&f.rel))?;
                }
            }
            Plan {
                extra: Extra::WritesAfterDrop,
                ..Plan::clean(Secret::Password)
            }
        }
        "tamper-kdf-params" => {
            // The KDF parameters are bound into the password-wrapped key, so any
            // change (here t + 1) must make the password fail, not weaken it.
            let mut m = check::read_manifest(root)?;
            m.kdf.t += 1;
            fs::write(root.join(layout::MANIFEST), m.to_json()?)?;
            Plan {
                expect: vec![(layout::MANIFEST.to_owned(), Category::Unlock)],
                exit: 2,
                damaged: BTreeSet::new(),
                validate_with: Secret::Password,
                open_with: Secret::Recovery,
                extra: Extra::PasswordRefused,
            }
        }
        "recovery-code-only" => Plan::clean(Secret::Recovery),
        other => bail!("unknown fault {other}"),
    })
}

// ---- running and judging ------------------------------------------------------

/// Runs every fault on its own copy of a freshly generated library.
pub fn run_drill(cfg: &DrillConfig) -> anyhow::Result<Vec<Outcome>> {
    fs::create_dir_all(&cfg.dir)?;
    let base = build_base(&cfg.dir.join("base"), cfg.seed, cfg.items)?;
    let mut out = Vec::with_capacity(FAULTS.len());
    for fault in FAULTS {
        let root = cfg.dir.join(fault);
        copy_dir(&base.root, &root)?;
        let plan = apply(fault, &root, &base).with_context(|| format!("applying {fault}"))?;
        out.push(judge(fault, &root, &base, &plan));
    }
    Ok(out)
}

fn unlock<'a>(secret: Secret, base: &'a Base) -> Unlock<'a> {
    match secret {
        Secret::Password => Unlock::Password(PASSWORD),
        Secret::Recovery => Unlock::Recovery(&base.code),
    }
}

fn judge(fault: &'static str, root: &Path, base: &Base, plan: &Plan) -> Outcome {
    let validator = match validate::validate(root, Some(unlock(plan.validate_with, base))) {
        Ok(r) => judge_report(&r, plan),
        Err(e) => Verdict::fail(format!("validator error: {e:#}")),
    };
    let (opens, isolation) = match Library::open(root, unlock(plan.open_with, base)) {
        Ok(v) => {
            let iso = judge_isolation(&v, base, plan);
            (Verdict::pass(format!("{:?}", plan.open_with)), iso)
        }
        Err(e) => (
            Verdict::fail(format!("does not open: {e}")),
            Verdict::fail("not checked: library does not open"),
        ),
    };
    let recovery = match Library::open(root, Unlock::Recovery(&base.code)) {
        Ok(v) => {
            let extra = judge_extra(&v, root, base, plan.extra);
            drop(v);
            let after = if plan.extra == Extra::TornTailRepaired {
                match validate::validate(root, Some(Unlock::Password(PASSWORD))) {
                    Ok(r) if r.findings.is_empty() => Verdict::pass("validator clean after append"),
                    Ok(r) => Verdict::fail(format!(
                        "validator after append: {}",
                        summarize(&r.findings)
                    )),
                    Err(e) => Verdict::fail(format!("validator error: {e:#}")),
                }
            } else {
                Verdict::pass("")
            };
            Verdict::pass("recovery code unlocks").and(extra).and(after)
        }
        Err(e) => Verdict::fail(format!("recovery code does not unlock: {e}")),
    };
    Outcome {
        fault,
        validator,
        isolation,
        opens,
        recovery,
    }
}

fn summarize(findings: &[validate::Finding]) -> String {
    findings
        .iter()
        .map(|f| format!("{} {} ({})", f.category.as_str(), f.path, f.message))
        .collect::<Vec<_>>()
        .join(", ")
}

fn judge_report(r: &Report, plan: &Plan) -> Verdict {
    let mut problems = Vec::new();
    for (path, cat) in &plan.expect {
        if !r.has(path, *cat) {
            problems.push(format!("missing {} on {path}", cat.as_str()));
        }
    }
    let expected_paths: BTreeSet<&str> = plan.expect.iter().map(|(p, _)| p.as_str()).collect();
    let stray: Vec<_> = r
        .findings
        .iter()
        .filter(|f| f.severity == Severity::Corruption && !expected_paths.contains(f.path.as_str()))
        .cloned()
        .collect();
    if !stray.is_empty() {
        problems.push(format!("unexpected corruption: {}", summarize(&stray)));
    }
    if plan.expect.is_empty() && !r.findings.is_empty() {
        problems.push(format!("expected no findings: {}", summarize(&r.findings)));
    }
    if r.exit_code() != plan.exit {
        problems.push(format!("exit {} instead of {}", r.exit_code(), plan.exit));
    }
    if problems.is_empty() {
        Verdict::pass(format!(
            "{} finding(s), exit {}",
            r.findings.len(),
            r.exit_code()
        ))
    } else {
        Verdict::fail(problems.join("; "))
    }
}

fn judge_isolation(v: &Library, base: &Base, plan: &Plan) -> Verdict {
    let mut wrong = Vec::new();
    let mut intact = 0;
    for (id, exp) in &base.expected {
        let loaded = v
            .load_item(*id)
            .ok()
            .filter(|d| d.meta().is_ok_and(|m| m.title == exp.title) && d.body_text() == exp.body);
        match (loaded.is_some(), plan.damaged.contains(id)) {
            (true, false) => intact += 1,
            (false, true) => {}
            (true, true) => wrong.push(format!("{id} should be unreadable")),
            (false, false) => wrong.push(format!("{id} was lost or changed")),
        }
    }
    Verdict::check(
        wrong.is_empty(),
        if wrong.is_empty() {
            format!(
                "{intact}/{} intact, {} unreadable as expected",
                base.expected.len(),
                plan.damaged.len()
            )
        } else {
            wrong.join(", ")
        },
    )
}

fn judge_extra(v: &Library, root: &Path, base: &Base, extra: Extra) -> Verdict {
    let attempt = || -> anyhow::Result<Verdict> {
        Ok(match extra {
            Extra::None => Verdict::pass(""),
            Extra::OneLogRecordLost => {
                let logs = v.read_logs(LogKind::Activity)?;
                Verdict::check(
                    logs.damaged == 1 && logs.records.len() == base.log_records - 1,
                    format!(
                        "{} records read, {} damaged",
                        logs.records.len(),
                        logs.damaged
                    ),
                )
            }
            Extra::TornTailRepaired => {
                let before = v.read_logs(LogKind::Activity)?;
                v.append_log(LogKind::Activity, &activity(base.plain[0], "note"))?;
                let after = v.read_logs(LogKind::Activity)?;
                Verdict::check(
                    before.torn_tail_bytes > 0
                        && after.torn_tail_bytes == 0
                        && after.damaged == 0
                        && after.records.len() == base.log_records + 1,
                    format!(
                        "torn {} -> {} bytes, {} records after append",
                        before.torn_tail_bytes,
                        after.torn_tail_bytes,
                        after.records.len()
                    ),
                )
            }
            Extra::OtherBlobReads => {
                let mut small = Vec::new();
                v.read_blob(&base.small_blob.0, &mut small)?;
                let large_fails = v.read_blob(&base.large_blob.0, &mut Vec::new()).is_err();
                Verdict::check(
                    small == base.small_blob.1 && large_fails && base.large_blob.1.len() > 65_536,
                    "other attachment reads, damaged one refused",
                )
            }
            Extra::TmpCleared => Verdict::check(
                !root.join(LEFTOVER_TMP).exists(),
                "leftover temporary file removed on open",
            ),
            Extra::WritesAfterDrop => {
                let id = base.plain[0];
                let mut doc = v.load_item(id)?;
                doc.set_body_text("written after tmp/ and the index were deleted")?;
                doc.commit(ChangeOrigin::Me, None);
                let wrote = v.save_item(&mut doc)?;
                let back = v.load_item(id)?.body_text();
                Verdict::check(
                    wrote
                        && back == doc.body_text()
                        && !root.join(INDEX_FILE).exists()
                        && check::unexpected_dirs(root)?.is_empty(),
                    "item edited, saved and read back without tmp/ or the index",
                )
            }
            Extra::PasswordRefused => {
                // The recovery-code library `v` holds the lock; check through the
                // lock-free inspector instead of a second open.
                Verdict::check(
                    check::Inspector::unlock(root, Unlock::Password(PASSWORD)).is_err(),
                    "password refused after tampering",
                )
            }
        })
    };
    attempt().unwrap_or_else(|e| Verdict::fail(format!("{e:#}")))
}

fn copy_dir(from: &Path, to: &Path) -> anyhow::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verdicts_combine() {
        let v = Verdict::pass("a").and(Verdict::fail("b"));
        assert!(!v.ok);
        assert_eq!(v.detail, "a; b");
        assert_eq!(Verdict::pass("a").and(Verdict::pass("")).detail, "a");
    }

    #[test]
    fn table_lists_failures() {
        let o = Outcome {
            fault: "x",
            validator: Verdict::pass("ok"),
            isolation: Verdict::fail("lost"),
            opens: Verdict::pass("ok"),
            recovery: Verdict::pass("ok"),
        };
        let t = render_table(&[o]);
        assert!(t.contains("FAIL"));
        assert!(t.contains("x / isolation: lost"));
        assert!(t.contains("0/1 faults passed"));
    }
}
