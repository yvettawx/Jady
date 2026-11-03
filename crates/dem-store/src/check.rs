//! Read-only inspection for the format validator and the corruption drill (format
//! spec §18). Everything a checker needs below the file level lives here, so tools
//! never parse library bytes themselves (P0 plan, Q2).
//!
//! Unlike [`Library::open`](crate::Library::open), an [`Inspector`] takes no process
//! lock and changes nothing on disk (no `tmp/` cleanup, no device file), so it can
//! look at a damaged library exactly as it is.

use std::fmt;
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};

use dem_crypto::keys::{Subkeys, unwrap_with_password, unwrap_with_recovery};
use dem_crypto::shape::{self, SegmentShape};
use dem_crypto::stream::StreamHeader;
use dem_crypto::{envelope, records, stream};
use dem_model::ItemId;
use loro::{LoroValue, ToJson, TreeParentId, ValueOrContainer};
use serde_json::Value as J;

use crate::item::{ItemDoc, new_doc};
use crate::layout::{self, DocDir};
use crate::library::{Unlock, read_raw};
use crate::manifest::Manifest;
use crate::structure::StructureDoc;
use crate::{DOC_SCHEMA, Result, io_err};

// ---- keyless checks ---------------------------------------------------------

/// Parses `manifest.json` with the same rules as opening the library.
pub fn read_manifest(root: &Path) -> Result<Manifest> {
    Manifest::parse(&read_raw(root, layout::MANIFEST)?)
}

/// Header of a sealed small file (`.dexm`, `.dexu`, `local/*`), without a key.
pub fn sealed_header(root: &Path, rel: &str) -> Result<envelope::Header> {
    Ok(envelope::Header::parse(&read_raw(root, rel)?)?)
}

/// Record framing of a log segment, without a key.
pub fn segment_shape(root: &Path, rel: &str) -> Result<SegmentShape> {
    Ok(shape::segment_shape(&read_raw(root, rel)?)?)
}

/// Header of an attachment, checked against the file length (format spec §13).
pub fn blob_shape(root: &Path, rel: &str) -> Result<StreamHeader> {
    let path = root.join(rel);
    let mut f = File::open(&path).map_err(io_err(&path))?;
    let len = f.metadata().map_err(io_err(&path))?.len();
    let mut head = Vec::with_capacity(stream::HEADER_LEN);
    (&mut f)
        .take(stream::HEADER_LEN as u64)
        .read_to_end(&mut head)
        .map_err(io_err(&path))?;
    Ok(shape::stream_shape(&head, len)?)
}

/// Directories the layout (format spec §2) does not allow, library-relative, sorted.
/// Files are classified by [`layout::classify`]; this covers empty or stray
/// directories that a file listing cannot show.
pub fn unexpected_dirs(root: &Path) -> Result<Vec<String>> {
    let mut out = Vec::new();
    walk_dirs(root, "", &mut out)?;
    out.sort();
    Ok(out)
}

fn walk_dirs(root: &Path, rel: &str, out: &mut Vec<String>) -> Result<()> {
    let dir = if rel.is_empty() {
        root.to_path_buf()
    } else {
        root.join(rel)
    };
    for entry in fs::read_dir(&dir).map_err(io_err(&dir))? {
        let entry = entry.map_err(io_err(&dir))?;
        if !entry.file_type().map_err(io_err(&dir))?.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let child = if rel.is_empty() {
            name
        } else {
            format!("{rel}/{name}")
        };
        match dir_rule(&child) {
            DirRule::Free => {}
            DirRule::Descend => walk_dirs(root, &child, out)?,
            DirRule::Leaf => {
                // Files inside are checked by name; deeper directories are not allowed.
                let p = root.join(&child);
                for e in fs::read_dir(&p).map_err(io_err(&p))? {
                    let e = e.map_err(io_err(&p))?;
                    if e.file_type().map_err(io_err(&p))?.is_dir() {
                        out.push(format!("{child}/{}", e.file_name().to_string_lossy()));
                    }
                }
            }
            DirRule::Unexpected => out.push(child),
        }
    }
    Ok(())
}

enum DirRule {
    /// Anything goes below (local-only, temporary or reserved directories).
    Free,
    Descend,
    /// Holds files only.
    Leaf,
    Unexpected,
}

fn dir_rule(rel: &str) -> DirRule {
    let parts: Vec<&str> = rel.split('/').collect();
    match parts.as_slice() {
        ["local" | "tmp" | "vault"] => DirRule::Free,
        ["items" | "types" | "blobs" | "logs"] => DirRule::Descend,
        ["structure"] => DirRule::Leaf,
        ["items" | "types" | "blobs", shard] if is_shard(shard) => DirRule::Leaf,
        ["logs", "activity" | "review" | "ai-access"] => DirRule::Descend,
        ["logs", _, month] if is_month(month) => DirRule::Leaf,
        _ => DirRule::Unexpected,
    }
}

fn is_shard(s: &str) -> bool {
    s.len() == 2
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn is_month(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 7
        && b[4] == b'-'
        && b[..4].iter().all(u8::is_ascii_digit)
        && matches!(s[5..].parse::<u32>(), Ok(1..=12))
}

// ---- keyed checks -----------------------------------------------------------

/// Decryption access to a library without opening it: no lock, no writes.
pub struct Inspector {
    root: PathBuf,
    manifest: Manifest,
    keys: Subkeys,
}

impl fmt::Debug for Inspector {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Inspector")
            .field("root", &self.root)
            .finish_non_exhaustive()
    }
}

impl Inspector {
    /// Unwraps the master key exactly as [`Library::open`](crate::Library::open) does.
    pub fn unlock(root: &Path, unlock: Unlock<'_>) -> Result<Inspector> {
        let manifest = read_manifest(root)?;
        let check_by_reading = matches!(unlock, Unlock::MasterKey(_));
        let master = match unlock {
            Unlock::Password(pw) => unwrap_with_password(
                &manifest.wrapped("password")?,
                pw,
                &manifest.salt()?,
                manifest.kdf_params(),
                &manifest.password_binding()?,
            )?,
            Unlock::Recovery(code) => unwrap_with_recovery(
                &manifest.wrapped("recovery")?,
                code,
                &manifest.recovery_binding(),
            )?,
            Unlock::MasterKey(k) => k,
        };
        let keys = Subkeys::derive(&master, &manifest.library_id_bytes());
        let inspector = Inspector {
            root: root.to_path_buf(),
            manifest,
            keys,
        };
        if check_by_reading && root.join(layout::DEVICE_FILE).exists() {
            inspector.open_sealed(layout::DEVICE_FILE)?;
        }
        Ok(inspector)
    }

    pub fn manifest(&self) -> &Manifest {
        &self.manifest
    }

    /// Decrypts a small file (`.dexm`, `.dexu`, `local/*`).
    pub fn open_sealed(&self, rel: &str) -> Result<Vec<u8>> {
        Ok(envelope::open(
            &self.keys.files,
            rel,
            &read_raw(&self.root, rel)?,
        )?)
    }

    /// Decrypts every complete record of a log segment.
    pub fn open_segment(&self, rel: &str) -> Result<records::Segment> {
        Ok(records::open_segment(
            &self.keys.files,
            rel,
            &read_raw(&self.root, rel)?,
        )?)
    }

    /// Decrypts an attachment and recomputes its keyed name (format spec §13).
    /// Returns whether the name matches.
    pub fn check_blob(&self, rel: &str, name: &str) -> Result<bool> {
        let path = self.root.join(rel);
        let f = File::open(&path).map_err(io_err(&path))?;
        let mut content = Vec::new();
        stream::open(
            &self.keys.files,
            rel,
            std::io::BufReader::new(f),
            &mut content,
        )?;
        Ok(self.keys.blob_name.name_for(&content[..])? == name)
    }
}

// ---- documents --------------------------------------------------------------

/// Result of importing one CRDT document file by file.
#[derive(Debug, Default)]
pub struct DocCheck {
    /// `(file, message)` for every part Loro refused to import.
    pub import_errors: Vec<(String, String)>,
    /// A problem with the merged document (schema version, item metadata).
    pub doc_error: Option<String>,
    /// The merged item, when `dir` is items and it could be built.
    pub item: Option<ItemDoc>,
    /// The merged structure document, when `dir` is structure.
    pub structure: Option<StructureDoc>,
}

/// Imports decrypted `(file, bytes)` parts (snapshot first) into a fresh document,
/// attributing every failure to its file, then checks `dem.schema` and, for items,
/// the metadata (format spec §6.2, §18 item 8).
pub fn check_doc(dir: DocDir, stem: &str, parts: &[(String, Vec<u8>)]) -> DocCheck {
    let doc = new_doc();
    let mut out = DocCheck::default();
    for (rel, bytes) in parts {
        if let Err(e) = doc.import(bytes) {
            out.import_errors.push((rel.clone(), e.to_string()));
        }
    }
    match doc.get_map("dem").get("schema") {
        Some(ValueOrContainer::Value(LoroValue::I64(DOC_SCHEMA))) => {}
        Some(ValueOrContainer::Value(LoroValue::I64(v))) => {
            out.doc_error = Some(format!("unsupported dem.schema {v}"));
            return out;
        }
        _ => {
            out.doc_error = Some("missing dem.schema".into());
            return out;
        }
    }
    let saved = doc.oplog_vv();
    match dir {
        DocDir::Items => {
            let Ok(id) = stem.parse::<ItemId>() else {
                out.doc_error = Some("file name is not an item id".into());
                return out;
            };
            let item = ItemDoc { id, doc, saved };
            match item.meta() {
                Ok(m) if m.type_id.0.is_empty() => {
                    out.doc_error = Some("meta.type is empty".into());
                }
                Ok(_) => {}
                Err(e) => out.doc_error = Some(e.to_string()),
            }
            out.item = Some(item);
        }
        DocDir::Structure => out.structure = Some(StructureDoc { doc, saved }),
        DocDir::Types => {}
    }
    out
}

/// Relation ids in an item's `links` map whose entry lacks a valid `to` or `kind`.
pub fn malformed_links(item: &ItemDoc) -> Vec<String> {
    let J::Object(all) = item.doc.get_map("links").get_deep_value().to_json_value() else {
        return vec!["<links is not a map>".into()];
    };
    all.into_iter()
        .filter(|(_, v)| {
            let to_ok = v
                .get("to")
                .and_then(J::as_str)
                .is_some_and(|t| t.parse::<ItemId>().is_ok());
            !(to_ok && v.get("kind").and_then(J::as_str).is_some())
        })
        .map(|(k, _)| k)
        .collect()
}

/// Target ids of inline item links in the body: `item_link` nodes, target in the
/// `to`, `item` or `id` attribute (the editor schema is fixed in P1).
pub fn inline_links(item: &ItemDoc) -> Vec<String> {
    let mut out = Vec::new();
    collect_inline_links(
        &item.doc.get_map("body").get_deep_value().to_json_value(),
        &mut out,
    );
    out.sort();
    out.dedup();
    out
}

fn collect_inline_links(v: &J, out: &mut Vec<String>) {
    match v {
        J::Object(m) => {
            if m.get("nodeName").and_then(J::as_str) == Some("item_link")
                && let Some(attrs) = m.get("attributes")
                && let Some(t) = ["to", "item", "id"]
                    .iter()
                    .find_map(|k| attrs.get(*k).and_then(J::as_str))
            {
                out.push(t.to_owned());
            }
            m.values().for_each(|x| collect_inline_links(x, out));
        }
        J::Array(xs) => xs.iter().for_each(|x| collect_inline_links(x, out)),
        _ => {}
    }
}

/// One live tree node exactly as stored, before any interpretation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawNode {
    /// Loro tree id, `counter@peer`.
    pub node: String,
    pub parent: Option<String>,
    pub item: Option<String>,
    pub kind: Option<String>,
}

/// All live nodes of the structure tree with their raw metadata (format spec §7).
pub fn structure_raw_nodes(s: &StructureDoc) -> Vec<RawNode> {
    let tree = s.doc.get_tree("tree");
    let name = |id: loro::TreeID| format!("{}@{}", id.counter, id.peer);
    let mut out: Vec<RawNode> = tree
        .nodes()
        .into_iter()
        .filter(|id| !tree.is_node_deleted(id).unwrap_or(true))
        .map(|id| {
            let meta = tree
                .get_meta(id)
                .map(|m| m.get_deep_value().to_json_value())
                .unwrap_or(J::Null);
            let field = |k: &str| meta.get(k).and_then(J::as_str).map(str::to_owned);
            RawNode {
                node: name(id),
                parent: match tree.parent(id) {
                    Some(TreeParentId::Node(p)) => Some(name(p)),
                    _ => None,
                },
                item: field("item"),
                kind: field("kind"),
            }
        })
        .collect();
    out.sort_by(|a, b| a.node.cmp(&b.node));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dir_rules() {
        let dir = tempfile::tempdir().unwrap();
        for d in [
            "items/ab",
            "types/00",
            "blobs/ff",
            "logs/activity/2026-10",
            "local/x/y",
            "tmp/z",
            "structure",
            "items/g1",
            "items/ab/cd",
            "logs/other",
            "logs/review/2026-13",
            "junk",
        ] {
            fs::create_dir_all(dir.path().join(d)).unwrap();
        }
        assert_eq!(
            unexpected_dirs(dir.path()).unwrap(),
            [
                "items/ab/cd",
                "items/g1",
                "junk",
                "logs/other",
                "logs/review/2026-13"
            ]
        );
    }

    #[test]
    fn check_doc_attributes_bad_parts() {
        let now = dem_model::Timestamp::from_millisecond(1_760_000_000_000).unwrap();
        let meta = dem_model::ItemMeta {
            id: ItemId::new(),
            type_id: dem_model::TypeId("note".into()),
            title: None,
            state: dem_model::ItemState::Active,
            privacy: dem_model::Privacy::Normal,
            container: None,
            tags: vec![],
            created: now,
            updated: now,
            time: None,
            source: dem_model::SourceInfo::default(),
            ai_web: false,
        };
        let doc = ItemDoc::create(&meta).unwrap();
        let good = doc.export_snapshot().unwrap();
        let stem = meta.id.to_string();
        let parts = vec![
            ("a.dexm".to_owned(), good),
            ("b.dexu".to_owned(), b"not loro".to_vec()),
        ];
        let c = check_doc(DocDir::Items, &stem, &parts);
        assert_eq!(c.import_errors.len(), 1);
        assert_eq!(c.import_errors[0].0, "b.dexu");
        assert!(c.doc_error.is_none());
        assert!(c.item.is_some());
        assert!(malformed_links(c.item.as_ref().unwrap()).is_empty());

        let empty = check_doc(DocDir::Items, &stem, &[]);
        assert_eq!(empty.doc_error.as_deref(), Some("missing dem.schema"));
    }
}
