//! Rebuilding an item document from its JSON representation (the lossless
//! converter of `dem-dev convert`, P0-35).
//!
//! [`ItemDoc::to_json`] returns the Loro deep value, which does not say which
//! JSON objects and arrays were containers and which were plain values. The
//! item layout (format spec §6.2) does, so the rebuild is schema-aware:
//!
//! - `meta`: scalars, except `tags`, a child Map.
//! - `fields`: scalars (child Text containers for long fields are not written
//!   anywhere yet; a string always becomes a scalar).
//! - `links`: one child Map per relation, holding scalars; `anchor` holds bytes
//!   (an encoded stable position), shown as an array of numbers like labels.
//!
//! `meta`, `fields` and `links` are reconciled key by key and existing child
//! maps (tags, relations) are reused, so unchanged values keep their history and
//! concurrent edits from other replicas still merge. `body` and `labels` are
//! rebuilt as a whole when they differ.
//! - `body`: nodes are Maps with `nodeName`, `attributes` (child Map) and
//!   `children` (child List); in `children` a string is a Text container and an
//!   object is a nested node.
//! - `labels`: a List of child Maps; `version` holds bytes (encoded Frontiers),
//!   which the deep value shows as an array of numbers and the rebuild turns
//!   back into a Loro Binary value.
//!
//! Text marks (bold and so on) are not part of the deep value; the editor that
//! writes them is defined in P1, together with their JSON form.

use loro::{Container, LoroList, LoroMap, LoroText, LoroValue, ToJson, ValueOrContainer};
use serde_json::{Map, Value as J};

use crate::item::ItemDoc;
use crate::{DOC_SCHEMA, Result, StoreError};

/// Root containers rebuilt by [`ItemDoc::replace_from_json`], in this order.
pub const ROOTS: &[&str] = &["meta", "fields", "links", "body", "labels"];

fn bad(what: impl Into<String>) -> StoreError {
    StoreError::InvalidDocument(what.into())
}

/// A JSON value stored as a plain (non-container) Loro value.
fn plain(v: &J) -> LoroValue {
    match v {
        J::Null => LoroValue::Null,
        J::Bool(b) => LoroValue::from(*b),
        J::Number(n) => match n.as_i64() {
            Some(i) => LoroValue::from(i),
            None => LoroValue::from(n.as_f64().unwrap_or_default()),
        },
        J::String(s) => LoroValue::from(s.as_str()),
        J::Array(xs) => LoroValue::from(xs.iter().map(plain).collect::<Vec<_>>()),
        J::Object(m) => {
            let map: std::collections::HashMap<String, LoroValue> =
                m.iter().map(|(k, v)| (k.clone(), plain(v))).collect();
            LoroValue::from(map)
        }
    }
}

fn object<'a>(v: &'a J, what: &str) -> Result<&'a Map<String, J>> {
    v.as_object()
        .ok_or_else(|| bad(format!("{what} must be an object")))
}

fn fill_plain(map: &LoroMap, obj: &Map<String, J>) -> Result<()> {
    for (k, v) in obj {
        map.insert(k, plain(v))?;
    }
    Ok(())
}

/// How the value under a map key is stored.
type Encode = fn(&str, &J) -> Result<LoroValue>;

fn encode_plain(_key: &str, v: &J) -> Result<LoroValue> {
    Ok(plain(v))
}

/// Relation entries: `anchor` is an encoded Loro stable position (bytes).
fn encode_link(key: &str, v: &J) -> Result<LoroValue> {
    if key == "anchor" {
        binary(v, "link anchor")
    } else {
        Ok(plain(v))
    }
}

/// Whether `map[key]` already is a plain value equal to `want`.
fn scalar_matches(map: &LoroMap, key: &str, want: &J) -> bool {
    matches!(map.get(key), Some(ValueOrContainer::Value(cur)) if &cur.to_json_value() == want)
}

fn delete_missing(map: &LoroMap, obj: &Map<String, J>) -> Result<()> {
    let stale: Vec<String> = map
        .keys()
        .map(|k| k.to_string())
        .filter(|k| !obj.contains_key(k))
        .collect();
    for k in stale {
        map.delete(&k)?;
    }
    Ok(())
}

/// Makes the plain entries of `map` equal to `obj`, writing only keys whose
/// value differs, so unchanged keys keep their history and concurrent edits.
fn sync_scalars(map: &LoroMap, obj: &Map<String, J>, encode: Encode) -> Result<()> {
    delete_missing(map, obj)?;
    for (k, v) in obj {
        if !scalar_matches(map, k, v) {
            map.insert(k, encode(k, v)?)?;
        }
    }
    Ok(())
}

/// The child Map under `key`, reusing the existing container: a fresh one would
/// silently drop concurrent edits other replicas make to the old one.
fn child_map(map: &LoroMap, key: &str) -> Result<LoroMap> {
    match map.get(key) {
        Some(ValueOrContainer::Container(Container::Map(m))) => Ok(m),
        _ => Ok(map.insert_container(key, LoroMap::new())?),
    }
}

fn sync_meta(map: &LoroMap, obj: &Map<String, J>) -> Result<()> {
    delete_missing(map, obj)?;
    for (k, v) in obj {
        if k == "tags" {
            sync_scalars(
                &child_map(map, "tags")?,
                object(v, "meta.tags")?,
                encode_plain,
            )?;
        } else if !scalar_matches(map, k, v) {
            map.insert(k, plain(v))?;
        }
    }
    Ok(())
}

fn sync_links(map: &LoroMap, obj: &Map<String, J>) -> Result<()> {
    delete_missing(map, obj)?;
    for (id, rel) in obj {
        sync_scalars(
            &child_map(map, id)?,
            object(rel, "links entry")?,
            encode_link,
        )?;
    }
    Ok(())
}

/// Fills a body node (the root `body` map or a nested block / inline node).
fn fill_node(map: &LoroMap, obj: &Map<String, J>) -> Result<()> {
    for (k, v) in obj {
        match k.as_str() {
            "attributes" => {
                let attrs = map.insert_container("attributes", LoroMap::new())?;
                fill_plain(&attrs, object(v, "body attributes")?)?;
            }
            "children" => {
                let kids = map.insert_container("children", LoroList::new())?;
                let xs = v
                    .as_array()
                    .ok_or_else(|| bad("body children must be an array"))?;
                for x in xs {
                    match x {
                        J::String(s) => {
                            let t = kids.push_container(LoroText::new())?;
                            t.insert(0, s)?;
                        }
                        J::Object(o) => {
                            let node = kids.push_container(LoroMap::new())?;
                            fill_node(&node, o)?;
                        }
                        _ => return Err(bad("body child must be text or a node")),
                    }
                }
            }
            _ => map.insert(k, plain(v))?,
        }
    }
    Ok(())
}

/// A JSON array of byte values as Loro bytes.
fn binary(v: &J, what: &str) -> Result<LoroValue> {
    let xs = v
        .as_array()
        .ok_or_else(|| bad(format!("{what} must be a byte array")))?;
    let bytes = xs
        .iter()
        .map(|x| x.as_u64().and_then(|n| u8::try_from(n).ok()))
        .collect::<Option<Vec<u8>>>()
        .ok_or_else(|| bad(format!("{what} must be a byte array")))?;
    Ok(LoroValue::from(bytes))
}

fn fill_labels(list: &LoroList, v: &J) -> Result<()> {
    let xs = v.as_array().ok_or_else(|| bad("labels must be an array"))?;
    for x in xs {
        let m = list.push_container(LoroMap::new())?;
        for (k, v) in object(x, "label")? {
            let value = if k == "version" {
                binary(v, "label version")?
            } else {
                plain(v)
            };
            m.insert(k, value)?;
        }
    }
    Ok(())
}

impl ItemDoc {
    /// Makes the document's state equal to `value`, a JSON object as returned by
    /// [`ItemDoc::to_json`]. Roots that already match are left alone, so history
    /// only gains what changed. The caller commits (normally `import:<batch>`).
    ///
    /// `dem.schema` must equal [`DOC_SCHEMA`]; migrating other schemas is not the
    /// converter's job. On error the document may hold uncommitted partial
    /// changes; the caller must drop it without saving.
    pub fn replace_from_json(&self, value: &J) -> Result<()> {
        let root = object(value, "item document")?;
        match root
            .get("dem")
            .and_then(|d| d.get("schema"))
            .and_then(J::as_i64)
        {
            Some(DOC_SCHEMA) => {}
            Some(v) => return Err(bad(format!("unsupported schema {v}"))),
            None => return Err(bad("missing dem.schema")),
        }
        if let Some(k) = root
            .keys()
            .find(|k| *k != "dem" && !ROOTS.contains(&k.as_str()))
        {
            return Err(bad(format!("unknown root container {k:?}")));
        }
        let empty_map = J::Object(Map::new());
        let empty_list = J::Array(Vec::new());
        for name in ROOTS {
            if *name == "labels" {
                let want = root.get("labels").unwrap_or(&empty_list);
                let list = self.doc.get_list("labels");
                if &list.get_deep_value().to_json_value() != want {
                    list.clear()?;
                    fill_labels(&list, want)?;
                }
                continue;
            }
            let want = root.get(*name).unwrap_or(&empty_map);
            let map = self.doc.get_map(*name);
            if &map.get_deep_value().to_json_value() == want {
                continue;
            }
            let obj = object(want, name)?;
            match *name {
                "meta" => sync_meta(&map, obj)?,
                "links" => sync_links(&map, obj)?,
                "fields" => sync_scalars(&map, obj, encode_plain)?,
                _ => {
                    // The body is rebuilt as a whole; diffing rich text is the
                    // editor binding's job (P1).
                    map.clear()?;
                    fill_node(&map, obj)?;
                }
            }
        }
        // Reading the meta back checks that the result is a well-formed item.
        self.meta()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use dem_model::{
        ChangeOrigin, ItemId, ItemMeta, ItemState, Privacy, SourceInfo, TagId, Timestamp, TypeId,
    };

    use super::*;

    fn meta() -> ItemMeta {
        let now = Timestamp::from_millisecond(1_760_000_000_000).unwrap();
        ItemMeta {
            id: ItemId::new(),
            type_id: TypeId("note".into()),
            title: Some("标题".into()),
            state: ItemState::Active,
            privacy: Privacy::Private,
            container: None,
            tags: vec![TagId("x".into())],
            created: now,
            updated: now,
            time: None,
            source: SourceInfo::default(),
            ai_web: false,
        }
    }

    #[test]
    fn rebuild_reproduces_the_deep_value() {
        let a = ItemDoc::create(&meta()).unwrap();
        a.set_body_text("一\n\nzwei 𗀀").unwrap();
        a.set_field("n", &J::from(3)).unwrap();
        a.set_field("f", &J::from(1.5)).unwrap();
        a.set_field("s", &J::from("text")).unwrap();
        a.add_link(ItemId::new(), "reference").unwrap();
        a.commit(ChangeOrigin::Me, None);

        let mut other = meta();
        other.id = a.id();
        let b = ItemDoc::create(&other).unwrap();
        b.replace_from_json(&a.to_json()).unwrap();
        b.commit(ChangeOrigin::Import, Some("t"));
        assert_eq!(b.to_json(), a.to_json());
        assert_eq!(b.meta().unwrap(), a.meta().unwrap());
        assert_eq!(b.body_text(), a.body_text());
        assert_eq!(b.links(), a.links());
        // Text containers really are Text: appending a paragraph keeps working.
        b.append_paragraph("more").unwrap();
    }

    #[test]
    fn labels_and_inline_nodes_keep_their_loro_types() {
        let a = ItemDoc::create(&meta()).unwrap();
        a.set_body_text("before after").unwrap();
        // An inline atom inside the first paragraph, as the editor writes it.
        let blocks = match a.doc.get_map("body").get("children") {
            Some(loro::ValueOrContainer::Container(loro::Container::List(l))) => l,
            _ => panic!("body.children"),
        };
        let para = match blocks.get(0) {
            Some(loro::ValueOrContainer::Container(loro::Container::Map(m))) => m,
            _ => panic!("paragraph"),
        };
        let kids = match para.get("children") {
            Some(loro::ValueOrContainer::Container(loro::Container::List(l))) => l,
            _ => panic!("children"),
        };
        let atom = kids.push_container(LoroMap::new()).unwrap();
        atom.insert("nodeName", "itemLink").unwrap();
        let attrs = atom.insert_container("attributes", LoroMap::new()).unwrap();
        attrs
            .insert("to", ItemId::new().to_string().as_str())
            .unwrap();
        atom.insert_container("children", LoroList::new()).unwrap();
        let label = a
            .doc
            .get_list("labels")
            .push_container(LoroMap::new())
            .unwrap();
        label.insert("name", "v1").unwrap();
        label.insert("version", vec![0u8, 7, 255]).unwrap();
        label.insert("created", 1_760_000_000_000_i64).unwrap();
        a.commit(ChangeOrigin::Me, None);

        let mut other = meta();
        other.id = a.id();
        let b = ItemDoc::create(&other).unwrap();
        b.replace_from_json(&a.to_json()).unwrap();
        b.commit(ChangeOrigin::Import, Some("t"));
        // Same Loro values, not only the same JSON.
        assert_eq!(b.doc.get_deep_value(), a.doc.get_deep_value());
        assert_eq!(
            b.body_text(),
            format!("before after{}", crate::item::OBJECT_CHAR)
        );

        let mut v = a.to_json();
        v["labels"][0]["version"] = J::from(vec![1, 300]);
        assert!(b.replace_from_json(&v).is_err());
    }

    #[test]
    fn unchanged_roots_add_no_history() {
        let a = ItemDoc::create(&meta()).unwrap();
        let before = a.history().len();
        a.replace_from_json(&a.to_json()).unwrap();
        a.commit(ChangeOrigin::Import, Some("noop"));
        assert_eq!(a.history().len(), before);
    }

    #[test]
    fn link_anchors_stay_bytes() {
        let a = ItemDoc::create(&meta()).unwrap();
        let rel = a.add_link(ItemId::new(), "annotates").unwrap();
        let m = match a.doc.get_map("links").get(&rel) {
            Some(ValueOrContainer::Container(Container::Map(m))) => m,
            _ => panic!("relation"),
        };
        m.insert("anchor", vec![4u8, 0, 200]).unwrap();
        a.commit(ChangeOrigin::Me, None);

        let mut other = meta();
        other.id = a.id();
        let b = ItemDoc::create(&other).unwrap();
        b.replace_from_json(&a.to_json()).unwrap();
        b.commit(ChangeOrigin::Import, Some("t"));
        assert_eq!(b.doc.get_deep_value(), a.doc.get_deep_value());
    }

    #[test]
    fn concurrent_tag_edits_survive_an_import() {
        let a = ItemDoc::create(&meta()).unwrap();
        let b = ItemDoc::load(a.id(), &[a.export_snapshot().unwrap()]).unwrap();
        b.set_tag(&TagId("from-b".into()), true).unwrap();
        b.commit(ChangeOrigin::Me, None);

        // An import that changes the state and another tag on replica `a`.
        let mut v = a.to_json();
        v["meta"]["state"] = J::from("archived");
        v["meta"]["tags"]["imported"] = J::from(true);
        v["fields"]["k"] = J::from(1);
        a.replace_from_json(&v).unwrap();
        a.commit(ChangeOrigin::Import, Some("t"));
        a.import(&b.export_snapshot().unwrap()).unwrap();

        let tags: Vec<_> = a.meta().unwrap().tags.into_iter().map(|t| t.0).collect();
        assert_eq!(tags, ["from-b", "imported", "x"]);
        assert_eq!(a.meta().unwrap().state, ItemState::Archived);
        // Only the changed keys were written. Look the import up by message: it is
        // concurrent with b's change, and ties in Lamport order are broken by the
        // randomly assigned peer ids, so it is not necessarily last.
        let import = a
            .history()
            .into_iter()
            .find(|c| c.message.as_deref() == Some("import:t"))
            .unwrap();
        assert_eq!(import.ops, 3);
    }

    #[test]
    fn removed_keys_and_relations_are_deleted() {
        let a = ItemDoc::create(&meta()).unwrap();
        a.set_field("gone", &J::from("x")).unwrap();
        a.add_link(ItemId::new(), "reference").unwrap();
        a.commit(ChangeOrigin::Me, None);
        let mut v = a.to_json();
        v["fields"] = J::Object(Map::new());
        v["links"] = J::Object(Map::new());
        v["meta"]["tags"] = J::Object(Map::new());
        a.replace_from_json(&v).unwrap();
        assert!(a.fields().is_empty());
        assert!(a.links().is_empty());
        assert!(a.meta().unwrap().tags.is_empty());
        assert_eq!(a.to_json(), v);
    }

    #[test]
    fn rejects_bad_documents() {
        let a = ItemDoc::create(&meta()).unwrap();
        let mut v = a.to_json();
        v["dem"]["schema"] = J::from(99);
        assert!(a.replace_from_json(&v).is_err());
        let mut v = a.to_json();
        v["extra"] = J::Object(Map::new());
        assert!(a.replace_from_json(&v).is_err());
        let mut v = a.to_json();
        v["meta"]["state"] = J::from("bogus");
        assert!(a.replace_from_json(&v).is_err());
    }
}
