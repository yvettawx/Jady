#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

//! P0-32: the gateway simulator passes on the reference fake and catches a leak.

use std::path::Path;
use std::process::ExitCode;

use clap::Parser;
use dem_devtools::gateway_sim::dataset::Dataset;
use dem_devtools::gateway_sim::reference::{LeakyGateway, ReferenceGateway};
use dem_devtools::gateway_sim::runner::{DEFAULT_SCENARIO_DIR, run_all, run_matrix, run_scenario};
use dem_devtools::gateway_sim::scenario::{self, load_dir};
use dem_devtools::gateway_sim::{GatewayUnderTest, Session, ToolResponse};
use dem_devtools::{Cli, run};
use serde_json::Value;

#[test]
fn reference_gateway_passes_matrix_and_all_scenarios() {
    let scenarios = load_dir(Path::new(DEFAULT_SCENARIO_DIR)).unwrap();
    assert!(scenarios.len() >= 6, "example scenarios missing");
    let report = run_all(
        &mut ReferenceGateway::new(),
        &Dataset::reference(),
        &scenarios,
        true,
    )
    .unwrap();
    assert!(report.passed(), "{}", report.render());
    assert_eq!(report.matrix.len(), 4 * 4 * 2);
    assert!(report.render().contains("result: PASS"));
}

#[test]
fn leaky_gateway_is_detected() {
    let scenarios = load_dir(Path::new(DEFAULT_SCENARIO_DIR)).unwrap();
    let dataset = Dataset::reference();
    let report = run_all(&mut LeakyGateway::new(), &dataset, &scenarios, true).unwrap();
    assert!(!report.passed());
    let text = report.render();
    assert!(text.contains("LEAK"), "{text}");
    assert!(text.contains(&dataset.canaries.private));
    assert!(text.contains("result: FAIL"));
    // Every search cell of the matrix fails, in both session kinds.
    let failing: Vec<_> = report
        .matrix
        .iter()
        .filter(|c| !c.failures.is_empty())
        .map(|c| c.tool.as_str())
        .collect();
    assert_eq!(failing, vec!["search"; 8]);
}

#[test]
fn wrong_expectations_are_reported() {
    let s = scenario::parse(
        r#"{"name": "wrong", "steps": [
            {"call": {"tool": "read_item", "args": {"id": "n-002"}},
             "expect": {"ok": false, "contains": ["no such text"]}},
            {"call": {"tool": "related", "args": {"id": "n-001"}},
             "expect": {"protected_links": 0, "ids": ["n-001"]}}
        ]}"#,
        Path::new("wrong.json"),
    )
    .unwrap();
    let r = run_scenario(&mut ReferenceGateway::new(), &Dataset::reference(), &s).unwrap();
    assert_eq!(r.failures.len(), 4, "{:#?}", r.failures);
    assert!(r.failures[0].starts_with("step 1 (read_item): expected ok=false"));
}

#[test]
fn cli_exit_code_reflects_result() {
    let ok = run(Cli::parse_from(["dem-dev", "gateway-sim"])).unwrap();
    assert_eq!(ok, ExitCode::SUCCESS);
    let leaky = run(Cli::parse_from([
        "dem-dev",
        "gateway-sim",
        "--target",
        "leaky",
        "--json",
    ]))
    .unwrap();
    assert_eq!(leaky, ExitCode::FAILURE);
}

#[test]
fn missing_scenario_dir_is_an_error() {
    let dir = tempfile::tempdir().unwrap();
    let err = run(Cli::parse_from([
        "dem-dev",
        "gateway-sim",
        "--scenarios",
        dir.path().join("nope").to_str().unwrap(),
    ]));
    assert!(err.is_err());
}

/// A gateway wrapper that breaks one rule without leaking any canary or hidden id,
/// to prove the matrix checks other than the canary grep really fire.
struct Broken {
    inner: ReferenceGateway,
    rule: Rule,
    mutated: bool,
}

#[derive(Clone, Copy, PartialEq)]
enum Rule {
    /// Hidden items answer "access denied" instead of the not-found error.
    DistinguishableHidden,
    /// `propose_changes` changes the data snapshot.
    MutatingProposal,
    /// Authorized sessions cannot read sensitive items.
    NoSensitiveWhenAuthorized,
}

impl Broken {
    fn new(rule: Rule) -> Self {
        Self {
            inner: ReferenceGateway::new(),
            rule,
            mutated: false,
        }
    }
}

impl GatewayUnderTest for Broken {
    fn name(&self) -> &str {
        "broken"
    }

    fn load(&mut self, dataset: &Dataset) -> anyhow::Result<()> {
        self.mutated = false;
        self.inner.load(dataset)
    }

    fn call(&mut self, session: &Session, tool: &str, args: &Value) -> ToolResponse {
        let id = args
            .get("id")
            .or_else(|| args.get("item_id"))
            .and_then(Value::as_str)
            .unwrap_or("");
        match self.rule {
            Rule::DistinguishableHidden if ["s-", "p-", "c-"].iter().any(|p| id.starts_with(p)) => {
                let r = self.inner.call(session, tool, args);
                if r.is_error {
                    return ToolResponse::error("access denied");
                }
                r
            }
            Rule::MutatingProposal if tool == "propose_changes" => {
                self.mutated = true;
                self.inner.call(session, tool, args)
            }
            Rule::NoSensitiveWhenAuthorized if id.starts_with("s-") => {
                self.inner
                    .call(&Session::new(&session.id, false), tool, args)
            }
            _ => self.inner.call(session, tool, args),
        }
    }

    fn data_snapshot(&self) -> anyhow::Result<String> {
        let s = self.inner.data_snapshot()?;
        Ok(if self.mutated {
            format!("{s}+changed")
        } else {
            s
        })
    }

    fn pending_proposals(&self) -> usize {
        self.inner.pending_proposals()
    }
}

fn failures_of(rule: Rule) -> Vec<String> {
    let cells = run_matrix(&mut Broken::new(rule), &Dataset::reference()).unwrap();
    cells
        .into_iter()
        .flat_map(|c| {
            c.failures
                .into_iter()
                .map(move |f| format!("{} {} {}: {f}", c.tool, c.level, c.authorized))
        })
        .collect()
}

#[test]
fn matrix_detects_rule_breaks_beyond_canary_leaks() {
    let f = failures_of(Rule::DistinguishableHidden);
    assert!(
        f.iter().any(|x| x.contains("distinguishable from missing")),
        "{f:#?}"
    );
    assert!(!f.iter().any(|x| x.contains("LEAK")), "{f:#?}");

    let f = failures_of(Rule::MutatingProposal);
    assert!(f.iter().any(|x| x.contains("DATA MUTATED")), "{f:#?}");

    let f = failures_of(Rule::NoSensitiveWhenAuthorized);
    assert!(
        f.iter()
            .any(|x| x.starts_with("read_item sensitive true") && x.contains("returned an error")),
        "{f:#?}"
    );
}
