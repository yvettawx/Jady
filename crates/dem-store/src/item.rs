//! Item documents (format spec §6): one Loro document per item.

use std::fmt;

use dem_model::{
    ChangeOrigin, ItemId, ItemMeta, ItemState, Privacy, SourceInfo, TagId, TimeAnchor, Timestamp,
    TypeId,
};
use loro::{
    Container, ExportMode, ID, LoroDoc, LoroList, LoroMap, LoroText, LoroValue, ToJson,
    ValueOrContainer, VersionVector,
};
use serde_json::Value as J;

use crate::{DOC_SCHEMA, Result, StoreError};

/// Keys in `fields` that belong to a whiteboard rather than to its type.
const CANVAS_PREFIX: &str = "canvas:";

/// Placeholder for inline atoms (item links, images) in plain-text views.
pub const OBJECT_CHAR: char = '\u{fffc}';

/// Editor nodes whose children are more blocks, not a line of text.
const BLOCK_CONTAINERS: &[&str] = &[
    "blockquote",
    "bullet_list",
    "ordered_list",
    "list_item",
    "task_list",
    "task_item",
];

/// One entry of an item's history.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChangeInfo {
    pub peer: u64,
    pub counter: i32,
    pub lamport: u32,
    /// Unix seconds as recorded by Loro (format spec §6.1).
    pub timestamp: i64,
    /// Commit message: `me`, `ai:<proposal>`, `import:<batch>`, `revert:<proposal>`, `system`.
    pub message: Option<String>,
    pub ops: u32,
}

/// An open item document. Tracks what has been persisted so `Library::save_item`
/// writes only the new changes as an update file.
pub struct ItemDoc {
    pub(crate) id: ItemId,
    pub(crate) doc: LoroDoc,
    pub(crate) saved: VersionVector,
}

impl fmt::Debug for ItemDoc {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ItemDoc")
            .field("id", &self.id)
            .finish_non_exhaustive()
    }
}

fn s(v: &str) -> LoroValue {
    LoroValue::from(v)
}

fn privacy_str(p: Privacy) -> &'static str {
    match p {
        Privacy::Normal => "normal",
        Privacy::Sensitive => "sensitive",
        Privacy::Private => "private",
        Privacy::Confidential => "confidential",
    }
}

fn state_str(st: ItemState) -> &'static str {
    match st {
        ItemState::Inbox => "inbox",
        ItemState::Active => "active",
        ItemState::Archived => "archived",
        ItemState::Trashed => "trashed",
    }
}

fn bad(what: &str) -> StoreError {
    StoreError::InvalidDocument(what.to_owned())
}

pub(crate) fn new_doc() -> LoroDoc {
    let doc = LoroDoc::new();
    doc.set_record_timestamp(true);
    // A fresh random peer id per replica (format spec §6.4).
    let _ = doc.set_peer_id(dem_crypto::random_u64() >> 1);
    doc
}

pub(crate) fn origin_message(origin: ChangeOrigin, detail: Option<&str>) -> String {
    match (origin, detail) {
        (ChangeOrigin::Me, _) => "me".to_owned(),
        (ChangeOrigin::Ai, Some(p)) => format!("ai:{p}"),
        (ChangeOrigin::Ai, None) => "ai".to_owned(),
        (ChangeOrigin::Import, Some(b)) => format!("import:{b}"),
        (ChangeOrigin::Import, None) => "import".to_owned(),
    }
}

impl ItemDoc {
    /// Creates the document skeleton (format spec §6.2). Only the core does this,
    /// once per item; every other replica loads the resulting bytes.
    pub fn create(meta: &ItemMeta) -> Result<ItemDoc> {
        let doc = new_doc();
        doc.get_map("dem").insert("schema", DOC_SCHEMA)?;
        let item = ItemDoc {
            id: meta.id,
            doc,
            saved: VersionVector::default(),
        };
        item.write_meta(meta)?;
        let body = item.doc.get_map("body");
        body.insert("nodeName", "doc")?;
        body.insert_container("attributes", LoroMap::new())?;
        body.insert_container("children", LoroList::new())?;
        item.doc.get_map("fields");
        item.doc.get_map("links");
        item.doc.get_list("labels");
        item.commit_raw("system");
        Ok(item)
    }

    /// Loads a document from a snapshot followed by any number of updates.
    pub(crate) fn load(id: ItemId, parts: &[Vec<u8>]) -> Result<ItemDoc> {
        let doc = new_doc();
        for p in parts {
            doc.import(p)?;
        }
        let item = ItemDoc {
            id,
            saved: doc.oplog_vv(),
            doc,
        };
        item.check_schema()?;
        Ok(item)
    }

    fn check_schema(&self) -> Result<()> {
        match self.doc.get_map("dem").get("schema") {
            Some(ValueOrContainer::Value(LoroValue::I64(DOC_SCHEMA))) => Ok(()),
            Some(ValueOrContainer::Value(LoroValue::I64(v))) => Err(StoreError::InvalidDocument(
                format!("unsupported schema {v}"),
            )),
            _ => Err(bad("missing dem.schema")),
        }
    }

    pub fn id(&self) -> ItemId {
        self.id
    }

    pub(crate) fn loro(&self) -> &LoroDoc {
        &self.doc
    }

    fn write_meta(&self, m: &ItemMeta) -> Result<()> {
        let meta = self.doc.get_map("meta");
        meta.insert("type", s(&m.type_id.0))?;
        self.set_title(m.title.as_deref())?;
        meta.insert("state", state_str(m.state))?;
        meta.insert("privacy", privacy_str(m.privacy))?;
        if m.ai_web {
            meta.insert("ai_web", true)?;
        }
        match m.container {
            Some(c) => meta.insert("container", s(&c.to_string()))?,
            None => meta.insert("container", LoroValue::Null)?,
        }
        meta.insert("created", m.created.as_millisecond())?;
        meta.insert("updated", m.updated.as_millisecond())?;
        let time = match &m.time {
            Some(t) => s(&serde_json::to_string(t).map_err(|e| bad(&e.to_string()))?),
            None => LoroValue::Null,
        };
        meta.insert("time", time)?;
        meta.insert(
            "source",
            s(&serde_json::to_string(&m.source).map_err(|e| bad(&e.to_string()))?),
        )?;
        let tags = meta.insert_container("tags", LoroMap::new())?;
        for t in &m.tags {
            tags.insert(&t.0, true)?;
        }
        Ok(())
    }

    pub fn meta(&self) -> Result<ItemMeta> {
        let v = self.doc.get_map("meta").get_deep_value().to_json_value();
        let str_of = |k: &str| v.get(k).and_then(J::as_str);
        let ms = |k: &str| -> Result<Timestamp> {
            let n = v.get(k).and_then(J::as_i64).ok_or_else(|| bad(k))?;
            Timestamp::from_millisecond(n).map_err(|_| bad(k))
        };
        let state = match str_of("state") {
            Some("inbox") => ItemState::Inbox,
            Some("active") => ItemState::Active,
            Some("archived") => ItemState::Archived,
            Some("trashed") => ItemState::Trashed,
            _ => return Err(bad("meta.state")),
        };
        let privacy = match str_of("privacy") {
            Some("normal") => Privacy::Normal,
            Some("sensitive") => Privacy::Sensitive,
            Some("private") => Privacy::Private,
            Some("confidential") => Privacy::Confidential,
            _ => return Err(bad("meta.privacy")),
        };
        let container = match str_of("container") {
            Some(c) => Some(c.parse::<ItemId>().map_err(|_| bad("meta.container"))?),
            None => None,
        };
        let time: Option<TimeAnchor> = match str_of("time") {
            Some(t) => Some(serde_json::from_str(t).map_err(|_| bad("meta.time"))?),
            None => None,
        };
        let source: SourceInfo = match str_of("source") {
            Some(t) => serde_json::from_str(t).map_err(|_| bad("meta.source"))?,
            None => SourceInfo::default(),
        };
        let mut tags: Vec<TagId> = v
            .get("tags")
            .and_then(J::as_object)
            .map(|o| {
                o.iter()
                    .filter(|(_, on)| on.as_bool() == Some(true))
                    .map(|(k, _)| TagId(k.clone()))
                    .collect()
            })
            .unwrap_or_default();
        tags.sort();
        Ok(ItemMeta {
            id: self.id,
            type_id: TypeId(str_of("type").ok_or_else(|| bad("meta.type"))?.to_owned()),
            title: str_of("title").map(str::to_owned),
            state,
            privacy,
            container,
            tags,
            created: ms("created")?,
            updated: ms("updated")?,
            time,
            source,
            ai_web: v.get("ai_web").and_then(J::as_bool) == Some(true),
        })
    }

    pub fn set_ai_web(&self, on: bool) -> Result<()> {
        self.doc.get_map("meta").insert("ai_web", on)?;
        Ok(())
    }

    pub fn set_time(&self, time: Option<&TimeAnchor>) -> Result<()> {
        let v = match time {
            Some(t) => s(&serde_json::to_string(t).map_err(|e| bad(&e.to_string()))?),
            None => LoroValue::Null,
        };
        self.doc.get_map("meta").insert("time", v)?;
        Ok(())
    }

    pub fn set_source(&self, source: &SourceInfo) -> Result<()> {
        self.doc.get_map("meta").insert(
            "source",
            s(&serde_json::to_string(source).map_err(|e| bad(&e.to_string()))?),
        )?;
        Ok(())
    }

    pub fn touch(&self, at: Timestamp) -> Result<()> {
        self.doc
            .get_map("meta")
            .insert("updated", at.as_millisecond())?;
        Ok(())
    }

    /// Targets of the `item_link` nodes in the body (format spec §11).
    pub fn body_links(&self) -> Vec<ItemId> {
        fn walk(v: &J, out: &mut Vec<ItemId>) {
            if v.get("nodeName").and_then(J::as_str) == Some("item_link")
                && let Some(t) = v
                    .get("attributes")
                    .and_then(|a| a.get("target"))
                    .and_then(J::as_str)
                && let Ok(id) = t.parse()
            {
                out.push(id);
            }
            if let Some(kids) = v.get("children").and_then(J::as_array) {
                for k in kids {
                    walk(k, out);
                }
            }
        }
        let mut out = Vec::new();
        walk(
            &self.doc.get_map("body").get_deep_value().to_json_value(),
            &mut out,
        );
        out.sort();
        out.dedup();
        out
    }

    /// The whole document's bytes, for the editor's own replica to load.
    pub fn export_for_editor(&self) -> Result<Vec<u8>> {
        self.export_snapshot()
    }

    /// Makes the document as it was at a version, as new changes, then puts everything except the
    /// body back: restoring text must not change the title, the level or anything else. Returns
    /// false if that version is unknown.
    pub fn restore_body(&self, frontiers_json: &str) -> Result<bool> {
        let Ok(ids) = serde_json::from_str::<Vec<(u64, i32)>>(frontiers_json) else {
            return Ok(false);
        };
        let frontiers = loro::Frontiers::from(
            ids.into_iter()
                .map(|(peer, counter)| loro::ID::new(peer, counter))
                .collect::<Vec<_>>(),
        );
        if self.doc.fork_at(&frontiers).is_err() {
            return Ok(false);
        }
        let meta = self.meta()?;
        let fields = self.fields();
        let labels = self.labels();
        self.doc
            .revert_to(&frontiers)
            .map_err(|e| bad(&e.to_string()))?;
        self.write_meta(&meta)?;
        for (name, version) in &labels {
            self.add_label(name, version)?;
        }
        for (k, v) in &fields {
            self.set_field(k, v)?;
        }
        // The very first version may have had no text at all; the editor needs one block.
        if self.body_children()?.is_empty() {
            self.append_paragraph("")?;
        }
        Ok(true)
    }

    /// The body's plain text as it was at a version; `None` if that version is unknown.
    pub fn body_text_at(&self, frontiers_json: &str) -> Result<Option<String>> {
        let ids: Vec<(u64, i32)> =
            serde_json::from_str(frontiers_json).map_err(|_| bad("version"))?;
        let frontiers = loro::Frontiers::from(
            ids.into_iter()
                .map(|(peer, counter)| loro::ID::new(peer, counter))
                .collect::<Vec<_>>(),
        );
        let Ok(fork) = self.doc.fork_at(&frontiers) else {
            return Ok(None);
        };
        let at = ItemDoc {
            id: self.id,
            doc: fork,
            saved: VersionVector::default(),
        };
        Ok(Some(at.body_text()))
    }

    /// The current version, in the form `body_text_at` takes.
    pub fn version(&self) -> String {
        let ids: Vec<(u64, i32)> = self
            .doc
            .state_frontiers()
            .iter()
            .map(|id| (id.peer, id.counter))
            .collect();
        serde_json::to_string(&ids).unwrap_or_else(|_| "[]".to_owned())
    }

    /// Names a version (format spec §6.2 `labels`).
    pub fn add_label(&self, name: &str, version: &str) -> Result<()> {
        let labels = self.doc.get_list("labels");
        let m: LoroMap = labels.push_container(LoroMap::new())?;
        m.insert("name", name)?;
        m.insert("version", version)?;
        m.insert("created", Timestamp::now().as_millisecond())?;
        Ok(())
    }

    pub fn labels(&self) -> Vec<(String, String)> {
        let v = self.doc.get_list("labels").get_deep_value().to_json_value();
        v.as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|m| {
                        Some((
                            m.get("name")?.as_str()?.to_owned(),
                            m.get("version")?.as_str()?.to_owned(),
                        ))
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn set_title(&self, title: Option<&str>) -> Result<()> {
        let meta = self.doc.get_map("meta");
        match title {
            Some(t) => meta.insert("title", t)?,
            None => meta.insert("title", LoroValue::Null)?,
        }
        Ok(())
    }

    pub fn set_state(&self, st: ItemState) -> Result<()> {
        self.doc.get_map("meta").insert("state", state_str(st))?;
        Ok(())
    }

    pub fn set_privacy(&self, p: Privacy) -> Result<()> {
        self.doc.get_map("meta").insert("privacy", privacy_str(p))?;
        Ok(())
    }

    pub fn set_container(&self, c: Option<ItemId>) -> Result<()> {
        let meta = self.doc.get_map("meta");
        match c {
            Some(c) => meta.insert("container", s(&c.to_string()))?,
            None => meta.insert("container", LoroValue::Null)?,
        }
        Ok(())
    }

    pub fn set_tag(&self, tag: &TagId, on: bool) -> Result<()> {
        // The skeleton always creates `tags`; do not use mergeable child containers
        // (format spec §6.1).
        let tags = match self.doc.get_map("meta").get("tags") {
            Some(ValueOrContainer::Container(Container::Map(m))) => m,
            _ => return Err(bad("meta.tags")),
        };
        if on {
            tags.insert(&tag.0, true)?
        } else {
            tags.delete(&tag.0)?
        }
        Ok(())
    }

    /// Sets a type-specific field to a JSON scalar (string, number, bool, null).
    pub fn set_field(&self, key: &str, value: &J) -> Result<()> {
        let v = match value {
            J::Null => LoroValue::Null,
            J::Bool(b) => LoroValue::from(*b),
            J::Number(n) => match n.as_i64() {
                Some(i) => LoroValue::from(i),
                None => LoroValue::from(n.as_f64().unwrap_or_default()),
            },
            J::String(t) => s(t),
            // A short list of strings (a multi-select, ids): replaced whole, like a scalar.
            J::Array(a) if a.iter().all(J::is_string) => {
                let list: Vec<LoroValue> = a
                    .iter()
                    .map(|x| s(x.as_str().unwrap_or_default()))
                    .collect();
                LoroValue::from(list)
            }
            _ => return Err(bad("fields hold scalars or lists of strings")),
        };
        self.doc.get_map("fields").insert(key, v)?;
        Ok(())
    }

    /// A whiteboard's nodes and lines (H6): each is a small JSON text under its own key in `fields`,
    /// so two computers moving different nodes both keep their change.
    pub fn canvas_put(&self, key: &str, value: Option<&str>) -> Result<()> {
        let fields = self.doc.get_map("fields");
        let key = format!("{CANVAS_PREFIX}{key}");
        match value {
            Some(v) => fields.insert(&key, v)?,
            None => fields.delete(&key)?,
        }
        Ok(())
    }

    pub fn canvas(&self) -> serde_json::Map<String, J> {
        self.fields()
            .into_iter()
            .filter_map(|(k, v)| k.strip_prefix(CANVAS_PREFIX).map(|k| (k.to_owned(), v)))
            .collect()
    }

    pub fn fields(&self) -> serde_json::Map<String, J> {
        match self.doc.get_map("fields").get_deep_value().to_json_value() {
            J::Object(m) => m,
            _ => serde_json::Map::new(),
        }
    }

    /// Adds a relation outside the body (format spec §11); returns the relation id.
    pub fn add_link(&self, to: ItemId, kind: &str) -> Result<String> {
        let link_id = ItemId::new().to_string();
        let m = self
            .doc
            .get_map("links")
            .insert_container(&link_id, LoroMap::new())?;
        m.insert("to", s(&to.to_string()))?;
        m.insert("kind", kind)?;
        Ok(link_id)
    }

    /// `(relation id, target, kind)` for every relation outside the body.
    pub fn links(&self) -> Vec<(String, ItemId, String)> {
        let J::Object(all) = self.doc.get_map("links").get_deep_value().to_json_value() else {
            return Vec::new();
        };
        let mut out: Vec<_> = all
            .into_iter()
            .filter_map(|(k, v)| {
                let to = v.get("to")?.as_str()?.parse().ok()?;
                Some((k, to, v.get("kind")?.as_str()?.to_owned()))
            })
            .collect();
        out.sort();
        out
    }

    fn body_children(&self) -> Result<LoroList> {
        match self.doc.get_map("body").get("children") {
            Some(ValueOrContainer::Container(Container::List(l))) => Ok(l),
            _ => Err(bad("body.children")),
        }
    }

    /// Plain text of the body: blocks joined by `\n`, inline atoms as U+FFFC. Nested blocks
    /// (lists, quotes) each give their own lines, so search sees them.
    pub fn body_text(&self) -> String {
        fn walk(list: &LoroList, lines: &mut Vec<String>) {
            for i in 0..list.len() {
                let Some(ValueOrContainer::Container(Container::Map(block))) = list.get(i) else {
                    continue;
                };
                let Some(ValueOrContainer::Container(Container::List(kids))) =
                    block.get("children")
                else {
                    lines.push(String::new());
                    continue;
                };
                // A block holding blocks recurses; one holding text and atoms is a line.
                let holds_blocks = matches!(
                    block.get("nodeName"),
                    Some(ValueOrContainer::Value(LoroValue::String(n)))
                        if BLOCK_CONTAINERS.contains(&n.as_str())
                );
                if holds_blocks {
                    walk(&kids, lines);
                    continue;
                }
                let mut line = String::new();
                for j in 0..kids.len() {
                    match kids.get(j) {
                        Some(ValueOrContainer::Container(Container::Text(t))) => {
                            line.push_str(&t.to_string())
                        }
                        Some(ValueOrContainer::Container(Container::Map(_))) => {
                            line.push(OBJECT_CHAR)
                        }
                        _ => {}
                    }
                }
                lines.push(line);
            }
        }
        let Ok(blocks) = self.body_children() else {
            return String::new();
        };
        let mut lines = Vec::with_capacity(blocks.len());
        walk(&blocks, &mut lines);
        lines.join("\n")
    }

    /// Appends one paragraph of plain text.
    pub fn append_paragraph(&self, text: &str) -> Result<()> {
        let blocks = self.body_children()?;
        let p: LoroMap = blocks.push_container(LoroMap::new())?;
        p.insert("nodeName", "paragraph")?;
        p.insert_container("attributes", LoroMap::new())?;
        let kids: LoroList = p.insert_container("children", LoroList::new())?;
        if !text.is_empty() {
            let t: LoroText = kids.push_container(LoroText::new())?;
            t.insert(0, text)?;
        }
        Ok(())
    }

    /// Replaces the whole body with plain-text paragraphs (one per line). For
    /// imports and generated data; editing goes through the editor binding.
    pub fn set_body_text(&self, text: &str) -> Result<()> {
        let blocks = self.body_children()?;
        blocks.clear()?;
        for line in text.split('\n') {
            self.append_paragraph(line)?;
        }
        Ok(())
    }

    /// Commits pending changes with their origin (format spec §6.3).
    /// The commit that undoes a proposal (format spec §6.3).
    pub fn commit_revert(&self, proposal: &str) {
        self.commit_raw(&format!("revert:{proposal}"));
    }

    pub fn commit(&self, origin: ChangeOrigin, detail: Option<&str>) {
        self.commit_raw(&origin_message(origin, detail));
    }

    pub(crate) fn commit_raw(&self, message: &str) {
        self.doc.set_next_commit_message(message);
        self.doc.commit();
    }

    /// Whether there are committed changes not yet written to disk.
    pub fn has_unsaved(&self) -> bool {
        self.doc.oplog_vv() != self.saved
    }

    pub(crate) fn export_unsaved(&self) -> Result<Option<Vec<u8>>> {
        if !self.has_unsaved() {
            return Ok(None);
        }
        Ok(Some(self.doc.export(ExportMode::updates(&self.saved))?))
    }

    pub(crate) fn export_snapshot(&self) -> Result<Vec<u8>> {
        Ok(self.doc.export(ExportMode::Snapshot)?)
    }

    pub(crate) fn mark_saved(&mut self) {
        self.saved = self.doc.oplog_vv();
    }

    /// Imports bytes from another replica (editor, another device).
    pub fn import(&self, bytes: &[u8]) -> Result<()> {
        self.doc.import(bytes)?;
        self.check_schema()
    }

    /// Full history, oldest first.
    pub fn history(&self) -> Vec<ChangeInfo> {
        let vv = self.doc.oplog_vv();
        let mut out = Vec::new();
        for (peer, end) in vv.iter() {
            let mut counter = 0;
            while counter < *end {
                let Some(m) = self.doc.get_change(ID::new(*peer, counter)) else {
                    break;
                };
                counter = m.id.counter + m.len as i32;
                out.push(ChangeInfo {
                    peer: *peer,
                    counter: m.id.counter,
                    lamport: m.lamport,
                    timestamp: m.timestamp,
                    message: m.message.map(|x| x.to_string()),
                    ops: m.len as u32,
                });
            }
        }
        out.sort_by_key(|c| (c.lamport, c.peer));
        out
    }

    /// The whole document as JSON (debugging and the lossless converter).
    pub fn to_json(&self) -> J {
        self.doc.get_deep_value().to_json_value()
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    #[test]
    fn two_copies_moving_different_nodes_both_keep_their_change() {
        let meta = sample_meta();
        let a = ItemDoc::create(&meta).unwrap();
        a.canvas_put("n1", Some("one")).unwrap();
        a.canvas_put("n2", Some("two")).unwrap();
        a.commit(ChangeOrigin::Me, None);
        let b = ItemDoc::load(meta.id, &[a.doc.export(ExportMode::Snapshot).unwrap()]).unwrap();
        a.canvas_put("n1", Some("one moved")).unwrap();
        a.commit(ChangeOrigin::Me, None);
        b.canvas_put("n2", None).unwrap();
        b.commit(ChangeOrigin::Me, None);
        a.import(&b.doc.export(ExportMode::all_updates()).unwrap())
            .unwrap();
        let got = a.canvas();
        assert_eq!(got.get("n1").and_then(J::as_str), Some("one moved"));
        assert!(!got.contains_key("n2"));
    }

    pub(crate) fn sample_meta() -> ItemMeta {
        let now = Timestamp::from_millisecond(1_760_000_000_000).unwrap();
        ItemMeta {
            id: ItemId::new(),
            type_id: TypeId("note".into()),
            title: Some("标题 café".into()),
            state: ItemState::Active,
            privacy: Privacy::Sensitive,
            container: Some(ItemId::new()),
            tags: vec![TagId("a".into()), TagId("法语".into())],
            created: now,
            updated: now,
            time: Some(TimeAnchor::Occurred {
                date: dem_model::FlexDate::year(-221).unwrap().approx(),
            }),
            source: SourceInfo::default(),
            ai_web: false,
        }
    }

    #[test]
    fn meta_round_trips_through_the_document() {
        let meta = sample_meta();
        let doc = ItemDoc::create(&meta).unwrap();
        assert_eq!(doc.meta().unwrap(), meta);
        let bytes = doc.export_snapshot().unwrap();
        let back = ItemDoc::load(meta.id, &[bytes]).unwrap();
        assert_eq!(back.meta().unwrap(), meta);
    }

    #[test]
    fn body_fields_links_and_origins() {
        let doc = ItemDoc::create(&sample_meta()).unwrap();
        doc.set_body_text("第一段\n西夏 𗀀𗀁\nzweite Zeile")
            .unwrap();
        doc.set_field("important", &J::Bool(true)).unwrap();
        let target = ItemId::new();
        doc.add_link(target, "reference").unwrap();
        doc.commit(ChangeOrigin::Import, Some("batch-1"));
        doc.append_paragraph("AI 加的一段").unwrap();
        doc.commit(ChangeOrigin::Ai, Some("prop-1"));

        assert_eq!(
            doc.body_text(),
            "第一段\n西夏 𗀀𗀁\nzweite Zeile\nAI 加的一段"
        );
        assert_eq!(doc.fields()["important"], J::Bool(true));
        assert_eq!(doc.links()[0].1, target);
        let messages: Vec<_> = doc
            .history()
            .into_iter()
            .filter_map(|c| c.message)
            .collect();
        assert_eq!(messages, ["system", "import:batch-1", "ai:prop-1"]);
    }

    #[test]
    fn concurrent_tag_additions_merge_as_a_set() {
        let doc = ItemDoc::create(&sample_meta()).unwrap();
        let bytes = doc.export_snapshot().unwrap();
        let a = ItemDoc::load(doc.id, std::slice::from_ref(&bytes)).unwrap();
        let b = ItemDoc::load(doc.id, &[bytes]).unwrap();
        a.set_tag(&TagId("x".into()), true).unwrap();
        a.commit(ChangeOrigin::Me, None);
        b.set_tag(&TagId("x".into()), true).unwrap();
        b.set_tag(&TagId("y".into()), true).unwrap();
        b.commit(ChangeOrigin::Me, None);
        a.import(&b.export_snapshot().unwrap()).unwrap();
        let tags: Vec<_> = a.meta().unwrap().tags.into_iter().map(|t| t.0).collect();
        assert_eq!(tags, ["a", "x", "y", "法语"]);
    }
}
