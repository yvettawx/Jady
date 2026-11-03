//! Runs the whole corruption and recovery drill (P0-39) as CI does.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use dem_devtools::drill::{DrillConfig, FAULTS, render_table, run_drill};

#[test]
fn every_fault_is_detected_isolated_and_recoverable() {
    let dir = tempfile::tempdir().unwrap();
    let outcomes = run_drill(&DrillConfig {
        seed: 39,
        items: 24,
        dir: dir.path().join("drill"),
    })
    .unwrap();
    let table = render_table(&outcomes);
    let names: Vec<&str> = outcomes.iter().map(|o| o.fault).collect();
    assert_eq!(names, FAULTS, "{table}");
    // The faults the P0 plan (P0-39) requires.
    for f in [
        "flip-snapshot-byte",
        "truncate-update",
        "delete-item",
        "swap-items",
        "corrupt-log-record",
        "torn-log-tail",
        "corrupt-blob",
        "drop-tmp-and-index",
        "tamper-kdf-params",
        "recovery-code-only",
    ] {
        assert!(FAULTS.contains(&f), "{f} missing");
    }
    assert!(outcomes.iter().all(|o| o.passed()), "{table}");
}
