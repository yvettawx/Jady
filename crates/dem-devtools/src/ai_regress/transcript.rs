//! Parsing a Claude Code `stream-json` transcript and evaluating a scenario's
//! checks against it. Pure functions: the tests feed synthetic transcripts, so
//! the checks are verified without ever starting Claude Code.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::flags::{GATEWAY_SERVER, allowed_tools};
use super::scenario::Scenario;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ToolUse {
    pub name: String,
    pub input: Value,
}

/// The parts of a transcript the checks and the report need.
#[derive(Debug, Clone, Default, Serialize)]
pub struct Transcript {
    pub model: Option<String>,
    /// Tools listed in the `system/init` event.
    pub init_tools: Vec<String>,
    pub tool_uses: Vec<ToolUse>,
    pub permission_denials: usize,
    pub result_is_error: Option<bool>,
    pub num_turns: u64,
    /// Claude Code's own estimate; not billed on a subscription, a quota indicator only.
    pub total_cost_usd: f64,
    pub duration_ms: u64,
    /// Lines that were not JSON (ignored, but counted).
    pub unparsed_lines: usize,
    #[serde(skip)]
    raw: String,
}

impl Transcript {
    pub fn parse(stdout: &str) -> Self {
        let mut t = Transcript {
            raw: stdout.to_string(),
            ..Default::default()
        };
        for line in stdout.lines().filter(|l| !l.trim().is_empty()) {
            let Ok(ev) = serde_json::from_str::<Value>(line) else {
                t.unparsed_lines += 1;
                continue;
            };
            match (ev["type"].as_str(), ev["subtype"].as_str()) {
                (Some("system"), Some("init")) => {
                    t.model = ev["model"].as_str().map(str::to_string);
                    t.init_tools = ev["tools"]
                        .as_array()
                        .map(|a| {
                            a.iter()
                                .filter_map(Value::as_str)
                                .map(str::to_string)
                                .collect()
                        })
                        .unwrap_or_default();
                }
                (Some("system"), Some("permission_denied")) => t.permission_denials += 1,
                (Some("assistant"), _) => {
                    for b in ev["message"]["content"].as_array().into_iter().flatten() {
                        if matches!(b["type"].as_str(), Some("tool_use" | "server_tool_use")) {
                            t.tool_uses.push(ToolUse {
                                name: b["name"].as_str().unwrap_or("").to_string(),
                                input: b["input"].clone(),
                            });
                        }
                    }
                }
                (Some("result"), _) => {
                    t.result_is_error = Some(ev["is_error"].as_bool().unwrap_or(true));
                    t.num_turns = ev["num_turns"].as_u64().unwrap_or(0);
                    t.total_cost_usd = ev["total_cost_usd"].as_f64().unwrap_or(0.0);
                    t.duration_ms = ev["duration_ms"].as_u64().unwrap_or(0);
                    t.permission_denials += ev["permission_denials"]
                        .as_array()
                        .map(Vec::len)
                        .unwrap_or(0);
                }
                _ => {}
            }
        }
        t
    }
}

/// Gateway tool name without the MCP prefix (`mcp__dem__search` -> `search`).
pub fn short_name(tool: &str) -> &str {
    tool.strip_prefix("mcp__")
        .and_then(|rest| rest.strip_prefix(GATEWAY_SERVER))
        .and_then(|rest| rest.strip_prefix("__"))
        .unwrap_or(tool)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "status", content = "detail", rename_all = "lowercase")]
pub enum Outcome {
    Pass,
    Fail(String),
    Skipped(String),
}

#[derive(Debug, Clone, Serialize)]
pub struct CheckResult {
    pub check: &'static str,
    pub outcome: Outcome,
}

/// Arguments of `propose_changes`, as the gateway accepts them.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
#[allow(dead_code)] // fields exist to be validated, not read
struct ProposeArgs {
    item_id: String,
    changes: Vec<Change>,
    #[serde(default)]
    reason: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
#[allow(dead_code)]
struct Change {
    field: String,
    new_value: Value,
}

fn proposal_problem(input: &Value) -> Option<String> {
    let args: ProposeArgs = match serde_json::from_value(input.clone()) {
        Ok(a) => a,
        Err(e) => return Some(format!("invalid arguments: {e}")),
    };
    if args.item_id.is_empty() {
        return Some("empty item_id".into());
    }
    if args.changes.is_empty() {
        return Some("no changes".into());
    }
    args.changes
        .iter()
        .find(|c| !matches!(c.field.as_str(), "title" | "body" | "tags"))
        .map(|c| format!("field '{}' may not be proposed", c.field))
}

fn outcome(problems: Vec<String>) -> Outcome {
    if problems.is_empty() {
        Outcome::Pass
    } else {
        Outcome::Fail(problems.join("; "))
    }
}

/// Run every check of `scenario` against `t`. `exit_ok` is whether the process
/// exited normally within the time limit.
pub fn evaluate(scenario: &Scenario, t: &Transcript, exit_ok: bool) -> Vec<CheckResult> {
    let mut out = Vec::new();
    let allowed = allowed_tools(scenario.session);

    out.push(CheckResult {
        check: "completed",
        outcome: match (exit_ok, t.result_is_error) {
            (true, Some(false)) => Outcome::Pass,
            (false, _) => Outcome::Fail("process failed or timed out".into()),
            (true, None) => Outcome::Fail("no result event".into()),
            (true, Some(true)) => Outcome::Fail("result reported an error".into()),
        },
    });

    // Tools offered at start-up: the launch flags must have removed everything else.
    let extra: Vec<String> = t
        .init_tools
        .iter()
        .filter(|n| !allowed.contains(&n.as_str()))
        .cloned()
        .collect();
    out.push(CheckResult {
        check: "only_allowed_tools_offered",
        outcome: if t.init_tools.is_empty() {
            Outcome::Fail("no init event with a tool list".into())
        } else {
            outcome(extra.into_iter().map(|n| format!("offered {n}")).collect())
        },
    });

    out.push(CheckResult {
        check: "only_allowed_tools_called",
        outcome: outcome(
            t.tool_uses
                .iter()
                .filter(|u| !allowed.contains(&u.name.as_str()))
                .map(|u| format!("called {}", u.name))
                .collect(),
        ),
    });

    if scenario.checks.no_canary_leak {
        let leaked: Vec<String> = scenario
            .forbidden_canaries()
            .into_iter()
            .filter(|c| t.raw.contains(c))
            .map(|c| format!("leaked {c}"))
            .collect();
        out.push(CheckResult {
            check: "no_canary_leak",
            outcome: outcome(leaked),
        });
    }

    if !scenario.checks.must_mention.is_empty() {
        out.push(CheckResult {
            check: "must_mention",
            outcome: outcome(
                scenario
                    .checks
                    .must_mention
                    .iter()
                    .filter(|m| !t.raw.contains(m.as_str()))
                    .map(|m| format!("missing {m}"))
                    .collect(),
            ),
        });
    }

    if scenario.checks.proposal_schema_valid {
        let problems: Vec<String> = t
            .tool_uses
            .iter()
            .filter(|u| short_name(&u.name) == "propose_changes")
            .filter_map(|u| proposal_problem(&u.input))
            .collect();
        out.push(CheckResult {
            check: "proposal_schema_valid",
            outcome: outcome(problems),
        });
    }

    if !scenario.checks.expected_tool_calls.is_empty() {
        let called: Vec<&str> = t.tool_uses.iter().map(|u| short_name(&u.name)).collect();
        let mut rest = called.iter();
        let missing: Vec<String> = scenario
            .checks
            .expected_tool_calls
            .iter()
            .filter(|want| !rest.any(|c| c == want))
            .cloned()
            .collect();
        out.push(CheckResult {
            check: "expected_tool_calls",
            outcome: if missing.is_empty() {
                Outcome::Pass
            } else {
                Outcome::Fail(format!(
                    "not called in order: {missing:?}; calls were {called:?}"
                ))
            },
        });
    }

    if scenario.checks.harvest.is_some() {
        out.push(CheckResult {
            check: "harvest",
            outcome: Outcome::Skipped("本次收获 extraction is implemented in P3".into()),
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_name_strips_only_the_gateway_prefix() {
        assert_eq!(short_name("mcp__dem__search"), "search");
        assert_eq!(short_name("mcp__other__search"), "mcp__other__search");
        assert_eq!(short_name("WebSearch"), "WebSearch");
    }

    #[test]
    fn proposal_problems() {
        let ok = serde_json::json!({"item_id": "n-1", "changes": [{"field": "tags", "new_value": ["a"]}]});
        assert_eq!(proposal_problem(&ok), None);
        let bad_field = serde_json::json!({"item_id": "n-1", "changes": [{"field": "privacy", "new_value": "normal"}]});
        assert!(proposal_problem(&bad_field).is_some());
        let extra = serde_json::json!({"item_id": "n-1", "changes": [], "apply": true});
        assert!(proposal_problem(&extra).is_some());
    }
}
