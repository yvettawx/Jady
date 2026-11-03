#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

//! `dem-dev bench` (P0-40) on a tiny library: every measurement is present in the
//! JSON report, the checks follow the plan, and the temporary libraries are deleted.

use std::process::Command;

use dem_devtools::bench::{Stats, checks};

#[test]
fn small_run_reports_everything_and_cleans_up() {
    let dir = tempfile::tempdir().unwrap();
    let out = dir.path().join("report.json");
    let work = dir.path().join("work");
    std::fs::create_dir_all(&work).unwrap();
    let status = Command::new(env!("CARGO_BIN_EXE_dem-dev"))
        .args([
            "bench",
            "--items",
            "120,300",
            "--samples",
            "15",
            "--unlock-runs",
            "1",
            "--threads",
            "3",
            // The default Argon2id parameters cost 256 MiB per run; tests use the
            // fast ones (the unlock check then fails, which exit code 1 allows).
            "--unlock-kdf-insecure-for-tests",
        ])
        .arg("--out")
        .arg(&out)
        .arg("--dir")
        .arg(&work)
        .output()
        .unwrap();
    // 0 = all targets met, 1 = some missed (possible on a loaded machine); 2 = error.
    assert!(matches!(status.status.code(), Some(0 | 1)), "{status:?}");
    let stdout = String::from_utf8(status.stdout).unwrap();
    assert!(stdout.contains("checks against P0 plan"), "{stdout}");

    let r: serde_json::Value = serde_json::from_slice(&std::fs::read(&out).unwrap()).unwrap();
    assert_eq!(r["sizes"].as_array().unwrap().len(), 2);
    let s = &r["sizes"][1];
    assert_eq!(s["items"], 300);
    // One snapshot and one update per ordinary item, plus containers and fixed files.
    assert!(s["files"].as_u64().unwrap() > 600, "{s}");
    for k in ["open_item", "save_item", "compact_item"] {
        assert_eq!(s[k]["n"], 15, "{k}");
        assert!(s[k]["p50_ms"].as_f64().unwrap() > 0.0, "{k}");
    }
    assert_eq!(s["unlock_master_key"]["n"], 10);
    assert_eq!(s["open_library"]["n"], 3);
    assert_eq!(
        r["unlock"]["kdf_m_kib"],
        dem_crypto::keys::KdfParams::INSECURE_FOR_TESTS.m_kib
    );
    assert_eq!(r["unlock"]["password"]["n"], 1);
    assert!(r["micro"]["envelope_4k_seal_us"].as_f64().unwrap() > 0.0);
    assert!(r["search"].as_str().unwrap().starts_with("P1"));
    // `uptime` exists on macOS and Linux only; on Windows the load is not recorded.
    if cfg!(unix) {
        assert!(r["load_before"].is_string());
    } else {
        assert!(r["load_before"].is_null());
    }
    // Unlock checks plus master-key / open / item / save checks per size.
    assert_eq!(r["checks"].as_array().unwrap().len(), 2 + 2 * 4);

    // Nothing left behind.
    assert_eq!(std::fs::read_dir(&work).unwrap().count(), 0);
}

fn stats(p50: f64, p95: f64) -> Stats {
    Stats {
        n: 1,
        p50_ms: p50,
        p95_ms: p95,
        max_ms: p95,
    }
}

#[test]
fn checks_apply_relaxed_targets_at_100k_and_none_at_50k() {
    let size =
        |items: usize, open_s: f64, item_ms: f64, save_ms: f64| dem_devtools::bench::SizeReport {
            items,
            containers: 0,
            generate_s: 0.0,
            write_s: 0.0,
            files: 0,
            bytes: 0,
            unlock_master_key: stats(1.0, 1.0),
            open_library: stats(open_s * 1e3, open_s * 1e3),
            load_all_s: 0.0,
            rss_before_kib: None,
            rss_all_loaded_kib: None,
            open_item: stats(item_ms, item_ms),
            save_item: stats(save_ms, save_ms),
            compact_item: stats(0.0, 0.0),
            scan_files_s: 0.0,
        };
    // 40 ms per item fails at 10k (30 ms) but passes at 100k (50 ms).
    let c = checks(
        None,
        &[
            size(10_000, 1.0, 40.0, 10.0),
            size(50_000, 9.0, 99.0, 99.0),
            size(100_000, 3.0, 40.0, 25.0),
        ],
    );
    let failed: Vec<_> = c
        .iter()
        .filter(|c| !c.pass)
        .map(|c| (c.items, c.what.as_str()))
        .collect();
    assert_eq!(failed, [(Some(10_000), "open one item (p95)")]);
    // 50k: only the master-key check.
    assert_eq!(c.iter().filter(|c| c.items == Some(50_000)).count(), 1);
}
