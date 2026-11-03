//! Scenario files: a session, a list of tool calls and what each call must return.
//!
//! ```json
//! {
//!   "name": "hidden items look missing",
//!   "authorized": false,
//!   "steps": [
//!     { "call": {"tool": "read_item", "args": {"id": "p-001"}},
//!       "expect": {"ok": false, "same_as": {"tool": "read_item", "args": {"id": "x-404"}}} }
//!   ]
//! }
//! ```
//!
//! Strings in `args`, `contains` and `not_contains` may use the placeholders
//! `{canary.private}`, `{canary.confidential}` and `{canary.sensitive}`. The global
//! leak checks (canaries, hidden ids, data unchanged) apply to every step anyway;
//! `expect` adds step-specific assertions. Unknown keys are rejected so a typo
//! cannot silently disable a check.

use std::path::{Path, PathBuf};

use anyhow::Context;
use serde::Deserialize;
use serde_json::Value;

use super::dataset::Canaries;

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Scenario {
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// Whether the session is authorized to read sensitive items.
    #[serde(default)]
    pub authorized: bool,
    pub steps: Vec<Step>,
    /// File the scenario was loaded from (not part of the file format).
    #[serde(skip)]
    pub file: PathBuf,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Step {
    pub call: Call,
    #[serde(default)]
    pub expect: Expect,
    #[serde(default)]
    pub note: String,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Call {
    pub tool: String,
    #[serde(default = "empty_object")]
    pub args: Value,
}

fn empty_object() -> Value {
    Value::Object(serde_json::Map::new())
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Expect {
    /// `true`: the call must succeed; `false`: it must be an error.
    pub ok: Option<bool>,
    /// Exact set of all `"id"` values anywhere in the response (order ignored).
    pub ids: Option<Vec<String>>,
    /// Substrings the response text must contain.
    #[serde(default)]
    pub contains: Vec<String>,
    /// Substrings the response text must not contain.
    #[serde(default)]
    pub not_contains: Vec<String>,
    /// The response must be identical to the response of this call.
    pub same_as: Option<Call>,
    /// Whether this call must add exactly one proposal to the queue.
    pub proposal_queued: Option<bool>,
    /// Number of links shown as "protected".
    pub protected_links: Option<usize>,
}

/// Replace `{canary.*}` placeholders.
pub fn expand(s: &str, c: &Canaries) -> String {
    s.replace("{canary.private}", &c.private)
        .replace("{canary.confidential}", &c.confidential)
        .replace("{canary.sensitive}", &c.sensitive)
}

/// [`expand`] applied to every string inside a JSON value.
pub fn expand_value(v: &Value, c: &Canaries) -> Value {
    match v {
        Value::String(s) => Value::String(expand(s, c)),
        Value::Array(a) => Value::Array(a.iter().map(|x| expand_value(x, c)).collect()),
        Value::Object(o) => Value::Object(
            o.iter()
                .map(|(k, x)| (k.clone(), expand_value(x, c)))
                .collect(),
        ),
        other => other.clone(),
    }
}

pub fn parse(text: &str, file: &Path) -> anyhow::Result<Scenario> {
    let mut s: Scenario =
        serde_json::from_str(text).with_context(|| format!("parse {}", file.display()))?;
    s.file = file.to_path_buf();
    Ok(s)
}

/// Load every `*.json` file in `dir`, sorted by file name.
pub fn load_dir(dir: &Path) -> anyhow::Result<Vec<Scenario>> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir)
        .with_context(|| format!("read scenario dir {}", dir.display()))?
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .collect();
    files.sort();
    files
        .iter()
        .map(|f| {
            let text =
                std::fs::read_to_string(f).with_context(|| format!("read {}", f.display()))?;
            parse(&text, f)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn unknown_keys_are_rejected() {
        let bad = r#"{"name":"x","steps":[{"call":{"tool":"search"},"expect":{"okk":true}}]}"#;
        assert!(parse(bad, Path::new("bad.json")).is_err());
    }

    #[test]
    fn args_default_to_empty_object_and_placeholders_expand() {
        let s = parse(
            r#"{"name":"x","steps":[{"call":{"tool":"search"}}]}"#,
            Path::new("x.json"),
        )
        .unwrap();
        assert_eq!(s.steps[0].call.args, json!({}));
        let c = Canaries::generate();
        let v = expand_value(&json!({"q": ["{canary.private}", 1]}), &c);
        assert_eq!(v, json!({"q": [c.private, 1]}));
    }
}
