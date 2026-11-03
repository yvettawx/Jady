//! 提议 (M6, PRD D9, F4, CLAUDE.md): everything AI wants to change in what exists waits here until
//! the user decides. A proposal is a system item carrying what would change and what was there.
//!
//! There is deliberately no way to name the privacy level, the web mark or any setting: the changes
//! AI can express are listed in [`Change`], and everything else is refused when it is proposed.

use dem_model::{ChangeOrigin, Timestamp};
use serde::{Deserialize, Serialize};
use serde_json::{Value as J, json};

use crate::dto::{ItemView, NewItem};
use crate::error::{CoreError, CoreResult};
use crate::session::{Session, parse_id};

/// One change AI can ask for.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Change {
    Title {
        to: String,
    },
    Body {
        markdown: String,
    },
    AppendBody {
        markdown: String,
    },
    Tags {
        to: Vec<String>,
    },
    Container {
        to: Option<String>,
    },
    /// `archived`, `active` or `trashed`.
    State {
        to: String,
    },
    Field {
        key: String,
        to: J,
    },
}

/// What the item held before, to take the change back.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
struct Undo {
    title: Option<String>,
    tags: Vec<String>,
    container: Option<String>,
    state: String,
    fields: serde_json::Map<String, J>,
    version: String,
    body: String,
    /// The same, right after the change: undoing only applies if nothing has moved since.
    after_title: Option<String>,
    after_tags: Vec<String>,
    after_container: Option<String>,
    after_state: String,
    after_fields: serde_json::Map<String, J>,
    after_body: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct Data {
    target: String,
    changes: Vec<Change>,
    reason: Option<String>,
    session: Option<String>,
    action: String,
    scope_id: String,
    scope_label: String,
    /// `pending`, `confirmed` or `ignored`.
    status: String,
    by_rule: bool,
    /// The item's `updated` when this was written: a later edit makes it stale.
    base_updated: f64,
    before: Vec<String>,
    after: Vec<String>,
    undo: Option<Undo>,
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct ProposalView {
    pub id: String,
    /// `tidy`, `fill-tags`, `add-link`, `merge` or `delete`.
    pub action: String,
    pub scope_id: String,
    pub scope_label: String,
    pub summary: String,
    pub target_id: String,
    pub target_title: String,
    /// The target's level.
    pub privacy: String,
    pub before: Vec<String>,
    pub after: Vec<String>,
    /// `pending`, `confirmed` or `ignored`.
    pub state: String,
    pub by_rule: bool,
    pub stale: bool,
    pub session: Option<String>,
    pub created: f64,
}

impl std::fmt::Debug for ProposalView {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProposalView")
            .field("id", &self.id)
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct Rule {
    action: String,
    scope: String,
}

const RULES_KEY: &str = "ai-rules";

/// 删除 always asks (CLAUDE.md); so does anything 敏感, and changes to the agreements.
fn may_have_rule(action: &str, privacy: &str, type_id: &str) -> bool {
    action != "delete" && privacy == "normal" && type_id != "agreement"
}

fn action_of(changes: &[Change]) -> &'static str {
    if changes
        .iter()
        .any(|c| matches!(c, Change::State { to } if to == "trashed"))
    {
        "delete"
    } else if changes
        .iter()
        .any(|c| matches!(c, Change::AppendBody { markdown } if markdown.contains("[[")))
    {
        "add-link"
    } else if changes.iter().all(|c| matches!(c, Change::Tags { .. })) {
        "fill-tags"
    } else {
        "tidy"
    }
}

fn lines(text: &str) -> Vec<String> {
    text.split('\n').map(str::to_owned).collect()
}

/// Turns the words AI used into changes, refusing whatever is not one of them.
pub fn parse_change(field: &str, value: &J) -> Result<Change, String> {
    let text = |v: &J| v.as_str().map(str::to_owned);
    let refused = || format!("field '{field}' cannot be changed");
    let change = match field {
        "title" => Change::Title {
            to: text(value).ok_or_else(refused)?,
        },
        "body" => Change::Body {
            markdown: text(value).ok_or_else(refused)?,
        },
        "append_body" => Change::AppendBody {
            markdown: text(value).ok_or_else(refused)?,
        },
        "tags" => Change::Tags {
            to: value
                .as_array()
                .map(|a| a.iter().filter_map(J::as_str).map(str::to_owned).collect())
                .or_else(|| text(value).map(|t| vec![t]))
                .ok_or_else(refused)?,
        },
        "container" => Change::Container { to: text(value) },
        "state" => {
            let to = text(value).ok_or_else(refused)?;
            if !matches!(to.as_str(), "archived" | "active" | "trashed") {
                return Err(refused());
            }
            Change::State { to }
        }
        other => {
            let key = other.strip_prefix("fields.").ok_or_else(refused)?;
            if key.is_empty() || !(value.is_string() || value.is_number() || value.is_boolean()) {
                return Err(refused());
            }
            Change::Field {
                key: key.to_owned(),
                to: value.clone(),
            }
        }
    };
    Ok(change)
}

impl Session {
    fn proposal_data(&mut self, id: &str) -> CoreResult<(ItemView, Data)> {
        let item = self.get_item(id)?;
        if item.type_id != "proposal" {
            return Err(CoreError::new("not-found", "proposal"));
        }
        let fields: J = serde_json::from_str(&item.fields).unwrap_or(J::Null);
        let data = fields
            .get("data")
            .and_then(J::as_str)
            .and_then(|d| serde_json::from_str(d).ok())
            .ok_or_else(|| CoreError::new("broken", "proposal"))?;
        Ok((item, data))
    }

    fn store_proposal(&mut self, id: &str, data: &Data) -> CoreResult<()> {
        let pid = parse_id(id)?;
        let text =
            serde_json::to_string(data).map_err(|e| CoreError::new("broken", e.to_string()))?;
        let doc = self.doc(pid)?;
        doc.set_field("data", &J::String(text))?;
        doc.commit(ChangeOrigin::Me, None);
        self.persist(pid)?;
        Ok(())
    }

    fn rules(&self) -> Vec<Rule> {
        self.local_get(RULES_KEY)
            .ok()
            .flatten()
            .and_then(|j| serde_json::from_str(&j).ok())
            .unwrap_or_default()
    }

    /// Stores a proposal for the target. The caller has checked AI may read the target; a rule the
    /// user made may apply it at once, and it is still recorded and can be undone.
    pub(crate) fn add_proposal(
        &mut self,
        target: &ItemView,
        changes: Vec<Change>,
        reason: Option<String>,
        session: Option<String>,
    ) -> CoreResult<ProposalView> {
        let action = action_of(&changes).to_owned();
        let (scope_id, scope_label) = match &target.container {
            Some(c) => {
                let label = self
                    .get_item(c)
                    .ok()
                    .and_then(|i| i.title)
                    .unwrap_or_default();
                (c.clone(), label)
            }
            None => ("all".to_owned(), String::new()),
        };
        let (before, after) = self.preview_changes(target, &changes)?;
        let data = Data {
            target: target.id.clone(),
            changes,
            reason: reason.clone(),
            session,
            action,
            scope_id,
            scope_label,
            status: "pending".into(),
            by_rule: false,
            base_updated: target.updated,
            before,
            after,
            undo: None,
        };
        let text =
            serde_json::to_string(&data).map_err(|e| CoreError::new("broken", e.to_string()))?;
        let made = self.create_item(NewItem {
            type_id: "proposal".into(),
            title: reason.clone().or_else(|| target.title.clone()),
            state: None,
            container: None,
            // A proposal can quote the target, so it is as private as the target.
            privacy: Some(target.privacy.clone()),
            fields: Some(json!({ "data": text }).to_string()),
            tags: None,
            due: None,
            markdown: None,
        })?;
        let covered = may_have_rule(&data.action, &target.privacy, &target.type_id)
            && self
                .rules()
                .iter()
                .any(|r| r.action == data.action && r.scope == data.scope_id);
        if covered {
            self.confirm_proposal(&made.id)?;
            let (item, mut data) = self.proposal_data(&made.id)?;
            data.by_rule = true;
            self.store_proposal(&item.id, &data)?;
        }
        self.proposal_view(&made.id)
    }

    /// The user chose to add something (a press on 插入原文下方): the same record and the same undo,
    /// confirmed by that press.
    pub fn propose_from_user(
        &mut self,
        target: &ItemView,
        changes: Vec<Change>,
        reason: Option<String>,
    ) -> CoreResult<ProposalView> {
        let made = self.add_proposal(target, changes, reason, None)?;
        if made.state == "pending" {
            return self.confirm_proposal(&made.id);
        }
        Ok(made)
    }

    fn preview_changes(
        &mut self,
        target: &ItemView,
        changes: &[Change],
    ) -> CoreResult<(Vec<String>, Vec<String>)> {
        let id = parse_id(&target.id)?;
        let body = self.doc(id)?.body_text();
        let mut before = Vec::new();
        let mut after = Vec::new();
        for c in changes {
            match c {
                Change::Title { to } => {
                    before.push(target.title.clone().unwrap_or_default());
                    after.push(to.clone());
                }
                Change::Body { markdown } => {
                    before.extend(lines(&body));
                    after.extend(lines(markdown.trim_end()));
                }
                Change::AppendBody { markdown } => after.extend(lines(markdown.trim_end())),
                Change::Tags { to } => {
                    before.push(target.tags.join(" "));
                    after.push(to.join(" "));
                }
                Change::Container { to } => {
                    let name = |s: &mut Self, c: &Option<String>| {
                        c.as_ref()
                            .and_then(|c| s.get_item(c).ok())
                            .and_then(|i| i.title)
                            .unwrap_or_default()
                    };
                    before.push(name(self, &target.container));
                    after.push(name(self, to));
                }
                Change::State { to } => {
                    before.push(target.state.clone());
                    after.push(to.clone());
                }
                Change::Field { key, to } => {
                    let fields: J = serde_json::from_str(&target.fields).unwrap_or(J::Null);
                    let show = |v: &J| match v {
                        J::String(s) => s.clone(),
                        J::Null => String::new(),
                        other => other.to_string(),
                    };
                    before.push(format!("{key}: {}", show(&fields[key.as_str()])));
                    after.push(format!("{key}: {}", show(to)));
                }
            }
        }
        Ok((before, after))
    }

    pub fn proposal_view(&mut self, id: &str) -> CoreResult<ProposalView> {
        let (item, data) = self.proposal_data(id)?;
        let target = self.get_item(&data.target).ok();
        let stale = data.status == "pending"
            && target
                .as_ref()
                .is_none_or(|t| t.updated > data.base_updated);
        Ok(ProposalView {
            id: item.id,
            action: data.action,
            scope_id: data.scope_id,
            scope_label: data.scope_label,
            summary: item.title.unwrap_or_default(),
            target_id: data.target,
            target_title: target
                .as_ref()
                .and_then(|t| t.title.clone())
                .unwrap_or_default(),
            privacy: item.privacy,
            before: data.before,
            after: data.after,
            state: data.status,
            by_rule: data.by_rule,
            stale,
            session: data.session,
            created: item.created,
        })
    }

    /// Newest first. What is decided stays listed so it can be undone.
    pub fn proposal_list(&mut self) -> CoreResult<Vec<ProposalView>> {
        let rows = self.list_items(&crate::dto::ListQuery {
            type_id: Some("proposal".into()),
            states: Some(vec!["active".into()]),
            container: None,
            tag: None,
            order: Some("created".into()),
            limit: Some(500),
        })?;
        let mut out = Vec::new();
        for r in rows {
            if let Ok(v) = self.proposal_view(&r.id) {
                out.push(v);
            }
        }
        out.sort_by(|a, b| b.created.total_cmp(&a.created));
        Ok(out)
    }

    /// Applies a proposal as one commit marked with its id (format spec §6.3).
    pub fn confirm_proposal(&mut self, id: &str) -> CoreResult<ProposalView> {
        let (item, mut data) = self.proposal_data(id)?;
        if data.status != "pending" {
            return self.proposal_view(id);
        }
        let current = self.get_item(&data.target)?;
        if current.updated > data.base_updated {
            return Err(CoreError::new(
                "stale",
                "the text changed since this was proposed",
            ));
        }
        let tid = parse_id(&data.target)?;
        let titles = self.title_lookup_pub();
        let doc = self.doc(tid)?;
        let meta = doc.meta()?;
        let fields_before = doc.fields();
        let body_before = doc.body_text();
        let version_before = doc.version();
        for c in &data.changes {
            match c {
                Change::Title { to } => doc.set_title(Some(to.as_str()))?,
                Change::Body { markdown } => {
                    doc.set_body_markdown(markdown, &|t| titles.get(t).copied())?;
                }
                Change::AppendBody { markdown } => {
                    doc.append_body_markdown(markdown, &|t| titles.get(t).copied())?;
                }
                Change::Tags { to } => {
                    for t in &meta.tags {
                        doc.set_tag(t, false)?;
                    }
                    for t in to {
                        doc.set_tag(&dem_model::TagId(t.clone()), true)?;
                    }
                }
                Change::Container { to } => {
                    doc.set_container(to.as_deref().map(parse_id).transpose()?)?;
                }
                Change::State { to } => doc.set_state(crate::session::state_of(to)?)?,
                Change::Field { key, to } => doc.set_field(key, to)?,
            }
        }
        doc.touch(Timestamp::now())?;
        doc.commit(ChangeOrigin::Ai, Some(&item.id));
        let after_body = doc.body_text();
        let after_fields = doc.fields();
        let view = self.persist(tid)?;
        data.undo = Some(Undo {
            title: meta.title.clone(),
            tags: meta.tags.iter().map(|t| t.0.clone()).collect(),
            container: meta.container.map(|c| c.to_string()),
            state: crate::session::state_str(meta.state).to_owned(),
            fields: fields_before,
            version: version_before,
            body: body_before,
            after_title: view.title.clone(),
            after_tags: view.tags.clone(),
            after_container: view.container.clone(),
            after_state: view.state.clone(),
            after_fields,
            after_body,
        });
        data.status = "confirmed".into();
        self.store_proposal(&item.id, &data)?;
        self.proposal_view(&item.id)
    }

    pub fn ignore_proposal(&mut self, id: &str) -> CoreResult<ProposalView> {
        let (item, mut data) = self.proposal_data(id)?;
        if data.status == "pending" {
            data.status = "ignored".into();
            self.store_proposal(&item.id, &data)?;
        }
        self.proposal_view(&item.id)
    }

    /// Takes a decision back (format spec §9). If the item has moved on since, nothing is touched and
    /// the error says so: the user decides by looking, not by losing later work.
    pub fn undo_proposal(&mut self, id: &str) -> CoreResult<ProposalView> {
        let (item, mut data) = self.proposal_data(id)?;
        if data.status == "ignored" {
            data.status = "pending".into();
            self.store_proposal(&item.id, &data)?;
            return self.proposal_view(&item.id);
        }
        let Some(undo) = data.undo.take() else {
            return self.proposal_view(&item.id);
        };
        let tid = parse_id(&data.target)?;
        let doc = self.doc(tid)?;
        let meta = doc.meta()?;
        let same = doc.body_text() == undo.after_body
            && meta.title == undo.after_title
            && crate::session::state_str(meta.state) == undo.after_state
            && meta.container.map(|c| c.to_string()) == undo.after_container
            && doc.fields() == undo.after_fields
            && {
                let mut a: Vec<_> = meta.tags.iter().map(|t| t.0.clone()).collect();
                let mut b = undo.after_tags.clone();
                a.sort();
                b.sort();
                a == b
            };
        if !same {
            return Err(CoreError::new(
                "conflict",
                "the item changed after this was applied",
            ));
        }
        if undo.body != undo.after_body && !doc.restore_body(&undo.version)? {
            return Err(CoreError::new("conflict", "that version is gone"));
        }
        doc.set_title(undo.title.as_deref())?;
        doc.set_state(crate::session::state_of(&undo.state)?)?;
        doc.set_container(undo.container.as_deref().map(parse_id).transpose()?)?;
        for t in &meta.tags {
            doc.set_tag(t, false)?;
        }
        for t in &undo.tags {
            doc.set_tag(&dem_model::TagId(t.clone()), true)?;
        }
        for k in undo.after_fields.keys() {
            if !undo.fields.contains_key(k) {
                doc.set_field(k, &J::Null)?;
            }
        }
        for (k, v) in &undo.fields {
            doc.set_field(k, v)?;
        }
        doc.touch(Timestamp::now())?;
        doc.commit_revert(&item.id);
        let view = self.persist(tid)?;
        data.status = "pending".into();
        data.by_rule = false;
        data.base_updated = view.updated;
        self.store_proposal(&item.id, &data)?;
        self.proposal_view(&item.id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dto::ItemPatch;
    use crate::session::tests::{new_note, open_core};

    fn note(s: &mut Session, title: &str, md: &str) -> ItemView {
        s.create_item(NewItem {
            markdown: Some(md.into()),
            ..new_note(title)
        })
        .unwrap()
    }

    fn body(s: &mut Session, id: &str) -> String {
        s.doc(parse_id(id).unwrap()).unwrap().body_text()
    }

    #[test]
    fn nothing_changes_until_confirmed_and_undo_puts_it_back() {
        let d = tempfile::tempdir().unwrap();
        let c = open_core(d.path());
        c.with(|s| {
            let n = note(s, "标题", "原文\n");
            let changes = vec![
                Change::Title {
                    to: "新标题".into(),
                },
                Change::Body {
                    markdown: "改过\n".into(),
                },
                Change::Tags {
                    to: vec!["标签".into()],
                },
                Change::Field {
                    key: "x".into(),
                    to: json!(1),
                },
            ];
            let p = s.add_proposal(&n, changes, Some("改一下".into()), None)?;
            assert_eq!(p.state, "pending");
            assert_eq!(s.get_item(&n.id)?.title.as_deref(), Some("标题"));
            assert!(body(s, &n.id).contains("原文"));

            s.confirm_proposal(&p.id)?;
            let now = s.get_item(&n.id)?;
            assert_eq!(now.title.as_deref(), Some("新标题"));
            assert_eq!(now.tags, ["标签"]);
            assert!(body(s, &n.id).contains("改过"));
            let last = s.history(&n.id)?;
            assert_eq!(last[0].origin, "ai", "marked as AI's in the history");

            let back = s.undo_proposal(&p.id)?;
            assert_eq!(back.state, "pending");
            let now = s.get_item(&n.id)?;
            assert_eq!(now.title.as_deref(), Some("标题"));
            assert!(now.tags.is_empty());
            let t = body(s, &n.id);
            assert!(t.contains("原文") && !t.contains("改过"), "{t}");
            assert!(
                serde_json::from_str::<J>(&now.fields)
                    .unwrap()
                    .get("x")
                    .is_none_or(J::is_null)
            );
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn a_proposal_goes_stale_and_undo_never_overwrites_later_work() {
        let d = tempfile::tempdir().unwrap();
        let c = open_core(d.path());
        c.with(|s| {
            let n = note(s, "标题", "原文\n");
            let edit = |s: &mut Session, id: &str| {
                std::thread::sleep(std::time::Duration::from_millis(5));
                s.body_append(id, "我后来写的").unwrap();
            };
            let p = s.add_proposal(&n, vec![Change::Title { to: "甲".into() }], None, None)?;
            edit(s, &n.id);
            assert!(s.proposal_view(&p.id)?.stale);
            assert_eq!(s.confirm_proposal(&p.id).unwrap_err().code, "stale");

            let n2 = note(s, "二", "原文\n");
            let p2 = s.add_proposal(
                &n2,
                vec![Change::Body {
                    markdown: "AI 写的\n".into(),
                }],
                None,
                None,
            )?;
            s.confirm_proposal(&p2.id)?;
            edit(s, &n2.id);
            assert_eq!(s.undo_proposal(&p2.id).unwrap_err().code, "conflict");
            assert!(body(s, &n2.id).contains("我后来写的"));
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn a_rule_applies_at_once_but_never_for_a_delete_or_anything_sensitive() {
        let d = tempfile::tempdir().unwrap();
        let c = open_core(d.path());
        c.with(|s| {
            s.local_set(
                RULES_KEY,
                &json!([{ "action": "fill-tags", "scope": "all" }, { "action": "delete", "scope": "all" }])
                    .to_string(),
            )?;
            let n = note(s, "一", "");
            let p = s.add_proposal(&n, vec![Change::Tags { to: vec!["甲".into()] }], None, None)?;
            assert_eq!(p.state, "confirmed");
            assert!(p.by_rule);
            let del = s.add_proposal(&n, vec![Change::State { to: "trashed".into() }], None, None)?;
            assert_eq!(del.state, "pending", "delete always asks");
            let sens = s.create_item(NewItem {
                privacy: Some("sensitive".into()),
                ..new_note("敏感")
            })?;
            let p = s.add_proposal(&sens, vec![Change::Tags { to: vec!["乙".into()] }], None, None)?;
            assert_eq!(p.state, "pending");
            assert_eq!(p.privacy, "sensitive", "as private as what it quotes");
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn the_privacy_level_web_mark_and_settings_cannot_be_named() {
        for field in [
            "privacy",
            "ai_web",
            "meta.privacy",
            "type",
            "id",
            "settings",
            "fields.",
        ] {
            assert!(parse_change(field, &json!("normal")).is_err(), "{field}");
        }
        assert!(parse_change("state", &json!("inbox")).is_err());
        assert!(parse_change("fields.x", &json!({ "a": 1 })).is_err());
        assert!(parse_change("title", &json!("t")).is_ok());
    }

    #[test]
    fn proposals_stay_out_of_lists_and_search() {
        let d = tempfile::tempdir().unwrap();
        let c = open_core(d.path());
        c.with(|s| {
            let n = note(s, "一", "");
            s.add_proposal(
                &n,
                vec![Change::Title {
                    to: "zzproposalzz".into(),
                }],
                Some("zzproposalzz".into()),
                None,
            )?;
            assert!(s.search("zzproposalzz", 5)?.is_empty());
            let all = s.list_items(&crate::dto::ListQuery {
                type_id: None,
                states: None,
                container: None,
                tag: None,
                order: None,
                limit: None,
            })?;
            assert_eq!(all.len(), 1);
            s.update_item(&n.id, ItemPatch::default())?;
            Ok(())
        })
        .unwrap();
    }
}
