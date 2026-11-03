//! P4's completion test: two computers, edits on both while apart, and they end up the same, with
//! nothing readable on the storage in between. Real libraries, real core.
#![allow(clippy::unwrap_used)]

use dem_core::{Core, ItemPatch, ListQuery, MemoryKeychain, NewItem};
use dem_crypto::KdfParams;
use dem_sync::FolderBackend;

const PASSWORD: &str = "correct horse battery";

fn core(base: &std::path::Path) -> Core {
    Core::with_kdf(
        base.join("config"),
        base.join("docs"),
        Box::new(MemoryKeychain::default()),
        KdfParams::INSECURE_FOR_TESTS,
    )
}

fn new_item(title: &str, markdown: &str) -> NewItem {
    NewItem {
        type_id: "note".into(),
        title: Some(title.into()),
        state: None,
        container: None,
        privacy: None,
        fields: None,
        tags: None,
        due: None,
        markdown: Some(markdown.into()),
    }
}

fn walk(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
    for e in std::fs::read_dir(dir).unwrap().flatten() {
        if e.path().is_dir() {
            walk(&e.path(), out);
        } else {
            out.push(e.path());
        }
    }
}

fn titles(c: &Core) -> Vec<String> {
    c.with(|s| {
        s.list_items(&ListQuery {
            type_id: Some("note".into()),
            states: None,
            container: None,
            tag: None,
            order: Some("title".into()),
            limit: None,
        })
    })
    .unwrap()
    .into_iter()
    .filter_map(|i| i.title)
    .collect()
}

#[test]
fn two_computers_edit_apart_and_end_up_the_same() {
    let (a_dir, b_dir, store) = (
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
    );
    let backend = FolderBackend::new(store.path());

    // First computer.
    let a = core(a_dir.path());
    let lib_a = a_dir.path().join("lib");
    a.prepare_library("甲", lib_a.to_str().unwrap(), PASSWORD)
        .unwrap();
    a.commit_library().unwrap();
    let shared = a
        .with(|s| s.create_item(new_item("共同的 zzcanarytitle", "第一段 zzcanarybody\n")))
        .unwrap();
    a.sync_now(&backend).unwrap();

    // The storage holds nothing readable, and not this computer's own files.
    let mut files = Vec::new();
    walk(store.path(), &mut files);
    assert!(files.len() > 2);
    for f in &files {
        let raw = String::from_utf8_lossy(&std::fs::read(f).unwrap()).into_owned();
        assert!(!raw.contains("zzcanary"), "{}", f.display());
        let name = f.to_string_lossy();
        assert!(
            !name.contains("index.sqlite") && !name.contains("/local/"),
            "{name}"
        );
    }

    // Second computer joins with the password.
    let b = core(b_dir.path());
    let lib_b = b_dir.path().join("lib");
    let joined = b.sync_join(&backend, lib_b.to_str().unwrap()).unwrap();
    assert!(!b.unlock_password(&joined.path, "wrong password").unwrap());
    assert!(b.unlock_password(&joined.path, PASSWORD).unwrap());
    assert_eq!(titles(&b), ["共同的 zzcanarytitle"]);

    // Apart: each adds its own, and both change the shared item in different ways.
    a.with(|s| s.create_item(new_item("甲新建的", ""))).unwrap();
    b.with(|s| s.create_item(new_item("乙新建的", ""))).unwrap();
    let tag = |t: &str| ItemPatch {
        tags: Some(vec![t.to_owned()]),
        ..Default::default()
    };
    let field = |v: &str| ItemPatch {
        fields: Some(format!(r#"{{"from_a":"{v}"}}"#)),
        ..Default::default()
    };
    a.with(|s| s.update_item(&shared.id, field("甲"))).unwrap();
    b.with(|s| s.update_item(&shared.id, tag("来自乙")))
        .unwrap();

    // Back together. Two rounds each way settle everything.
    a.sync_now(&backend).unwrap();
    let got = b.sync_now(&backend).unwrap();
    assert!(got.items.contains(&shared.id));
    a.sync_now(&backend).unwrap();
    b.sync_now(&backend).unwrap();

    let want = ["乙新建的", "共同的 zzcanarytitle", "甲新建的"];
    let mut ta = titles(&a);
    let mut tb = titles(&b);
    ta.sort();
    tb.sort();
    let mut w = want.map(str::to_owned).to_vec();
    w.sort();
    assert_eq!(ta, w);
    assert_eq!(tb, w);

    for c in [&a, &b] {
        let item = c.with(|s| s.get_item(&shared.id)).unwrap();
        assert_eq!(item.tags, ["来自乙"]);
        assert!(item.fields.contains("甲"), "{}", item.fields);
        // The index found the merged item too.
        assert_eq!(c.with(|s| s.search("zzcanarybody", 5)).unwrap().len(), 1);
    }

    // A second look finds nothing more to do.
    let quiet = a.sync_now(&backend).unwrap();
    assert_eq!((quiet.uploaded, quiet.downloaded, quiet.merged), (0, 0, 0));
}

#[test]
fn locking_the_folder_library_still_lets_the_next_sync_continue() {
    let (a_dir, store) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let backend = FolderBackend::new(store.path());
    let a = core(a_dir.path());
    let lib = a_dir.path().join("lib");
    a.prepare_library("甲", lib.to_str().unwrap(), PASSWORD)
        .unwrap();
    a.commit_library().unwrap();
    a.sync_now(&backend).unwrap();
    a.lock().unwrap();
    assert!(a.sync_now(&backend).is_err());
    let path = a.start_state().library.unwrap().path;
    assert!(a.unlock_password(&path, PASSWORD).unwrap());
    let again = a.sync_now(&backend).unwrap();
    assert_eq!(again.downloaded, 0);
}
