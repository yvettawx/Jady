//! Fake gateways: the reference implementation of the privacy rules, and a
//! deliberately leaky one that the simulator must catch.
//!
//! The reference follows the P0-14 spike gateway (`spikes/claude-mcp`): one choke
//! point decides visibility, hidden items are filtered before matching, hidden and
//! missing items produce byte-identical errors, links to hidden items are reduced
//! to a "protected" placeholder, and proposals go to a queue without touching data.

use serde::Deserialize;
use serde_json::{Value, json};

use super::dataset::{Dataset, SimItem};
use super::{GatewayUnderTest, Session, ToolResponse};
use dem_model::Privacy;

/// The one error text for an item that is missing or not visible.
pub const NOT_FOUND: &str = "item not found or not accessible";

/// Label shown instead of a hidden link target.
pub const PROTECTED_LABEL: &str = "protected content";

#[derive(Debug, Clone, PartialEq)]
pub struct Proposal {
    pub id: String,
    pub session: String,
    pub item_id: String,
    pub changes: Vec<(String, Value)>,
    pub reason: Option<String>,
}

#[derive(Debug, Default)]
pub struct ReferenceGateway {
    items: Vec<SimItem>,
    proposals: Vec<Proposal>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SearchArgs {
    #[serde(default)]
    query: String,
    #[serde(default)]
    limit: Option<usize>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct IdArgs {
    id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Change {
    field: String,
    new_value: Value,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProposeArgs {
    item_id: String,
    changes: Vec<Change>,
    #[serde(default)]
    reason: Option<String>,
}

fn parse<T: for<'de> Deserialize<'de>>(args: &Value) -> Result<T, String> {
    serde_json::from_value(args.clone()).map_err(|e| format!("invalid arguments: {e}"))
}

impl ReferenceGateway {
    pub fn new() -> Self {
        Self::default()
    }

    /// The only place that decides what the AI may see.
    fn visible(session: &Session, item: &SimItem) -> bool {
        item.privacy.ai_may_read(session.authorized)
    }

    fn find_visible(&self, session: &Session, id: &str) -> Option<&SimItem> {
        self.items
            .iter()
            .find(|i| i.id == id && Self::visible(session, i))
    }

    /// Search results for `session`; also used by [`LeakyGateway`].
    fn search_hits(&self, session: &Session, args: &SearchArgs) -> Vec<Value> {
        let words: Vec<String> = args
            .query
            .to_lowercase()
            .split_whitespace()
            .map(str::to_string)
            .collect();
        let limit = args.limit.unwrap_or(10).clamp(1, 50);
        self.items
            .iter()
            .filter(|i| Self::visible(session, i)) // before matching: hidden items never influence results
            .filter(|i| {
                let hay = format!("{} {} {}", i.title, i.body, i.tags.join(" ")).to_lowercase();
                words.iter().all(|w| hay.contains(w.as_str()))
            })
            .take(limit)
            .map(search_entry)
            .collect()
    }

    fn search(&self, session: &Session, args: &Value) -> Result<String, String> {
        let args: SearchArgs = parse(args)?;
        Ok(json!({ "results": self.search_hits(session, &args) }).to_string())
    }

    fn read_item(&self, session: &Session, args: &Value) -> Result<String, String> {
        let args: IdArgs = parse(args)?;
        let it = self
            .find_visible(session, &args.id)
            .ok_or_else(|| NOT_FOUND.to_string())?;
        Ok(json!({
            "id": it.id,
            "title": it.title,
            "tags": it.tags,
            "body": it.body,
            "sensitive": it.privacy == Privacy::Sensitive,
        })
        .to_string())
    }

    fn link_entry(&self, session: &Session, direction: &str, id: &str) -> Option<Value> {
        // Links to missing items are dropped; links to hidden items keep only a placeholder.
        let target = self.items.iter().find(|i| i.id == id)?;
        Some(if Self::visible(session, target) {
            json!({"direction": direction, "id": target.id, "title": target.title})
        } else {
            json!({"direction": direction, "protected": true, "label": PROTECTED_LABEL})
        })
    }

    fn related(&self, session: &Session, args: &Value) -> Result<String, String> {
        let args: IdArgs = parse(args)?;
        let it = self
            .find_visible(session, &args.id)
            .ok_or_else(|| NOT_FOUND.to_string())?;
        let mut links: Vec<Value> = it
            .links
            .iter()
            .filter_map(|l| self.link_entry(session, "out", l))
            .collect();
        links.extend(
            self.items
                .iter()
                .filter(|src| src.links.contains(&it.id))
                .filter_map(|src| self.link_entry(session, "in", &src.id)),
        );
        Ok(json!({"id": it.id, "links": links}).to_string())
    }

    fn propose_changes(&mut self, session: &Session, args: &Value) -> Result<String, String> {
        let args: ProposeArgs = parse(args)?;
        let item_id = self
            .find_visible(session, &args.item_id)
            .ok_or_else(|| NOT_FOUND.to_string())?
            .id
            .clone();
        if args.changes.is_empty() {
            return Err("no changes given".into());
        }
        let mut changes = Vec::new();
        for ch in args.changes {
            if !matches!(ch.field.as_str(), "title" | "body" | "tags") {
                return Err(format!("field '{}' cannot be changed", ch.field));
            }
            changes.push((ch.field, ch.new_value));
        }
        let id = format!("prop-{}", self.proposals.len() + 1);
        self.proposals.push(Proposal {
            id: id.clone(),
            session: session.id.clone(),
            item_id,
            changes,
            reason: args.reason,
        });
        Ok(json!({
            "proposal_id": id,
            "status": "pending",
            "note": "Queued for the user's review. Nothing has been changed yet."
        })
        .to_string())
    }

    pub fn proposals(&self) -> &[Proposal] {
        &self.proposals
    }
}

fn search_entry(i: &SimItem) -> Value {
    json!({
        "id": i.id,
        "title": i.title,
        "tags": i.tags,
        "snippet": i.body.chars().take(60).collect::<String>(),
    })
}

fn respond(outcome: Result<String, String>) -> ToolResponse {
    match outcome {
        Ok(t) => ToolResponse::ok(t),
        Err(t) => ToolResponse::error(t),
    }
}

impl GatewayUnderTest for ReferenceGateway {
    fn name(&self) -> &str {
        "reference"
    }

    fn load(&mut self, dataset: &Dataset) -> anyhow::Result<()> {
        self.items = dataset.items.clone();
        self.proposals.clear();
        Ok(())
    }

    fn call(&mut self, session: &Session, tool: &str, args: &Value) -> ToolResponse {
        respond(match tool {
            "search" => self.search(session, args),
            "read_item" => self.read_item(session, args),
            "related" => self.related(session, args),
            "propose_changes" => self.propose_changes(session, args),
            other => Err(format!("unknown tool '{other}'")),
        })
    }

    fn data_snapshot(&self) -> anyhow::Result<String> {
        Ok(serde_json::to_string(&self.items)?)
    }

    fn pending_proposals(&self) -> usize {
        self.proposals.len()
    }
}

/// Negative control: identical to the reference, except that `search` also
/// returns the first private item. The simulator must report it.
#[derive(Debug, Default)]
pub struct LeakyGateway {
    inner: ReferenceGateway,
}

impl LeakyGateway {
    pub fn new() -> Self {
        Self::default()
    }
}

impl GatewayUnderTest for LeakyGateway {
    fn name(&self) -> &str {
        "leaky"
    }

    fn load(&mut self, dataset: &Dataset) -> anyhow::Result<()> {
        self.inner.load(dataset)
    }

    fn call(&mut self, session: &Session, tool: &str, args: &Value) -> ToolResponse {
        if tool != "search" {
            return self.inner.call(session, tool, args);
        }
        respond(parse::<SearchArgs>(args).map(|a| {
            let mut hits = self.inner.search_hits(session, &a);
            if let Some(p) = self
                .inner
                .items
                .iter()
                .find(|i| i.privacy == Privacy::Private)
            {
                hits.push(search_entry(p));
            }
            json!({ "results": hits }).to_string()
        }))
    }

    fn data_snapshot(&self) -> anyhow::Result<String> {
        self.inner.data_snapshot()
    }

    fn pending_proposals(&self) -> usize {
        self.inner.pending_proposals()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gateway_sim::dataset::MISSING_ID;

    fn loaded() -> (ReferenceGateway, Dataset) {
        let d = Dataset::reference();
        let mut g = ReferenceGateway::new();
        g.load(&d).unwrap();
        (g, d)
    }

    #[test]
    fn hidden_read_matches_missing_read() {
        let (mut g, _) = loaded();
        let s = Session::new("t", false);
        let missing = g.call(&s, "read_item", &json!({"id": MISSING_ID}));
        for id in ["s-001", "p-001", "c-001"] {
            assert_eq!(g.call(&s, "read_item", &json!({"id": id})), missing);
        }
        assert!(missing.is_error);
    }

    #[test]
    fn proposal_is_queued_not_applied() {
        let (mut g, _) = loaded();
        let s = Session::new("t", false);
        let before = g.data_snapshot().unwrap();
        let r = g.call(
            &s,
            "propose_changes",
            &json!({"item_id": "n-002", "changes": [{"field": "title", "new_value": "X"}]}),
        );
        assert!(!r.is_error, "{r:?}");
        assert_eq!(g.data_snapshot().unwrap(), before);
        assert_eq!(g.proposals()[0].item_id, "n-002");
    }

    #[test]
    fn invalid_arguments_and_unknown_tools_are_errors() {
        let (mut g, _) = loaded();
        let s = Session::new("t", true);
        assert!(g.call(&s, "read_item", &json!({})).is_error);
        assert!(g.call(&s, "search", &json!({"q": "x"})).is_error);
        assert!(g.call(&s, "delete_item", &json!({"id": "n-001"})).is_error);
    }

    #[test]
    fn leaky_gateway_really_leaks() {
        let d = Dataset::reference();
        let mut g = LeakyGateway::new();
        g.load(&d).unwrap();
        let r = g.call(
            &Session::new("t", false),
            "search",
            &json!({"query": "rust"}),
        );
        assert!(r.text.contains(&d.canaries.private));
    }
}
