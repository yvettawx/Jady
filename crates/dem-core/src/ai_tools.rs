//! What AI can do, as tools (M6). Transport-free: the MCP server and the API-key provider call the
//! same [`call`], so both get the same rules. Every answer has been through the restricted view:
//! whatever this session may not read looks exactly like what does not exist.

use std::collections::HashMap;

use dem_model::{AiSession, Privacy, SourceInfo, SourceOrigin};
use dem_store::logs::{LogKind, LogRecord};
use serde::Deserialize;
use serde_json::{Map, Value as J, json};

use crate::ai_view::AiView;
use crate::dto::{ItemView, ListQuery, NewItem};
use crate::error::{CoreError, CoreResult};
use crate::learn::ReviewInput;
use crate::proposal::{Change, parse_change};
use crate::session::{Session, parse_id, privacy_of};

/// The one error text for an item that is missing or not visible.
pub const NOT_FOUND: &str = "item not found or not accessible";
/// What stands in for a title AI may not see.
pub const PROTECTED_LABEL: &str = "protected content";

/// One AI session, as the tools see it.
#[derive(Debug, Clone)]
pub struct ToolSession {
    pub id: String,
    pub kind: AiSession,
    /// A learning chat: cards it offers take part in review by default (C1).
    pub learning: bool,
}

/// Something AI offered for the user to place (docs/05-design.md §5.1): nothing is written until
/// the user places it.
#[derive(Debug, Clone, PartialEq)]
pub struct Offered {
    pub type_id: String,
    pub title: String,
    pub markdown: String,
    pub fields: Option<String>,
    pub tags: Vec<String>,
    pub origin: String,
    pub needs_check: bool,
    pub refs: Vec<String>,
}

/// What a call did besides answering, for the interface to show.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Effects {
    pub offered: Vec<Offered>,
    pub proposals: Vec<String>,
    pub annotations: Vec<String>,
    pub reviewed: Vec<String>,
}

/// Tool name, description and input schema: what is offered to the model.
pub fn tool_list() -> Vec<J> {
    let tool = |name: &str, description: &str, props: J, required: &[&str]| {
        json!({
            "name": name,
            "description": description,
            "input_schema": {
                "type": "object",
                "properties": props,
                "required": required,
                "additionalProperties": false,
            },
        })
    };
    vec![
        tool(
            "search",
            "Find items by words. Returns ids, titles, tags and a snippet. Only what you may read is ever returned.",
            json!({ "query": { "type": "string" }, "limit": { "type": "integer" } }),
            &["query"],
        ),
        tool(
            "read_item",
            "Read one item: fields, tags and the text as Markdown. Set summary to true for only the beginning of a long text.",
            json!({ "id": { "type": "string" }, "summary": { "type": "boolean" } }),
            &["id"],
        ),
        tool(
            "related",
            "An item's links and backlinks. Ends you may not read show only as protected content.",
            json!({ "id": { "type": "string" } }),
            &["id"],
        ),
        tool(
            "context",
            "The working agreements, open questions and things to fill in for a domain or project, or the whole library if no id is given.",
            json!({ "id": { "type": "string" } }),
            &[],
        ),
        tool(
            "learning_state",
            "Cards due for review, how well things are remembered, recurring error patterns and learning projects.",
            json!({}),
            &[],
        ),
        tool(
            "propose_changes",
            "Ask to change an existing item. Nothing changes until the user confirms. field is one of title, body (Markdown, replaces the text), append_body (Markdown), tags (array), container (a domain or project id, or null), state (archived, active or trashed) or fields.<key>.",
            json!({
                "item_id": { "type": "string" },
                "changes": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": { "field": { "type": "string" }, "new_value": {} },
                        "required": ["field", "new_value"],
                        "additionalProperties": false,
                    },
                },
                "reason": { "type": "string" },
            }),
            &["item_id", "changes"],
        ),
        tool(
            "create_items",
            "Offer new items (a study sheet, a chapter, cards). They are shown to the user, who decides whether to keep them. Say where each fact came from: origin is ai_memory if from your own knowledge, ai_search if from the web, and needs_check true when unsure.",
            json!({
                "items": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "type": { "type": "string" },
                            "title": { "type": "string" },
                            "markdown": { "type": "string" },
                            "fields": { "type": "object" },
                            "tags": { "type": "array", "items": { "type": "string" } },
                            "origin": { "type": "string", "enum": ["ai_memory", "ai_search"] },
                            "needs_check": { "type": "boolean" },
                            "refs": { "type": "array", "items": { "type": "string" } },
                        },
                        "required": ["type", "title"],
                        "additionalProperties": false,
                    },
                },
            }),
            &["items"],
        ),
        tool(
            "annotate",
            "Leave a note on a passage of an item, without changing its text. quote is the exact passage.",
            json!({
                "item_id": { "type": "string" },
                "quote": { "type": "string" },
                "note": { "type": "string" },
            }),
            &["item_id", "note"],
        ),
        tool(
            "record_review",
            "Record that the user just used a due card correctly in conversation. rating is good or easy.",
            json!({ "item_id": { "type": "string" }, "rating": { "type": "string" } }),
            &["item_id"],
        ),
    ]
}

fn parse<T: for<'de> Deserialize<'de>>(args: &J) -> Result<T, String> {
    serde_json::from_value(args.clone()).map_err(|e| format!("invalid arguments: {e}"))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SearchArgs {
    #[serde(default)]
    query: String,
    #[serde(default)]
    limit: Option<u32>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct IdArgs {
    id: String,
    #[serde(default)]
    summary: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ContextArgs {
    #[serde(default)]
    id: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ChangeArg {
    field: String,
    new_value: J,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProposeArgs {
    item_id: String,
    changes: Vec<ChangeArg>,
    #[serde(default)]
    reason: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OfferArg {
    #[serde(rename = "type")]
    type_id: String,
    title: String,
    #[serde(default)]
    markdown: String,
    #[serde(default)]
    fields: Option<Map<String, J>>,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    origin: Option<String>,
    #[serde(default)]
    needs_check: bool,
    #[serde(default)]
    refs: Vec<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OfferArgs {
    items: Vec<OfferArg>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AnnotateArgs {
    item_id: String,
    #[serde(default)]
    quote: String,
    note: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReviewArgs {
    item_id: String,
    #[serde(default)]
    rating: Option<String>,
}

fn session_kind_name(kind: AiSession) -> &'static str {
    match kind {
        AiSession::Plain => "normal",
        AiSession::Authorized => "sensitive_authorized",
        AiSession::WebAuthorized => "web_authorized",
    }
}

const SUMMARY_CHARS: usize = 800;

impl AiView<'_> {
    fn find(&mut self, id: &str) -> Result<ItemView, String> {
        self.get(id).map_err(|_| NOT_FOUND.to_owned())
    }

    /// Text as Markdown, with links to what this session may not read reduced to a placeholder.
    fn text_of(&mut self, id: &str) -> CoreResult<String> {
        let parsed = parse_id(id)?;
        let targets = self.session.doc(parsed)?.body_links();
        let mut names: HashMap<String, String> = HashMap::new();
        for t in targets {
            let key = t.to_string();
            let name = match self.get(&key) {
                Ok(v) => v.title.unwrap_or_default(),
                Err(_) => PROTECTED_LABEL.to_owned(),
            };
            names.insert(key, name);
        }
        self.session
            .doc(parsed)?
            .body_markdown(&|t| {
                Some(
                    names
                        .get(t)
                        .cloned()
                        .unwrap_or_else(|| PROTECTED_LABEL.to_owned()),
                )
            })
            .map_err(Into::into)
    }

    fn link_entry(&mut self, direction: &str, id: &str) -> Option<J> {
        let exists = self.session.get_item(id).is_ok();
        if !exists {
            return None;
        }
        Some(match self.get(id) {
            Ok(v) => json!({ "direction": direction, "id": v.id, "title": v.title }),
            Err(_) => {
                json!({ "direction": direction, "protected": true, "label": PROTECTED_LABEL })
            }
        })
    }

    fn lists_under(&mut self, container: Option<&str>) -> CoreResult<Map<String, J>> {
        let mut out = Map::new();
        for (key, ty) in [("open_questions", "question"), ("to_fill_in", "followup")] {
            let rows = self.session.list_items(&ListQuery {
                type_id: Some(ty.into()),
                states: Some(vec!["active".into(), "inbox".into()]),
                container: container.map(str::to_owned),
                tag: None,
                order: None,
                limit: Some(50),
            })?;
            let mut list = Vec::new();
            for r in rows {
                let done = serde_json::from_str::<J>(&r.fields)
                    .ok()
                    .and_then(|f| f.get("status").and_then(J::as_str).map(str::to_owned));
                if matches!(done.as_deref(), Some("settled" | "done")) {
                    continue;
                }
                if let Ok(v) = self.get(&r.id) {
                    list.push(json!({ "id": v.id, "title": v.title }));
                }
            }
            out.insert(key.to_owned(), J::Array(list));
        }
        Ok(out)
    }

    /// The agreements that apply, general first (M6), with what AI may use of them.
    pub fn agreements(&mut self, container: Option<&str>) -> CoreResult<Vec<J>> {
        let mut chain: Vec<Option<String>> = vec![None];
        let mut at = container.map(str::to_owned);
        let mut path = Vec::new();
        while let Some(c) = at {
            at = self.session.get_item(&c).ok().and_then(|i| i.container);
            path.push(Some(c));
            if path.len() > 16 {
                break;
            }
        }
        path.reverse();
        chain.extend(path);
        let all = self.session.list_items(&ListQuery {
            type_id: Some("agreement".into()),
            states: Some(vec!["active".into()]),
            container: None,
            tag: None,
            order: Some("created".into()),
            limit: None,
        })?;
        let mut out = Vec::new();
        for level in chain {
            for a in all.iter().filter(|a| a.container == level) {
                if self.get(&a.id).is_ok() {
                    let text = self.text_of(&a.id)?;
                    out.push(json!({ "id": a.id, "scope": level, "text": text }));
                }
            }
        }
        Ok(out)
    }
}

impl Session {
    fn log_ai_access(
        &mut self,
        session: &ToolSession,
        tool: &str,
        items: &[(String, String)],
        result: &str,
    ) -> CoreResult<()> {
        let mut fields = Map::new();
        fields.insert("session".into(), json!(session.id));
        fields.insert(
            "session_kind".into(),
            json!(session_kind_name(session.kind)),
        );
        fields.insert("tool".into(), json!(tool));
        fields.insert(
            "items".into(),
            json!(
                items
                    .iter()
                    .map(|(id, level)| json!({ "id": id, "level": level }))
                    .collect::<Vec<_>>()
            ),
        );
        fields.insert("result".into(), json!(result));
        self.lib.append_log(
            LogKind::AiAccess,
            &LogRecord::new(LogKind::AiAccess, fields),
        )?;
        Ok(())
    }

    /// Runs one tool call. `Err` is what the AI is told went wrong.
    pub fn ai_call(
        &mut self,
        session: &ToolSession,
        tool: &str,
        args: &J,
        effects: &mut Effects,
    ) -> Result<String, String> {
        let mut touched: Vec<(String, String)> = Vec::new();
        let outcome = self.ai_dispatch(session, tool, args, effects, &mut touched);
        let result = match &outcome {
            Ok(_) => "returned",
            Err(e) if e == NOT_FOUND => "not_found",
            Err(_) => "denied",
        };
        // The log holds ids and levels only, never words or text (format spec §12.2).
        if let Err(e) = self.log_ai_access(session, tool, &touched, result) {
            tracing::warn!(code = %e.code, "could not write the AI access log");
        }
        outcome
    }

    fn ai_dispatch(
        &mut self,
        session: &ToolSession,
        tool: &str,
        args: &J,
        effects: &mut Effects,
        touched: &mut Vec<(String, String)>,
    ) -> Result<String, String> {
        let internal = |e: CoreError| {
            tracing::warn!(code = %e.code, "an AI tool failed");
            "something went wrong on our side".to_owned()
        };
        let mut view = self.ai_view(session.kind);
        match tool {
            "search" => {
                let a: SearchArgs = parse(args)?;
                let limit = a.limit.unwrap_or(10).clamp(1, 50);
                let hits = view.search(&a.query, limit).map_err(internal)?;
                let results: Vec<J> = hits
                    .iter()
                    .map(|h| {
                        touched.push((h.item.id.clone(), h.item.privacy.clone()));
                        json!({
                            "id": h.item.id,
                            "type": h.item.type_id,
                            "title": h.item.title,
                            "tags": h.item.tags,
                            "snippet": h.snippet.replace(['⁅', '⁆'], "").replace('\u{fffc}', "…"),
                        })
                    })
                    .collect();
                Ok(json!({ "results": results }).to_string())
            }
            "read_item" => {
                let a: IdArgs = parse(args)?;
                let it = view.find(&a.id)?;
                touched.push((it.id.clone(), it.privacy.clone()));
                let mut body = view.text_of(&it.id).map_err(internal)?;
                if a.summary && body.chars().count() > SUMMARY_CHARS {
                    body = body.chars().take(SUMMARY_CHARS).collect();
                }
                let fields: J = serde_json::from_str(&it.fields).unwrap_or(J::Null);
                Ok(json!({
                    "id": it.id,
                    "type": it.type_id,
                    "title": it.title,
                    "tags": it.tags,
                    "container": it.container.as_ref().filter(|c| view.get(c).is_ok()),
                    "fields": fields,
                    "body": body,
                    "occurred": it.occurred,
                    "sensitive": it.privacy == "sensitive",
                })
                .to_string())
            }
            "related" => {
                let a: IdArgs = parse(args)?;
                let it = view.find(&a.id)?;
                touched.push((it.id.clone(), it.privacy.clone()));
                let parsed = parse_id(&it.id).map_err(internal)?;
                let out = view.session.doc(parsed).map_err(internal)?.body_links();
                let mut links: Vec<J> = out
                    .iter()
                    .filter_map(|l| view.link_entry("out", &l.to_string()))
                    .collect();
                let incoming = view.session.backlinks_any(&it.id).map_err(internal)?;
                links.extend(incoming.iter().filter_map(|s| view.link_entry("in", s)));
                Ok(json!({ "id": it.id, "links": links }).to_string())
            }
            "context" => {
                let a: ContextArgs = parse(args)?;
                let container = match &a.id {
                    Some(id) => Some(view.find(id)?.id),
                    None => None,
                };
                let agreements = view.agreements(container.as_deref()).map_err(internal)?;
                let lists = view.lists_under(container.as_deref()).map_err(internal)?;
                let mut out = lists;
                out.insert("agreements".into(), J::Array(agreements));
                Ok(J::Object(out).to_string())
            }
            "learning_state" => self.learning_state(session.kind).map_err(internal),
            "propose_changes" => {
                let a: ProposeArgs = parse(args)?;
                let target = view.find(&a.item_id)?;
                touched.push((target.id.clone(), target.privacy.clone()));
                if a.changes.is_empty() {
                    return Err("no changes given".to_owned());
                }
                let mut changes = Vec::new();
                for c in &a.changes {
                    let change = parse_change(&c.field, &c.new_value)?;
                    if target.type_id == "agreement"
                        && !matches!(change, Change::Body { .. } | Change::AppendBody { .. })
                    {
                        return Err(format!("field '{}' cannot be changed", c.field));
                    }
                    if let Change::Container { to: Some(c) } = &change {
                        view.find(c)?;
                    }
                    changes.push(change);
                }
                let made = self
                    .add_proposal(&target, changes, a.reason, Some(session.id.clone()))
                    .map_err(internal)?;
                effects.proposals.push(made.id.clone());
                Ok(json!({
                    "proposal_id": made.id,
                    "status": made.state,
                    "note": "Queued for the user's review. Nothing has been changed yet.",
                })
                .to_string())
            }
            "create_items" => {
                let a: OfferArgs = parse(args)?;
                if a.items.is_empty() {
                    return Err("no items given".to_owned());
                }
                let types = view.session.types();
                for i in a.items {
                    if !types.iter().any(|t| t.id == i.type_id)
                        || dem_model::is_system_type(&i.type_id)
                        || matches!(i.type_id.as_str(), "domain" | "project" | "file")
                    {
                        return Err(format!("cannot make items of type '{}'", i.type_id));
                    }
                    let mut fields = i.fields.unwrap_or_default();
                    if session.learning && i.type_id == "card" {
                        fields.entry("review").or_insert(J::Bool(true));
                    }
                    effects.offered.push(Offered {
                        type_id: i.type_id,
                        title: i.title,
                        markdown: i.markdown,
                        fields: (!fields.is_empty()).then(|| J::Object(fields).to_string()),
                        tags: i.tags,
                        origin: match i.origin.as_deref() {
                            Some("ai_search") => "aiSearch".to_owned(),
                            _ => "aiMemory".to_owned(),
                        },
                        needs_check: i.needs_check,
                        refs: i.refs,
                    });
                }
                Ok(json!({
                    "status": "offered",
                    "note": "Shown to the user, who decides whether to keep them.",
                })
                .to_string())
            }
            "annotate" => {
                let a: AnnotateArgs = parse(args)?;
                let target = view.find(&a.item_id)?;
                touched.push((target.id.clone(), target.privacy.clone()));
                let made = self
                    .create_item(NewItem {
                        type_id: "annotation".into(),
                        title: Some(a.note.chars().take(60).collect()),
                        state: None,
                        container: None,
                        privacy: Some(target.privacy.clone()),
                        fields: Some(
                            json!({ "target": target.id, "quote": a.quote, "note": a.note, "by": "ai" })
                                .to_string(),
                        ),
                        tags: None,
                        due: None,
                        markdown: None,
                    })
                    .map_err(internal)?;
                effects.annotations.push(made.id.clone());
                Ok(json!({ "annotation_id": made.id, "status": "added" }).to_string())
            }
            "record_review" => {
                let a: ReviewArgs = parse(args)?;
                let target = view.find(&a.item_id)?;
                touched.push((target.id.clone(), target.privacy.clone()));
                if target.type_id != "card" {
                    return Err(NOT_FOUND.to_owned());
                }
                let rating = match a.rating.as_deref() {
                    Some("easy") => "easy",
                    _ => "good",
                };
                self.record_review(&ReviewInput {
                    item: target.id.clone(),
                    rating: rating.to_owned(),
                    confidence: None,
                    peeked: false,
                    duration_ms: 0,
                    context: "chat".to_owned(),
                })
                .map_err(internal)?;
                effects.reviewed.push(target.id.clone());
                Ok(json!({ "status": "recorded" }).to_string())
            }
            other => Err(format!("unknown tool '{other}'")),
        }
    }

    fn learning_state(&mut self, kind: AiSession) -> CoreResult<String> {
        let readable = |p: &str, web: bool| -> bool {
            privacy_of(p).is_ok_and(|l: Privacy| l.ai_may_read_in(web, kind))
        };
        let due: Vec<J> = self
            .review_queue(50)?
            .into_iter()
            .filter_map(|c| {
                let item = self.get_item(&c.id).ok()?;
                readable(&item.privacy, item.ai_web)
                    .then(|| json!({ "id": c.id, "front": c.front, "back": c.back }))
            })
            .collect();
        let mastery: Vec<J> = self
            .mastery_overview()?
            .into_iter()
            .filter(|g| g.kind == "tag")
            .map(|g| json!({ "tag": g.key, "cards": g.cards, "mastery": g.mastery, "stage": g.stage }))
            .collect();
        let list = |s: &mut Session, ty: &str| -> CoreResult<Vec<J>> {
            let rows = s.list_items(&ListQuery {
                type_id: Some(ty.into()),
                states: Some(vec!["active".into()]),
                container: None,
                tag: None,
                order: Some("updated".into()),
                limit: Some(30),
            })?;
            let mut out = Vec::new();
            for r in rows {
                let item = s.get_item(&r.id)?;
                if readable(&item.privacy, item.ai_web) {
                    let fields: J = serde_json::from_str(&item.fields).unwrap_or(J::Null);
                    out.push(json!({ "id": item.id, "title": item.title, "fields": fields }));
                }
            }
            Ok(out)
        };
        let patterns = list(self, "error_pattern")?;
        let projects = list(self, "learning_project")?;
        Ok(json!({
            "due": due,
            "mastery": mastery,
            "error_patterns": patterns,
            "learning_projects": projects,
        })
        .to_string())
    }

    /// Keeps something AI offered, once the user chose to. Marked with where it came from (A8), and
    /// as private as the session that made it.
    pub fn place_offered(
        &mut self,
        offered: &Offered,
        kind: AiSession,
        container: Option<String>,
    ) -> CoreResult<ItemView> {
        let privacy = match kind {
            AiSession::Plain => None,
            _ => Some("sensitive".to_owned()),
        };
        let view = self.create_item_as(
            NewItem {
                type_id: offered.type_id.clone(),
                title: Some(offered.title.clone()),
                state: None,
                container,
                privacy,
                fields: offered.fields.clone(),
                tags: Some(offered.tags.clone()),
                due: None,
                markdown: (!offered.markdown.is_empty()).then(|| offered.markdown.clone()),
            },
            dem_model::ChangeOrigin::Ai,
            None,
        )?;
        let id = parse_id(&view.id)?;
        let source = SourceInfo {
            origin: if offered.origin == "aiSearch" {
                SourceOrigin::AiSearch
            } else {
                SourceOrigin::AiMemory
            },
            needs_check: offered.needs_check,
            refs: offered.refs.clone(),
            ..Default::default()
        };
        let doc = self.doc(id)?;
        doc.set_source(&source)?;
        doc.commit(dem_model::ChangeOrigin::Ai, None);
        self.persist(id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::tests::{new_note, open_core};

    const SECRET: &str = "ZZSECRETWORDZZ";

    fn session(kind: AiSession) -> ToolSession {
        ToolSession {
            id: "t".into(),
            kind,
            learning: false,
        }
    }

    fn call(s: &mut Session, t: &ToolSession, tool: &str, args: J) -> Result<String, String> {
        s.ai_call(t, tool, &args, &mut Effects::default())
    }

    /// Items at every level, each holding a word only it has, linked from a normal one.
    fn seeded(s: &mut Session) -> HashMap<&'static str, String> {
        let mut ids = HashMap::new();
        let levels = [
            ("sensitive", "敏感甲"),
            ("private", "私密乙"),
            ("confidential", "机密丙"),
        ];
        // Made ordinary first, so the links exist, then raised: 机密 titles are not in the index.
        for (level, name) in levels {
            let v = s
                .create_item(NewItem {
                    tags: Some(vec![format!("tag{SECRET}")]),
                    markdown: Some(format!("{SECRET}{level} 共同\n")),
                    ..new_note(name)
                })
                .unwrap();
            ids.insert(level, v.id);
        }
        let hub = s
            .create_item(NewItem {
                markdown: Some("普通 共同 [[敏感甲]] [[私密乙]] [[机密丙]]\n".into()),
                ..new_note("中心")
            })
            .unwrap();
        for (level, _) in levels {
            s.update_item(
                &ids[level],
                crate::dto::ItemPatch {
                    privacy: Some(level.into()),
                    ..Default::default()
                },
            )
            .unwrap();
        }
        ids.insert("normal", hub.id);
        ids
    }

    #[test]
    fn nothing_of_a_higher_level_reaches_any_tool() {
        let d = tempfile::tempdir().unwrap();
        let c = open_core(d.path());
        c.with(|s| {
            let ids = seeded(s);
            for kind in [AiSession::Plain, AiSession::Authorized, AiSession::WebAuthorized] {
                let t = session(kind);
                let mut calls: Vec<(&str, J)> = vec![
                    ("search", json!({ "query": "共同" })),
                    ("search", json!({ "query": SECRET })),
                    ("search", json!({ "query": "私密乙" })),
                    ("context", json!({})),
                    ("learning_state", json!({})),
                    ("read_item", json!({ "id": ids["normal"] })),
                    ("related", json!({ "id": ids["normal"] })),
                ];
                for level in ["private", "confidential"] {
                    calls.push(("read_item", json!({ "id": ids[level] })));
                    calls.push(("related", json!({ "id": ids[level] })));
                    calls.push(("annotate", json!({ "item_id": ids[level], "note": "x" })));
                    calls.push(("record_review", json!({ "item_id": ids[level] })));
                    calls.push((
                        "propose_changes",
                        json!({ "item_id": ids[level], "changes": [{ "field": "title", "new_value": "t" }] }),
                    ));
                }
                for (tool, args) in calls {
                    let out = match call(s, &t, tool, args.clone()) {
                        Ok(o) | Err(o) => o,
                    };
                    for bad in ["private", "confidential"] {
                        assert!(
                            !out.contains(&format!("{SECRET}{bad}")),
                            "{tool} {args} leaked {bad}: {out}"
                        );
                    }
                    for name in ["私密乙", "机密丙"] {
                        assert!(!out.contains(name), "{tool} leaked {name}: {out}");
                    }
                    assert!(
                        !out.contains(&ids["private"]) && !out.contains(&ids["confidential"]) || tool != "related",
                        "{tool}: {out}"
                    );
                    if kind == AiSession::Plain {
                        assert!(!out.contains("敏感甲") && !out.contains(&format!("tag{SECRET}")), "{tool} {out}");
                    }
                }
            }
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn hidden_and_missing_answer_the_same() {
        let d = tempfile::tempdir().unwrap();
        let c = open_core(d.path());
        c.with(|s| {
            let ids = seeded(s);
            let t = session(AiSession::Plain);
            let missing = "01890000-0000-7000-8000-000000000000";
            for tool in ["read_item", "related"] {
                let want = call(s, &t, tool, json!({ "id": missing })).unwrap_err();
                assert_eq!(want, NOT_FOUND);
                for level in ["sensitive", "private", "confidential"] {
                    let got = call(s, &t, tool, json!({ "id": ids[level] })).unwrap_err();
                    assert_eq!(got, want);
                }
                assert_eq!(
                    call(s, &t, tool, json!({ "id": "nonsense" })).unwrap_err(),
                    want
                );
            }
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn sensitive_shows_only_where_it_may() {
        let d = tempfile::tempdir().unwrap();
        let c = open_core(d.path());
        c.with(|s| {
            let ids = seeded(s);
            let read = json!({ "id": ids["sensitive"] });
            assert!(call(s, &session(AiSession::Plain), "read_item", read.clone()).is_err());
            assert!(
                call(
                    s,
                    &session(AiSession::WebAuthorized),
                    "read_item",
                    read.clone()
                )
                .is_err()
            );
            assert!(
                call(
                    s,
                    &session(AiSession::Authorized),
                    "read_item",
                    read.clone()
                )
                .is_ok()
            );
            s.update_item(
                &ids["sensitive"],
                crate::dto::ItemPatch {
                    ai_web: Some(true),
                    ..Default::default()
                },
            )?;
            assert!(
                call(
                    s,
                    &session(AiSession::WebAuthorized),
                    "read_item",
                    read.clone()
                )
                .is_ok()
            );
            assert!(call(s, &session(AiSession::Plain), "read_item", read).is_err());
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn links_to_what_cannot_be_read_show_a_placeholder_only() {
        let d = tempfile::tempdir().unwrap();
        let c = open_core(d.path());
        c.with(|s| {
            let ids = seeded(s);
            let t = session(AiSession::Plain);
            let read = call(s, &t, "read_item", json!({ "id": ids["normal"] })).unwrap();
            assert!(read.contains(PROTECTED_LABEL), "{read}");
            let rel = call(s, &t, "related", json!({ "id": ids["normal"] })).unwrap();
            let v: J = serde_json::from_str(&rel).unwrap();
            assert_eq!(v["links"].as_array().unwrap().len(), 3);
            assert!(
                v["links"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(|l| l["protected"] == true)
            );
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn the_apps_own_records_never_reach_ai_as_items() {
        let d = tempfile::tempdir().unwrap();
        let c = open_core(d.path());
        c.with(|s| {
            let n = s.create_item(new_note("一"))?;
            let t = session(AiSession::Plain);
            let mut fx = Effects::default();
            s.ai_call(
                &t,
                "propose_changes",
                &json!({ "item_id": n.id, "changes": [{ "field": "title", "new_value": "zzz" }] }),
                &mut fx,
            )
            .unwrap();
            let pid = fx.proposals[0].clone();
            assert_eq!(
                call(s, &t, "read_item", json!({ "id": pid })).unwrap_err(),
                NOT_FOUND
            );
            let session_item = s.create_item(NewItem {
                type_id: "ai_session".into(),
                ..new_note("别的对话")
            })?;
            assert_eq!(
                call(s, &t, "read_item", json!({ "id": session_item.id })).unwrap_err(),
                NOT_FOUND
            );
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn proposals_cannot_touch_the_level_and_tools_cannot_change_anything() {
        let d = tempfile::tempdir().unwrap();
        let c = open_core(d.path());
        c.with(|s| {
            let n = s.create_item(new_note("一"))?;
            let t = session(AiSession::Plain);
            for field in ["privacy", "ai_web"] {
                let e = call(
                    s,
                    &t,
                    "propose_changes",
                    json!({ "item_id": n.id, "changes": [{ "field": field, "new_value": "normal" }] }),
                )
                .unwrap_err();
                assert!(e.contains("cannot be changed"), "{e}");
            }
            assert!(call(s, &t, "delete_item", json!({ "id": n.id })).is_err());
            assert!(call(s, &t, "local_set", json!({ "key": "ai-rules", "value": "[]" })).is_err());
            call(
                s,
                &t,
                "propose_changes",
                json!({ "item_id": n.id, "changes": [{ "field": "title", "new_value": "改" }] }),
            )
            .unwrap();
            assert_eq!(s.get_item(&n.id)?.title.as_deref(), Some("一"), "only queued");
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn agreements_layer_from_general_to_the_project_and_changes_are_only_text() {
        let d = tempfile::tempdir().unwrap();
        let c = open_core(d.path());
        c.with(|s| {
            let project = s.create_item(NewItem {
                type_id: "project".into(),
                ..new_note("写书")
            })?;
            let general = s.create_item(NewItem {
                type_id: "agreement".into(),
                markdown: Some("全局约定\n".into()),
                ..new_note("全局")
            })?;
            s.create_item(NewItem {
                type_id: "agreement".into(),
                container: Some(project.id.clone()),
                markdown: Some("只批评不代笔\n".into()),
                ..new_note("项目")
            })?;
            let t = session(AiSession::Plain);
            let at_top = call(s, &t, "context", json!({})).unwrap();
            assert!(at_top.contains("全局约定") && !at_top.contains("只批评"));
            let inside = call(s, &t, "context", json!({ "id": project.id })).unwrap();
            let v: J = serde_json::from_str(&inside).unwrap();
            let texts: Vec<&str> = v["agreements"]
                .as_array()
                .unwrap()
                .iter()
                .map(|a| a["text"].as_str().unwrap())
                .collect();
            assert!(texts[0].contains("全局约定") && texts[1].contains("只批评"), "{texts:?}");
            assert!(
                call(s, &t, "propose_changes", json!({ "item_id": general.id, "changes": [{ "field": "tags", "new_value": ["x"] }] })).is_err()
            );
            assert!(
                call(s, &t, "propose_changes", json!({ "item_id": general.id, "changes": [{ "field": "append_body", "new_value": "加一条" }] })).is_ok()
            );
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn offered_items_wait_and_keep_their_source_and_level() {
        let d = tempfile::tempdir().unwrap();
        let c = open_core(d.path());
        c.with(|s| {
            let mut t = session(AiSession::Authorized);
            t.learning = true;
            let mut fx = Effects::default();
            s.ai_call(
                &t,
                "create_items",
                &json!({ "items": [{ "type": "card", "title": "le quai", "fields": { "front": "le quai", "back": "站台" }, "origin": "ai_search", "needs_check": true }] }),
                &mut fx,
            )
            .unwrap();
            assert!(s.review_queue(10)?.is_empty(), "nothing written yet");
            assert!(
                s.ai_call(&t, "create_items", &json!({ "items": [{ "type": "proposal", "title": "x" }] }), &mut Effects::default()).is_err()
            );
            let placed = s.place_offered(&fx.offered[0], t.kind, None)?;
            assert_eq!(placed.privacy, "sensitive", "as private as its session");
            let src = s.get_item(&placed.id)?.source.unwrap();
            assert_eq!(src.origin, "aiSearch");
            assert!(src.needs_check);
            assert_eq!(s.review_queue(10)?.len(), 1, "learning cards take part");
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn the_access_log_holds_ids_and_levels_and_no_words() {
        let d = tempfile::tempdir().unwrap();
        let c = open_core(d.path());
        c.with(|s| {
            let ids = seeded(s);
            let t = session(AiSession::Plain);
            call(s, &t, "search", json!({ "query": "查询词ZZ" })).unwrap();
            call(s, &t, "read_item", json!({ "id": ids["normal"] })).unwrap();
            call(s, &t, "read_item", json!({ "id": ids["private"] })).unwrap_err();
            let logs = s.lib.read_logs(LogKind::AiAccess)?;
            let text = format!(
                "{:?}",
                logs.records.iter().map(|r| &r.fields).collect::<Vec<_>>()
            );
            assert_eq!(logs.records.len(), 3);
            assert!(!text.contains("查询词ZZ") && !text.contains("中心") && !text.contains(SECRET));
            assert!(text.contains("not_found") && text.contains("normal"));
            assert!(
                !text.contains(&ids["private"]),
                "a refused id reveals nothing either"
            );
            Ok(())
        })
        .unwrap();
    }
}
