#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

//! P0-37: the runner reports hits and misses of a fake search correctly.

use std::path::Path;
use std::process::ExitCode;

use clap::Parser;
use dem_devtools::search_eval::{DEFAULT_QUERY_FILE, EvalSet, SubstringSearch, run_eval};
use dem_devtools::{Cli, run};

const SMALL: &str = r#"{
  "version": 1,
  "k": 10,
  "highlight_markers": ["[", "]"],
  "docs": [
    {"id": "a", "title": "Café à Paris", "body": "un café"},
    {"id": "b", "title": "cafe notes", "body": "plain ascii"},
    {"id": "c", "title": "头发", "body": "理发店"}
  ],
  "queries": [
    {"id": "q1", "category": "latin", "query": "cafe", "expected": ["b"]},
    {"id": "q2", "category": "accent", "query": "café", "expected": ["a", "b"]},
    {"id": "q3", "category": "negative", "query": "发", "expected": []},
    {"id": "q4", "category": "zh", "query": "头发", "expected": ["c"]}
  ],
  "highlights": [
    {"query": "发", "doc": "c", "field": "body", "expected": "理[发]店"},
    {"query": "cafe", "doc": "a", "field": "title", "expected": "[Café] à Paris"}
  ]
}"#;

fn small() -> EvalSet {
    let set: EvalSet = serde_json::from_str(SMALL).unwrap();
    set.validate().unwrap();
    set
}

#[test]
fn reports_hits_misses_and_unexpected_results() {
    let report = run_eval(&mut SubstringSearch::default(), &small(), "small.json").unwrap();
    let by_id = |id: &str| report.queries.iter().find(|q| q.id == id).unwrap();

    assert!(by_id("q1").hit);
    let q2 = by_id("q2");
    assert!(!q2.hit);
    assert_eq!(q2.missing, vec!["b"]);
    assert_eq!(q2.recall, Some(0.5));
    let q3 = by_id("q3");
    assert!(!q3.hit);
    assert_eq!(q3.unexpected, vec!["c"]);
    assert!(by_id("q4").hit);

    let cat = |c: &str| report.categories.get(c).unwrap();
    assert_eq!((cat("latin").hits, cat("latin").queries), (1, 1));
    assert_eq!(cat("accent").hit_rate, 0.0);
    assert_eq!(cat("accent").recall_at_k, Some(0.5));
    assert_eq!(cat("negative").recall_at_k, None);
    assert_eq!(report.overall.hits, 2);
    assert_eq!(report.overall.hit_rate, 0.5);
    let recall = report.overall.recall_at_k.unwrap();
    assert!((recall - 2.5 / 3.0).abs() < 1e-9);

    // The substring highlighter passes the first case and fails the accent-folding one.
    let passed: Vec<_> = report.highlights.iter().map(|h| h.passed).collect();
    assert_eq!(passed, vec![Some(true), Some(false)]);

    let text = report.render();
    assert!(text.contains("misses (2)"), "{text}");
    assert!(
        text.contains(r#"[q2] "café" (accent): missing ["b"], unexpected []"#),
        "{text}"
    );
    assert!(text.contains("highlights: 1/2 passed, 0 skipped"), "{text}");
}

#[test]
fn invalid_sets_are_rejected() {
    let unknown = SMALL.replace(r#""expected": ["c"]"#, r#""expected": ["zz"]"#);
    let set: EvalSet = serde_json::from_str(&unknown).unwrap();
    assert!(set.validate().is_err());
    let dup = SMALL.replace(r#""id": "q4""#, r#""id": "q1""#);
    let set: EvalSet = serde_json::from_str(&dup).unwrap();
    assert!(set.validate().is_err());
    let typo = SMALL.replace(r#""expected": []"#, r#""expect": []"#);
    assert!(serde_json::from_str::<EvalSet>(&typo).is_err());
}

#[test]
fn seed_set_loads_and_runs() {
    let set = EvalSet::load(Path::new(DEFAULT_QUERY_FILE)).unwrap();
    assert_eq!(set.docs.len(), 22);
    assert_eq!(set.queries.len(), 56);
    assert_eq!(set.highlights.len(), 9);
    let report = run_eval(&mut SubstringSearch::default(), &set, "seed.json").unwrap();
    assert_eq!(report.overall.queries, 56);
    let sum: usize = report.categories.values().map(|c| c.queries).sum();
    assert_eq!(sum, 56);
    // A naive substring search cannot fold Traditional and Simplified Chinese.
    assert!(report.categories["trad-simp"].hit_rate < 1.0);
    assert!(report.overall.hits > 0);
}

#[test]
fn cli_threshold_sets_exit_code() {
    let ok = run(Cli::parse_from(["dem-dev", "search-eval"])).unwrap();
    assert_eq!(ok, ExitCode::SUCCESS);
    let strict = run(Cli::parse_from([
        "dem-dev",
        "search-eval",
        "--min-hit-rate",
        "1.0",
        "--json",
    ]))
    .unwrap();
    assert_eq!(strict, ExitCode::FAILURE);
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("small.json");
    std::fs::write(&path, SMALL).unwrap();
    let k1 = run(Cli::parse_from([
        "dem-dev",
        "search-eval",
        "--queries",
        path.to_str().unwrap(),
        "--k",
        "1",
        "--min-hit-rate",
        "0.5",
    ]))
    .unwrap();
    assert_eq!(k1, ExitCode::SUCCESS);
}

#[test]
fn out_of_range_threshold_is_an_error() {
    let err = run(Cli::parse_from([
        "dem-dev",
        "search-eval",
        "--min-hit-rate",
        "35",
    ]));
    assert!(err.is_err());
}
