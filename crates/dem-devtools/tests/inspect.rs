#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! `dem-dev inspect` (P0-36): everything the generator writes can be viewed.

use std::path::Path;
use std::process::Command;

use dem_crypto::keys::KdfParams;
use dem_model::Privacy;
use dem_store::Library;
use dem_testkit::{GenConfig, GenLibrary, generate};
use serde_json::Value as J;

const PW: &str = "pw";

/// A generated library on disk; returns the data and the recovery code text.
fn make_library(root: &Path, seed: u64, items: usize) -> (GenLibrary, String) {
    let data = generate(&GenConfig::new(seed, items));
    let (library, code) =
        Library::create(root, PW.as_bytes(), KdfParams::INSECURE_FOR_TESTS).unwrap();
    dem_devtools::gen_cmd::write_library(&library, &data, true).unwrap();
    (data, code.display_text().unwrap().to_string())
}

fn inspect(root: &Path, args: &[&str]) -> String {
    let out = Command::new(env!("CARGO_BIN_EXE_dem-dev"))
        .arg("inspect")
        .arg("--library")
        .arg(root)
        .args(["--password", PW])
        .args(args)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "inspect {args:?} failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout).unwrap()
}

fn inspect_json(root: &Path, args: &[&str]) -> J {
    let mut a = args.to_vec();
    a.push("--json");
    serde_json::from_str(&inspect(root, &a)).unwrap()
}

#[test]
fn list_with_filters() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("v");
    let (data, _) = make_library(&root, 21, 150);

    let all = inspect_json(&root, &["list"]);
    assert_eq!(
        all.as_array().unwrap().len(),
        data.items.len() + data.containers.len()
    );
    // No subcommand means `list`.
    assert_eq!(inspect_json(&root, &[]), all);

    let conf = inspect_json(&root, &["list", "--privacy", "confidential"]);
    let expected = data
        .items
        .iter()
        .filter(|i| i.meta.privacy == Privacy::Confidential)
        .count();
    assert!(expected > 0);
    assert_eq!(conf.as_array().unwrap().len(), expected);

    let todos = inspect_json(&root, &["list", "--type", "todo", "--state", "active"]);
    for row in todos.as_array().unwrap() {
        assert_eq!(row["type"], "todo");
        assert_eq!(row["state"], "active");
    }
    let expected = data
        .items
        .iter()
        .filter(|i| i.meta.type_id.0 == "todo" && i.meta.state == dem_model::ItemState::Active)
        .count();
    assert_eq!(todos.as_array().unwrap().len(), expected);

    let text = inspect(&root, &["list"]);
    assert!(text.ends_with(&format!("{} items\n", all.as_array().unwrap().len())));
}

#[test]
fn item_shows_meta_fields_links_body_and_history() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("v");
    let (data, _) = make_library(&root, 22, 60);
    let it = data.items.iter().find(|i| !i.links.is_empty()).unwrap();
    let id = it.meta.id.to_string();

    let d = inspect_json(&root, &["item", &id]);
    assert_eq!(d["meta"], serde_json::to_value(&it.meta).unwrap());
    let fields: serde_json::Map<_, _> = it.fields.clone().into_iter().collect();
    assert_eq!(d["fields"], J::Object(fields));
    assert_eq!(
        d["body"],
        dem_devtools::gen_cmd::body_lines(&it.body).as_str()
    );
    assert_eq!(d["links"].as_array().unwrap().len(), it.links.len());
    let origins: Vec<&str> = d["history"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["origin"].as_str().unwrap())
        .collect();
    assert_eq!(origins, ["system", "import:gen-22"]);
    for c in d["history"].as_array().unwrap() {
        assert!(c["lamport"].is_u64());
        assert!(c["time"].as_str().unwrap().ends_with('Z'));
    }

    let text = inspect(&root, &["item", &id]);
    let first_para = it.body.split("\n\n").next().unwrap();
    assert!(text.contains(&format!("  | {first_para}\n")));
    assert!(text.contains("import:gen-22"));
    assert!(text.contains("(reference)"));
}

#[test]
fn structure_logs_and_files() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("v");
    let (data, code) = make_library(&root, 23, 80);

    fn count(nodes: &J) -> usize {
        nodes
            .as_array()
            .unwrap()
            .iter()
            .map(|n| 1 + count(&n["children"]))
            .sum()
    }
    let tree = inspect_json(&root, &["structure"]);
    assert_eq!(count(&tree), data.containers.len());
    let top = data
        .containers
        .iter()
        .filter(|c| c.parent.is_none())
        .count();
    assert_eq!(tree.as_array().unwrap().len(), top);
    let text = inspect(&root, &["structure"]);
    let first = &data.containers[0];
    assert!(text.contains(&format!(
        "- [domain] {} ({})",
        first.meta.title.as_deref().unwrap(),
        first.meta.id
    )));
    assert!(text.lines().any(|l| l.starts_with("  - [")), "indented");

    let logs = inspect_json(&root, &["logs", "--kind", "activity"]);
    assert_eq!(
        logs["records"].as_array().unwrap().len(),
        data.items.len() + data.containers.len()
    );
    assert_eq!(logs["damaged"], 0);
    let review = inspect_json(&root, &["logs", "--kind", "review"]);
    assert!(review["records"].as_array().unwrap().is_empty());

    let files = inspect_json(&root, &["files"]);
    let kinds: Vec<&str> = files
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["kind"].as_str().unwrap())
        .collect();
    assert!(kinds.contains(&"manifest"));
    assert!(kinds.iter().any(|k| k.starts_with("snapshot(structure)")));
    assert!(kinds.iter().any(|k| k.starts_with("log(activity")));
    assert!(!kinds.contains(&"UNEXPECTED"));

    // Unlocking with the recovery code works too, and a wrong password does not.
    let out = Command::new(env!("CARGO_BIN_EXE_dem-dev"))
        .arg("inspect")
        .arg("--library")
        .arg(&root)
        .args(["--recovery", &code, "list"])
        .output()
        .unwrap();
    assert!(out.status.success());
    let bad = Command::new(env!("CARGO_BIN_EXE_dem-dev"))
        .arg("inspect")
        .arg("--library")
        .arg(&root)
        .args(["--password", "wrong", "list"])
        .output()
        .unwrap();
    assert!(!bad.status.success());
}

#[test]
fn files_needs_no_password() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("v");
    make_library(&root, 24, 5);
    let out = Command::new(env!("CARGO_BIN_EXE_dem-dev"))
        .arg("inspect")
        .arg("--library")
        .arg(&root)
        .arg("files")
        .env_remove("DEM_PASSWORD")
        .output()
        .unwrap();
    assert!(out.status.success());
    let text = String::from_utf8(out.stdout).unwrap();
    assert!(text.contains("manifest.json  manifest"));
}

#[test]
fn list_shows_the_rest_when_one_item_is_damaged() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("v");
    let (data, _) = make_library(&root, 25, 10);
    let victim = data.items[3].meta.id.to_string();
    let file = dem_store::layout::scan(&root)
        .unwrap()
        .into_iter()
        .find(|f| f.rel.ends_with(&format!("{victim}.dexm")))
        .unwrap();
    let path = root.join(&file.rel);
    let mut bytes = std::fs::read(&path).unwrap();
    let last = bytes.len() - 1;
    bytes[last] ^= 0xff;
    std::fs::write(&path, bytes).unwrap();

    let out = Command::new(env!("CARGO_BIN_EXE_dem-dev"))
        .arg("inspect")
        .arg("--library")
        .arg(&root)
        .args(["--password", PW, "--json", "list"])
        .output()
        .unwrap();
    assert!(!out.status.success());
    let rows: J = serde_json::from_slice(&out.stdout).unwrap();
    let total = data.items.len() + data.containers.len();
    assert_eq!(rows.as_array().unwrap().len(), total - 1);
    let err = String::from_utf8(out.stderr).unwrap();
    assert!(err.contains(&format!("cannot read item {victim}")), "{err}");
}
