//! The structure document (format spec §7): the domain/project hierarchy as a
//! Loro movable tree. Nodes hold only `{kind, item}`; names live in the items.

use std::collections::BTreeMap;
use std::fmt;

use dem_model::ItemId;
use loro::{LoroDoc, LoroTree, LoroValue, ToJson, TreeID, TreeParentId, VersionVector};

use crate::item::new_doc;
use crate::{DOC_SCHEMA, Result, StoreError};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NodeKind {
    Domain,
    Project,
}

impl NodeKind {
    fn as_str(self) -> &'static str {
        match self {
            NodeKind::Domain => "domain",
            NodeKind::Project => "project",
        }
    }
}

pub struct StructureDoc {
    pub(crate) doc: LoroDoc,
    pub(crate) saved: VersionVector,
}

impl fmt::Debug for StructureDoc {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("StructureDoc")
    }
}

/// One node as read back: item, kind and parent item (None at top level).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StructureNode {
    pub item: ItemId,
    pub kind: NodeKind,
    pub parent: Option<ItemId>,
}

impl StructureDoc {
    pub(crate) fn create() -> Result<StructureDoc> {
        let doc = new_doc();
        doc.get_map("dem").insert("schema", DOC_SCHEMA)?;
        doc.get_tree("tree").enable_fractional_index(0);
        doc.set_next_commit_message("system");
        doc.commit();
        Ok(StructureDoc {
            doc,
            saved: VersionVector::default(),
        })
    }

    pub(crate) fn load(parts: &[Vec<u8>]) -> Result<StructureDoc> {
        let doc = new_doc();
        for p in parts {
            doc.import(p)?;
        }
        Ok(StructureDoc {
            saved: doc.oplog_vv(),
            doc,
        })
    }

    fn tree(&self) -> LoroTree {
        self.doc.get_tree("tree")
    }

    /// Live node for an item; with duplicates (concurrent creation) the node whose
    /// tree id sorts first wins, as the spec requires.
    fn node_of(&self, item: ItemId) -> Option<TreeID> {
        let key = item.to_string();
        let tree = self.tree();
        let mut found: Vec<TreeID> = tree
            .nodes()
            .into_iter()
            .filter(|id| !tree.is_node_deleted(id).unwrap_or(true))
            .filter(|id| {
                tree.get_meta(*id)
                    .ok()
                    .and_then(|m| {
                        m.get_deep_value()
                            .to_json_value()
                            .get("item")
                            .and_then(|v| v.as_str().map(str::to_owned))
                    })
                    .as_deref()
                    == Some(key.as_str())
            })
            .collect();
        found.sort_by_key(|id| (id.peer, id.counter));
        found.first().copied()
    }

    /// Adds a domain or project under `parent` (None = top level).
    pub fn add(&self, item: ItemId, kind: NodeKind, parent: Option<ItemId>) -> Result<()> {
        if self.node_of(item).is_some() {
            return Err(StoreError::InvalidDocument(
                "item already in the structure".into(),
            ));
        }
        let parent = self.parent_id(parent)?;
        let tree = self.tree();
        let id = tree.create(parent)?;
        let meta = tree.get_meta(id)?;
        meta.insert("kind", kind.as_str())?;
        meta.insert("item", LoroValue::from(item.to_string().as_str()))?;
        Ok(())
    }

    fn parent_id(&self, parent: Option<ItemId>) -> Result<TreeParentId> {
        Ok(match parent {
            None => TreeParentId::Root,
            Some(p) => TreeParentId::Node(
                self.node_of(p)
                    .ok_or_else(|| StoreError::NotFound(format!("structure node {p}")))?,
            ),
        })
    }

    /// Moves a node. Loro refuses moves that would create a cycle locally, and
    /// concurrent moves always merge into a tree.
    pub fn move_to(&self, item: ItemId, parent: Option<ItemId>) -> Result<()> {
        let node = self
            .node_of(item)
            .ok_or_else(|| StoreError::NotFound(format!("structure node {item}")))?;
        let parent = self.parent_id(parent)?;
        self.tree().mov(node, parent)?;
        Ok(())
    }

    pub fn commit(&self, message: &str) {
        self.doc.set_next_commit_message(message);
        self.doc.commit();
    }

    /// All live nodes with their parent items.
    pub fn nodes(&self) -> Vec<StructureNode> {
        let tree = self.tree();
        let mut item_of: BTreeMap<TreeID, (ItemId, NodeKind)> = BTreeMap::new();
        for id in tree.nodes() {
            if tree.is_node_deleted(&id).unwrap_or(true) {
                continue;
            }
            let Ok(meta) = tree.get_meta(id) else {
                continue;
            };
            let v = meta.get_deep_value().to_json_value();
            let item = v
                .get("item")
                .and_then(|x| x.as_str())
                .and_then(|x| x.parse::<ItemId>().ok());
            let kind = match v.get("kind").and_then(|x| x.as_str()) {
                Some("domain") => Some(NodeKind::Domain),
                Some("project") => Some(NodeKind::Project),
                _ => None,
            };
            if let (Some(item), Some(kind)) = (item, kind) {
                item_of.insert(id, (item, kind));
            }
        }
        let mut out: Vec<StructureNode> = item_of
            .iter()
            .map(|(id, (item, kind))| {
                let parent = match tree.parent(*id) {
                    Some(TreeParentId::Node(p)) => item_of.get(&p).map(|(i, _)| *i),
                    _ => None,
                };
                StructureNode {
                    item: *item,
                    kind: *kind,
                    parent,
                }
            })
            .collect();
        out.sort_by_key(|n| n.item);
        out
    }
}

#[cfg(test)]
mod tests {
    use loro::ExportMode;

    use super::*;

    #[test]
    fn contradictory_concurrent_moves_stay_a_tree() {
        let base = StructureDoc::create().unwrap();
        let (a_item, b_item) = (ItemId::new(), ItemId::new());
        base.add(a_item, NodeKind::Domain, None).unwrap();
        base.add(b_item, NodeKind::Domain, None).unwrap();
        base.commit("me");
        let bytes = base.doc.export(ExportMode::Snapshot).unwrap();
        let r1 = StructureDoc::load(std::slice::from_ref(&bytes)).unwrap();
        let r2 = StructureDoc::load(&[bytes]).unwrap();
        r1.move_to(a_item, Some(b_item)).unwrap();
        r1.commit("me");
        r2.move_to(b_item, Some(a_item)).unwrap();
        r2.commit("me");
        r1.doc
            .import(&r2.doc.export(ExportMode::Snapshot).unwrap())
            .unwrap();
        r2.doc
            .import(&r1.doc.export(ExportMode::Snapshot).unwrap())
            .unwrap();
        let n1 = r1.nodes();
        assert_eq!(n1, r2.nodes());
        // Exactly one of the two is at the top level: no cycle.
        assert_eq!(n1.iter().filter(|n| n.parent.is_none()).count(), 1);
    }

    #[test]
    fn local_cycle_is_refused() {
        let s = StructureDoc::create().unwrap();
        let (a, b) = (ItemId::new(), ItemId::new());
        s.add(a, NodeKind::Domain, None).unwrap();
        s.add(b, NodeKind::Domain, Some(a)).unwrap();
        assert!(s.move_to(a, Some(b)).is_err());
    }
}
