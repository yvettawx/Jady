//! Library round trips, unlocking, tamper detection and randomized write/reload.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use dem_crypto::keys::{KdfParams, RecoveryCode};
use dem_model::{
    ChangeOrigin, ItemId, ItemMeta, ItemState, Privacy, SourceInfo, TagId, Timestamp, TypeId,
};
use dem_store::logs::{LogKind, LogRecord};
use dem_store::{Library, StoreError, Unlock};
use proptest::prelude::*;
use serde_json::{Map, Value};

const PW: &[u8] = b"correct horse battery staple";

fn meta(title: &str) -> ItemMeta {
    let now = Timestamp::now();
    ItemMeta {
        id: ItemId::new(),
        type_id: TypeId("note".into()),
        title: Some(title.into()),
        state: ItemState::Active,
        privacy: Privacy::Normal,
        container: None,
        tags: vec![],
        created: now,
        updated: now,
        time: None,
        source: SourceInfo::default(),
        ai_web: false,
    }
}

fn new_library() -> (tempfile::TempDir, Library, RecoveryCode) {
    let dir = tempfile::tempdir().unwrap();
    let (v, code) =
        Library::create(&dir.path().join("v"), PW, KdfParams::INSECURE_FOR_TESTS).unwrap();
    (dir, v, code)
}

#[test]
fn items_survive_reopen_with_password_and_recovery_code() {
    let (dir, library, code) = new_library();
    let m = meta("日记 café");
    let mut doc = library.create_item(&m).unwrap();
    doc.set_body_text("第一段\n第二段").unwrap();
    doc.commit(ChangeOrigin::Me, None);
    assert!(library.save_item(&mut doc).unwrap());
    assert!(!library.save_item(&mut doc).unwrap(), "nothing new to save");
    drop(library);

    let root = dir.path().join("v");
    let v = Library::open(&root, Unlock::Password(PW)).unwrap();
    let loaded = v.load_item(m.id).unwrap();
    assert_eq!(loaded.meta().unwrap().title.as_deref(), Some("日记 café"));
    assert_eq!(loaded.body_text(), "第一段\n第二段");
    assert_eq!(v.item_ids().unwrap(), vec![m.id]);
    let device = v.device();
    drop(v);

    let text = code.display_text().unwrap();
    let parsed = RecoveryCode::parse(&text).unwrap();
    let v = Library::open(&root, Unlock::Recovery(&parsed)).unwrap();
    assert_eq!(v.load_item(m.id).unwrap().body_text(), "第一段\n第二段");
    assert_eq!(v.device(), device, "device id persists");

    // Daily opening with the master key from the keychain.
    let key = dem_crypto::MasterKey::from_bytes(*v.master_key().expose_bytes());
    drop(v);
    assert!(Library::open(&root, Unlock::MasterKey(key)).is_ok());
}

#[test]
fn wrong_secrets_and_second_process_are_refused() {
    let (dir, library, _) = new_library();
    let root = dir.path().join("v");
    assert!(matches!(
        Library::open(&root, Unlock::Password(PW)),
        Err(StoreError::Locked)
    ));
    drop(library);
    assert!(Library::open(&root, Unlock::Password(b"wrong")).is_err());
    let other = RecoveryCode::generate();
    assert!(Library::open(&root, Unlock::Recovery(&other)).is_err());
    let wrong_key = dem_crypto::MasterKey::generate();
    assert!(Library::open(&root, Unlock::MasterKey(wrong_key)).is_err());
}

#[test]
fn tampered_manifest_params_prevent_unlock() {
    let (dir, library, _) = new_library();
    drop(library);
    let path = dir.path().join("v/manifest.json");
    let mut m: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    m["kdf"]["t"] = Value::from(2);
    std::fs::write(&path, serde_json::to_vec(&m).unwrap()).unwrap();
    assert!(Library::open(&dir.path().join("v"), Unlock::Password(PW)).is_err());
}

#[test]
fn swapped_item_files_fail_to_decrypt() {
    let (dir, library, _) = new_library();
    let (a, b) = (meta("a"), meta("b"));
    library.create_item(&a).unwrap();
    library.create_item(&b).unwrap();
    let files = dem_store::layout::scan(library.root()).unwrap();
    let path_of = |id: &ItemId| {
        files
            .iter()
            .find(|f| f.rel.contains(&id.to_string()))
            .unwrap()
            .rel
            .clone()
    };
    let (pa, pb) = (path_of(&a.id), path_of(&b.id));
    let root = dir.path().join("v");
    let bytes_b = std::fs::read(root.join(&pb)).unwrap();
    std::fs::write(root.join(&pa), bytes_b).unwrap();
    assert!(library.load_item(a.id).is_err());
    assert!(library.load_item(b.id).is_ok());
}

#[test]
fn updates_compact_into_a_snapshot() {
    let (_dir, library, _) = new_library();
    let m = meta("x");
    let mut doc = library.create_item(&m).unwrap();
    for i in 0..5 {
        doc.append_paragraph(&format!("p{i}")).unwrap();
        doc.commit(ChangeOrigin::Me, None);
        library.save_item(&mut doc).unwrap();
    }
    let count_updates = || {
        dem_store::layout::scan(library.root())
            .unwrap()
            .into_iter()
            .filter(|f| matches!(f.kind, dem_store::FileKind::Update { .. }))
            .count()
    };
    assert_eq!(count_updates(), 5);
    library.compact_item(&mut doc).unwrap();
    assert_eq!(count_updates(), 0);
    assert_eq!(
        library.load_item(m.id).unwrap().body_text(),
        "p0\np1\np2\np3\np4"
    );
}

#[test]
fn logs_append_read_and_reject_content_fields() {
    let (dir, library, _) = new_library();
    for i in 0..3 {
        let mut f = Map::new();
        f.insert("item".into(), Value::from(format!("id-{i}")));
        f.insert("action".into(), Value::from("edit"));
        library
            .append_log(LogKind::Activity, &LogRecord::new(LogKind::Activity, f))
            .unwrap();
    }
    let mut bad = Map::new();
    bad.insert("title".into(), Value::from("secret title"));
    assert!(
        library
            .append_log(LogKind::Activity, &LogRecord::new(LogKind::Activity, bad))
            .is_err()
    );
    drop(library);

    // Reopen and append more: sequence numbers continue.
    let v = Library::open(&dir.path().join("v"), Unlock::Password(PW)).unwrap();
    let mut f = Map::new();
    f.insert("item".into(), Value::from("id-3"));
    v.append_log(LogKind::Activity, &LogRecord::new(LogKind::Activity, f))
        .unwrap();
    let read = v.read_logs(LogKind::Activity).unwrap();
    assert_eq!(read.records.len(), 4);
    assert_eq!(read.damaged, 0);
}

#[test]
fn blobs_are_deduplicated_and_verified() {
    let (dir, library, _) = new_library();
    let data: Vec<u8> = (0..200_000u32).map(|i| (i % 253) as u8).collect();
    let n1 = library.put_blob(&data).unwrap();
    let src = dir.path().join("file.bin");
    std::fs::write(&src, &data).unwrap();
    let n2 = library.put_blob_file(&src).unwrap();
    assert_eq!(n1, n2);
    let mut back = Vec::new();
    library.read_blob(&n1, &mut back).unwrap();
    assert_eq!(back, data);
    assert!(library.verify_blob(&n1).unwrap());
}

#[test]
fn structure_persists() {
    let (dir, library, _) = new_library();
    let mut s = library.load_structure().unwrap();
    let (d, p) = (ItemId::new(), ItemId::new());
    s.add(d, dem_store::NodeKind::Domain, None).unwrap();
    s.add(p, dem_store::NodeKind::Project, Some(d)).unwrap();
    s.commit("me");
    library.save_structure(&mut s).unwrap();
    drop(library);
    let v = Library::open(&dir.path().join("v"), Unlock::Password(PW)).unwrap();
    let nodes = v.load_structure().unwrap().nodes();
    assert_eq!(nodes.len(), 2);
    assert_eq!(nodes.iter().find(|n| n.item == p).unwrap().parent, Some(d));
}

#[derive(Debug, Clone)]
enum Op {
    Title(String),
    Paragraph(String),
    Tag(u8, bool),
    Save,
    Compact,
    Reload,
}

fn op() -> impl Strategy<Value = Op> {
    prop_oneof![
        "[a-z西夏é ]{0,12}".prop_map(Op::Title),
        "[a-z中文𗀀 ]{0,20}".prop_map(Op::Paragraph),
        (0u8..4, any::<bool>()).prop_map(|(t, on)| Op::Tag(t, on)),
        Just(Op::Save),
        Just(Op::Compact),
        Just(Op::Reload),
    ]
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(24))]

    /// Any sequence of edits, saves, compactions and reloads ends with the same
    /// content on disk as in memory.
    #[test]
    fn random_edit_sequences_persist(ops in proptest::collection::vec(op(), 1..25)) {
        let (_dir, library, _) = new_library();
        let m = meta("start");
        let mut doc = library.create_item(&m).unwrap();
        for op in ops {
            match op {
                Op::Title(t) => { doc.set_title(Some(&t)).unwrap(); doc.commit(ChangeOrigin::Me, None); }
                Op::Paragraph(p) => { doc.append_paragraph(&p).unwrap(); doc.commit(ChangeOrigin::Ai, Some("p")); }
                Op::Tag(t, on) => { doc.set_tag(&TagId(format!("t{t}")), on).unwrap(); doc.commit(ChangeOrigin::Me, None); }
                Op::Save => { library.save_item(&mut doc).unwrap(); }
                Op::Compact => { library.save_item(&mut doc).unwrap(); library.compact_item(&mut doc).unwrap(); }
                Op::Reload => { library.save_item(&mut doc).unwrap(); doc = library.load_item(m.id).unwrap(); }
            }
        }
        library.save_item(&mut doc).unwrap();
        let back = library.load_item(m.id).unwrap();
        prop_assert_eq!(back.to_json(), doc.to_json());
        prop_assert_eq!(back.meta().unwrap(), doc.meta().unwrap());
    }
}
