#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! `dem-dev logs` (P0-31 viewer): filters and output formats.

use std::path::Path;
use std::process::Command;

fn write_logs(dir: &Path) {
    let day1 = [
        r#"{"ts":"2026-10-01T08:00:00Z","level":"INFO","target":"dem_store::library","message":"opened","fields":{"items":3}}"#,
        r#"{"ts":"2026-10-01T08:00:01Z","level":"WARN","target":"dem_store::library","message":"torn tail","fields":{"bytes":12}}"#,
        r#"{"ts":"2026-10-01T08:00:02Z","level":"DEBUG","target":"dem_index","message":"query"}"#,
        // Cut short by a crash: skipped.
        r#"{"ts":"2026-10-01T08:00:03Z","level":"ERR"#,
    ];
    let day2 = [
        r#"{"ts":"2026-10-02T09:00:00Z","level":"ERROR","target":"panic","message":"panic","fields":{"location":"src/x.rs:1"}}"#,
    ];
    std::fs::write(dir.join("dem.2026-10-01.log"), day1.join("\n") + "\n").unwrap();
    std::fs::write(dir.join("dem.2026-10-02.log"), day2.join("\n") + "\n").unwrap();
    // Not a log file of ours.
    std::fs::write(dir.join("other.txt"), "ignored\n").unwrap();
}

fn logs(dir: &Path, args: &[&str]) -> (bool, String) {
    let out = Command::new(env!("CARGO_BIN_EXE_dem-dev"))
        .arg("logs")
        .arg("--dir")
        .arg(dir)
        .args(args)
        .output()
        .unwrap();
    (out.status.success(), String::from_utf8(out.stdout).unwrap())
}

#[test]
fn shows_all_valid_entries_in_order() {
    let tmp = tempfile::tempdir().unwrap();
    write_logs(tmp.path());
    let (ok, text) = logs(tmp.path(), &[]);
    assert!(ok);
    let lines: Vec<&str> = text.lines().collect();
    assert_eq!(lines.len(), 4);
    assert_eq!(
        lines[0],
        "2026-10-01T08:00:00Z INFO  dem_store::library: opened items=3"
    );
    assert!(lines[3].contains("panic") && lines[3].contains("location=src/x.rs:1"));
}

#[test]
fn level_and_target_filters() {
    let tmp = tempfile::tempdir().unwrap();
    write_logs(tmp.path());
    let (_, warn) = logs(tmp.path(), &["--level", "warn"]);
    assert_eq!(warn.lines().count(), 2);
    assert!(warn.contains("torn tail") && warn.contains("panic"));

    let (_, store) = logs(tmp.path(), &["--target", "dem_store"]);
    assert_eq!(store.lines().count(), 2);

    let (_, both) = logs(tmp.path(), &["--target", "dem_store", "--level", "warn"]);
    assert_eq!(both.lines().count(), 1);

    let (ok, _) = logs(tmp.path(), &["--level", "loud"]);
    assert!(!ok);
}

#[test]
fn json_output_round_trips_entries() {
    let tmp = tempfile::tempdir().unwrap();
    write_logs(tmp.path());
    let (ok, text) = logs(tmp.path(), &["--json", "--level", "debug"]);
    assert!(ok);
    let entries: Vec<serde_json::Value> = text
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    assert_eq!(entries.len(), 4);
    assert_eq!(entries[1]["fields"]["bytes"], 12);
    assert_eq!(entries[2]["target"], "dem_index");
    assert!(entries[2]["message"] == "query");
}

#[test]
fn reads_what_dem_diag_writes() {
    let tmp = tempfile::tempdir().unwrap();
    let guard = dem_diag::init(&dem_diag::DiagConfig::new(tmp.path())).unwrap();
    tracing::info!(target: "logs_test", count = 3, body = "SECRET BODY", "hello");
    tracing::debug!(target: "logs_test", "below the configured level");
    drop(guard);
    let (ok, text) = logs(tmp.path(), &["--target", "logs_test"]);
    assert!(ok);
    let lines: Vec<&str> = text.lines().collect();
    assert_eq!(lines.len(), 1, "{text}");
    assert!(lines[0].contains("INFO  logs_test: hello"), "{text}");
    assert!(lines[0].contains("count=3"));
    // Content logged by mistake under a protected field name stays redacted.
    assert!(!text.contains("SECRET BODY"));
}
