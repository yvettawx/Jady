//! Library directory layout and file naming (format spec §2).

use std::path::Path;

use dem_model::ItemId;

use crate::{Result, io_err};

pub const MANIFEST: &str = "manifest.json";
pub const LOCK: &str = ".lock";
pub const STRUCTURE_STEM: &str = "structure";
pub const DEVICE_FILE: &str = "local/device.json";

/// 8-byte random id of this machine, as 16 lowercase hex digits.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct DeviceId(pub u64);

impl std::fmt::Display for DeviceId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:016x}", self.0)
    }
}

/// Which kind of CRDT document a snapshot or update belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DocDir {
    Items,
    Types,
    Structure,
}

impl DocDir {
    fn dir(self) -> &'static str {
        match self {
            DocDir::Items => "items",
            DocDir::Types => "types",
            DocDir::Structure => "structure",
        }
    }

    /// Directory holding the document's files, relative to the library root.
    pub fn parent(self, stem: &str) -> String {
        match self {
            DocDir::Structure => "structure".to_owned(),
            _ => format!("{}/{}", self.dir(), dem_crypto::shard(stem)),
        }
    }

    pub fn snapshot(self, stem: &str) -> String {
        format!("{}/{stem}.dexm", self.parent(stem))
    }

    pub fn update(self, stem: &str, device: DeviceId, seq: u64) -> String {
        format!("{}/{stem}.{device}-{seq}.dexu", self.parent(stem))
    }
}

pub fn item_stem(id: &ItemId) -> String {
    id.to_string()
}

pub fn blob_path(name: &str) -> String {
    format!("blobs/{}/{name}.dexs", dem_crypto::shard(name))
}

pub fn log_segment(kind: &str, month: &str, device: DeviceId) -> String {
    format!("logs/{kind}/{month}/{device}.dexl")
}

/// Classification of a file found in a library directory.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FileKind {
    Manifest,
    Lock,
    Index,
    Local,
    Temp,
    Snapshot {
        dir: DocDir,
        stem: String,
    },
    Update {
        dir: DocDir,
        stem: String,
        device: String,
        seq: u64,
    },
    LogSegment {
        kind: String,
        month: String,
        device: String,
    },
    Blob {
        name: String,
    },
    /// The password store (`vault/`), reserved for P4.
    Vault,
    /// Anything the format does not allow at this place.
    Unexpected,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LibraryFile {
    /// Library-relative path with `/` separators.
    pub rel: String,
    pub kind: FileKind,
}

/// Classifies a library-relative path purely by its name and place.
pub fn classify(rel: &str) -> FileKind {
    let parts: Vec<&str> = rel.split('/').collect();
    match parts.as_slice() {
        [MANIFEST] => FileKind::Manifest,
        [LOCK] => FileKind::Lock,
        ["index.sqlite"]
        | ["index.sqlite-wal"]
        | ["index.sqlite-shm"]
        | ["index.sqlite-journal"] => FileKind::Index,
        ["local", ..] => FileKind::Local,
        ["tmp", ..] => FileKind::Temp,
        ["vault", ..] => FileKind::Vault,
        ["structure", name] => doc_file(DocDir::Structure, name),
        [d @ ("items" | "types"), shard, name] => {
            let dir = if *d == "items" {
                DocDir::Items
            } else {
                DocDir::Types
            };
            let kind = doc_file(dir, name);
            match &kind {
                FileKind::Snapshot { stem, .. } | FileKind::Update { stem, .. }
                    if dem_crypto::shard(stem) == *shard =>
                {
                    kind
                }
                _ => FileKind::Unexpected,
            }
        }
        ["blobs", shard, name] => match name.strip_suffix(".dexs") {
            Some(n)
                if n.len() == 64
                    && n.bytes()
                        .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
                    && dem_crypto::shard(n) == *shard =>
            {
                FileKind::Blob { name: n.to_owned() }
            }
            _ => FileKind::Unexpected,
        },
        ["logs", kind, month, name] => match name.strip_suffix(".dexl") {
            Some(dev) if is_device(dev) && is_month(month) && is_log_kind(kind) => {
                FileKind::LogSegment {
                    kind: (*kind).to_owned(),
                    month: (*month).to_owned(),
                    device: dev.to_owned(),
                }
            }
            _ => FileKind::Unexpected,
        },
        _ => FileKind::Unexpected,
    }
}

fn doc_file(dir: DocDir, name: &str) -> FileKind {
    if let Some(stem) = name.strip_suffix(".dexm") {
        if valid_stem(dir, stem) {
            return FileKind::Snapshot {
                dir,
                stem: stem.to_owned(),
            };
        }
    } else if let Some(rest) = name.strip_suffix(".dexu")
        && let Some((stem, tail)) = rest.split_once('.')
        && let Some((device, seq)) = tail.split_once('-')
        && valid_stem(dir, stem)
        && is_device(device)
        && let Ok(seq) = seq.parse::<u64>()
    {
        return FileKind::Update {
            dir,
            stem: stem.to_owned(),
            device: device.to_owned(),
            seq,
        };
    }
    FileKind::Unexpected
}

fn valid_stem(dir: DocDir, stem: &str) -> bool {
    match dir {
        DocDir::Structure => stem == STRUCTURE_STEM,
        DocDir::Items => stem
            .parse::<ItemId>()
            .is_ok_and(|id| id.to_string() == stem),
        DocDir::Types => {
            !stem.is_empty()
                && stem
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
        }
    }
}

fn is_device(s: &str) -> bool {
    s.len() == 16
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn is_month(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 7
        && b[4] == b'-'
        && s[..4].parse::<u32>().is_ok()
        && matches!(s[5..].parse::<u32>(), Ok(1..=12))
}

fn is_log_kind(s: &str) -> bool {
    matches!(s, "activity" | "review" | "ai-access")
}

/// Lists every file under the library root (sorted), with its classification.
pub fn scan(root: &Path) -> Result<Vec<LibraryFile>> {
    let mut out = Vec::new();
    walk(root, root, &mut out)?;
    out.sort_by(|a, b| a.rel.cmp(&b.rel));
    Ok(out)
}

fn walk(root: &Path, dir: &Path, out: &mut Vec<LibraryFile>) -> Result<()> {
    for entry in std::fs::read_dir(dir).map_err(io_err(dir))? {
        let entry = entry.map_err(io_err(dir))?;
        let path = entry.path();
        let ft = entry.file_type().map_err(io_err(&path))?;
        if ft.is_dir() {
            walk(root, &path, out)?;
        } else {
            let rel = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .components()
                .map(|c| c.as_os_str().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join("/");
            let kind = classify(&rel);
            out.push(LibraryFile { rel, kind });
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_round_trip_through_classify() {
        let id = ItemId::new();
        let stem = item_stem(&id);
        let snap = DocDir::Items.snapshot(&stem);
        assert!(matches!(
            classify(&snap),
            FileKind::Snapshot {
                dir: DocDir::Items,
                ..
            }
        ));
        let upd = DocDir::Items.update(&stem, DeviceId(0xabc), 1_760_000_000_000);
        match classify(&upd) {
            FileKind::Update { device, seq, .. } => {
                assert_eq!(device, "0000000000000abc");
                assert_eq!(seq, 1_760_000_000_000);
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(
            classify(&DocDir::Structure.snapshot("structure")),
            FileKind::Snapshot {
                dir: DocDir::Structure,
                stem: "structure".into()
            }
        );
        let name = "a".repeat(64);
        assert_eq!(classify(&blob_path(&name)), FileKind::Blob { name });
        assert!(matches!(
            classify(&log_segment("activity", "2026-10", DeviceId(1))),
            FileKind::LogSegment { .. }
        ));
    }

    #[test]
    fn misplaced_or_malformed_files_are_unexpected() {
        let id = ItemId::new().to_string();
        let wrong_shard = if dem_crypto::shard(&id) == "00" {
            "01"
        } else {
            "00"
        };
        for rel in [
            format!("items/{wrong_shard}/{id}.dexm"),
            format!("items/{}/{}.dexm", dem_crypto::shard("x"), "x"),
            "items/ab/cd/x.dexm".to_owned(),
            "notes.txt".to_owned(),
            "logs/activity/2026-13/0000000000000001.dexl".to_owned(),
            "logs/other/2026-10/0000000000000001.dexl".to_owned(),
        ] {
            assert_eq!(classify(&rel), FileKind::Unexpected, "{rel}");
        }
    }
}
