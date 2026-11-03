//! `dem-dev inspect` (P0-36): unlock a library and print its items, structure,
//! logs, history and files. A debugging tool: it prints decrypted content,
//! including private and confidential items.
//!
//! Every read goes through `dem-store`; output is text by default and JSON with
//! `--json`.

use std::collections::BTreeMap;
use std::io::Write;
use std::process::ExitCode;

use dem_model::{ItemId, ItemMeta, ItemState, Privacy};
use dem_store::layout::{self, DocDir, FileKind};
use dem_store::logs::LogKind;
use dem_store::structure::StructureNode;
use dem_store::{ItemDoc, Library, NodeKind};
use serde::Serialize;
use serde_json::{Value as J, json};

use crate::{LibraryArgs, unlock};

#[derive(Debug, Clone, clap::Args)]
pub struct Args {
    #[command(flatten)]
    pub library: LibraryArgs,
    /// Machine-readable JSON output.
    #[arg(long, global = true)]
    pub json: bool,
    /// What to show (default: `list`).
    #[command(subcommand)]
    pub command: Option<InspectCommand>,
}

#[derive(Debug, Clone, clap::Subcommand)]
pub enum InspectCommand {
    /// List items, optionally filtered.
    List(ListArgs),
    /// Meta, fields, links, body and history of one item.
    Item { id: ItemId },
    /// The domain/project tree.
    Structure,
    /// Records of one log kind.
    Logs {
        /// activity, review or ai-access.
        #[arg(long, default_value = "activity", value_parser = parse_log_kind)]
        kind: LogKindArg,
    },
    /// Every file in the library with its classification (no unlock needed).
    Files,
}

#[derive(Debug, Clone, Default, clap::Args)]
pub struct ListArgs {
    /// Only this type id.
    #[arg(long = "type")]
    pub type_id: Option<String>,
    /// Only this privacy level.
    #[arg(long, value_parser = parse_privacy)]
    pub privacy: Option<Privacy>,
    /// Only this state.
    #[arg(long, value_parser = parse_state)]
    pub state: Option<ItemState>,
}

/// Clap-friendly wrapper (LogKind lives in dem-store).
#[derive(Debug, Clone, Copy)]
pub struct LogKindArg(pub LogKind);

fn parse_log_kind(s: &str) -> Result<LogKindArg, String> {
    [LogKind::Activity, LogKind::Review, LogKind::AiAccess]
        .into_iter()
        .find(|k| k.as_str() == s)
        .map(LogKindArg)
        .ok_or_else(|| format!("unknown log kind {s:?}"))
}

fn parse_enum<T: serde::de::DeserializeOwned>(s: &str) -> Result<T, String> {
    serde_json::from_value(J::String(s.to_owned())).map_err(|_| format!("unknown value {s:?}"))
}

fn parse_privacy(s: &str) -> Result<Privacy, String> {
    parse_enum(s)
}

fn parse_state(s: &str) -> Result<ItemState, String> {
    parse_enum(s)
}

fn enum_str<T: Serialize>(v: &T) -> String {
    match serde_json::to_value(v) {
        Ok(J::String(s)) => s,
        _ => String::new(),
    }
}

// ---- list ----------------------------------------------------------------------

/// One line of `inspect list`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ItemRow {
    pub id: ItemId,
    #[serde(rename = "type")]
    pub type_id: String,
    pub state: ItemState,
    pub privacy: Privacy,
    pub title: Option<String>,
    pub updated: dem_model::Timestamp,
}

impl ListArgs {
    fn matches(&self, m: &ItemMeta) -> bool {
        self.type_id.as_ref().is_none_or(|t| *t == m.type_id.0)
            && self.privacy.is_none_or(|p| p == m.privacy)
            && self.state.is_none_or(|s| s == m.state)
    }
}

/// Items that could not be read: id and error.
pub type Unreadable = Vec<(ItemId, String)>;

/// Items passing the filters, in id (creation) order, and the items that could
/// not be read. A damaged item does not hide the others.
pub fn list_items(
    library: &Library,
    filter: &ListArgs,
) -> anyhow::Result<(Vec<ItemRow>, Unreadable)> {
    let mut rows = Vec::new();
    let mut failed = Vec::new();
    for id in library.item_ids()? {
        let meta = match library.load_item(id).and_then(|d| d.meta()) {
            Ok(m) => m,
            Err(e) => {
                failed.push((id, e.to_string()));
                continue;
            }
        };
        if filter.matches(&meta) {
            rows.push(ItemRow {
                id,
                type_id: meta.type_id.0,
                state: meta.state,
                privacy: meta.privacy,
                title: meta.title,
                updated: meta.updated,
            });
        }
    }
    Ok((rows, failed))
}

fn print_rows(out: &mut impl Write, rows: &[ItemRow]) -> std::io::Result<()> {
    for r in rows {
        writeln!(
            out,
            "{}  {:<12} {:<8} {:<12} {}  {}",
            r.id,
            r.type_id,
            enum_str(&r.state),
            enum_str(&r.privacy),
            r.updated,
            r.title.as_deref().unwrap_or("(untitled)"),
        )?;
    }
    writeln!(out, "{} items", rows.len())
}

// ---- item ----------------------------------------------------------------------

/// Unix seconds of a change as RFC 3339 (empty when out of range).
fn change_time(secs: i64) -> String {
    dem_model::Timestamp::from_second(secs)
        .map(|t| t.to_string())
        .unwrap_or_default()
}

/// Everything `inspect item` shows, as JSON.
pub fn item_details(doc: &ItemDoc) -> anyhow::Result<J> {
    let links: Vec<J> = doc
        .links()
        .into_iter()
        .map(|(rel, to, kind)| json!({ "id": rel, "to": to.to_string(), "kind": kind }))
        .collect();
    let history: Vec<J> = doc
        .history()
        .into_iter()
        .map(|c| {
            json!({
                "lamport": c.lamport,
                "time": change_time(c.timestamp),
                "origin": c.message,
                "peer": format!("{:016x}", c.peer),
                "counter": c.counter,
                "ops": c.ops,
            })
        })
        .collect();
    Ok(json!({
        "meta": serde_json::to_value(doc.meta()?)?,
        "fields": doc.fields(),
        "links": links,
        "body": doc.body_text(),
        "history": history,
    }))
}

fn print_item(out: &mut impl Write, d: &J) -> std::io::Result<()> {
    writeln!(out, "meta:")?;
    if let Some(m) = d["meta"].as_object() {
        for (k, v) in m {
            writeln!(out, "  {k}: {v}")?;
        }
    }
    writeln!(out, "fields:")?;
    if let Some(m) = d["fields"].as_object() {
        for (k, v) in m {
            writeln!(out, "  {k}: {v}")?;
        }
    }
    writeln!(out, "links:")?;
    for l in d["links"].as_array().into_iter().flatten() {
        writeln!(
            out,
            "  {} -> {} ({})",
            l["id"].as_str().unwrap_or_default(),
            l["to"].as_str().unwrap_or_default(),
            l["kind"].as_str().unwrap_or_default()
        )?;
    }
    writeln!(out, "body:")?;
    for line in d["body"].as_str().unwrap_or_default().split('\n') {
        writeln!(out, "  | {line}")?;
    }
    writeln!(out, "history:")?;
    for c in d["history"].as_array().into_iter().flatten() {
        writeln!(
            out,
            "  lamport {:>6}  {}  {}  ({} ops, peer {})",
            c["lamport"].as_u64().unwrap_or_default(),
            c["time"].as_str().unwrap_or_default(),
            c["origin"].as_str().unwrap_or("(no message)"),
            c["ops"],
            c["peer"].as_str().unwrap_or_default(),
        )?;
    }
    Ok(())
}

// ---- structure -----------------------------------------------------------------

/// A structure node with its item's title, and its children.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TreeNode {
    pub item: ItemId,
    pub kind: &'static str,
    pub title: Option<String>,
    pub children: Vec<TreeNode>,
}

fn kind_str(k: NodeKind) -> &'static str {
    match k {
        NodeKind::Domain => "domain",
        NodeKind::Project => "project",
    }
}

/// The structure as a forest; siblings in id order. Titles come from the items
/// (missing items show no title).
pub fn structure_tree(library: &Library) -> anyhow::Result<Vec<TreeNode>> {
    let nodes = library.load_structure()?.nodes();
    let mut children: BTreeMap<Option<ItemId>, Vec<&StructureNode>> = BTreeMap::new();
    for n in &nodes {
        children.entry(n.parent).or_default().push(n);
    }
    fn build(
        library: &Library,
        children: &BTreeMap<Option<ItemId>, Vec<&StructureNode>>,
        parent: Option<ItemId>,
    ) -> Vec<TreeNode> {
        children
            .get(&parent)
            .into_iter()
            .flatten()
            .map(|n| TreeNode {
                item: n.item,
                kind: kind_str(n.kind),
                title: library
                    .load_item(n.item)
                    .ok()
                    .and_then(|d| d.meta().ok())
                    .and_then(|m| m.title),
                children: build(library, children, Some(n.item)),
            })
            .collect()
    }
    Ok(build(library, &children, None))
}

fn print_tree(out: &mut impl Write, nodes: &[TreeNode], depth: usize) -> std::io::Result<()> {
    for n in nodes {
        writeln!(
            out,
            "{}- [{}] {} ({})",
            "  ".repeat(depth),
            n.kind,
            n.title.as_deref().unwrap_or("(untitled)"),
            n.item
        )?;
        print_tree(out, &n.children, depth + 1)?;
    }
    Ok(())
}

// ---- files ---------------------------------------------------------------------

fn doc_dir_str(d: DocDir) -> &'static str {
    match d {
        DocDir::Items => "items",
        DocDir::Types => "types",
        DocDir::Structure => "structure",
    }
}

/// Short classification label, e.g. `snapshot(items)` or `log(activity 2026-01)`.
pub fn kind_label(k: &FileKind) -> String {
    match k {
        FileKind::Manifest => "manifest".into(),
        FileKind::Lock => "lock".into(),
        FileKind::Index => "index".into(),
        FileKind::Local => "local".into(),
        FileKind::Temp => "temp".into(),
        FileKind::Snapshot { dir, .. } => format!("snapshot({})", doc_dir_str(*dir)),
        FileKind::Update {
            dir, device, seq, ..
        } => format!("update({} device {device} seq {seq})", doc_dir_str(*dir)),
        FileKind::LogSegment {
            kind,
            month,
            device,
        } => format!("log({kind} {month} device {device})"),
        FileKind::Blob { .. } => "blob".into(),
        FileKind::Vault => "vault".into(),
        FileKind::Unexpected => "UNEXPECTED".into(),
    }
}

// ---- command -------------------------------------------------------------------

fn print_json(out: &mut impl Write, v: &J) -> anyhow::Result<()> {
    serde_json::to_writer_pretty(&mut *out, v)?;
    writeln!(out)?;
    Ok(())
}

pub fn run(args: Args) -> anyhow::Result<ExitCode> {
    let mut out = std::io::stdout().lock();
    let command = args
        .command
        .unwrap_or_else(|| InspectCommand::List(ListArgs::default()));
    if let InspectCommand::Files = command {
        let files = layout::scan(&args.library.library)?;
        if args.json {
            let v: Vec<J> = files
                .iter()
                .map(|f| json!({ "path": f.rel, "kind": kind_label(&f.kind) }))
                .collect();
            print_json(&mut out, &J::Array(v))?;
        } else {
            for f in &files {
                writeln!(out, "{}  {}", f.rel, kind_label(&f.kind))?;
            }
            writeln!(out, "{} files", files.len())?;
        }
        return Ok(ExitCode::SUCCESS);
    }

    let library = unlock::open(&args.library)?;
    match command {
        InspectCommand::List(filter) => {
            let (rows, failed) = list_items(&library, &filter)?;
            if args.json {
                print_json(&mut out, &serde_json::to_value(&rows)?)?;
            } else {
                print_rows(&mut out, &rows)?;
            }
            if !failed.is_empty() {
                for (id, e) in &failed {
                    eprintln!("cannot read item {id}: {e}");
                }
                eprintln!("{} items could not be read", failed.len());
                return Ok(ExitCode::FAILURE);
            }
        }
        InspectCommand::Item { id } => {
            let d = item_details(&library.load_item(id)?)?;
            if args.json {
                print_json(&mut out, &d)?;
            } else {
                print_item(&mut out, &d)?;
            }
        }
        InspectCommand::Structure => {
            let tree = structure_tree(&library)?;
            if args.json {
                print_json(&mut out, &serde_json::to_value(&tree)?)?;
            } else {
                print_tree(&mut out, &tree, 0)?;
            }
        }
        InspectCommand::Logs { kind } => {
            let read = library.read_logs(kind.0)?;
            if args.json {
                print_json(
                    &mut out,
                    &json!({
                        "records": read.records,
                        "damaged": read.damaged,
                        "torn_tail_bytes": read.torn_tail_bytes,
                    }),
                )?;
            } else {
                for r in &read.records {
                    writeln!(out, "{} {} {}", r.ts, r.kind, J::Object(r.fields.clone()))?;
                }
                writeln!(
                    out,
                    "{} records, {} damaged, {} torn tail bytes",
                    read.records.len(),
                    read.damaged,
                    read.torn_tail_bytes
                )?;
            }
        }
        InspectCommand::Files => {}
    }
    Ok(ExitCode::SUCCESS)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enum_arguments_parse() {
        assert_eq!(parse_privacy("confidential"), Ok(Privacy::Confidential));
        assert_eq!(parse_state("trashed"), Ok(ItemState::Trashed));
        assert!(parse_privacy("secret").is_err());
        assert!(parse_log_kind("ai-access").is_ok());
        assert!(parse_log_kind("audit").is_err());
    }

    #[test]
    fn file_labels() {
        assert_eq!(kind_label(&layout::classify("manifest.json")), "manifest");
        assert_eq!(kind_label(&FileKind::Manifest), "manifest");
        assert_eq!(kind_label(&FileKind::Unexpected), "UNEXPECTED");
    }
}
