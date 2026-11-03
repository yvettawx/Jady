//! Format validator (P0-38): every check of `docs/format-spec.md` §18.
//!
//! Checks 1–6 need no key and always run; checks 7–12 run when unlock options are
//! given. Each problem is reported with its file, a category and a severity; the
//! exit code is 0 (none), 1 (warnings only) or 2 (corruption). The validator only
//! reads: it unlocks through [`check::Inspector`], which takes no lock and writes
//! nothing, so a damaged library is seen exactly as it is.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::process::ExitCode;

use anyhow::Context;
use dem_crypto::{CryptoError, RecoveryCode};
use dem_model::ItemId;
use dem_store::check::{self, DocCheck, Inspector};
use dem_store::layout::{self, DocDir, FileKind};
use dem_store::logs::FORBIDDEN_FIELDS;
use dem_store::manifest::Manifest;
use dem_store::{ItemDoc, StoreError, Unlock};
use serde::Serialize;
use serde_json::Value as J;

use crate::LibraryArgs;

#[derive(Debug, Clone, clap::Args)]
pub struct Args {
    #[command(flatten)]
    pub library: LibraryArgs,
    /// Print the report as JSON.
    #[arg(long)]
    pub json: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Warning,
    Corruption,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Category {
    /// §18.1: manifest missing, unparsable or out of range.
    Manifest,
    /// §18.2–3: file or directory not allowed by the layout or naming rules.
    Layout,
    /// §18.4, §18.6: envelope header (magic, version, key id, minimum length).
    Header,
    /// §18.5: log segment framing.
    LogFrame,
    /// §18.5: half-written record at the end of a segment (a warning).
    TornTail,
    /// §18.6: attachment length does not fit the chunking rule.
    BlobLength,
    /// The given password or recovery code does not unlock the library.
    Unlock,
    /// §18.7: a file does not decrypt (also a file at the wrong path).
    Decrypt,
    /// §18.8: Loro import, schema version or metadata.
    Document,
    /// §18.8: update files whose snapshot is missing.
    MissingSnapshot,
    /// §18.9: structure document problems (reported, never fixed).
    Structure,
    /// §18.10: a relation or inline link to an item that does not exist.
    Dangling,
    /// §18.11: an attachment's content does not match its name.
    BlobName,
    /// §18.12: a log record does not decrypt or has invalid content.
    LogRecord,
}

impl Category {
    pub fn as_str(self) -> &'static str {
        match self {
            Category::Manifest => "manifest",
            Category::Layout => "layout",
            Category::Header => "header",
            Category::LogFrame => "log-frame",
            Category::TornTail => "torn-tail",
            Category::BlobLength => "blob-length",
            Category::Unlock => "unlock",
            Category::Decrypt => "decrypt",
            Category::Document => "document",
            Category::MissingSnapshot => "missing-snapshot",
            Category::Structure => "structure",
            Category::Dangling => "dangling",
            Category::BlobName => "blob-name",
            Category::LogRecord => "log-record",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Finding {
    /// Library-relative path of the file concerned (possibly a missing one).
    pub path: String,
    pub category: Category,
    pub severity: Severity,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Report {
    pub library: String,
    /// Whether the keyed checks (7–12) ran.
    pub keyed: bool,
    pub findings: Vec<Finding>,
}

impl Report {
    pub fn count(&self, s: Severity) -> usize {
        self.findings.iter().filter(|f| f.severity == s).count()
    }

    /// 0 no problems, 1 warnings only, 2 corruption.
    pub fn exit_code(&self) -> u8 {
        if self.count(Severity::Corruption) > 0 {
            2
        } else if self.count(Severity::Warning) > 0 {
            1
        } else {
            0
        }
    }

    pub fn has(&self, path: &str, category: Category) -> bool {
        self.findings
            .iter()
            .any(|f| f.path == path && f.category == category)
    }

    pub fn render_human(&self) -> String {
        let mut out = format!(
            "library {} ({} checks)\n",
            self.library,
            if self.keyed {
                "keyless and keyed"
            } else {
                "keyless only; give --password or --recovery for the rest"
            }
        );
        for f in &self.findings {
            let sev = match f.severity {
                Severity::Warning => "warning",
                Severity::Corruption => "CORRUPTION",
            };
            out.push_str(&format!(
                "{sev:<10}  {:<16}  {}  {}\n",
                f.category.as_str(),
                f.path,
                f.message
            ));
        }
        if self.findings.is_empty() {
            out.push_str("no problems found\n");
        } else {
            out.push_str(&format!(
                "{} corruption, {} warning(s)\n",
                self.count(Severity::Corruption),
                self.count(Severity::Warning)
            ));
        }
        out
    }
}

pub fn run(args: Args) -> anyhow::Result<ExitCode> {
    let password = match (&args.library.password, &args.library.recovery) {
        (Some(p), _) => Some(p.clone()),
        (None, None) => std::env::var("DEM_PASSWORD").ok(),
        (None, Some(_)) => None,
    };
    let recovery = match &args.library.recovery {
        Some(c) => Some(RecoveryCode::parse(c).context("invalid recovery code")?),
        None => None,
    };
    let unlock = match (&recovery, &password) {
        (Some(code), _) => Some(Unlock::Recovery(code)),
        (None, Some(p)) => Some(Unlock::Password(p.as_bytes())),
        (None, None) => None,
    };
    let report = validate(&args.library.library, unlock)?;
    if args.json {
        println!("{}", serde_json::to_string_pretty(&report)?);
    } else {
        print!("{}", report.render_human());
    }
    Ok(ExitCode::from(report.exit_code()))
}

/// Validates the library at `root`. Keyed checks run when `unlock` is given. Errors
/// are returned only when the library directory itself cannot be read.
pub fn validate(root: &Path, unlock: Option<Unlock<'_>>) -> anyhow::Result<Report> {
    anyhow::ensure!(root.is_dir(), "{} is not a directory", root.display());
    let mut v = Validator {
        root,
        findings: Vec::new(),
        key_ids: None,
    };
    v.check_manifest();
    let inv = v.check_files()?;
    let keyed = unlock.is_some();
    if let Some(u) = unlock {
        match Inspector::unlock(root, u) {
            Ok(ins) => Keyed {
                v: &mut v,
                ins: &ins,
                inv: &inv,
            }
            .run(),
            Err(e) => v.corrupt(
                layout::MANIFEST,
                Category::Unlock,
                format!("cannot unlock: {e} (wrong secret, or tampered KDF parameters)"),
            ),
        }
    }
    let mut findings = v.findings;
    findings
        .sort_by(|a, b| (&a.path, a.category, &a.message).cmp(&(&b.path, b.category, &b.message)));
    findings.dedup();
    Ok(Report {
        library: root.display().to_string(),
        keyed,
        findings,
    })
}

struct Validator<'a> {
    root: &'a Path,
    findings: Vec<Finding>,
    key_ids: Option<Vec<u16>>,
}

/// Files found by the keyless pass, grouped for the keyed pass.
#[derive(Default)]
struct Inventory {
    /// (dir, stem) → (snapshot, updates).
    docs: BTreeMap<(u8, String), DocFiles>,
    local: Vec<String>,
    /// (path, kind, records already framed by the keyless pass).
    segments: Vec<(String, String, usize)>,
    blobs: Vec<(String, String)>,
}

struct DocFiles {
    dir: DocDir,
    snapshot: Option<String>,
    updates: Vec<String>,
}

fn dir_key(d: DocDir) -> u8 {
    match d {
        DocDir::Structure => 0,
        DocDir::Types => 1,
        DocDir::Items => 2,
    }
}

impl Validator<'_> {
    fn push(&mut self, path: &str, category: Category, severity: Severity, message: String) {
        self.findings.push(Finding {
            path: path.to_owned(),
            category,
            severity,
            message,
        });
    }

    fn corrupt(&mut self, path: &str, category: Category, message: String) {
        self.push(path, category, Severity::Corruption, message);
    }

    fn warn(&mut self, path: &str, category: Category, message: String) {
        self.push(path, category, Severity::Warning, message);
    }

    // §18.1
    fn check_manifest(&mut self) {
        let m = match check::read_manifest(self.root) {
            Ok(m) => m,
            Err(e) => {
                self.corrupt(layout::MANIFEST, Category::Manifest, e.to_string());
                return;
            }
        };
        for problem in manifest_problems(&m) {
            self.corrupt(layout::MANIFEST, Category::Manifest, problem);
        }
        // `Manifest::parse` refuses newer versions; older ones open but need a
        // migration (§17), and 0 was never a valid version.
        match m.format_version {
            0 => self.corrupt(
                layout::MANIFEST,
                Category::Manifest,
                "format_version 0 is not a valid version".into(),
            ),
            v if v < dem_store::FORMAT_VERSION => self.warn(
                layout::MANIFEST,
                Category::Manifest,
                format!(
                    "format_version {v} is older than {}; the library needs a migration",
                    dem_store::FORMAT_VERSION
                ),
            ),
            _ => {}
        }
        if m.library_id.get_version_num() != 7 {
            self.warn(
                layout::MANIFEST,
                Category::Manifest,
                "library_id is not a UUIDv7".into(),
            );
        }
        self.key_ids = Some(m.file_key_ids.clone());
    }

    fn check_key_id(&mut self, rel: &str, key_id: u16) {
        if let Some(ids) = &self.key_ids
            && !ids.contains(&key_id)
        {
            self.corrupt(
                rel,
                Category::Header,
                format!("file key id {key_id} is not in manifest file_key_ids"),
            );
        }
    }

    // §18.2–6
    fn check_files(&mut self) -> anyhow::Result<Inventory> {
        let mut inv = Inventory::default();
        for d in check::unexpected_dirs(self.root)? {
            self.warn(
                &d,
                Category::Layout,
                "directory not allowed by the layout".into(),
            );
        }
        for f in layout::scan(self.root)? {
            let rel = f.rel;
            match f.kind {
                FileKind::Manifest
                | FileKind::Lock
                | FileKind::Index
                | FileKind::Temp
                | FileKind::Vault => {}
                FileKind::Unexpected => {
                    let looks_like_data = [".dexm", ".dexu", ".dexl", ".dexs"]
                        .iter()
                        .any(|e| rel.ends_with(e));
                    let msg = "file not allowed here by the layout or naming rules".to_owned();
                    if looks_like_data {
                        self.corrupt(&rel, Category::Layout, msg);
                    } else {
                        self.warn(&rel, Category::Layout, msg);
                    }
                }
                FileKind::Local => {
                    if self.check_sealed_header(&rel) {
                        inv.local.push(rel);
                    }
                }
                FileKind::Snapshot { dir, stem } => {
                    let ok = self.check_sealed_header(&rel);
                    let e = doc_entry(&mut inv, dir, &stem);
                    // A snapshot with a bad header is present (not missing) but
                    // unreadable; the empty path marks it for the keyed pass.
                    e.snapshot = Some(if ok { rel } else { String::new() });
                }
                FileKind::Update { dir, stem, .. } => {
                    let ok = self.check_sealed_header(&rel);
                    let e = doc_entry(&mut inv, dir, &stem);
                    if ok {
                        e.updates.push(rel);
                    }
                }
                FileKind::LogSegment { kind, .. } => {
                    if let Some(n) = self.check_segment(&rel) {
                        inv.segments.push((rel, kind, n));
                    }
                }
                FileKind::Blob { name } => {
                    if self.check_blob_shape(&rel) {
                        inv.blobs.push((rel, name));
                    }
                }
            }
        }
        let structure = (
            dir_key(DocDir::Structure),
            layout::STRUCTURE_STEM.to_owned(),
        );
        if !inv.docs.contains_key(&structure) {
            self.corrupt(
                &DocDir::Structure.snapshot(layout::STRUCTURE_STEM),
                Category::MissingSnapshot,
                "the structure document is missing".into(),
            );
        }
        for ((_, stem), files) in &inv.docs {
            if files.snapshot.is_none() {
                self.findings.push(Finding {
                    path: files.dir.snapshot(stem),
                    category: Category::MissingSnapshot,
                    severity: Severity::Corruption,
                    message: format!(
                        "snapshot missing; {} update file(s) cannot be read without it",
                        files.updates.len()
                    ),
                });
            }
        }
        Ok(inv)
    }

    /// §18.4. Returns whether the header is valid.
    fn check_sealed_header(&mut self, rel: &str) -> bool {
        match check::sealed_header(self.root, rel) {
            Ok(h) => {
                self.check_key_id(rel, h.key_id);
                true
            }
            Err(e) => {
                self.corrupt(rel, Category::Header, e.to_string());
                false
            }
        }
    }

    /// §18.5. Returns the number of framed records when the header is valid.
    fn check_segment(&mut self, rel: &str) -> Option<usize> {
        match check::segment_shape(self.root, rel) {
            Ok(s) => {
                self.check_key_id(rel, s.header.key_id);
                if let Some(at) = s.bad_length_at {
                    self.corrupt(
                        rel,
                        Category::LogFrame,
                        format!(
                            "invalid record length at offset {at}; the rest of the segment cannot be framed"
                        ),
                    );
                }
                if s.torn_tail_bytes > 0 {
                    self.warn(
                        rel,
                        Category::TornTail,
                        format!(
                            "{} byte(s) of an interrupted append at the end (dropped on the next append)",
                            s.torn_tail_bytes
                        ),
                    );
                }
                Some(s.records.len())
            }
            Err(e) => {
                self.corrupt(rel, Category::Header, e.to_string());
                None
            }
        }
    }

    /// §18.6. Returns whether header and length are valid.
    fn check_blob_shape(&mut self, rel: &str) -> bool {
        match check::blob_shape(self.root, rel) {
            Ok(h) => {
                self.check_key_id(rel, h.key_id);
                true
            }
            Err(StoreError::Crypto(CryptoError::Truncated)) => {
                self.corrupt(
                    rel,
                    Category::BlobLength,
                    "length does not match the chunking rule (truncated or extended)".into(),
                );
                false
            }
            Err(e) => {
                self.corrupt(rel, Category::Header, e.to_string());
                false
            }
        }
    }
}

fn doc_entry<'a>(inv: &'a mut Inventory, dir: DocDir, stem: &str) -> &'a mut DocFiles {
    inv.docs
        .entry((dir_key(dir), stem.to_owned()))
        .or_insert_with(|| DocFiles {
            dir,
            snapshot: None,
            updates: Vec::new(),
        })
}

/// Range checks beyond what [`Manifest::parse`] enforces (§18.1).
fn manifest_problems(m: &Manifest) -> Vec<String> {
    let mut out = Vec::new();
    let k = &m.kdf;
    if !(1..=64).contains(&k.p) {
        out.push(format!("kdf.p = {} is outside 1..=64", k.p));
    }
    if !(1..=64).contains(&k.t) {
        out.push(format!("kdf.t = {} is outside 1..=64", k.t));
    }
    if k.m_kib < 8 * k.p.max(1) || k.m_kib > 4 * 1024 * 1024 {
        out.push(format!("kdf.m_kib = {} is outside 8·p ..= 4 GiB", k.m_kib));
    }
    for kind in ["password", "recovery"] {
        match m.wrapped(kind) {
            Ok(w) if w.ciphertext.len() == 48 => {}
            Ok(w) => out.push(format!(
                "{kind} wrapped key is {} bytes, expected 48",
                w.ciphertext.len()
            )),
            Err(e) => out.push(e.to_string()),
        }
    }
    let mut ids = m.file_key_ids.clone();
    ids.sort_unstable();
    ids.dedup();
    if ids.len() != m.file_key_ids.len() {
        out.push("file_key_ids has duplicates".into());
    }
    out
}

/// The keyed pass (§18.7–12).
struct Keyed<'a, 'b> {
    v: &'a mut Validator<'b>,
    ins: &'a Inspector,
    inv: &'a Inventory,
}

struct LoadedItem {
    snapshot: String,
    doc: ItemDoc,
}

impl Keyed<'_, '_> {
    fn run(mut self) {
        for rel in &self.inv.local {
            if let Err(e) = self.ins.open_sealed(rel) {
                self.v.corrupt(rel, Category::Decrypt, e.to_string());
            }
        }
        // Items that have a snapshot file count as existing, even when damaged:
        // damage is reported on the file itself, not as dangling links elsewhere.
        let existing: BTreeSet<String> = self
            .inv
            .docs
            .iter()
            .filter(|((d, _), f)| *d == dir_key(DocDir::Items) && f.snapshot.is_some())
            .map(|((_, stem), _)| stem.clone())
            .collect();
        let mut items = Vec::new();
        let mut structure = None;
        for ((_, stem), files) in &self.inv.docs {
            let Some(c) = self.check_doc(files, stem) else {
                continue;
            };
            if let Some(doc) = c.item {
                items.push(LoadedItem {
                    snapshot: files.dir.snapshot(stem),
                    doc,
                });
            }
            if let Some(s) = c.structure {
                structure = Some(s);
            }
        }
        for item in &items {
            self.check_links(item, &existing);
        }
        if let Some(s) = &structure {
            self.check_structure(s, &existing, &items);
        }
        for (rel, name) in &self.inv.blobs {
            match self.ins.check_blob(rel, name) {
                Ok(true) => {}
                Ok(false) => self.v.corrupt(
                    rel,
                    Category::BlobName,
                    "content does not match the attachment name".into(),
                ),
                Err(e) => self.v.corrupt(rel, Category::Decrypt, e.to_string()),
            }
        }
        for (rel, kind, framed) in &self.inv.segments {
            self.check_segment(rel, kind, *framed);
        }
    }

    /// §18.7–8 for one document. Every file is decrypted (§18.7 applies to update
    /// files even when their snapshot is missing or unreadable); the document is
    /// imported only when its snapshot decrypts. None otherwise.
    fn check_doc(&mut self, files: &DocFiles, stem: &str) -> Option<DocCheck> {
        let snapshot = files.snapshot.as_ref().filter(|s| !s.is_empty());
        let mut parts = Vec::with_capacity(1 + files.updates.len());
        let mut snapshot_ok = false;
        for rel in snapshot.into_iter().chain(&files.updates) {
            match self.ins.open_sealed(rel) {
                Ok(bytes) => {
                    snapshot_ok |= Some(rel) == snapshot;
                    parts.push((rel.clone(), bytes));
                }
                Err(e) => self.v.corrupt(rel, Category::Decrypt, e.to_string()),
            }
        }
        let snapshot = snapshot.filter(|_| snapshot_ok)?;
        let c = check::check_doc(files.dir, stem, &parts);
        for (rel, msg) in &c.import_errors {
            self.v.corrupt(
                rel,
                Category::Document,
                format!("CRDT import failed: {msg}"),
            );
        }
        if let Some(msg) = &c.doc_error {
            self.v.corrupt(snapshot, Category::Document, msg.clone());
        }
        Some(c)
    }

    /// §18.10.
    fn check_links(&mut self, item: &LoadedItem, existing: &BTreeSet<String>) {
        let doc = &item.doc;
        let path = &item.snapshot;
        for rid in check::malformed_links(doc) {
            self.v.corrupt(
                path,
                Category::Document,
                format!("relation {rid} lacks a valid `to` or `kind`"),
            );
        }
        for (rid, to, _) in doc.links() {
            if !existing.contains(&to.to_string()) {
                self.v.warn(
                    path,
                    Category::Dangling,
                    format!("relation {rid} points to missing item {to}"),
                );
            }
        }
        for to in check::inline_links(doc) {
            if !existing.contains(&to) {
                self.v.warn(
                    path,
                    Category::Dangling,
                    format!("inline link points to missing item {to}"),
                );
            }
        }
        if let Ok(m) = doc.meta()
            && let Some(c) = m.container
            && !existing.contains(&c.to_string())
        {
            self.v.warn(
                path,
                Category::Dangling,
                format!("meta.container points to missing item {c}"),
            );
        }
    }

    /// §18.9: reported, never fixed.
    fn check_structure(
        &mut self,
        s: &dem_store::StructureDoc,
        existing: &BTreeSet<String>,
        items: &[LoadedItem],
    ) {
        let path = DocDir::Structure.snapshot(layout::STRUCTURE_STEM);
        let nodes = check::structure_raw_nodes(s);
        let types: BTreeMap<String, String> = items
            .iter()
            .filter_map(|i| Some((i.doc.id().to_string(), i.doc.meta().ok()?.type_id.0)))
            .collect();
        let kind_of: BTreeMap<&str, Option<&str>> = nodes
            .iter()
            .map(|n| (n.node.as_str(), n.kind.as_deref()))
            .collect();
        let mut seen: BTreeMap<&str, usize> = BTreeMap::new();
        for n in &nodes {
            let label = format!("node {}", n.node);
            let item = n.item.as_deref().filter(|i| i.parse::<ItemId>().is_ok());
            let Some(item) = item else {
                self.v.warn(
                    &path,
                    Category::Structure,
                    format!("{label} has no valid `item`"),
                );
                continue;
            };
            *seen.entry(item).or_default() += 1;
            let kind = n.kind.as_deref();
            if !matches!(kind, Some("domain" | "project")) {
                self.v.warn(
                    &path,
                    Category::Structure,
                    format!("{label} ({item}) has an invalid `kind`"),
                );
            }
            if !existing.contains(item) {
                self.v.warn(
                    &path,
                    Category::Structure,
                    format!("{label} refers to missing item {item}"),
                );
            } else if let (Some(k), Some(t)) = (kind, types.get(item))
                && k != t
            {
                self.v.warn(
                    &path,
                    Category::Structure,
                    format!("{label}: kind {k} but item {item} has type {t}"),
                );
            }
            let parent_kind = n
                .parent
                .as_deref()
                .map(|p| kind_of.get(p).copied().flatten());
            match (kind, parent_kind) {
                (_, Some(Some("project"))) => self.v.warn(
                    &path,
                    Category::Structure,
                    format!("{label} ({item}) is under a project; projects have no children"),
                ),
                (Some("project"), None) => self.v.warn(
                    &path,
                    Category::Structure,
                    format!("project {item} is at the top level; projects belong under domains"),
                ),
                _ => {}
            }
        }
        for (item, n) in seen {
            if n > 1 {
                self.v.warn(
                    &path,
                    Category::Structure,
                    format!("item {item} appears in {n} nodes; the first one wins"),
                );
            }
        }
        // Items claiming a container that is not in the structure.
        let in_tree: BTreeSet<&str> = nodes.iter().filter_map(|n| n.item.as_deref()).collect();
        for i in items {
            if let Ok(m) = i.doc.meta()
                && let Some(c) = m.container
                && existing.contains(&c.to_string())
                && !in_tree.contains(c.to_string().as_str())
            {
                self.v.warn(
                    &i.snapshot,
                    Category::Structure,
                    format!("meta.container {c} is not a domain or project in the structure"),
                );
            }
        }
    }

    /// §18.12. `framed` records were framed by the keyless pass; anything after
    /// them comes from an invalid length already reported as `log-frame`.
    fn check_segment(&mut self, rel: &str, kind: &str, framed: usize) {
        let seg = match self.ins.open_segment(rel) {
            Ok(s) => s,
            Err(e) => {
                self.v.corrupt(rel, Category::Decrypt, e.to_string());
                return;
            }
        };
        for (i, r) in seg.records.iter().take(framed).enumerate() {
            match r {
                Err(_) => self.v.corrupt(
                    rel,
                    Category::LogRecord,
                    format!("record {i} does not decrypt"),
                ),
                Ok(bytes) => {
                    for p in record_problems(kind, bytes) {
                        self.v
                            .corrupt(rel, Category::LogRecord, format!("record {i}: {p}"));
                    }
                }
            }
        }
    }
}

/// Problems with one decrypted log record (§12.2). Never echoes record content.
pub fn record_problems(segment_kind: &str, bytes: &[u8]) -> Vec<String> {
    let Ok(v) = serde_json::from_slice::<J>(bytes) else {
        return vec!["not valid JSON".into()];
    };
    let Some(obj) = v.as_object() else {
        return vec!["not a JSON object".into()];
    };
    let mut out = Vec::new();
    match obj.get("v").and_then(J::as_u64) {
        Some(1) => {}
        Some(n) => out.push(format!("unsupported record version {n}")),
        None => out.push("missing `v`".into()),
    }
    match obj.get("ts").and_then(J::as_str) {
        Some(ts) if ts.parse::<jiff::Timestamp>().is_ok() => {}
        Some(_) => out.push("`ts` is not RFC 3339".into()),
        None => out.push("missing `ts`".into()),
    }
    match obj.get("kind").and_then(J::as_str) {
        Some(k) if k == segment_kind => {}
        Some(_) => out.push(format!("`kind` does not match the {segment_kind} segment")),
        None => out.push("missing `kind`".into()),
    }
    let mut forbidden = BTreeSet::new();
    find_forbidden(&v, &mut forbidden);
    for k in forbidden {
        out.push(format!("contains forbidden content field `{k}`"));
    }
    out
}

fn find_forbidden(v: &J, out: &mut BTreeSet<String>) {
    match v {
        J::Object(m) => {
            for (k, x) in m {
                if FORBIDDEN_FIELDS.contains(&k.as_str()) {
                    out.insert(k.clone());
                }
                find_forbidden(x, out);
            }
        }
        J::Array(xs) => xs.iter().for_each(|x| find_forbidden(x, out)),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn record_rules() {
        let ok = br#"{"v":1,"ts":"2026-10-18T03:00:00Z","kind":"activity","item":"x"}"#;
        assert!(record_problems("activity", ok).is_empty());
        assert_eq!(record_problems("review", ok).len(), 1);
        let bad = br#"{"v":2,"kind":"activity","meta":{"title":"secret"}}"#;
        let p = record_problems("activity", bad);
        assert_eq!(p.len(), 3, "{p:?}");
        assert!(p.iter().all(|m| !m.contains("secret")));
        assert_eq!(record_problems("activity", b"[]"), ["not a JSON object"]);
        assert_eq!(record_problems("activity", b"{"), ["not valid JSON"]);
    }

    #[test]
    fn exit_codes() {
        let mut r = Report {
            library: "v".into(),
            keyed: false,
            findings: vec![],
        };
        assert_eq!(r.exit_code(), 0);
        r.findings.push(Finding {
            path: "a".into(),
            category: Category::Dangling,
            severity: Severity::Warning,
            message: String::new(),
        });
        assert_eq!(r.exit_code(), 1);
        r.findings.push(Finding {
            path: "b".into(),
            category: Category::Decrypt,
            severity: Severity::Corruption,
            message: String::new(),
        });
        assert_eq!(r.exit_code(), 2);
        assert!(r.has("b", Category::Decrypt));
        let json = serde_json::to_value(&r).unwrap();
        assert_eq!(json["findings"][1]["category"], "decrypt");
        assert_eq!(json["findings"][1]["severity"], "corruption");
    }
}
