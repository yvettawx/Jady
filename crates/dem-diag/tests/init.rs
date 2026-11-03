//! End-to-end: the global logger writes rotated files that `read_entries` parses,
//! panics are recorded without their message, and canaries never reach disk.
//! Kept as the only test in this binary because it installs a global subscriber.

use dem_diag::{DiagConfig, Sensitive, init, read_entries};

#[test]
fn logs_to_disk_without_content() {
    let dir = tempfile::tempdir().unwrap();
    let guard = init(&DiagConfig::new(dir.path())).unwrap();

    tracing::info!(item_id = 1_u64, body = "CANARY-BODY", "saved");
    tracing::info!(value = ?Sensitive("CANARY-SECRET"), "wrapped");
    let _ = std::thread::Builder::new()
        .name("worker".into())
        .spawn(|| panic!("CANARY-PANIC payload"))
        .unwrap()
        .join();
    drop(guard);

    let raw: String = std::fs::read_dir(dir.path())
        .unwrap()
        .map(|e| std::fs::read_to_string(e.unwrap().path()).unwrap())
        .collect();
    assert!(
        !raw.contains("CANARY"),
        "content reached the log file:\n{raw}"
    );

    let entries = read_entries(dir.path()).unwrap();
    assert_eq!(entries.len(), 3);
    let panic = entries.iter().find(|e| e.target == "panic").unwrap();
    assert_eq!(panic.fields["thread"], "worker");
    assert!(
        panic.fields["location"]
            .as_str()
            .unwrap()
            .contains("init.rs")
    );
}
