//! Format validator (P0-38): a healthy library is clean; each §18 check fires on the
//! damage it is meant to find, with the right file, category and exit code.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use clap::Parser;
use dem_crypto::{KdfParams, RecoveryCode, records, stream};
use dem_devtools::validate::{Category, Report, Severity, validate};
use dem_model::{
    ChangeOrigin, ItemId, ItemMeta, ItemState, Privacy, SourceInfo, Timestamp, TypeId,
};
use dem_store::layout::{self, DocDir};
use dem_store::logs::{LogKind, LogRecord};
use dem_store::{Library, NodeKind, Unlock};
use serde_json::{Map, Value};

const PW: &[u8] = b"validator test";

fn meta(ty: &str, container: Option<ItemId>) -> ItemMeta {
    let now = Timestamp::now();
    ItemMeta {
        id: ItemId::new(),
        type_id: TypeId(ty.into()),
        title: Some("标题".into()),
        state: ItemState::Active,
        privacy: Privacy::Normal,
        container,
        tags: vec![],
        created: now,
        updated: now,
        time: None,
        source: SourceInfo::default(),
        ai_web: false,
    }
}

struct Fixture {
    _dir: tempfile::TempDir,
    root: PathBuf,
    code: RecoveryCode,
    /// A domain, a note inside it linking to a second note.
    domain: ItemId,
    note: ItemId,
    other: ItemId,
    blob: String,
}

fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("v");
    let (library, code) = Library::create(&root, PW, KdfParams::INSECURE_FOR_TESTS).unwrap();
    let d = meta("domain", None);
    library.create_item(&d).unwrap();
    let mut s = library.load_structure().unwrap();
    s.add(d.id, NodeKind::Domain, None).unwrap();
    s.commit("system");
    library.save_structure(&mut s).unwrap();

    let o = meta("note", Some(d.id));
    library.create_item(&o).unwrap();
    let n = meta("note", Some(d.id));
    let mut doc = library.create_item(&n).unwrap();
    doc.set_body_text("正文 café\n𗀀").unwrap();
    doc.add_link(o.id, "reference").unwrap();
    doc.commit(ChangeOrigin::Me, None);
    library.save_item(&mut doc).unwrap();

    let mut f = Map::new();
    f.insert("item".into(), Value::from(n.id.to_string()));
    f.insert("action".into(), Value::from("edit"));
    library
        .append_log(
            LogKind::Activity,
            &LogRecord::new(LogKind::Activity, f.clone()),
        )
        .unwrap();
    library
        .append_log(LogKind::Activity, &LogRecord::new(LogKind::Activity, f))
        .unwrap();
    let blob = library.put_blob(b"attachment").unwrap();
    drop(library);
    Fixture {
        _dir: dir,
        root,
        code,
        domain: d.id,
        note: n.id,
        other: o.id,
        blob,
    }
}

fn keyed(root: &Path) -> Report {
    validate(root, Some(Unlock::Password(PW))).unwrap()
}

fn keyless(root: &Path) -> Report {
    validate(root, None).unwrap()
}

fn snapshot(id: ItemId) -> String {
    DocDir::Items.snapshot(&layout::item_stem(&id))
}

fn segment(root: &Path) -> String {
    layout::scan(root)
        .unwrap()
        .into_iter()
        .find(|f| f.rel.ends_with(".dexl"))
        .unwrap()
        .rel
}

fn assert_finding(r: &Report, path: &str, cat: Category, sev: Severity) {
    assert!(
        r.findings
            .iter()
            .any(|f| f.path == path && f.category == cat && f.severity == sev),
        "expected {cat:?}/{sev:?} on {path}:\n{}",
        r.render_human()
    );
}

#[test]
fn healthy_library_is_clean_with_and_without_keys() {
    let fx = fixture();
    let r = keyless(&fx.root);
    assert!(!r.keyed);
    assert!(r.findings.is_empty(), "{}", r.render_human());
    let r = keyed(&fx.root);
    assert!(r.keyed);
    assert!(r.findings.is_empty(), "{}", r.render_human());
    assert_eq!(r.exit_code(), 0);
    let r = validate(&fx.root, Some(Unlock::Recovery(&fx.code))).unwrap();
    assert!(r.findings.is_empty(), "{}", r.render_human());
}

#[test]
fn validator_does_not_touch_the_library() {
    let fx = fixture();
    let _held = Library::open(&fx.root, Unlock::Password(PW)).unwrap();
    // Works while the app holds the lock, and leaves a crash leftover in place
    // (opening a library would clear tmp/).
    fs::create_dir_all(fx.root.join("tmp")).unwrap();
    fs::write(fx.root.join("tmp/leftover.tmp"), b"x").unwrap();
    let before = layout::scan(&fx.root).unwrap();
    let r = keyed(&fx.root);
    assert_eq!(r.exit_code(), 0, "{}", r.render_human());
    assert_eq!(before, layout::scan(&fx.root).unwrap());
}

#[test]
fn flipped_ciphertext_needs_the_key_to_be_seen() {
    let fx = fixture();
    let rel = snapshot(fx.note);
    let path = fx.root.join(&rel);
    let mut data = fs::read(&path).unwrap();
    let mid = data.len() / 2;
    data[mid] ^= 1;
    fs::write(&path, data).unwrap();
    assert!(keyless(&fx.root).findings.is_empty());
    let r = keyed(&fx.root);
    assert_finding(&r, &rel, Category::Decrypt, Severity::Corruption);
    assert_eq!(r.exit_code(), 2);
    // The other item is not reported, and links to the damaged one are not dangling.
    assert!(
        r.findings.iter().all(|f| f.path == rel),
        "{}",
        r.render_human()
    );
}

#[test]
fn bad_headers_are_found_without_a_key() {
    let fx = fixture();
    let rel = snapshot(fx.other);
    let path = fx.root.join(&rel);
    let mut data = fs::read(&path).unwrap();
    data[0] = b'X';
    fs::write(&path, &data).unwrap();
    let r = keyless(&fx.root);
    assert_finding(&r, &rel, Category::Header, Severity::Corruption);

    // Unknown key id and a too-short file.
    data[0] = b'D';
    data[6] = 9;
    fs::write(&path, &data).unwrap();
    assert_finding(
        &keyless(&fx.root),
        &rel,
        Category::Header,
        Severity::Corruption,
    );
    fs::write(&path, &data[..40]).unwrap();
    assert_finding(
        &keyless(&fx.root),
        &rel,
        Category::Header,
        Severity::Corruption,
    );
}

#[test]
fn layout_and_naming_rules() {
    let fx = fixture();
    fs::write(fx.root.join("notes.txt"), b"x").unwrap();
    fs::create_dir_all(fx.root.join("items/zz")).unwrap();
    // A real item file under the wrong shard.
    let rel = snapshot(fx.other);
    let stem = layout::item_stem(&fx.other);
    let shard = dem_crypto::shard(&stem);
    let wrong = if shard == "00" { "01" } else { "00" };
    let misplaced = format!("items/{wrong}/{stem}.dexm");
    fs::create_dir_all(fx.root.join(format!("items/{wrong}"))).unwrap();
    fs::copy(fx.root.join(&rel), fx.root.join(&misplaced)).unwrap();

    let r = keyless(&fx.root);
    assert_finding(&r, "notes.txt", Category::Layout, Severity::Warning);
    assert_finding(&r, "items/zz", Category::Layout, Severity::Warning);
    assert_finding(&r, &misplaced, Category::Layout, Severity::Corruption);
    assert_eq!(r.exit_code(), 2);
}

#[test]
fn manifest_problems_and_wrong_secret() {
    let fx = fixture();
    let r = validate(&fx.root, Some(Unlock::Password(b"wrong"))).unwrap();
    assert_finding(&r, "manifest.json", Category::Unlock, Severity::Corruption);

    let mpath = fx.root.join("manifest.json");
    let original = fs::read(&mpath).unwrap();
    let mut m = dem_store::check::read_manifest(&fx.root).unwrap();
    m.kdf.p = 0;
    fs::write(&mpath, m.to_json().unwrap()).unwrap();
    assert_finding(
        &keyless(&fx.root),
        "manifest.json",
        Category::Manifest,
        Severity::Corruption,
    );

    fs::write(&mpath, b"{ not json").unwrap();
    let r = keyed(&fx.root);
    assert_finding(
        &r,
        "manifest.json",
        Category::Manifest,
        Severity::Corruption,
    );
    assert_finding(&r, "manifest.json", Category::Unlock, Severity::Corruption);
    fs::write(&mpath, original).unwrap();
    assert!(keyed(&fx.root).findings.is_empty());
}

#[test]
fn missing_snapshot_and_dangling_links() {
    let fx = fixture();
    // `note` has a snapshot and an update; deleting the snapshot orphans the update.
    let rel = snapshot(fx.note);
    fs::remove_file(fx.root.join(&rel)).unwrap();
    assert_finding(
        &keyless(&fx.root),
        &rel,
        Category::MissingSnapshot,
        Severity::Corruption,
    );

    let fx = fixture();
    fs::remove_file(fx.root.join(snapshot(fx.other))).unwrap();
    let r = keyed(&fx.root);
    assert_finding(
        &r,
        &snapshot(fx.note),
        Category::Dangling,
        Severity::Warning,
    );
    assert_eq!(r.exit_code(), 1, "{}", r.render_human());
}

#[test]
fn orphaned_updates_are_still_decrypted() {
    // §18.7 covers every file: an update whose snapshot is gone (or unreadable)
    // must still be decrypted and reported when damaged.
    let fx = fixture();
    let stem = layout::item_stem(&fx.note);
    let update = layout::scan(&fx.root)
        .unwrap()
        .into_iter()
        .find(|f| f.rel.ends_with(".dexu") && f.rel.contains(&stem))
        .unwrap()
        .rel;
    let path = fx.root.join(&update);
    let mut data = fs::read(&path).unwrap();
    let last = data.len() - 1;
    data[last] ^= 1;
    fs::write(&path, data).unwrap();

    let snap = snapshot(fx.note);
    let snap_path = fx.root.join(&snap);
    let mut snap_data = fs::read(&snap_path).unwrap();
    snap_data[40] ^= 1;
    fs::write(&snap_path, &snap_data).unwrap();
    let r = keyed(&fx.root);
    assert_finding(&r, &snap, Category::Decrypt, Severity::Corruption);
    assert_finding(&r, &update, Category::Decrypt, Severity::Corruption);

    fs::remove_file(&snap_path).unwrap();
    let r = keyed(&fx.root);
    assert_finding(&r, &snap, Category::MissingSnapshot, Severity::Corruption);
    assert_finding(&r, &update, Category::Decrypt, Severity::Corruption);
}

#[test]
fn format_version_is_checked() {
    let fx = fixture();
    let mpath = fx.root.join("manifest.json");
    let mut m = dem_store::check::read_manifest(&fx.root).unwrap();
    m.format_version = 0;
    fs::write(&mpath, m.to_json().unwrap()).unwrap();
    let r = keyless(&fx.root);
    assert_finding(
        &r,
        "manifest.json",
        Category::Manifest,
        Severity::Corruption,
    );
    assert!(
        r.findings
            .iter()
            .any(|f| f.message.contains("format_version")),
        "{}",
        r.render_human()
    );
}

#[test]
fn structure_problems_are_warnings() {
    let fx = fixture();
    {
        let library = Library::open(&fx.root, Unlock::Password(PW)).unwrap();
        let mut s = library.load_structure().unwrap();
        s.add(ItemId::new(), NodeKind::Domain, Some(fx.domain))
            .unwrap();
        s.add(fx.other, NodeKind::Project, None).unwrap();
        s.commit("me");
        library.save_structure(&mut s).unwrap();
    }
    let r = keyed(&fx.root);
    let path = DocDir::Structure.snapshot("structure");
    let msgs: Vec<&str> = r
        .findings
        .iter()
        .filter(|f| f.path == path && f.category == Category::Structure)
        .map(|f| f.message.as_str())
        .collect();
    assert!(msgs.iter().any(|m| m.contains("missing item")), "{msgs:?}");
    assert!(msgs.iter().any(|m| m.contains("top level")), "{msgs:?}");
    assert!(msgs.iter().any(|m| m.contains("has type note")), "{msgs:?}");
    assert_eq!(r.exit_code(), 1, "{}", r.render_human());
}

#[test]
fn blob_checks() {
    let fx = fixture();
    let rel = layout::blob_path(&fx.blob);
    let path = fx.root.join(&rel);
    let data = fs::read(&path).unwrap();
    fs::write(&path, &data[..data.len() - 20]).unwrap();
    assert_finding(
        &keyless(&fx.root),
        &rel,
        Category::BlobLength,
        Severity::Corruption,
    );

    // Valid encryption of other content under this name.
    let library = Library::open(&fx.root, Unlock::Password(PW)).unwrap();
    let mut sealed = Vec::new();
    stream::seal(
        library.file_key(),
        &rel,
        &b"something else"[..],
        &mut sealed,
    )
    .unwrap();
    drop(library);
    fs::write(&path, sealed).unwrap();
    let r = keyed(&fx.root);
    assert_finding(&r, &rel, Category::BlobName, Severity::Corruption);
}

#[test]
fn log_checks() {
    let fx = fixture();
    let seg = segment(&fx.root);
    let path = fx.root.join(&seg);
    let original = fs::read(&path).unwrap();

    let mut torn = original.clone();
    torn.extend_from_slice(&[7, 0, 0]);
    fs::write(&path, &torn).unwrap();
    let r = keyed(&fx.root);
    assert_finding(&r, &seg, Category::TornTail, Severity::Warning);
    assert_eq!(r.exit_code(), 1);

    let shape = dem_store::check::segment_shape(&fx.root, &seg).unwrap();
    let mut bad_len = original.clone();
    let at = shape.records[1].offset;
    bad_len[at..at + 4].copy_from_slice(&1u32.to_le_bytes());
    fs::write(&path, &bad_len).unwrap();
    let r = keyed(&fx.root);
    assert_finding(&r, &seg, Category::LogFrame, Severity::Corruption);
    // The record cut off by the bad length is not reported twice.
    assert!(!r.findings.iter().any(|f| f.category == Category::LogRecord));

    let mut flipped = original.clone();
    let i = shape.records[0].ciphertext_offset();
    flipped[i] ^= 1;
    fs::write(&path, &flipped).unwrap();
    let r = keyed(&fx.root);
    assert_finding(&r, &seg, Category::LogRecord, Severity::Corruption);
    assert!(r.findings.iter().any(|f| f.message.starts_with("record 0")));
    fs::write(&path, &original).unwrap();

    // A segment written by another device with a content field in a record.
    let rel = format!(
        "logs/activity/{}/00000000000000aa.dexl",
        seg.split('/').nth(2).unwrap()
    );
    let library = Library::open(&fx.root, Unlock::Password(PW)).unwrap();
    let key = library.file_key();
    let header = records::new_segment_header(key);
    let record = br#"{"v":1,"ts":"2026-10-18T03:00:00Z","kind":"activity","title":"x"}"#;
    let mut data = header.to_vec();
    data.extend(records::seal_record(key, &header, &rel, 0, record).unwrap());
    drop(library);
    fs::write(fx.root.join(&rel), data).unwrap();
    let r = keyed(&fx.root);
    assert_finding(&r, &rel, Category::LogRecord, Severity::Corruption);
    assert!(
        r.findings
            .iter()
            .any(|f| f.message.contains("forbidden content field `title`"))
    );
}

#[test]
fn cli_exit_codes_and_json() {
    let fx = fixture();
    let root = fx.root.to_str().unwrap();
    let run = |extra: &[&str]| {
        let mut argv = vec!["dem-dev", "validate", "--library", root];
        argv.extend_from_slice(extra);
        dem_devtools::run(dem_devtools::Cli::parse_from(argv)).unwrap()
    };
    assert_eq!(run(&["--password", "validator test"]), ExitCode::from(0));
    fs::write(fx.root.join("stray.txt"), b"x").unwrap();
    assert_eq!(run(&["--json"]), ExitCode::from(1));
    fs::remove_file(fx.root.join(snapshot(fx.note))).unwrap();
    assert_eq!(run(&[]), ExitCode::from(2));

    let r = keyless(&fx.root);
    let json = serde_json::to_value(&r).unwrap();
    assert_eq!(json["keyed"], false);
    assert!(
        json["findings"]
            .as_array()
            .unwrap()
            .iter()
            .any(|f| f["category"] == "missing-snapshot" && f["severity"] == "corruption")
    );
}

#[test]
fn document_checks_attribute_the_bad_file() {
    let fx = fixture();
    let library = Library::open(&fx.root, Unlock::Password(PW)).unwrap();
    let key = library.file_key();
    let stem = layout::item_stem(&fx.note);
    // An update that decrypts but is not a Loro update.
    let update = DocDir::Items.update(&stem, dem_store::layout::DeviceId(0xbb), 1);
    let sealed = dem_crypto::envelope::seal(key, &update, b"not a loro update").unwrap();
    fs::write(fx.root.join(&update), sealed).unwrap();
    // A snapshot that is valid Loro with `dem.schema` but no item metadata: the
    // structure document re-sealed under an item path.
    let ins = dem_store::check::Inspector::unlock(&fx.root, Unlock::Password(PW)).unwrap();
    let structure = ins
        .open_sealed(&DocDir::Structure.snapshot(layout::STRUCTURE_STEM))
        .unwrap();
    let other = snapshot(fx.other);
    let sealed = dem_crypto::envelope::seal(key, &other, &structure).unwrap();
    fs::write(fx.root.join(&other), sealed).unwrap();
    drop(library);

    let r = keyed(&fx.root);
    assert_finding(&r, &update, Category::Document, Severity::Corruption);
    assert_finding(&r, &other, Category::Document, Severity::Corruption);
    // The note itself (snapshot and its real update) is fine.
    assert!(
        !r.findings
            .iter()
            .any(|f| f.path == snapshot(fx.note) && f.severity == Severity::Corruption),
        "{}",
        r.render_human()
    );
    assert_eq!(r.exit_code(), 2);
    // Keyless checks see nothing: both files are well-formed envelopes.
    assert!(keyless(&fx.root).findings.is_empty());
}
