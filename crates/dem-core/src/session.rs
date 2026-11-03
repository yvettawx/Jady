//! One open library: every operation on its items, the index kept in step, and the activity log.

use std::collections::{HashMap, HashSet};

use data_encoding::BASE64;
use dem_index::{Filter, Index, IndexRecord, Order};
use dem_model::{
    ChangeOrigin, FlexDate, ItemId, ItemMeta, ItemState, Privacy, SourceInfo, SourceOrigin, TagId,
    TimeAnchor, Timestamp, TypeDef, TypeId, builtin_types,
};
use dem_store::logs::{LogKind, LogRecord};
use dem_store::structure::NodeKind;
use dem_store::{ItemDoc, Library, StructureDoc};
use jiff::tz::TimeZone;
use serde_json::{Map, Value as J, json};

use crate::dto::*;
use crate::error::{CoreError, CoreResult};

/// Update files per item before they are folded into a snapshot.
const COMPACT_AFTER: u32 = 64;

pub struct Session {
    pub(crate) lib: Library,
    /// Worked out from the review log (M7).
    pub(crate) memories: HashMap<String, dem_learn::Memory>,
    pub(crate) index: Index,
    structure: StructureDoc,
    docs: HashMap<ItemId, ItemDoc>,
    types: Vec<TypeDef>,
    /// Items already counted as edited today: a day of typing is one edit on the heat map.
    edited_today: HashSet<(ItemId, String)>,
    writes: HashMap<ItemId, u32>,
}

impl std::fmt::Debug for Session {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Session").finish_non_exhaustive()
    }
}

pub(crate) fn state_of(s: &str) -> CoreResult<ItemState> {
    Ok(match s {
        "inbox" => ItemState::Inbox,
        "active" => ItemState::Active,
        "archived" => ItemState::Archived,
        "trashed" => ItemState::Trashed,
        _ => return Err(CoreError::invalid("state")),
    })
}

pub(crate) fn state_str(s: ItemState) -> &'static str {
    match s {
        ItemState::Inbox => "inbox",
        ItemState::Active => "active",
        ItemState::Archived => "archived",
        ItemState::Trashed => "trashed",
    }
}

pub fn privacy_of(s: &str) -> CoreResult<Privacy> {
    Ok(match s {
        "normal" => Privacy::Normal,
        "sensitive" => Privacy::Sensitive,
        "private" => Privacy::Private,
        "confidential" => Privacy::Confidential,
        _ => return Err(CoreError::invalid("privacy")),
    })
}

pub(crate) fn privacy_str(p: Privacy) -> &'static str {
    match p {
        Privacy::Normal => "normal",
        Privacy::Sensitive => "sensitive",
        Privacy::Private => "private",
        Privacy::Confidential => "confidential",
    }
}

pub(crate) fn parse_id(s: &str) -> CoreResult<ItemId> {
    s.parse().map_err(|_| CoreError::invalid("item id"))
}

fn ts(ms: f64) -> CoreResult<Timestamp> {
    Timestamp::from_millisecond(ms as i64).map_err(|_| CoreError::invalid("time"))
}

fn day_str(d: &FlexDate) -> Option<String> {
    Some(format!("{:04}-{:02}-{:02}", d.year, d.month?, d.day?))
}

fn parse_day(s: &str) -> CoreResult<FlexDate> {
    let bad = || CoreError::invalid("date");
    let mut p = s.split('-');
    let (Some(y), Some(m), Some(d), None) = (p.next(), p.next(), p.next(), p.next()) else {
        return Err(bad());
    };
    FlexDate::ymd(
        y.parse().map_err(|_| bad())?,
        m.parse().map_err(|_| bad())?,
        d.parse().map_err(|_| bad())?,
    )
    .map_err(|_| bad())
}

fn source_view(s: &SourceInfo) -> SourceView {
    SourceView {
        origin: match s.origin {
            SourceOrigin::Me => "mine",
            SourceOrigin::AiMemory => "aiMemory",
            SourceOrigin::AiSearch => "aiSearch",
            SourceOrigin::Import => "import",
        }
        .to_owned(),
        needs_check: s.needs_check,
        conflict: s.conflict,
        recheck_on: s.recheck_on.as_ref().and_then(day_str),
        refs: s.refs.clone(),
    }
}

fn source_info(v: &SourceView) -> CoreResult<SourceInfo> {
    Ok(SourceInfo {
        origin: match v.origin.as_str() {
            "mine" => SourceOrigin::Me,
            "aiMemory" => SourceOrigin::AiMemory,
            "aiSearch" => SourceOrigin::AiSearch,
            "import" => SourceOrigin::Import,
            _ => return Err(CoreError::invalid("source origin")),
        },
        needs_check: v.needs_check,
        conflict: v.conflict,
        recheck_on: v.recheck_on.as_deref().map(parse_day).transpose()?,
        refs: v.refs.clone(),
    })
}

fn time_of(meta: &ItemMeta) -> dem_index::TimeColumns {
    match &meta.time {
        Some(TimeAnchor::Span {
            start,
            end,
            tz,
            recurrence,
        }) => dem_index::TimeColumns {
            start: Some(start.as_millisecond()),
            end: Some(end.as_millisecond()),
            tz: Some(tz.clone()),
            recurrence: recurrence.clone(),
            ..Default::default()
        },
        Some(TimeAnchor::Occurred { date }) => dem_index::TimeColumns {
            occurred: Some(date.to_string()),
            occurred_key: Some(date.sort_key()),
            ..Default::default()
        },
        _ => dem_index::TimeColumns::default(),
    }
}

fn due_of(meta: &ItemMeta) -> Option<i64> {
    match &meta.time {
        Some(TimeAnchor::Due { at }) => Some(at.as_millisecond()),
        _ => None,
    }
}

pub(crate) fn today() -> String {
    Timestamp::now()
        .to_zoned(TimeZone::system())
        .date()
        .to_string()
}

fn record_of(doc: &ItemDoc) -> CoreResult<IndexRecord> {
    let meta = doc.meta()?;
    let mut links: Vec<(String, String)> = doc
        .body_links()
        .into_iter()
        .map(|t| (t.to_string(), "link".to_owned()))
        .collect();
    links.extend(
        doc.links()
            .into_iter()
            .map(|(_, to, kind)| (to.to_string(), kind)),
    );
    if let Some(c) = meta.container {
        links.push((c.to_string(), "in".to_owned()));
    }
    let mut body = doc.body_text();
    for v in doc.canvas().values() {
        let Some(node) = v.as_str().and_then(|t| serde_json::from_str::<J>(t).ok()) else {
            continue;
        };
        if let Some(text) = node.get("text").and_then(J::as_str) {
            body.push('\n');
            body.push_str(text);
        }
        if let Some(item) = node.get("item").and_then(J::as_str) {
            links.push((item.to_owned(), "link".to_owned()));
        }
    }
    Ok(IndexRecord {
        id: meta.id.to_string(),
        type_id: meta.type_id.0.clone(),
        title: meta.title.clone(),
        state: state_str(meta.state).to_owned(),
        privacy: privacy_str(meta.privacy).to_owned(),
        container: meta.container.map(|c| c.to_string()),
        created: meta.created.as_millisecond(),
        updated: meta.updated.as_millisecond(),
        due: due_of(&meta),
        time: time_of(&meta),
        recheck: meta.source.recheck_on.as_ref().and_then(day_str),
        tags: meta.tags.iter().map(|t| t.0.clone()).collect(),
        fields: J::Object(doc.fields()),
        body,
        links,
    })
}

pub(crate) struct SyncBegin {
    pub root: std::path::PathBuf,
    pub key: dem_crypto::FileKey,
    pub device: String,
    pub first_seq: u64,
    pub state: dem_sync::SyncState,
}

/// A full view of an open document, title and fields included (the index leaves those out for
/// 机密 items, but whoever opened one may see it).
fn view_of(doc: &ItemDoc) -> CoreResult<ItemView> {
    let meta = doc.meta()?;
    Ok(ItemView {
        id: meta.id.to_string(),
        type_id: meta.type_id.0.clone(),
        title: meta.title.clone(),
        state: state_str(meta.state).to_owned(),
        privacy: privacy_str(meta.privacy).to_owned(),
        ai_web: meta.ai_web,
        container: meta.container.map(|c| c.to_string()),
        created: meta.created.as_millisecond() as f64,
        updated: meta.updated.as_millisecond() as f64,
        due: due_of(&meta).map(|d| d as f64),
        occurred: match &meta.time {
            Some(TimeAnchor::Occurred { date }) => Some(date.to_string()),
            _ => None,
        },
        span: match &meta.time {
            Some(TimeAnchor::Span {
                start,
                end,
                tz,
                recurrence,
            }) => Some(SpanView {
                start: start.as_millisecond() as f64,
                end: end.as_millisecond() as f64,
                tz: tz.clone(),
                recurrence: recurrence.clone(),
            }),
            _ => None,
        },
        tags: meta.tags.iter().map(|t| t.0.clone()).collect(),
        fields: serde_json::to_string(&doc.fields())
            .map_err(|e| CoreError::new("broken", e.to_string()))?,
        preview: String::new(),
        source: Some(source_view(&meta.source)),
    })
}

fn add_logged_activity(
    index: &Index,
    logs: dem_store::library::LogRead,
    reviews: dem_store::library::LogRead,
) -> Result<(), dem_index::IndexError> {
    let tz = TimeZone::system();
    for r in reviews.records {
        let day = r.ts.to_zoned(tz.clone()).date().to_string();
        index.add_activity(&day, "review", 1)?;
    }
    for r in logs.records {
        let day = r.ts.to_zoned(tz.clone()).date().to_string();
        let ty = r.fields.get("type").and_then(J::as_str).unwrap_or("note");
        index.add_activity(&day, ty, 1)?;
    }
    Ok(())
}

impl Session {
    pub(crate) fn open(lib: Library) -> CoreResult<Session> {
        let index_path = lib.root().join("index.sqlite");
        let (index, fresh) = Index::open(&index_path, lib.index_key().expose_bytes())?;
        let structure = lib.load_structure()?;
        let mut types = lib.load_types()?;
        for def in builtin_types() {
            match types.iter_mut().find(|t| t.id == def.id) {
                None => {
                    lib.save_type(&def)?;
                    types.push(def);
                }
                // A newer version may have given a built-in type more fields; yours stay.
                Some(saved) => {
                    let new: Vec<_> = def
                        .fields
                        .iter()
                        .filter(|f| !saved.fields.iter().any(|s| s.key == f.key))
                        .cloned()
                        .collect();
                    if !new.is_empty() {
                        saved.fields.extend(new);
                        lib.save_type(saved)?;
                    }
                }
            }
        }
        let mut session = Session {
            memories: HashMap::new(),
            lib,
            index,
            structure,
            docs: HashMap::new(),
            types,
            edited_today: HashSet::new(),
            writes: HashMap::new(),
        };
        if fresh {
            session.rebuild_index()?;
        }
        session.memories = crate::learn::replay(&session)?;
        Ok(session)
    }

    /// Reads every item again and refills the index. One unreadable item is logged and skipped:
    /// it must not stop the others, and the validator reports it.
    pub fn rebuild_index(&mut self) -> CoreResult<u32> {
        let ids = self.lib.item_ids()?;
        let lib = &self.lib;
        let logs = lib.read_logs(LogKind::Activity)?;
        let reviews = lib.read_logs(LogKind::Review)?;
        self.index
            .transaction(|index| {
                index.clear()?;
                let mut n = 0;
                for id in ids {
                    let Ok(rec) = lib.load_item(id).and_then(|d| {
                        record_of(&d).map_err(|e| dem_store::StoreError::InvalidDocument(e.message))
                    }) else {
                        tracing::warn!(%id, "item could not be indexed");
                        continue;
                    };
                    index.upsert(&rec)?;
                    n += 1;
                }
                add_logged_activity(index, logs, reviews)?;
                Ok(n)
            })
            .map_err(Into::into)
    }

    pub(crate) fn doc(&mut self, id: ItemId) -> CoreResult<&mut ItemDoc> {
        if !self.docs.contains_key(&id) {
            let doc = self.lib.load_item(id)?;
            self.docs.insert(id, doc);
        }
        self.docs
            .get_mut(&id)
            .ok_or_else(|| CoreError::new("not-found", "item"))
    }

    fn log(&self, id: ItemId, type_id: &str, action: &str, origin: &str) -> CoreResult<()> {
        let mut fields = Map::new();
        fields.insert("item".into(), json!(id.to_string()));
        fields.insert("type".into(), json!(type_id));
        fields.insert("action".into(), json!(action));
        fields.insert("origin".into(), json!(origin));
        self.lib.append_log(
            LogKind::Activity,
            &LogRecord::new(LogKind::Activity, fields),
        )?;
        self.index.add_activity(&today(), type_id, 1)?;
        Ok(())
    }

    /// Writes what changed, keeps the index in step and folds update files now and then.
    pub(crate) fn persist(&mut self, id: ItemId) -> CoreResult<ItemView> {
        let doc = self
            .docs
            .get_mut(&id)
            .ok_or_else(|| CoreError::new("not-found", "item"))?;
        self.lib.save_item(doc)?;
        let writes = self.writes.entry(id).or_insert(0);
        *writes += 1;
        if *writes >= COMPACT_AFTER {
            *writes = 0;
            self.lib.compact_item(doc)?;
        }
        self.index.upsert(&record_of(doc)?)?;
        view_of(doc)
    }

    fn edited(&mut self, id: ItemId, type_id: &str) -> CoreResult<()> {
        if self.edited_today.insert((id, today())) {
            self.log(id, type_id, "edit", "me")?;
        }
        Ok(())
    }

    // ---- items ---------------------------------------------------------------------------

    pub(crate) fn type_def(&self, id: &str) -> Option<&TypeDef> {
        self.types.iter().find(|t| t.id == id)
    }

    /// A new item is at least as protected as its type's default and what it goes inside.
    fn starting_privacy(&mut self, type_id: &str, container: Option<ItemId>) -> Privacy {
        let mut p: Privacy = self
            .type_def(type_id)
            .map_or(Privacy::Normal, |t| t.default_privacy.into());
        if let Some(c) = container
            && let Ok(meta) = self.doc(c).and_then(|d| d.meta().map_err(Into::into))
        {
            p = p.max(meta.privacy);
        }
        p
    }

    pub fn create_item(&mut self, new: NewItem) -> CoreResult<ItemView> {
        self.create_item_as(new, ChangeOrigin::Me, None)
    }

    pub(crate) fn create_item_as(
        &mut self,
        new: NewItem,
        origin: ChangeOrigin,
        batch: Option<&str>,
    ) -> CoreResult<ItemView> {
        if self.type_def(&new.type_id).is_none() {
            return Err(CoreError::invalid("unknown type"));
        }
        let container = new.container.as_deref().map(parse_id).transpose()?;
        let inherited = self.starting_privacy(&new.type_id, container);
        let privacy = match new.privacy.as_deref() {
            Some(p) => privacy_of(p)?,
            None => inherited,
        };
        let now = Timestamp::now();
        let id = ItemId::new();
        let time = new
            .due
            .map(ts)
            .transpose()?
            .map(|at| TimeAnchor::Due { at });
        let meta = ItemMeta {
            id,
            type_id: TypeId(new.type_id.clone()),
            title: new.title.clone().filter(|t| !t.trim().is_empty()),
            state: state_of(new.state.as_deref().unwrap_or("active"))?,
            privacy,
            container,
            tags: new
                .tags
                .unwrap_or_default()
                .into_iter()
                .map(TagId)
                .collect(),
            created: now,
            updated: now,
            time,
            source: SourceInfo {
                origin: match origin {
                    ChangeOrigin::Me => SourceOrigin::Me,
                    ChangeOrigin::Ai => SourceOrigin::AiMemory,
                    ChangeOrigin::Import => SourceOrigin::Import,
                },
                ..SourceInfo::default()
            },
            ai_web: false,
        };
        let doc = self.lib.create_item(&meta)?;
        if let Some(fields) = &new.fields {
            let map: Map<String, J> =
                serde_json::from_str(fields).map_err(|_| CoreError::invalid("fields"))?;
            for (k, v) in &map {
                doc.set_field(k, v)?;
            }
        }
        // The editor's document needs at least one block (format spec §6.2).
        if let Some(md) = new.markdown.as_ref().filter(|m| !m.trim().is_empty()) {
            let titles = self.title_lookup();
            doc.set_body_markdown(md, &|t| titles.get(t).copied())?;
        } else {
            doc.append_paragraph("")?;
        }
        doc.commit(origin, batch);
        self.docs.insert(id, doc);
        if matches!(new.type_id.as_str(), "domain" | "project") {
            let kind = if new.type_id == "domain" {
                NodeKind::Domain
            } else {
                NodeKind::Project
            };
            self.structure.add(id, kind, container)?;
            self.structure.commit("me");
            self.lib.save_structure(&mut self.structure)?;
        }
        let origin_str = match origin {
            ChangeOrigin::Me => "me",
            ChangeOrigin::Ai => "ai",
            ChangeOrigin::Import => "import",
        };
        self.log(id, &new.type_id, "create", origin_str)?;
        self.edited_today.insert((id, today()));
        self.persist(id)
    }

    pub(crate) fn title_lookup_pub(&self) -> HashMap<String, ItemId> {
        self.title_lookup()
    }

    /// Who links here, whatever their level: for the AI view to reduce to placeholders.
    pub(crate) fn backlinks_any(&self, id: &str) -> CoreResult<Vec<String>> {
        Ok(self
            .index
            .backlinks(id)?
            .into_iter()
            .map(|r| r.id)
            .collect())
    }

    /// Id to title, for writing links out as `[[title]]`. 机密 titles are not in the index.
    pub(crate) fn id_titles(&self) -> HashMap<String, String> {
        let rows = self.index.list(&Filter::default()).unwrap_or_default();
        rows.into_iter()
            .filter_map(|r| Some((r.id, r.title?)))
            .collect()
    }

    fn title_lookup(&self) -> HashMap<String, ItemId> {
        let rows = self.index.list(&Filter::default()).unwrap_or_default();
        rows.into_iter()
            .filter_map(|r| Some((r.title?, r.id.parse().ok()?)))
            .collect()
    }

    pub fn get_item(&mut self, id: &str) -> CoreResult<ItemView> {
        let id = parse_id(id)?;
        view_of(self.doc(id)?)
    }

    pub fn update_item(&mut self, id: &str, patch: ItemPatch) -> CoreResult<ItemView> {
        let id = parse_id(id)?;
        let doc = self.doc(id)?;
        let before = doc.meta()?;
        if let Some(t) = &patch.title {
            doc.set_title(t.as_deref().filter(|s| !s.trim().is_empty()))?;
        }
        if let Some(s) = &patch.state {
            doc.set_state(state_of(s)?)?;
        }
        if let Some(p) = &patch.privacy {
            let level = privacy_of(p)?;
            doc.set_privacy(level)?;
            // 可以联网给 AI 用 only means something on 敏感.
            if level != Privacy::Sensitive && before.ai_web {
                doc.set_ai_web(false)?;
            }
        }
        if let Some(on) = patch.ai_web {
            let level = match &patch.privacy {
                Some(p) => privacy_of(p)?,
                None => before.privacy,
            };
            if on && level != Privacy::Sensitive {
                return Err(CoreError::invalid("only sensitive items can be marked"));
            }
            doc.set_ai_web(on)?;
        }
        if let Some(c) = &patch.container {
            doc.set_container(c.as_deref().map(parse_id).transpose()?)?;
        }
        if let Some(due) = &patch.due {
            let anchor = due.map(ts).transpose()?.map(|at| TimeAnchor::Due { at });
            doc.set_time(anchor.as_ref())?;
        }
        if let Some(text) = &patch.occurred {
            let anchor = text
                .as_deref()
                .map(|t| FlexDate::parse(t).map_err(|_| CoreError::invalid("date")))
                .transpose()?
                .map(|date| TimeAnchor::Occurred { date });
            doc.set_time(anchor.as_ref())?;
        }
        if let Some(span) = &patch.span {
            let anchor = span
                .as_ref()
                .map(|v| -> CoreResult<TimeAnchor> {
                    let (start, end) = (ts(v.start)?, ts(v.end)?);
                    if end < start {
                        return Err(CoreError::invalid("span"));
                    }
                    Ok(TimeAnchor::Span {
                        start,
                        end,
                        tz: v.tz.clone(),
                        recurrence: v.recurrence.clone(),
                    })
                })
                .transpose()?;
            doc.set_time(anchor.as_ref())?;
        }
        if let Some(tags) = &patch.tags {
            for t in &before.tags {
                doc.set_tag(t, false)?;
            }
            for t in tags {
                doc.set_tag(&TagId(t.clone()), true)?;
            }
        }
        if let Some(fields) = &patch.fields {
            let map: Map<String, J> =
                serde_json::from_str(fields).map_err(|_| CoreError::invalid("fields"))?;
            for (k, v) in &map {
                doc.set_field(k, v)?;
            }
        }
        if let Some(source) = &patch.source {
            doc.set_source(&source_info(source)?)?;
        }
        doc.touch(Timestamp::now())?;
        doc.commit(ChangeOrigin::Me, None);
        let ty = before.type_id.0.clone();
        self.edited(id, &ty)?;
        self.persist(id)
    }

    /// Gone for good. The interface has asked first.
    pub fn purge_item(&mut self, id: &str) -> CoreResult<()> {
        let id = parse_id(id)?;
        self.docs.remove(&id);
        self.lib.delete_item(id)?;
        self.index.remove(&id.to_string())?;
        Ok(())
    }

    pub fn empty_trash(&mut self) -> CoreResult<u32> {
        let rows = self.index.list(&Filter {
            states: vec!["trashed".into()],
            ..Default::default()
        })?;
        let n = rows.len() as u32;
        for r in rows {
            self.purge_item(&r.id)?;
        }
        Ok(n)
    }

    pub fn list_items(&self, q: &ListQuery) -> CoreResult<Vec<ItemView>> {
        let asked_for = q.type_id.is_some();
        let rows = self.index.list(&Filter {
            type_id: q.type_id.clone(),
            states: q.states.clone().unwrap_or_default(),
            container: q.container.clone(),
            tag: q.tag.clone(),
            due_before: None,
            order: match q.order.as_deref() {
                Some("created") => Order::Created,
                Some("due") => Order::Due,
                Some("title") => Order::Title,
                _ => Order::Updated,
            },
            limit: q.limit,
        })?;
        Ok(rows
            .into_iter()
            .filter(|r| asked_for || !dem_model::is_system_type(&r.type_id))
            .map(Into::into)
            .collect())
    }

    /// A whiteboard's nodes and lines, by key, each a JSON text the interface owns.
    pub fn canvas(&mut self, id: &str) -> CoreResult<HashMap<String, String>> {
        let id = parse_id(id)?;
        Ok(self
            .doc(id)?
            .canvas()
            .into_iter()
            .filter_map(|(k, v)| v.as_str().map(|t| (k, t.to_owned())))
            .collect())
    }

    /// Changes some of them; `None` removes one.
    pub fn canvas_update(
        &mut self,
        id: &str,
        changes: HashMap<String, Option<String>>,
    ) -> CoreResult<()> {
        let id = parse_id(id)?;
        let doc = self.doc(id)?;
        let type_id = doc.meta()?.type_id.0;
        for (k, v) in &changes {
            doc.canvas_put(k, v.as_deref())?;
        }
        doc.touch(Timestamp::now())?;
        doc.commit(ChangeOrigin::Me, None);
        self.persist(id)?;
        self.edited(id, &type_id)
    }

    /// What sync needs while it moves files, without holding the session: everything written out.
    pub(crate) fn sync_begin(&mut self) -> CoreResult<SyncBegin> {
        let ids: Vec<ItemId> = self.docs.keys().copied().collect();
        for id in ids {
            if let Some(doc) = self.docs.get_mut(&id) {
                self.lib.save_item(doc)?;
            }
        }
        self.lib.save_structure(&mut self.structure)?;
        let state = self
            .local_get("sync-state")?
            .and_then(|j| serde_json::from_str(&j).ok())
            .unwrap_or_default();
        Ok(SyncBegin {
            root: self.lib.root().to_owned(),
            key: self.lib.file_key().clone(),
            device: self.lib.device().to_string(),
            first_seq: self.lib.next_seq(),
            state,
        })
    }

    /// Opens again what changed on disk, so the index and anything open catch up. Returns the items.
    pub(crate) fn sync_finish(
        &mut self,
        state: &dem_sync::SyncState,
        changed: &[String],
    ) -> CoreResult<Vec<String>> {
        self.local_set(
            "sync-state",
            &serde_json::to_string(state).map_err(|e| CoreError::new("broken", e.to_string()))?,
        )?;
        let mut items = HashSet::new();
        let (mut types, mut structure, mut logs) = (false, false, false);
        for path in changed {
            let mut parts = path.split('/');
            match parts.next() {
                Some("items") => {
                    let name = path.rsplit('/').next().unwrap_or_default();
                    items.insert(name.split('.').next().unwrap_or_default().to_owned());
                }
                Some("types") => types = true,
                Some("structure") => structure = true,
                Some("logs") => logs = true,
                _ => {}
            }
        }
        let mut touched = Vec::new();
        for stem in items {
            let Ok(id) = parse_id(&stem) else {
                continue;
            };
            self.docs.remove(&id);
            match self.lib.load_item(id) {
                Ok(doc) => {
                    self.index.upsert(&record_of(&doc)?)?;
                    self.docs.insert(id, doc);
                }
                // Every file of it is gone: purged on another computer.
                Err(_) => self.index.remove(&stem)?,
            }
            touched.push(stem);
        }
        if types {
            for def in self.lib.load_types()? {
                match self.types.iter_mut().find(|t| t.id == def.id) {
                    Some(t) => *t = def,
                    None => self.types.push(def),
                }
            }
        }
        if structure {
            self.structure = self.lib.load_structure()?;
        }
        if logs {
            let activity = self.lib.read_logs(LogKind::Activity)?;
            let reviews = self.lib.read_logs(LogKind::Review)?;
            self.index.clear_activity()?;
            add_logged_activity(&self.index, activity, reviews)?;
        }
        Ok(touched)
    }

    /// Everything on the calendar between two times, recurring items once per occurrence.
    pub fn agenda(&self, from: f64, to: f64) -> CoreResult<Vec<AgendaEntry>> {
        let (from, to) = (ts(from)?, ts(to)?);
        let mut out = Vec::new();
        for row in self.index.scheduled(to.as_millisecond())? {
            let (Some(start), Some(end)) = (row.time.start, row.time.end) else {
                continue;
            };
            let (Ok(start), Ok(end)) = (
                Timestamp::from_millisecond(start),
                Timestamp::from_millisecond(end),
            ) else {
                continue;
            };
            if dem_model::is_system_type(&row.type_id) {
                continue;
            }
            let length = (end.as_millisecond() - start.as_millisecond()) as f64;
            let at = dem_model::occurrences(
                start,
                end,
                row.time.tz.as_deref().unwrap_or("UTC"),
                row.time.recurrence.as_deref(),
                from,
                to,
            );
            let item: ItemView = row.into();
            for a in at {
                let s = a.as_millisecond() as f64;
                out.push(AgendaEntry {
                    item: item.clone(),
                    start: s,
                    end: s + length,
                });
            }
        }
        out.sort_by(|a, b| a.start.total_cmp(&b.start));
        Ok(out)
    }

    /// Everything that says when it happened: its time anchor, or else the first date field its
    /// type has. `type_id` narrows it to one type. Oldest first; dates may be BCE or only a year.
    pub fn timeline(&self, type_id: Option<&str>) -> CoreResult<Vec<TimelineEntry>> {
        let rows = self.index.list(&Filter {
            type_id: type_id.map(str::to_owned),
            states: vec!["active".into(), "inbox".into(), "archived".into()],
            ..Default::default()
        })?;
        let mut out = Vec::new();
        for row in rows {
            if dem_model::is_system_type(&row.type_id) {
                continue;
            }
            let fields: J = serde_json::from_str(&row.fields).unwrap_or(J::Null);
            let from_field = self.type_def(&row.type_id).and_then(|def| {
                def.fields
                    .iter()
                    .filter(|f| matches!(f.kind, dem_model::FieldKind::Date))
                    .find_map(|f| fields.get(&f.key).and_then(J::as_str))
                    .map(str::to_owned)
            });
            let from_span = row.time.start.and_then(|ms| {
                let at = Timestamp::from_millisecond(ms).ok()?;
                Some(at.to_zoned(TimeZone::system()).date().to_string())
            });
            let when = row.time.occurred.clone().or(from_span).or(from_field);
            let Some((when, date)) = when.and_then(|w| FlexDate::parse(&w).ok().map(|d| (w, d)))
            else {
                continue;
            };
            out.push(TimelineEntry {
                key: date.sort_key() as f64,
                when,
                item: row.into(),
            });
        }
        out.sort_by(|a, b| a.key.total_cmp(&b.key));
        Ok(out)
    }

    pub fn search(&self, query: &str, limit: u32) -> CoreResult<Vec<SearchHit>> {
        Ok(self
            .index
            .search(query, limit)?
            .into_iter()
            .filter(|h| !dem_model::is_system_type(&h.row.type_id))
            .map(|h| SearchHit {
                snippet: h.snippet,
                item: h.row.into(),
            })
            .collect())
    }

    pub fn backlinks(&self, id: &str) -> CoreResult<Vec<ItemView>> {
        Ok(self
            .index
            .backlinks(id)?
            .into_iter()
            .map(Into::into)
            .collect())
    }

    pub fn tags(&self) -> CoreResult<Vec<TagCount>> {
        Ok(self
            .index
            .tags()?
            .into_iter()
            .map(|t| TagCount {
                tag: t.tag,
                count: t.count as u32,
            })
            .collect())
    }

    pub fn activity_since(&self, day: &str) -> CoreResult<Vec<ActivityDay>> {
        Ok(self
            .index
            .activity_since(day)?
            .into_iter()
            .map(|a| ActivityDay {
                date: a.day,
                type_id: a.type_id,
                count: a.count as u32,
            })
            .collect())
    }

    /// What wants attention: to-dos due today or earlier, and what is due for a recheck.
    fn rule_on(&self, rule: &str) -> CoreResult<bool> {
        let off: Vec<String> = self
            .local_get("reminder-rules-off")?
            .and_then(|j| serde_json::from_str(&j).ok())
            .unwrap_or_default();
        Ok(!off.iter().any(|o| o == rule))
    }

    /// The other rules in M8. Each can be turned off, and none piles up: a review skipped last
    /// week is simply not asked for any more.
    fn rule_reminders(&self, now: &jiff::Zoned, end_ms: i64) -> CoreResult<Vec<Reminder>> {
        let off: Vec<String> = self
            .local_get("reminder-rules-off")?
            .and_then(|j| serde_json::from_str(&j).ok())
            .unwrap_or_default();
        let on = |rule: &str| !off.iter().any(|o| o == rule);
        let rows = |ty: &str| {
            self.index.list(&Filter {
                type_id: Some(ty.into()),
                states: vec!["active".into(), "inbox".into()],
                ..Default::default()
            })
        };
        let field = |r: &str, key: &str| {
            serde_json::from_str::<J>(r)
                .ok()
                .and_then(|f| f.get(key).and_then(J::as_str).map(str::to_owned))
        };
        let day = now.date();
        let settled = now.timestamp().as_millisecond()
            - self.lib.manifest().created.as_millisecond()
            > 7 * 86_400_000;
        let mut out = Vec::new();
        if on("decision") {
            for r in rows("decision")? {
                let due = field(&r.fields, "review_on");
                let looked = field(&r.fields, "looked_back").is_some_and(|t| !t.is_empty());
                if !looked && due.is_some_and(|d| !d.is_empty() && d <= today()) {
                    out.push(Reminder {
                        id: r.id,
                        title: r.title,
                        kind: "decision".to_owned(),
                        when: None,
                    });
                }
            }
        }
        // 周: from Sunday; 月: the first days of a month; 年: the first week of January.
        let reviewed = |period: &str, since: &str| -> CoreResult<bool> {
            Ok(rows("review")?.iter().any(|r| {
                field(&r.fields, "period").as_deref() == Some(period)
                    && field(&r.fields, "date").is_some_and(|d| d.as_str() >= since)
            }))
        };
        let week_start = day
            .checked_sub(jiff::Span::new().days(i64::from(day.weekday().to_monday_zero_offset())))
            .map_err(|e| CoreError::new("time", e.to_string()))?
            .to_string();
        let month_start = day.first_of_month().to_string();
        let year_start = format!("{:04}-01-01", day.year());
        let periods = [
            (
                "week",
                day.weekday() == jiff::civil::Weekday::Sunday,
                week_start,
            ),
            ("month", day.day() <= 3, month_start),
            ("year", day.month() == 1 && day.day() <= 7, year_start),
        ];
        for (period, time, since) in periods {
            // A library made this week has nothing to look back on yet.
            if time && on("review") && settled && !reviewed(period, &since)? {
                out.push(Reminder {
                    id: format!("review:{period}"),
                    title: None,
                    kind: format!("review-{period}"),
                    when: None,
                });
            }
        }
        if on("stale") {
            let month_ago = end_ms - 30 * 86_400_000;
            let mut stale: Vec<_> = rows("project")?
                .into_iter()
                .filter(|r| r.updated < month_ago && r.privacy != "confidential")
                .collect();
            stale.sort_by_key(|r| r.updated);
            for r in stale.into_iter().take(3) {
                out.push(Reminder {
                    id: r.id,
                    title: r.title,
                    kind: "stale".to_owned(),
                    when: Some(r.updated as f64),
                });
            }
        }
        Ok(out)
    }

    /// 间隙日志: a line added to the end of the text (M5).
    pub fn body_append(&mut self, id: &str, line: &str) -> CoreResult<ItemView> {
        let id = parse_id(id)?;
        let doc = self.doc(id)?;
        let ty = doc.meta()?.type_id.0;
        doc.append_paragraph(line)?;
        doc.touch(Timestamp::now())?;
        doc.commit(ChangeOrigin::Me, None);
        self.edited(id, &ty)?;
        self.persist(id)
    }

    /// Replaces the text from Markdown: a document made again from its sources.
    pub fn body_set_markdown(&mut self, id: &str, markdown: &str) -> CoreResult<ItemView> {
        let id = parse_id(id)?;
        let titles = self.title_lookup();
        let doc = self.doc(id)?;
        let ty = doc.meta()?.type_id.0;
        doc.set_body_markdown(markdown, &|t| titles.get(t).copied())?;
        doc.touch(Timestamp::now())?;
        doc.commit(ChangeOrigin::Me, None);
        self.edited(id, &ty)?;
        self.persist(id)
    }

    /// The text as Markdown.
    pub fn body_markdown(&mut self, id: &str) -> CoreResult<String> {
        let id = parse_id(id)?;
        let names = self.id_titles();
        let md = self.doc(id)?.body_markdown(&|t| names.get(t).cloned())?;
        Ok(md)
    }

    pub fn reminders(&self) -> CoreResult<Vec<Reminder>> {
        let now = Timestamp::now().to_zoned(TimeZone::system());
        let start = now
            .start_of_day()
            .map_err(|e| CoreError::new("time", e.to_string()))?
            .timestamp()
            .as_millisecond();
        let end = now
            .end_of_day()
            .map_err(|e| CoreError::new("time", e.to_string()))?
            .timestamp()
            .as_millisecond();
        let mut out = Vec::new();
        for r in self.index.list(&Filter {
            due_before: Some(end),
            order: Order::Due,
            ..Default::default()
        })? {
            let done = serde_json::from_str::<J>(&r.fields)
                .ok()
                .and_then(|f| f.get("status").and_then(J::as_str).map(str::to_owned))
                .as_deref()
                == Some("done");
            if done || r.state == "archived" {
                continue;
            }
            let at = r.due.unwrap_or(end);
            out.push(Reminder {
                id: r.id,
                title: r.title,
                kind: if at < start { "overdue" } else { "today" }.to_owned(),
                when: Some(at as f64),
            });
        }
        for r in self.index.recheck_due(&today())? {
            out.push(Reminder {
                id: r.id,
                title: r.title,
                kind: "recheck".to_owned(),
                when: None,
            });
        }
        if self.rule_on("schedule")? {
            for e in self.agenda(now.timestamp().as_millisecond() as f64, end as f64)? {
                out.push(Reminder {
                    id: e.item.id,
                    title: e.item.title,
                    kind: "today".to_owned(),
                    when: Some(e.start),
                });
            }
        }
        out.extend(self.rule_reminders(&now, end)?);
        Ok(out)
    }

    /// Everything the star map draws. 机密 items are not part of it at all.
    pub fn graph(&self) -> CoreResult<GraphData> {
        let items = self
            .index
            .list(&Filter::default())?
            .into_iter()
            .filter(|r| r.privacy != "confidential" && !dem_model::is_system_type(&r.type_id))
            .map(Into::into)
            .collect();
        Ok(GraphData {
            items,
            links: self.index.all_links()?,
        })
    }

    // ---- the body, through the editor's own replica ----------------------------------------

    /// The document's bytes for the editor to load (format spec §6.4: a new replica).
    pub fn open_body(&mut self, id: &str) -> CoreResult<String> {
        let id = parse_id(id)?;
        let bytes = self.doc(id)?.export_for_editor()?;
        Ok(BASE64.encode(&bytes))
    }

    /// Changes from the editor. Saving them is one update file; a burst is merged by the editor
    /// before it gets here.
    pub fn apply_body(&mut self, id: &str, update: &str) -> CoreResult<ItemView> {
        let id = parse_id(id)?;
        let bytes = BASE64
            .decode(update.as_bytes())
            .map_err(|_| CoreError::invalid("update"))?;
        let doc = self.doc(id)?;
        doc.import(&bytes)?;
        doc.touch(Timestamp::now())?;
        doc.commit(ChangeOrigin::Me, None);
        let ty = doc.meta()?.type_id.0;
        self.edited(id, &ty)?;
        self.persist(id)
    }

    pub fn body_words(&mut self, id: &str) -> CoreResult<u32> {
        let id = parse_id(id)?;
        let text = self.doc(id)?.body_text();
        Ok(text.chars().filter(|c| !c.is_whitespace()).count() as u32)
    }

    // ---- versions ------------------------------------------------------------------------

    pub fn history(&mut self, id: &str) -> CoreResult<Vec<VersionView>> {
        let id = parse_id(id)?;
        let doc = self.doc(id)?;
        let labels = doc.labels();
        let changes = doc.history();
        let mut out: Vec<VersionView> = Vec::new();
        for c in &changes {
            let version = format!("[[{},{}]]", c.peer, c.counter + c.ops as i32 - 1);
            let at = c.timestamp as f64 * 1000.0;
            let origin = match c.message.as_deref() {
                Some(m) if m.starts_with("ai") => "ai",
                Some(m) if m.starts_with("import") => "import",
                Some("system") => "system",
                _ => "me",
            };
            // Five minutes of typing is one version.
            if let Some(last) = out.last_mut()
                && last.origin == origin
                && at - last.at < 300_000.0
            {
                last.version = version;
                last.at = at;
                continue;
            }
            out.push(VersionView {
                version,
                at,
                label: None,
                origin: origin.to_owned(),
            });
        }
        // A named point is its own entry, wherever it falls: Loro may have merged later commits
        // into the same change, so find the change that holds it.
        for (name, version) in labels {
            let point: Vec<(u64, i32)> = serde_json::from_str(&version).unwrap_or_default();
            let at = point
                .first()
                .and_then(|(peer, counter)| {
                    changes.iter().find(|c| {
                        c.peer == *peer
                            && *counter >= c.counter
                            && *counter < c.counter + c.ops as i32
                    })
                })
                .map_or(0.0, |c| c.timestamp as f64 * 1000.0);
            out.push(VersionView {
                version,
                at,
                label: Some(name),
                origin: "me".to_owned(),
            });
        }
        // Newest first; within one second, later changes still come first.
        out.reverse();
        out.sort_by(|a, b| b.at.total_cmp(&a.at));
        Ok(out)
    }

    /// The body's paragraphs at a version, for comparing two.
    pub fn version_text(&mut self, id: &str, version: &str) -> CoreResult<Vec<String>> {
        let id = parse_id(id)?;
        let text = self
            .doc(id)?
            .body_text_at(version)?
            .ok_or_else(|| CoreError::new("not-found", "version"))?;
        Ok(text.split('\n').map(str::to_owned).collect())
    }

    /// Back to how the text was at a version, as a new change: history keeps both, and the title,
    /// the level and the rest of the item stay as they are now.
    /// What is there now gets the name `before`, so it can always be found again.
    pub fn restore_version(
        &mut self,
        id: &str,
        version: &str,
        before: &str,
    ) -> CoreResult<ItemView> {
        let id = parse_id(id)?;
        let doc = self.doc(id)?;
        let ty = doc.meta()?.type_id.0;
        let now = doc.version();
        if !doc.restore_body(version)? {
            return Err(CoreError::new("not-found", "version"));
        }
        doc.add_label(before, &now)?;
        doc.touch(Timestamp::now())?;
        doc.commit(ChangeOrigin::Me, None);
        self.edited(id, &ty)?;
        self.persist(id)
    }

    pub fn name_version(&mut self, id: &str, version: &str, name: &str) -> CoreResult<()> {
        let id = parse_id(id)?;
        let doc = self.doc(id)?;
        doc.add_label(name, version)?;
        doc.commit(ChangeOrigin::Me, None);
        self.persist(id)?;
        Ok(())
    }

    // ---- structure -----------------------------------------------------------------------

    pub fn tree(&mut self) -> CoreResult<Vec<TreeNode>> {
        let mut out = Vec::new();
        for n in self.structure.nodes() {
            let doc = self.doc(n.item)?;
            let meta = doc.meta()?;
            if meta.state == ItemState::Trashed {
                continue;
            }
            out.push(TreeNode {
                id: n.item.to_string(),
                kind: match n.kind {
                    NodeKind::Domain => "domain",
                    NodeKind::Project => "project",
                }
                .to_owned(),
                parent: n.parent.map(|p| p.to_string()),
                title: meta.title,
                privacy: privacy_str(meta.privacy).to_owned(),
                state: state_str(meta.state).to_owned(),
            });
        }
        Ok(out)
    }

    /// 目录 is the one place a 机密 title shows (2026-11-02): read from the item itself, since the
    /// index does not hold it.
    pub fn directory_titles(&mut self) -> CoreResult<Vec<ItemView>> {
        let rows = self.index.list(&Filter {
            states: vec!["active".into(), "inbox".into()],
            order: Order::Title,
            ..Default::default()
        })?;
        let mut out: Vec<ItemView> = Vec::with_capacity(rows.len());
        for r in rows
            .into_iter()
            .filter(|r| !dem_model::is_system_type(&r.type_id))
        {
            if r.privacy == "confidential" {
                let id = parse_id(&r.id)?;
                out.push(view_of(self.doc(id)?)?);
            } else {
                out.push(r.into());
            }
        }
        Ok(out)
    }

    /// A project goes under a domain, a domain under a domain or nothing (format spec §7).
    pub fn move_node(&mut self, id: &str, parent: Option<&str>) -> CoreResult<()> {
        let item = parse_id(id)?;
        let parent = parent.map(parse_id).transpose()?;
        let kind = self
            .structure
            .nodes()
            .into_iter()
            .find(|n| n.item == item)
            .map(|n| n.kind)
            .ok_or_else(|| CoreError::new("not-found", "node"))?;
        let parent_kind = match parent {
            Some(p) => Some(
                self.structure
                    .nodes()
                    .into_iter()
                    .find(|n| n.item == p)
                    .map(|n| n.kind)
                    .ok_or_else(|| CoreError::new("not-found", "parent"))?,
            ),
            None => None,
        };
        if matches!(parent_kind, Some(NodeKind::Project)) {
            return Err(CoreError::invalid("nothing goes under a project"));
        }
        if kind == NodeKind::Project && parent_kind.is_none() {
            return Err(CoreError::invalid("a project goes under a domain"));
        }
        self.structure.move_to(item, parent)?;
        self.structure.commit("me");
        self.lib.save_structure(&mut self.structure)?;
        let doc = self.doc(item)?;
        doc.set_container(parent)?;
        doc.commit(ChangeOrigin::Me, None);
        self.persist(item)?;
        Ok(())
    }

    // ---- types ---------------------------------------------------------------------------

    pub fn types(&self) -> Vec<TypeDef> {
        self.types.clone()
    }

    /// Saves a type. A field that goes away keeps its data in the items, it is just no longer
    /// shown (M1). Built-in types keep their identity: only their fields can grow.
    pub fn save_type(&mut self, mut def: TypeDef) -> CoreResult<TypeDef> {
        if def.id.is_empty() {
            def.id = uuid::Uuid::now_v7().to_string();
        }
        def.builtin = self.type_def(&def.id).is_some_and(|t| t.builtin);
        if def.name.trim().is_empty() {
            return Err(CoreError::invalid("type name"));
        }
        self.lib.save_type(&def)?;
        match self.types.iter_mut().find(|t| t.id == def.id) {
            Some(t) => *t = def.clone(),
            None => self.types.push(def.clone()),
        }
        Ok(def)
    }

    // ---- attachments and settings ----------------------------------------------------------

    pub fn put_blob(&self, data_base64: &str) -> CoreResult<String> {
        let bytes = BASE64
            .decode(data_base64.as_bytes())
            .map_err(|_| CoreError::invalid("data"))?;
        Ok(self.lib.put_blob(&bytes)?.to_string())
    }

    /// Writes an attachment out where the user chose: decrypted, because they asked for the file.
    pub fn save_blob(&self, name: &str, path: &str) -> CoreResult<()> {
        let file = std::fs::File::create(path).map_err(|e| CoreError::new("io", e.to_string()))?;
        self.lib.read_blob(name, file)?;
        Ok(())
    }

    pub fn get_blob(&self, name: &str) -> CoreResult<String> {
        let mut out = Vec::new();
        self.lib.read_blob(name, &mut out)?;
        Ok(BASE64.encode(&out))
    }

    /// This device's settings (layout, spaces…), sealed like everything else.
    pub fn local_get(&self, key: &str) -> CoreResult<Option<String>> {
        check_local_key(key)?;
        Ok(self
            .lib
            .read_local(&format!("{key}.json"))?
            .map(|b| String::from_utf8_lossy(&b).into_owned()))
    }

    pub fn local_set(&self, key: &str, value: &str) -> CoreResult<()> {
        check_local_key(key)?;
        Ok(self
            .lib
            .write_local(&format!("{key}.json"), value.as_bytes())?)
    }

    pub fn verify_password(&self, password: &str) -> bool {
        self.lib.check_password(password.as_bytes())
    }

    pub fn library_path(&self) -> String {
        self.lib.root().display().to_string()
    }

    /// Before closing: fold update files of everything that was open.
    pub(crate) fn flush(&mut self) {
        for doc in self.docs.values_mut() {
            if self.lib.save_item(doc).is_err() {
                tracing::warn!("an item could not be saved on closing");
            }
        }
    }
}

fn check_local_key(key: &str) -> CoreResult<()> {
    let ok = !key.is_empty()
        && key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if ok && key != "device" {
        Ok(())
    } else {
        Err(CoreError::invalid("settings key"))
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
pub(crate) mod tests {
    use super::*;
    use crate::core::{Core, MemoryKeychain};
    use dem_crypto::keys::KdfParams;

    pub(crate) fn open_core(dir: &std::path::Path) -> Core {
        let c = Core::with_kdf(
            dir.join("config"),
            dir.join("docs"),
            Box::new(MemoryKeychain::default()),
            KdfParams::INSECURE_FOR_TESTS,
        );
        c.prepare_library("库", dir.to_str().unwrap(), "correct horse")
            .unwrap();
        c.commit_library().unwrap();
        c
    }

    pub(crate) fn new_note(title: &str) -> NewItem {
        NewItem {
            type_id: "note".into(),
            title: Some(title.into()),
            state: None,
            container: None,
            privacy: None,
            fields: None,
            tags: None,
            due: None,
            markdown: None,
        }
    }

    #[test]
    fn creates_lists_finds_updates_and_survives_reopening() {
        let d = tempfile::tempdir().unwrap();
        let c = open_core(d.path());
        let id = c
            .with(|s| {
                s.create_item(NewItem {
                    markdown: Some("# 复合过去时\n\n助动词加过去分词。\n".into()),
                    tags: Some(vec!["法语".into()]),
                    ..new_note("第 12 课")
                })
            })
            .unwrap()
            .id;
        c.with(|s| {
            let hits = s.search("过去分词", 5)?;
            assert_eq!(hits[0].item.id, id);
            assert!(hits[0].snippet.contains('\u{2045}'));
            assert_eq!(s.tags()?[0].tag, "法语");
            s.update_item(
                &id,
                ItemPatch {
                    title: Some(Some("第十二课".into())),
                    ..Default::default()
                },
            )?;
            Ok(())
        })
        .unwrap();
        let path = c.start_state().library.unwrap().path;
        c.lock().unwrap();
        assert!(c.unlock_password(&path, "correct horse").unwrap());
        c.with(|s| {
            let item = s.get_item(&id)?;
            assert_eq!(item.title.as_deref(), Some("第十二课"));
            assert_eq!(s.search("第十二课", 5)?.len(), 1);
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn rebuilds_the_index_from_nothing_after_it_is_deleted() {
        let d = tempfile::tempdir().unwrap();
        let c = open_core(d.path());
        let path = c.start_state().library.unwrap().path;
        c.with(|s| {
            s.create_item(NewItem {
                markdown: Some("独一无二的内容\n".into()),
                ..new_note("甲")
            })?;
            Ok(())
        })
        .unwrap();
        c.lock().unwrap();
        for f in ["index.sqlite", "index.sqlite-wal", "index.sqlite-shm"] {
            let _ = std::fs::remove_file(std::path::Path::new(&path).join(f));
        }
        assert!(c.unlock_password(&path, "correct horse").unwrap());
        c.with(|s| {
            assert_eq!(s.search("独一无二", 5)?.len(), 1);
            assert!(!s.activity_since("2000-01-01")?.is_empty());
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn leaves_nothing_readable_on_disk() {
        let d = tempfile::tempdir().unwrap();
        let c = open_core(d.path());
        let path = c.start_state().library.unwrap().path;
        c.with(|s| {
            s.create_item(NewItem {
                markdown: Some("UNIQUECANARYBODY\n".into()),
                tags: Some(vec!["UNIQUECANARYTAG".into()]),
                ..new_note("UNIQUECANARYTITLE")
            })?;
            s.local_set("layout", "UNIQUECANARYLAYOUT")?;
            Ok(())
        })
        .unwrap();
        c.lock().unwrap();
        fn walk(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
            for e in std::fs::read_dir(dir).unwrap() {
                let p = e.unwrap().path();
                if p.is_dir() {
                    walk(&p, out);
                } else {
                    out.push(p);
                }
            }
        }
        let mut files = Vec::new();
        walk(std::path::Path::new(&path), &mut files);
        assert!(files.len() > 3);
        for f in files {
            let raw = std::fs::read(&f).unwrap();
            assert!(
                !String::from_utf8_lossy(&raw).contains("UNIQUECANARY"),
                "{}",
                f.display()
            );
        }
    }

    #[test]
    fn restoring_a_version_brings_the_text_back_and_leaves_the_rest_alone() {
        let dir = tempfile::tempdir().unwrap();
        let core = open_core(dir.path());
        core.with(|s| {
            let mut note = new_note("标题");
            note.markdown = Some("第一版\n".into());
            let item = s.create_item(note)?;
            let id = parse_id(&item.id)?;
            let first = s.history(&item.id)?.remove(0).version;
            s.doc(id)?.set_body_text("第二版")?;
            s.doc(id)?.commit(ChangeOrigin::Me, None);
            s.update_item(
                &item.id,
                ItemPatch {
                    privacy: Some("private".into()),
                    title: Some(Some("新标题".into())),
                    ..Default::default()
                },
            )?;
            s.restore_version(&item.id, &first, "恢复前")?;
            let text = s.doc(id)?.body_text();
            assert!(text.contains("第一版"), "{text}");
            assert!(!text.contains("第二版"), "{text}");
            let now = s.get_item(&item.id)?;
            assert_eq!(now.privacy, "private", "restoring never lowers the level");
            assert_eq!(now.title.as_deref(), Some("新标题"));
            // What was there before is still there, under its name.
            let back = s
                .history(&item.id)?
                .into_iter()
                .find(|v| v.label.as_deref() == Some("恢复前"))
                .unwrap();
            s.restore_version(&item.id, &back.version, "恢复前 1")?;
            assert!(s.doc(id)?.body_text().contains("第二版"));
            assert!(
                s.restore_version(&item.id, "not a version", "恢复前 2")
                    .is_err()
            );
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn occurred_dates_read_what_people_type() {
        let dir = tempfile::tempdir().unwrap();
        let core = open_core(dir.path());
        core.with(|s| {
            let mut event = new_note("统一");
            event.type_id = "event".into();
            let item = s.create_item(event)?;
            let typed = |t: &str| ItemPatch {
                occurred: Some(Some(t.into())),
                ..Default::default()
            };
            let v = s.update_item(&item.id, typed("公元前221年"))?;
            assert_eq!(v.occurred.as_deref(), Some("公元前221年"));
            assert!(s.update_item(&item.id, typed("明天")).is_err());
            let clear: ItemPatch = serde_json::from_str(r#"{"occurred":null}"#).unwrap();
            assert_eq!(s.update_item(&item.id, clear)?.occurred, None);
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn a_file_keeps_its_bytes_and_its_text_can_be_searched() {
        let dir = tempfile::tempdir().unwrap();
        let core = open_core(dir.path());
        let src = dir.path().join("讲义.txt");
        std::fs::write(&src, "独特词语 zzfilezz").unwrap();
        core.with(|s| {
            let r = s.import_files(&[src.to_string_lossy().into_owned()])?;
            assert_eq!(r.created, 1);
            let hits = s.search("zzfilezz", 5)?;
            assert_eq!(hits.len(), 1);
            let item = s.get_item(&hits[0].item.id)?;
            assert_eq!(item.type_id, "file");
            assert_eq!(item.title.as_deref(), Some("讲义"));
            let fields: J = serde_json::from_str(&item.fields).unwrap();
            let out = dir.path().join("out.txt");
            s.save_blob(fields["blob"].as_str().unwrap(), &out.to_string_lossy())?;
            assert_eq!(std::fs::read_to_string(&out).unwrap(), "独特词语 zzfilezz");
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn confidential_items_stay_out_of_lists_of_titles_and_search() {
        let d = tempfile::tempdir().unwrap();
        let c = open_core(d.path());
        c.with(|s| {
            let id = s
                .create_item(NewItem {
                    privacy: Some("confidential".into()),
                    markdown: Some("号码是一串数字\n".into()),
                    ..new_note("护照")
                })?
                .id;
            assert!(s.search("护照", 5)?.is_empty());
            assert!(s.search("号码", 5)?.is_empty());
            let listed = s.list_items(&ListQuery {
                type_id: None,
                states: None,
                container: None,
                tag: None,
                order: None,
                limit: None,
            })?;
            assert_eq!(listed[0].title, None);
            assert!(s.graph()?.items.iter().all(|i| i.id != id));
            // 目录 is the one place it shows.
            let dir = s.directory_titles()?;
            assert_eq!(dir[0].title.as_deref(), Some("护照"));
            assert_eq!(s.get_item(&id)?.title.as_deref(), Some("护照"));
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn privacy_passes_down_to_new_items_and_the_web_mark_needs_sensitive() {
        let d = tempfile::tempdir().unwrap();
        let c = open_core(d.path());
        c.with(|s| {
            let parent = s
                .create_item(NewItem {
                    type_id: "domain".into(),
                    privacy: Some("private".into()),
                    ..new_note("私事")
                })?
                .id;
            let child = s.create_item(NewItem {
                container: Some(parent.clone()),
                ..new_note("里面的")
            })?;
            assert_eq!(child.privacy, "private");
            let plain = s.create_item(new_note("普通的"))?;
            let refused = s.update_item(
                &plain.id,
                ItemPatch {
                    ai_web: Some(true),
                    ..Default::default()
                },
            );
            assert_eq!(refused.unwrap_err().code, "invalid");
            let marked = s.update_item(
                &plain.id,
                ItemPatch {
                    privacy: Some("sensitive".into()),
                    ai_web: Some(true),
                    ..Default::default()
                },
            )?;
            assert!(marked.ai_web);
            let raised = s.update_item(
                &plain.id,
                ItemPatch {
                    privacy: Some("private".into()),
                    ..Default::default()
                },
            )?;
            assert!(!raised.ai_web);
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn trash_then_restore_then_gone_for_good() {
        let d = tempfile::tempdir().unwrap();
        let c = open_core(d.path());
        c.with(|s| {
            let id = s.create_item(new_note("甲"))?.id;
            let patch = |state: &str| ItemPatch {
                state: Some(state.into()),
                ..Default::default()
            };
            s.update_item(&id, patch("trashed"))?;
            assert!(s.search("甲", 5)?.is_empty());
            s.update_item(&id, patch("active"))?;
            assert_eq!(s.search("甲", 5)?.len(), 1);
            s.update_item(&id, patch("trashed"))?;
            assert_eq!(s.empty_trash()?, 1);
            assert_eq!(s.get_item(&id).unwrap_err().code, "not-found");
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn keeps_a_structure_of_domains_and_projects() {
        let d = tempfile::tempdir().unwrap();
        let c = open_core(d.path());
        c.with(|s| {
            let new = |ty: &str, title: &str, parent: Option<String>| NewItem {
                type_id: ty.into(),
                container: parent,
                ..new_note(title)
            };
            let lang = s.create_item(new("domain", "语言", None))?.id;
            let other = s.create_item(new("domain", "别的", None))?.id;
            let fr = s
                .create_item(new("project", "法语", Some(lang.clone())))?
                .id;
            let tree = s.tree()?;
            assert_eq!(tree.len(), 3);
            assert_eq!(
                tree.iter().find(|n| n.id == fr).unwrap().parent.as_deref(),
                Some(lang.as_str())
            );
            assert_eq!(s.move_node(&fr, None).unwrap_err().code, "invalid");
            assert_eq!(s.move_node(&other, Some(&fr)).unwrap_err().code, "invalid");
            s.move_node(&fr, Some(&other))?;
            assert_eq!(s.get_item(&fr)?.container.as_deref(), Some(other.as_str()));
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn links_in_the_body_make_backlinks() {
        let d = tempfile::tempdir().unwrap();
        let c = open_core(d.path());
        c.with(|s| {
            let target = s.create_item(new_note("第 11 课"))?.id;
            let from = s
                .create_item(NewItem {
                    markdown: Some("见 [[第 11 课]]。\n".into()),
                    ..new_note("第 12 课")
                })?
                .id;
            assert_eq!(s.backlinks(&target)?[0].id, from);
            assert_eq!(s.graph()?.links[0], (from, target));
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn a_decision_asks_to_be_looked_back_at_and_a_rule_can_be_turned_off() {
        let d = tempfile::tempdir().unwrap();
        let c = open_core(d.path());
        c.with(|s| {
            s.local_set("reminder-rules-off", r#"["review"]"#)?;
            let item = s.create_item(NewItem {
                type_id: "decision".into(),
                fields: Some(r#"{"review_on":"2020-01-01"}"#.into()),
                ..new_note("选哪个学校")
            })?;
            let kinds = |s: &Session| -> Vec<String> {
                s.reminders().unwrap().into_iter().map(|r| r.kind).collect()
            };
            assert_eq!(kinds(s), ["decision"]);
            s.update_item(
                &item.id,
                ItemPatch {
                    fields: Some(r#"{"looked_back":"判断对了"}"#.into()),
                    ..Default::default()
                },
            )?;
            assert!(kinds(s).is_empty());
            s.update_item(
                &item.id,
                ItemPatch {
                    fields: Some(r#"{"looked_back":""}"#.into()),
                    ..Default::default()
                },
            )?;
            s.local_set("reminder-rules-off", r#"["review","decision"]"#)?;
            assert!(kinds(s).is_empty());
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn reminds_about_what_is_due_and_not_what_is_done() {
        let d = tempfile::tempdir().unwrap();
        let c = open_core(d.path());
        c.with(|s| {
            s.local_set("reminder-rules-off", r#"["review","stale"]"#)?;
            let past = Timestamp::now().as_millisecond() as f64 - 86_400_000.0 * 3.0;
            let later = Timestamp::now().as_millisecond() as f64 + 86_400_000.0 * 30.0;
            let todo = |title: &str, due: f64, status: &str| NewItem {
                type_id: "todo".into(),
                due: Some(due),
                fields: Some(format!("{{\"status\":\"{status}\"}}")),
                ..new_note(title)
            };
            let late = s.create_item(todo("迟了", past, "next"))?.id;
            s.create_item(todo("做完了", past, "done"))?;
            s.create_item(todo("还早", later, "next"))?;
            let r = s.reminders()?;
            assert_eq!(r.len(), 1);
            assert_eq!(r[0].id, late);
            assert_eq!(r[0].kind, "overdue");
            let note = s.create_item(new_note("要复查的"))?.id;
            s.update_item(
                &note,
                ItemPatch {
                    source: Some(SourceView {
                        origin: "aiSearch".into(),
                        needs_check: false,
                        conflict: true,
                        recheck_on: Some("2020-01-01".into()),
                        refs: vec![],
                    }),
                    ..Default::default()
                },
            )?;
            assert!(s.reminders()?.iter().any(|x| x.kind == "recheck"));
            let got = s.get_item(&note)?.source.unwrap();
            assert!(got.conflict);
            assert_eq!(got.recheck_on.as_deref(), Some("2020-01-01"));
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn remembers_versions_and_their_names() {
        let d = tempfile::tempdir().unwrap();
        let c = open_core(d.path());
        c.with(|s| {
            let id = s
                .create_item(NewItem {
                    markdown: Some("第一版\n".into()),
                    ..new_note("甲")
                })?
                .id;
            let v1 = s.history(&id)?[0].version.clone();
            assert_eq!(s.version_text(&id, &v1)?, ["第一版"]);
            s.name_version(&id, &v1, "定稿")?;
            assert!(
                s.history(&id)?
                    .iter()
                    .any(|v| v.label.as_deref() == Some("定稿"))
            );
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn custom_types_can_be_made_and_used() {
        let d = tempfile::tempdir().unwrap();
        let c = open_core(d.path());
        let path = c.start_state().library.unwrap().path;
        let id = c
            .with(|s| {
                let def = s.save_type(TypeDef {
                    id: String::new(),
                    name: "投递".into(),
                    builtin: false,
                    default_view: dem_model::ViewKind::Board,
                    default_privacy: dem_model::PrivacyDto::Normal,
                    color: None,
                    fields: vec![],
                })?;
                assert!(!def.id.is_empty());
                let item = s.create_item(NewItem {
                    type_id: def.id.clone(),
                    fields: Some("{\"公司\":\"甲\"}".into()),
                    ..new_note("实习")
                })?;
                assert!(item.fields.contains("公司"));
                Ok(def.id)
            })
            .unwrap();
        c.lock().unwrap();
        assert!(c.unlock_password(&path, "correct horse").unwrap());
        c.with(|s| {
            assert!(s.types().iter().any(|t| t.id == id));
            assert!(s.types().iter().any(|t| t.id == "todo" && t.builtin));
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn settings_keys_cannot_escape_or_overwrite_the_device_file() {
        let d = tempfile::tempdir().unwrap();
        let c = open_core(d.path());
        c.with(|s| {
            assert_eq!(s.local_get("layout")?, None);
            s.local_set("layout", "{}")?;
            assert_eq!(s.local_get("layout")?.as_deref(), Some("{}"));
            assert!(s.local_set("../x", "{}").is_err());
            assert!(s.local_set("device", "{}").is_err());
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn the_master_password_can_be_checked() {
        let d = tempfile::tempdir().unwrap();
        let c = open_core(d.path());
        c.with(|s| {
            assert!(s.verify_password("correct horse"));
            assert!(!s.verify_password("wrong"));
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn the_calendar_shows_each_occurrence_and_no_secrets() {
        let dir = tempfile::tempdir().unwrap();
        let core = open_core(dir.path());
        core.with(|s| {
            let day = 86_400_000.0;
            let start = 1_795_000_000_000.0;
            let meeting = s.create_item(new_note("x"))?;
            let span = SpanView {
                start,
                end: start + 3_600_000.0,
                tz: "UTC".into(),
                recurrence: Some("FREQ=DAILY;COUNT=3".into()),
            };
            let on = ItemPatch {
                span: Some(Some(span.clone())),
                ..Default::default()
            };
            let got = s.update_item(&meeting.id, on.clone())?;
            assert_eq!(got.span.as_ref().map(|v| v.start), Some(start));
            assert_eq!(s.agenda(start - day, start + 10.0 * day)?.len(), 3);
            assert_eq!(s.agenda(start + day - 1.0, start + day + 1.0)?.len(), 1);
            assert!(s.agenda(start + 4.0 * day, start + 5.0 * day)?.is_empty());

            let secret = s.create_item(NewItem {
                privacy: Some("confidential".into()),
                ..new_note("x")
            })?;
            s.update_item(&secret.id, on)?;
            let ids: Vec<_> = s
                .agenda(start - day, start + 10.0 * day)?
                .into_iter()
                .map(|e| e.item.id)
                .collect();
            assert!(!ids.contains(&secret.id));
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn the_timeline_sorts_bce_first_and_reads_date_fields() {
        let dir = tempfile::tempdir().unwrap();
        let core = open_core(dir.path());
        core.with(|s| {
            let qin = s.create_item(NewItem {
                type_id: "event".into(),
                ..new_note("x")
            })?;
            let at = |t: &str| ItemPatch {
                occurred: Some(Some(t.into())),
                ..Default::default()
            };
            s.update_item(&qin.id, at("公元前221年"))?;
            let ming = s.create_item(NewItem {
                type_id: "event".into(),
                ..new_note("x")
            })?;
            s.update_item(&ming.id, at("1368年"))?;
            let diary = s.create_item(NewItem {
                fields: Some(r#"{"date":"2026-11-02"}"#.into()),
                type_id: "diary".into(),
                ..new_note("x")
            })?;
            let got: Vec<_> = s.timeline(None)?.into_iter().map(|e| e.item.id).collect();
            assert_eq!(got, [qin.id.clone(), ming.id.clone(), diary.id.clone()]);
            assert_eq!(s.timeline(Some("diary"))?.len(), 1);
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn a_whiteboard_keeps_its_nodes_and_finds_their_text() {
        let dir = tempfile::tempdir().unwrap();
        let core = open_core(dir.path());
        core.with(|s| {
            let board = s.create_item(NewItem {
                type_id: "whiteboard".into(),
                ..new_note("板")
            })?;
            let other = s.create_item(new_note("别的"))?;
            let node = format!(r#"{{"x":1,"text":"zzcanvaszz","item":"{}"}}"#, other.id);
            s.canvas_update(
                &board.id,
                HashMap::from([("n1".to_owned(), Some(node.clone()))]),
            )?;
            assert_eq!(s.canvas(&board.id)?.get("n1"), Some(&node));
            assert_eq!(s.search("zzcanvaszz", 5)?.len(), 1);
            assert_eq!(s.backlinks(&other.id)?.len(), 1);
            s.canvas_update(&board.id, HashMap::from([("n1".to_owned(), None)]))?;
            assert!(s.canvas(&board.id)?.is_empty());
            assert!(s.search("zzcanvaszz", 5)?.is_empty());
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn logs_hold_no_content() {
        let d = tempfile::tempdir().unwrap();
        let c = open_core(d.path());
        c.with(|s| {
            s.create_item(new_note("标题里的秘密"))?;
            let logs = s.lib.read_logs(LogKind::Activity)?;
            let json = serde_json::to_string(&logs.records).unwrap();
            assert!(!json.contains("秘密"));
            assert!(json.contains("create"));
            Ok(())
        })
        .unwrap();
    }
}
