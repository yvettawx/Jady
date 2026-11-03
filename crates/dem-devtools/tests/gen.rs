#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! `dem-dev gen` (P0-34): library and JSON output.

use std::collections::BTreeSet;
use std::path::Path;
use std::process::Command;

use dem_crypto::RecoveryCode;
use dem_store::logs::LogKind;
use dem_store::{Library, Unlock};
use dem_testkit::{GenConfig, GenLibrary, generate};

fn dem_dev(args: &[&str]) -> std::process::Output {
    let out = Command::new(env!("CARGO_BIN_EXE_dem-dev"))
        .args(args)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "dem-dev {args:?} failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    out
}

fn gen_library(dir: &Path, seed: u64, items: usize) -> String {
    let out = dem_dev(&[
        "gen",
        "--seed",
        &seed.to_string(),
        "--items",
        &items.to_string(),
        "--library",
        dir.to_str().unwrap(),
        "--password",
        "pw",
        "--kdf-test",
        "--quiet",
    ]);
    String::from_utf8(out.stdout).unwrap()
}

#[test]
fn library_holds_everything_generated() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("v");
    let stdout = gen_library(&root, 11, 120);
    let data = generate(&GenConfig::new(11, 120));

    // The recovery code is printed once and unlocks the library.
    let code_lines: Vec<&str> = stdout
        .lines()
        .filter(|l| l.starts_with("recovery code: "))
        .collect();
    assert_eq!(code_lines.len(), 1);
    let code = RecoveryCode::parse(code_lines[0].trim_start_matches("recovery code: ")).unwrap();
    let library = Library::open(&root, Unlock::Recovery(&code)).unwrap();

    let ids = library.item_ids().unwrap();
    assert_eq!(ids.len(), data.items.len() + data.containers.len());

    let nodes = library.load_structure().unwrap().nodes();
    assert_eq!(nodes.len(), data.containers.len());
    for c in &data.containers {
        let n = nodes.iter().find(|n| n.item == c.meta.id).unwrap();
        assert_eq!(n.parent, c.parent);
        assert_eq!(
            library.load_item(c.meta.id).unwrap().meta().unwrap(),
            c.meta
        );
    }

    for it in &data.items {
        let doc = library.load_item(it.meta.id).unwrap();
        assert_eq!(doc.meta().unwrap(), it.meta);
        assert_eq!(doc.body_text(), dem_devtools::gen_cmd::body_lines(&it.body));
        let fields: serde_json::Map<_, _> = it.fields.clone().into_iter().collect();
        assert_eq!(doc.fields(), fields);
        let targets: BTreeSet<_> = doc.links().into_iter().map(|(_, to, _)| to).collect();
        assert_eq!(targets, it.links.iter().copied().collect());
        assert!(doc.links().iter().all(|(_, _, kind)| kind == "reference"));
        let origins: Vec<_> = doc
            .history()
            .into_iter()
            .filter_map(|c| c.message)
            .collect();
        assert_eq!(origins, ["system", "import:gen-11"]);
    }

    let logs = library.read_logs(LogKind::Activity).unwrap();
    assert_eq!(logs.records.len(), ids.len());
    assert_eq!(logs.damaged, 0);
    for r in &logs.records {
        assert_eq!(r.fields["action"], "import");
        assert!(r.check().is_ok());
    }
}

#[test]
fn same_seed_same_library_content() {
    let tmp = tempfile::tempdir().unwrap();
    let (a, b) = (tmp.path().join("a"), tmp.path().join("b"));
    gen_library(&a, 5, 40);
    gen_library(&b, 5, 40);
    let va = Library::open(&a, Unlock::Password(b"pw")).unwrap();
    let vb = Library::open(&b, Unlock::Password(b"pw")).unwrap();
    let ids = va.item_ids().unwrap();
    assert_eq!(ids, vb.item_ids().unwrap());
    for id in ids {
        let (x, y) = (va.load_item(id).unwrap(), vb.load_item(id).unwrap());
        assert_eq!(x.meta().unwrap(), y.meta().unwrap());
        assert_eq!(x.fields(), y.fields());
        assert_eq!(x.body_text(), y.body_text());
        let tx: Vec<_> = x.links().into_iter().map(|l| l.1).collect();
        let mut ty: Vec<_> = y.links().into_iter().map(|l| l.1).collect();
        let mut tx = tx;
        tx.sort();
        ty.sort();
        assert_eq!(tx, ty);
    }
    // Activity records are deterministic too (their time is the creation time).
    let (la, lb) = (
        va.read_logs(LogKind::Activity).unwrap(),
        vb.read_logs(LogKind::Activity).unwrap(),
    );
    assert!(!la.records.is_empty());
    assert_eq!(la.records, lb.records);
}

#[test]
fn compact_leaves_one_file_per_item() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("v");
    dem_dev(&[
        "gen",
        "--seed",
        "2",
        "--items",
        "20",
        "--library",
        root.to_str().unwrap(),
        "--password",
        "pw",
        "--kdf-test",
        "--compact",
        "--quiet",
    ]);
    let updates = dem_store::layout::scan(&root)
        .unwrap()
        .into_iter()
        .filter(|f| {
            matches!(
                f.kind,
                dem_store::FileKind::Update {
                    dir: dem_store::layout::DocDir::Items,
                    ..
                }
            )
        })
        .count();
    assert_eq!(updates, 0);
    let library = Library::open(&root, Unlock::Password(b"pw")).unwrap();
    assert_eq!(library.item_ids().unwrap().len(), 25);
}

#[test]
fn json_output_is_deterministic() {
    let tmp = tempfile::tempdir().unwrap();
    let (a, b) = (tmp.path().join("a.json"), tmp.path().join("b.json"));
    for p in [&a, &b] {
        dem_dev(&[
            "gen",
            "--seed",
            "9",
            "--items",
            "300",
            "--json",
            p.to_str().unwrap(),
            "--quiet",
        ]);
    }
    let (ta, tb) = (std::fs::read(&a).unwrap(), std::fs::read(&b).unwrap());
    assert_eq!(ta, tb);
    let parsed: GenLibrary = serde_json::from_slice(&ta).unwrap();
    assert_eq!(parsed, generate(&GenConfig::new(9, 300)));
}

#[test]
fn needs_a_target_and_refuses_existing_libraries() {
    let st = Command::new(env!("CARGO_BIN_EXE_dem-dev"))
        .args(["gen", "--items", "3"])
        .output()
        .unwrap();
    assert!(!st.status.success());

    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("v");
    gen_library(&root, 1, 3);
    let again = Command::new(env!("CARGO_BIN_EXE_dem-dev"))
        .args([
            "gen",
            "--items",
            "3",
            "--kdf-test",
            "--quiet",
            "--password",
            "pw",
        ])
        .arg("--library")
        .arg(&root)
        .output()
        .unwrap();
    assert!(!again.status.success());
}
