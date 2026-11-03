#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! `dem-dev convert` (P0-35): JSON round trips are lossless; Markdown round trips
//! keep title, tags, scalar fields and plain paragraphs.

use std::path::Path;
use std::process::Command;

use dem_crypto::keys::KdfParams;
use dem_devtools::convert::{
    import_json, import_markdown, item_to_json, item_to_markdown, paragraphs, parse_markdown,
};
use dem_model::{ChangeOrigin, ItemState, TagId};
use dem_store::Library;
use dem_testkit::{GenConfig, GenLibrary, generate};
use proptest::prelude::*;

const PW: &[u8] = b"pw";

fn new_library(root: &Path) -> Library {
    Library::create(root, PW, KdfParams::INSECURE_FOR_TESTS)
        .unwrap()
        .0
}

fn generated(root: &Path, seed: u64, items: usize) -> (Library, GenLibrary) {
    let data = generate(&GenConfig::new(seed, items));
    let library = new_library(root);
    dem_devtools::gen_cmd::write_library(&library, &data, true).unwrap();
    (library, data)
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(12))]

    #[test]
    fn json_round_trip_is_lossless(seed in any::<u64>()) {
        let tmp = tempfile::tempdir().unwrap();
        let (a, _) = generated(&tmp.path().join("a"), seed, 25);
        let b = new_library(&tmp.path().join("b"));
        for id in a.item_ids().unwrap() {
            let src = a.load_item(id).unwrap();
            let json = item_to_json(&src).unwrap();
            // Through text, as the command line does it.
            let json: serde_json::Value =
                serde_json::from_str(&serde_json::to_string_pretty(&json).unwrap()).unwrap();
            let (got, created) = import_json(&b, &json).unwrap();
            prop_assert_eq!(got, id);
            prop_assert!(created);
            let back = b.load_item(id).unwrap();
            prop_assert_eq!(back.to_json(), src.to_json());
            prop_assert_eq!(back.meta().unwrap(), src.meta().unwrap());
            prop_assert_eq!(back.fields(), src.fields());
            prop_assert_eq!(back.links(), src.links());
            prop_assert_eq!(back.body_text(), src.body_text());
            prop_assert_eq!(item_to_json(&back).unwrap(), item_to_json(&src).unwrap());
        }
    }

    #[test]
    fn markdown_round_trip_keeps_common_content(seed in any::<u64>()) {
        let tmp = tempfile::tempdir().unwrap();
        let (a, _) = generated(&tmp.path().join("a"), seed, 25);
        let b = new_library(&tmp.path().join("b"));
        for id in a.item_ids().unwrap() {
            let src = a.load_item(id).unwrap();
            let md = parse_markdown(&item_to_markdown(&src).unwrap()).unwrap();
            let meta = src.meta().unwrap();
            prop_assert_eq!(&md.meta.title, &meta.title);
            prop_assert_eq!(&md.meta.tags, &meta.tags);
            prop_assert_eq!(&md.meta, &meta);
            prop_assert_eq!(&md.fields, &src.fields());
            prop_assert_eq!(&md.paragraphs, &paragraphs(&src));

            import_markdown(&b, &md).unwrap();
            let back = b.load_item(id).unwrap();
            prop_assert_eq!(back.meta().unwrap(), meta);
            prop_assert_eq!(back.fields(), src.fields());
            prop_assert_eq!(back.body_text(), src.body_text());
        }
    }
}

#[test]
fn json_import_overwrites_an_existing_item() {
    let tmp = tempfile::tempdir().unwrap();
    let (library, data) = generated(&tmp.path().join("v"), 3, 10);
    let id = data.items[4].meta.id;
    let before = item_to_json(&library.load_item(id).unwrap()).unwrap();

    let mut doc = library.load_item(id).unwrap();
    doc.set_body_text("changed").unwrap();
    doc.set_state(ItemState::Trashed).unwrap();
    doc.set_tag(&TagId("new".into()), true).unwrap();
    doc.set_field("extra", &serde_json::json!(1)).unwrap();
    doc.add_link(data.items[0].meta.id, "reference").unwrap();
    doc.commit(ChangeOrigin::Me, None);
    library.save_item(&mut doc).unwrap();

    let (_, created) = import_json(&library, &before).unwrap();
    assert!(!created);
    let after = library.load_item(id).unwrap();
    assert_eq!(item_to_json(&after).unwrap(), before);
    // History is kept, the import is one more change.
    let origins: Vec<String> = after
        .history()
        .into_iter()
        .filter_map(|c| c.message)
        .collect();
    assert_eq!(origins.len(), 4);
    assert_eq!(origins[2], "me");
    assert!(origins[3].starts_with("import:convert-"));
}

#[test]
fn json_import_rejects_inconsistent_files() {
    let tmp = tempfile::tempdir().unwrap();
    let (library, data) = generated(&tmp.path().join("v"), 4, 5);
    let good = item_to_json(&library.load_item(data.items[0].meta.id).unwrap()).unwrap();

    let mut v = good.clone();
    v["format"] = "other".into();
    assert!(import_json(&library, &v).is_err());
    let mut v = good.clone();
    v["meta"]["title"] = "not the document's title".into();
    assert!(import_json(&library, &v).is_err());
    let mut v = good.clone();
    v["id"] = data.items[1].meta.id.to_string().into();
    assert!(import_json(&library, &v).is_err());
    // Nothing was saved by the failed attempts.
    assert_eq!(
        item_to_json(&library.load_item(data.items[0].meta.id).unwrap()).unwrap(),
        good
    );

    // A bad file for an item that does not exist yet leaves no file behind.
    let other = tempfile::tempdir().unwrap();
    let fresh = new_library(&other.path().join("fresh"));
    let mut v = good.clone();
    v["meta"]["title"] = "not the document's title".into();
    assert!(import_json(&fresh, &v).is_err());
    let mut v = good.clone();
    v["doc"]["meta"]["state"] = "bogus".into();
    assert!(import_json(&fresh, &v).is_err());
    assert!(fresh.item_ids().unwrap().is_empty());
    assert!(matches!(
        fresh.load_item(data.items[0].meta.id),
        Err(dem_store::StoreError::NotFound(_))
    ));
}

#[test]
fn markdown_import_keeps_links_and_replaces_the_rest() {
    let tmp = tempfile::tempdir().unwrap();
    let (library, data) = generated(&tmp.path().join("v"), 6, 30);
    let it = data.items.iter().find(|i| !i.links.is_empty()).unwrap();
    let doc = library.load_item(it.meta.id).unwrap();
    let links = doc.links();
    let text = item_to_markdown(&doc).unwrap();
    drop(doc);

    let edited = text.replace("---\n\n", "---\n\nA new first paragraph.\n\n");
    let md = parse_markdown(&edited).unwrap();
    let (_, created) = import_markdown(&library, &md).unwrap();
    assert!(!created);
    let back = library.load_item(it.meta.id).unwrap();
    assert_eq!(back.links(), links);
    assert!(back.body_text().starts_with("A new first paragraph.\n"));
}

#[test]
fn markdown_import_keeps_version_labels() {
    let tmp = tempfile::tempdir().unwrap();
    let (library, data) = generated(&tmp.path().join("v"), 7, 5);
    let id = data.items[0].meta.id;
    let mut json = item_to_json(&library.load_item(id).unwrap()).unwrap();
    json["doc"]["labels"] = serde_json::json!([
        { "name": "draft", "version": [1, 2, 255], "created": 1_760_000_000_000_i64 }
    ]);
    import_json(&library, &json).unwrap();
    let labelled = library.load_item(id).unwrap().to_json()["labels"].clone();
    assert_eq!(labelled, json["doc"]["labels"]);

    let md = item_to_markdown(&library.load_item(id).unwrap()).unwrap();
    let edited = md.replace("---\n\n", "---\n\nNew text.\n\n");
    import_markdown(&library, &parse_markdown(&edited).unwrap()).unwrap();
    let back = library.load_item(id).unwrap();
    assert_eq!(back.to_json()["labels"], labelled);
    assert!(back.body_text().starts_with("New text.\n"));
}

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

#[test]
fn command_line_round_trips() {
    let tmp = tempfile::tempdir().unwrap();
    let (a_root, b_root) = (tmp.path().join("a"), tmp.path().join("b"));
    let (library, data) = generated(&a_root, 8, 12);
    let id = data.items[7].meta.id;
    let want = item_to_json(&library.load_item(id).unwrap()).unwrap();
    drop(library);
    drop(new_library(&b_root));

    let (a, b) = (a_root.to_str().unwrap(), b_root.to_str().unwrap());
    let id_s = id.to_string();
    let json_file = tmp.path().join("item.json");
    let md_file = tmp.path().join("item.md");
    dem_dev(&[
        "convert",
        "to-json",
        "--library",
        a,
        "--password",
        "pw",
        "--id",
        &id_s,
        "--out",
        json_file.to_str().unwrap(),
    ]);
    dem_dev(&[
        "convert",
        "from-json",
        "--library",
        b,
        "--password",
        "pw",
        json_file.to_str().unwrap(),
    ]);
    let printed = dem_dev(&[
        "convert",
        "to-json",
        "--library",
        b,
        "--password",
        "pw",
        "--id",
        &id_s,
    ]);
    let got: serde_json::Value = serde_json::from_slice(&printed.stdout).unwrap();
    assert_eq!(got, want);

    let md = dem_dev(&[
        "convert",
        "to-markdown",
        "--library",
        a,
        "--password",
        "pw",
        "--id",
        &id_s,
    ]);
    std::fs::write(&md_file, &md.stdout).unwrap();
    let c_root = tmp.path().join("c");
    drop(new_library(&c_root));
    let c = c_root.to_str().unwrap();
    dem_dev(&[
        "convert",
        "from-markdown",
        "--library",
        c,
        "--password",
        "pw",
        md_file.to_str().unwrap(),
    ]);
    let again = dem_dev(&[
        "convert",
        "to-markdown",
        "--library",
        c,
        "--password",
        "pw",
        "--id",
        &id_s,
    ]);
    assert_eq!(again.stdout, md.stdout);
}
