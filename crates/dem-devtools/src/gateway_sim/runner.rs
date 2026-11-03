//! Runs the generated privacy matrix and the scenario files against a
//! [`GatewayUnderTest`], and renders the report.
//!
//! Checks applied to every single call, in the matrix and in scenarios:
//! - no canary or id of an item the session may not see appears in the response;
//! - the gateway's item data is unchanged afterwards (tools never mutate data).
//!
//! Matrix checks per (tool, level, session):
//! - visible: the call succeeds and returns the level's target item;
//! - hidden: the response is identical to the same call on a missing item;
//! - `related` on the hub item shows hidden link targets only as "protected";
//! - `propose_changes` queues exactly one proposal for a visible item, none otherwise.

use std::fmt::Write as _;

use serde::Serialize;
use serde_json::{Value, json};

use super::dataset::{Dataset, HUB_ID, LEVELS, MISSING_ID, expected_visible, level_name};
use super::scenario::{Call, Scenario, expand, expand_value};
use super::{GatewayUnderTest, Session, TOOLS, ToolResponse};

pub const DEFAULT_SCENARIO_DIR: &str =
    concat!(env!("CARGO_MANIFEST_DIR"), "/../../testdata/gateway");

#[derive(Debug, Clone, Serialize)]
pub struct MatrixCell {
    pub tool: String,
    pub level: &'static str,
    pub authorized: bool,
    pub expected_visible: bool,
    pub failures: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ScenarioResult {
    pub name: String,
    pub file: String,
    pub steps: usize,
    pub failures: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Report {
    pub gateway: String,
    pub matrix: Vec<MatrixCell>,
    pub scenarios: Vec<ScenarioResult>,
}

impl Report {
    pub fn passed(&self) -> bool {
        self.failure_count() == 0
    }

    pub fn failure_count(&self) -> usize {
        self.matrix.iter().map(|c| c.failures.len()).sum::<usize>()
            + self
                .scenarios
                .iter()
                .map(|s| s.failures.len())
                .sum::<usize>()
    }

    /// Plain-text report: the matrix table, scenario lines, then every failure.
    pub fn render(&self) -> String {
        let mut out = String::new();
        let _ = writeln!(out, "gateway-sim: gateway '{}'", self.gateway);
        if !self.matrix.is_empty() {
            let _ = writeln!(
                out,
                "\nmatrix (cell: unauthorized / authorized session; vis = visible, hid = hidden, FAIL = check failed)"
            );
            let _ = write!(out, "{:<17}", "tool");
            for level in LEVELS {
                let _ = write!(out, "{:<16}", level_name(level));
            }
            out.push('\n');
            for tool in TOOLS {
                let _ = write!(out, "{tool:<17}");
                for level in LEVELS {
                    let cell = |auth: bool| {
                        self.matrix
                            .iter()
                            .find(|c| {
                                c.tool == tool
                                    && c.level == level_name(level)
                                    && c.authorized == auth
                            })
                            .map(|c| match (c.failures.is_empty(), c.expected_visible) {
                                (false, _) => "FAIL",
                                (true, true) => "vis",
                                (true, false) => "hid",
                            })
                            .unwrap_or("-")
                    };
                    let _ = write!(out, "{:<16}", format!("{} / {}", cell(false), cell(true)));
                }
                out.push('\n');
            }
        }
        if !self.scenarios.is_empty() {
            let _ = writeln!(out, "\nscenarios");
            for s in &self.scenarios {
                let status = if s.failures.is_empty() {
                    "ok  "
                } else {
                    "FAIL"
                };
                let _ = writeln!(out, "  {status} {} ({} steps, {})", s.name, s.steps, s.file);
            }
        }
        let failures: Vec<String> = self
            .matrix
            .iter()
            .flat_map(|c| {
                let auth = if c.authorized { "auth" } else { "unauth" };
                c.failures
                    .iter()
                    .map(move |f| format!("matrix {} x {} ({auth}): {f}", c.tool, c.level))
            })
            .chain(self.scenarios.iter().flat_map(|s| {
                s.failures
                    .iter()
                    .map(move |f| format!("scenario '{}': {f}", s.name))
            }))
            .collect();
        if failures.is_empty() {
            let _ = writeln!(out, "\nresult: PASS");
        } else {
            let _ = writeln!(out, "\nfailures ({})", failures.len());
            for f in &failures {
                let _ = writeln!(out, "  - {f}");
            }
            let _ = writeln!(out, "\nresult: FAIL");
        }
        out
    }
}

/// Wraps the gateway and applies the per-call checks.
struct Probe<'a> {
    gateway: &'a mut dyn GatewayUnderTest,
    dataset: &'a Dataset,
    baseline: String,
}

impl<'a> Probe<'a> {
    fn new(gateway: &'a mut dyn GatewayUnderTest, dataset: &'a Dataset) -> anyhow::Result<Self> {
        gateway.load(dataset)?;
        let baseline = gateway.data_snapshot()?;
        Ok(Self {
            gateway,
            dataset,
            baseline,
        })
    }

    fn call(
        &mut self,
        session: &Session,
        tool: &str,
        args: &Value,
        failures: &mut Vec<String>,
    ) -> ToolResponse {
        let r = self.gateway.call(session, tool, args);
        for token in self.dataset.forbidden_tokens(session.authorized) {
            if r.text.contains(&token) {
                failures.push(format!(
                    "LEAK: {tool} {args} returned hidden token '{token}': {}",
                    r.text
                ));
            }
        }
        match self.gateway.data_snapshot() {
            Ok(now) if now == self.baseline => {}
            Ok(_) => failures.push(format!("DATA MUTATED by {tool} {args}")),
            Err(e) => failures.push(format!("snapshot failed after {tool} {args}: {e:#}")),
        }
        r
    }
}

/// All `"id"` string values anywhere in a JSON value.
pub fn collect_ids(v: &Value) -> Vec<String> {
    let mut out = Vec::new();
    fn walk(v: &Value, out: &mut Vec<String>) {
        match v {
            Value::Object(o) => {
                for (k, x) in o {
                    match (k.as_str(), x) {
                        ("id", Value::String(s)) => out.push(s.clone()),
                        _ => walk(x, out),
                    }
                }
            }
            Value::Array(a) => a.iter().for_each(|x| walk(x, out)),
            _ => {}
        }
    }
    walk(v, &mut out);
    out
}

/// Number of objects with `"protected": true` anywhere in a JSON value.
pub fn count_protected(v: &Value) -> usize {
    match v {
        Value::Object(o) => {
            usize::from(o.get("protected") == Some(&Value::Bool(true)))
                + o.values().map(count_protected).sum::<usize>()
        }
        Value::Array(a) => a.iter().map(count_protected).sum(),
        _ => 0,
    }
}

fn tool_args(tool: &str, id: &str) -> Value {
    match tool {
        "propose_changes" => json!({
            "item_id": id,
            "changes": [{"field": "title", "new_value": "simulated proposal"}],
            "reason": "gateway-sim"
        }),
        _ => json!({ "id": id }),
    }
}

fn matrix_cell(
    probe: &mut Probe<'_>,
    tool: &str,
    level: dem_model::Privacy,
    authorized: bool,
) -> MatrixCell {
    let session = Session::new(format!("matrix-{tool}-{}", level_name(level)), authorized);
    let visible = expected_visible(level, authorized);
    let target = Dataset::target(level);
    let mut f = Vec::new();

    let (args, missing_args) = if tool == "search" {
        (
            json!({"query": Dataset::keyword(level), "limit": 50}),
            json!({"query": "kwmissing", "limit": 50}),
        )
    } else {
        (tool_args(tool, target), tool_args(tool, MISSING_ID))
    };
    let queued_before = probe.gateway.pending_proposals();
    let r = probe.call(&session, tool, &args, &mut f);
    let queued = probe
        .gateway
        .pending_proposals()
        .saturating_sub(queued_before);
    let missing = probe.call(&session, tool, &missing_args, &mut f);

    if visible {
        if r.is_error {
            f.push(format!(
                "visible target {target} returned an error: {}",
                r.text
            ));
        } else if tool != "propose_changes" // checked through the queue below
            && !collect_ids(&r.json()).iter().any(|i| i == target)
        {
            f.push(format!("visible target {target} missing from: {}", r.text));
        }
        if let Some(c) = probe.dataset.canaries.for_level(level)
            && tool == "read_item"
            && !r.text.contains(c)
        {
            f.push(format!("read_item {target} did not return its content"));
        }
    } else if r != missing {
        f.push(format!(
            "hidden {target} distinguishable from missing: {:?} vs {:?}",
            r, missing
        ));
    }

    if tool == "propose_changes" {
        let want = usize::from(visible);
        if queued != want {
            f.push(format!("expected {want} queued proposal(s), got {queued}"));
        }
    }

    if tool == "related" {
        let hub = probe.call(&session, "related", &json!({ "id": HUB_ID }), &mut f);
        let shown = collect_ids(&hub.json()).iter().any(|i| i == target);
        let protected = count_protected(&hub.json());
        let want_protected = LEVELS
            .iter()
            .filter(|l| !expected_visible(**l, authorized))
            .count();
        if shown != visible {
            f.push(format!(
                "hub link to {target}: shown={shown}, expected {visible}"
            ));
        }
        if protected != want_protected {
            f.push(format!(
                "hub shows {protected} protected links, expected {want_protected}: {}",
                hub.text
            ));
        }
    }

    MatrixCell {
        tool: tool.to_string(),
        level: level_name(level),
        authorized,
        expected_visible: visible,
        failures: f,
    }
}

/// The full matrix: every tool x every privacy level x both session kinds.
pub fn run_matrix(
    gateway: &mut dyn GatewayUnderTest,
    dataset: &Dataset,
) -> anyhow::Result<Vec<MatrixCell>> {
    let mut probe = Probe::new(gateway, dataset)?;
    let mut cells = Vec::new();
    for tool in TOOLS {
        for level in LEVELS {
            for authorized in [false, true] {
                cells.push(matrix_cell(&mut probe, tool, level, authorized));
            }
        }
    }
    Ok(cells)
}

pub fn run_scenario(
    gateway: &mut dyn GatewayUnderTest,
    dataset: &Dataset,
    scenario: &Scenario,
) -> anyhow::Result<ScenarioResult> {
    let mut probe = Probe::new(gateway, dataset)?;
    let c = &dataset.canaries;
    let session = Session::new(format!("scenario-{}", scenario.name), scenario.authorized);
    let mut failures = Vec::new();
    for (n, step) in scenario.steps.iter().enumerate() {
        let mut f = Vec::new();
        let args = expand_value(&step.call.args, c);
        let before = probe.gateway.pending_proposals();
        let r = probe.call(&session, &step.call.tool, &args, &mut f);
        let queued = probe.gateway.pending_proposals().saturating_sub(before);
        let e = &step.expect;
        if let Some(ok) = e.ok
            && ok == r.is_error
        {
            f.push(format!("expected ok={ok}, got: {}", r.text));
        }
        if let Some(want) = &e.ids {
            let mut got = collect_ids(&r.json());
            got.sort();
            got.dedup();
            let mut want = want.clone();
            want.sort();
            if got != want {
                f.push(format!("ids {got:?}, expected {want:?}"));
            }
        }
        for s in &e.contains {
            let s = expand(s, c);
            if !r.text.contains(&s) {
                f.push(format!("response lacks '{s}': {}", r.text));
            }
        }
        for s in &e.not_contains {
            let s = expand(s, c);
            if r.text.contains(&s) {
                f.push(format!("response contains '{s}': {}", r.text));
            }
        }
        if let Some(other) = &e.same_as {
            let other = Call {
                tool: other.tool.clone(),
                args: expand_value(&other.args, c),
            };
            let r2 = probe.call(&session, &other.tool, &other.args, &mut f);
            if r2 != r {
                f.push(format!(
                    "differs from {} {}: {:?} vs {:?}",
                    other.tool, other.args, r, r2
                ));
            }
        }
        if let Some(want) = e.proposal_queued
            && want != (queued == 1)
        {
            f.push(format!(
                "proposal_queued={want}, but {queued} proposal(s) were queued"
            ));
        }
        if let Some(want) = e.protected_links {
            let got = count_protected(&r.json());
            if got != want {
                f.push(format!("{got} protected links, expected {want}"));
            }
        }
        failures.extend(
            f.into_iter()
                .map(|x| format!("step {} ({}): {x}", n + 1, step.call.tool)),
        );
    }
    Ok(ScenarioResult {
        name: scenario.name.clone(),
        file: scenario
            .file
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        steps: scenario.steps.len(),
        failures,
    })
}

pub fn run_all(
    gateway: &mut dyn GatewayUnderTest,
    dataset: &Dataset,
    scenarios: &[Scenario],
    with_matrix: bool,
) -> anyhow::Result<Report> {
    let matrix = if with_matrix {
        run_matrix(gateway, dataset)?
    } else {
        Vec::new()
    };
    let scenarios = scenarios
        .iter()
        .map(|s| run_scenario(gateway, dataset, s))
        .collect::<anyhow::Result<Vec<_>>>()?;
    Ok(Report {
        gateway: gateway.name().to_string(),
        matrix,
        scenarios,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gateway_sim::reference::{LeakyGateway, ReferenceGateway};

    #[test]
    fn the_real_gateway_passes_every_scenario_and_the_whole_matrix() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../testdata/gateway");
        let scenarios = crate::gateway_sim::scenario::load_dir(&dir).unwrap();
        let mut gw = crate::gateway_sim::real::RealGateway::new();
        let report = run_all(&mut gw, &Dataset::reference(), &scenarios, true).unwrap();
        assert!(report.passed(), "{}", report.render());
    }

    #[test]
    fn reference_passes_the_whole_matrix() {
        let d = Dataset::reference();
        let cells = run_matrix(&mut ReferenceGateway::new(), &d).unwrap();
        assert_eq!(cells.len(), TOOLS.len() * LEVELS.len() * 2);
        let bad: Vec<_> = cells.iter().filter(|c| !c.failures.is_empty()).collect();
        assert!(bad.is_empty(), "{bad:#?}");
    }

    #[test]
    fn leaky_fails_only_search_cells() {
        let d = Dataset::reference();
        let cells = run_matrix(&mut LeakyGateway::new(), &d).unwrap();
        for c in &cells {
            assert_eq!(!c.failures.is_empty(), c.tool == "search", "{c:#?}");
        }
    }

    #[test]
    fn helpers_walk_nested_json() {
        let v = json!({"id": "a", "links": [{"id": "b"}, {"protected": true}, {"x": {"protected": true}}]});
        assert_eq!(collect_ids(&v), vec!["a", "b"]);
        assert_eq!(count_protected(&v), 2);
    }
}
