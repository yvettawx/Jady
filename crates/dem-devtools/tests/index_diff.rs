#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

//! `dem-dev index-diff` (P0-41) end to end: hand-built plain and SQLCipher
//! databases with known differences are reported exactly; identical ones are not.

use std::path::Path;
use std::process::{Command, Output};

use dem_crypto::keys::KdfParams;
use dem_devtools::index_diff::render;
use dem_index::compare::fixtures::{self, Variant};
use dem_index::compare::{self};
use dem_store::Library;

const KEY: [u8; 32] = [0x5a; 32];

fn dem_dev(args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_dem-dev"))
        .args(args)
        .env_remove("DEM_INDEX_KEY_HEX")
        .env_remove("DEM_PASSWORD")
        .output()
        .unwrap()
}

fn hex(k: &[u8; 32]) -> String {
    k.iter().map(|b| format!("{b:02x}")).collect()
}

fn write_pair(dir: &Path, key: Option<&[u8; 32]>, b: Variant) -> (String, String) {
    let pa = dir.join("a.sqlite");
    let pb = dir.join("b.sqlite");
    fixtures::write(&pa, key, Variant::A).unwrap();
    fixtures::write(&pb, key, b).unwrap();
    (pa.display().to_string(), pb.display().to_string())
}

const EXPECTED_B: &str = r#"pragma user_version: 1 -> 2
schema: index items_updated only in B
schema: table extra only in B
table items: 4 rows in A, 4 in B; +1 added, -1 removed, ~1 changed
  ~ ["i2"] title: "Paris" -> "Lyon"; updated: 200 -> 250
  - ("i3", "todo", NULL, 300, "private")
  + ("i5", "idea", "西夏", 500, "normal")
table links: 3 rows in A, 3 in B; +1 added, -1 removed, ~0 changed
  - ("i3", "i1", "ref")
  + ("i4", "i2", "ref")
table meta: 2 rows in A, 2 in B; +0 added, -0 removed, ~1 changed
  ~ ["built"] value: "2026-10-18T03:00:00Z" -> "2026-10-19T03:00:00Z"
table postings: 4 rows in A, 4 in B; +0 added, -0 removed, ~1 changed
  ~ ["角", 1] pos: x'0102' -> x'0103'
"#;

#[test]
fn plain_databases_with_known_differences() {
    let dir = tempfile::tempdir().unwrap();
    let (a, b) = write_pair(dir.path(), None, Variant::B);
    let out = dem_dev(&["index-diff", &a, &b]);
    assert_eq!(out.status.code(), Some(1));
    assert_eq!(String::from_utf8(out.stdout).unwrap(), EXPECTED_B);

    let d = compare::diff(Path::new(&a), Path::new(&b), None).unwrap();
    assert_eq!(fixtures::check_expected_b(&d), Ok(()));
}

#[test]
fn encrypted_databases_with_known_differences() {
    let dir = tempfile::tempdir().unwrap();
    let (a, b) = write_pair(dir.path(), Some(&KEY), Variant::B);
    let out = dem_dev(&["index-diff", &a, &b, "--key-hex", &hex(&KEY)]);
    assert_eq!(out.status.code(), Some(1));
    assert_eq!(String::from_utf8(out.stdout).unwrap(), EXPECTED_B);

    // JSON output carries the same differences.
    let out = dem_dev(&["index-diff", &a, &b, "--key-hex", &hex(&KEY), "--json"]);
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(v["tables"].as_array().unwrap().len(), 4);
    assert_eq!(
        v["tables"][3]["samples"][0]["columns"][0]["b"]["value"],
        "0103"
    );
}

#[test]
fn identical_databases_report_nothing() {
    for key in [None, Some(&KEY)] {
        let dir = tempfile::tempdir().unwrap();
        let (a, b) = write_pair(dir.path(), key, Variant::AReordered);
        let mut args = vec!["index-diff".to_owned(), a, b];
        if let Some(k) = key {
            args.extend(["--key-hex".to_owned(), hex(k)]);
        }
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        let out = dem_dev(&args);
        assert_eq!(out.status.code(), Some(0), "{out:?}");
        assert!(
            String::from_utf8(out.stdout)
                .unwrap()
                .starts_with("no differences (9 tables compared, 1 skipped)")
        );
    }
}

#[test]
fn wrong_key_is_an_error_not_a_difference() {
    let dir = tempfile::tempdir().unwrap();
    let (a, b) = write_pair(dir.path(), Some(&KEY), Variant::A);
    let out = dem_dev(&["index-diff", &a, &b, "--key-hex", &"00".repeat(32)]);
    assert_eq!(out.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&out.stderr).contains("key is wrong"));
    let out = dem_dev(&["index-diff", &a, &b]);
    assert_eq!(out.status.code(), Some(2));
    let out = dem_dev(&["index-diff", &a, &b, "--key-hex", "abc"]);
    assert_eq!(out.status.code(), Some(2));
}

#[test]
fn key_can_come_from_the_library() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("library");
    let key = {
        let (v, _) = Library::create(&root, b"pw", KdfParams::INSECURE_FOR_TESTS).unwrap();
        *v.index_key().expose_bytes()
    };
    let (a, b) = write_pair(dir.path(), Some(&key), Variant::B);
    let root = root.display().to_string();
    let out = dem_dev(&["index-diff", &a, &b, "--library", &root, "--password", "pw"]);
    assert_eq!(out.status.code(), Some(1), "{out:?}");
    assert_eq!(String::from_utf8(out.stdout).unwrap(), EXPECTED_B);
}

#[test]
fn render_truncates_long_sample_lists() {
    let dir = tempfile::tempdir().unwrap();
    let (a, b) = write_pair(dir.path(), None, Variant::B);
    let d = compare::diff_with(
        Path::new(&a),
        Path::new(&b),
        None,
        &compare::Options {
            max_samples: 1,
            skip_tables: vec!["postings".into()],
        },
    )
    .unwrap();
    let text = render(&d);
    assert!(text.contains("  … 2 more"), "{text}");
    assert!(!text.contains("table postings"), "{text}");
}
