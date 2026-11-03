//! Kills a writer process at random moments and checks the library is never left
//! unreadable (format spec §8, P0-23). The same binary acts as the child: when
//! `DEM_CRASH_CHILD` is set, `crash_child` writes forever until killed.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::path::Path;
use std::process::Command;
use std::time::Duration;

use dem_crypto::keys::KdfParams;
use dem_model::{
    ChangeOrigin, ItemId, ItemMeta, ItemState, Privacy, SourceInfo, Timestamp, TypeId,
};
use dem_store::logs::{LogKind, LogRecord};
use dem_store::{Library, Unlock};

const PW: &[u8] = b"pw";

#[test]
fn crash_child() {
    let Ok(root) = std::env::var("DEM_CRASH_CHILD") else {
        return;
    };
    let library = Library::open(Path::new(&root), Unlock::Password(PW)).unwrap();
    let id: ItemId = std::env::var("DEM_CRASH_ITEM").unwrap().parse().unwrap();
    let mut doc = library.load_item(id).unwrap();
    let mut i = 0u64;
    loop {
        i += 1;
        doc.append_paragraph(&format!("line {i} 中文内容")).unwrap();
        doc.commit(ChangeOrigin::Me, None);
        library.save_item(&mut doc).unwrap();
        let mut f = serde_json::Map::new();
        f.insert("item".into(), serde_json::Value::from(id.to_string()));
        library
            .append_log(LogKind::Activity, &LogRecord::new(LogKind::Activity, f))
            .unwrap();
        if i % 7 == 6 {
            library.compact_item(&mut doc).unwrap();
        }
    }
}

#[test]
fn killing_a_writer_never_corrupts_the_library() {
    if std::env::var("DEM_CRASH_CHILD").is_ok() {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("v");
    let (library, _) = Library::create(&root, PW, KdfParams::INSECURE_FOR_TESTS).unwrap();
    let now = Timestamp::now();
    let meta = ItemMeta {
        id: ItemId::new(),
        type_id: TypeId("note".into()),
        title: Some("crash".into()),
        state: ItemState::Active,
        privacy: Privacy::Normal,
        container: None,
        tags: vec![],
        created: now,
        updated: now,
        time: None,
        source: SourceInfo::default(),
        ai_web: false,
    };
    library.create_item(&meta).unwrap();
    drop(library);

    let exe = std::env::current_exe().unwrap();
    let mut last_lines = 0;
    for round in 0..12u64 {
        let mut child = Command::new(&exe)
            .args(["--exact", "crash_child", "--nocapture", "--test-threads=1"])
            .env("DEM_CRASH_CHILD", &root)
            .env("DEM_CRASH_ITEM", meta.id.to_string())
            .spawn()
            .unwrap();
        // Vary the kill moment: 150..700 ms after start.
        std::thread::sleep(Duration::from_millis(150 + (round * 47) % 550));
        child.kill().unwrap();
        child.wait().unwrap();

        let v = Library::open(&root, Unlock::Password(PW)).expect("library opens after a kill");
        let doc = v.load_item(meta.id).expect("item loads after a kill");
        let lines = doc.body_text().lines().filter(|l| !l.is_empty()).count();
        assert!(lines >= last_lines, "content never goes backwards");
        last_lines = lines;
        let logs = v.read_logs(LogKind::Activity).unwrap();
        assert_eq!(
            logs.damaged, 0,
            "a kill may tear the tail, never damage records"
        );
    }
    assert!(last_lines > 0, "the child made progress");
}
