//! `dem-dev convert` (P0-35): items to and from JSON and Markdown.
//!
//! - **JSON** is the lossless debugging and test representation: the item's whole
//!   Loro deep value (`ItemDoc::to_json`) plus its decoded meta. Importing goes
//!   through `ItemDoc::replace_from_json` in `dem-store`, so this module never
//!   touches the document format itself.
//! - **Markdown** carries meta and fields as front matter and the body as plain
//!   paragraphs. Rich text is left to P1. Inline atoms (U+FFFC in the plain
//!   text) are written as `[[link]]` and come back as that literal text.
//!
//! Front matter is YAML-compatible: one `key: value` per line where every value
//! is JSON (a YAML flow value), and fields are indented under `fields:`.

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use anyhow::{Context, bail};
use dem_model::{ChangeOrigin, ItemId, ItemMeta};
use dem_store::item::OBJECT_CHAR;
use dem_store::{ItemDoc, Library, StoreError};
use serde_json::{Map, Value as J, json};

use crate::{LibraryArgs, unlock};

/// Value of `format` in a converter JSON file.
pub const JSON_FORMAT: &str = "dem-item";
/// Version of the converter JSON file layout.
pub const JSON_VERSION: u64 = 1;
/// Markdown stand-in for an inline atom.
pub const LINK_PLACEHOLDER: &str = "[[link]]";

#[derive(Debug, Clone, clap::Args)]
pub struct Args {
    #[command(subcommand)]
    pub command: ConvertCommand,
}

#[derive(Debug, Clone, clap::Subcommand)]
pub enum ConvertCommand {
    /// Print an item as lossless JSON.
    ToJson(ExportArgs),
    /// Create or overwrite an item from a JSON file written by `to-json`.
    FromJson(ImportArgs),
    /// Print an item as Markdown with front matter.
    ToMarkdown(ExportArgs),
    /// Create or overwrite an item from a Markdown file (links are kept).
    FromMarkdown(ImportArgs),
}

#[derive(Debug, Clone, clap::Args)]
pub struct ExportArgs {
    #[command(flatten)]
    pub library: LibraryArgs,
    /// Item id.
    #[arg(long)]
    pub id: ItemId,
    /// Write to this file instead of standard output.
    #[arg(long)]
    pub out: Option<PathBuf>,
}

#[derive(Debug, Clone, clap::Args)]
pub struct ImportArgs {
    #[command(flatten)]
    pub library: LibraryArgs,
    /// File to import.
    pub file: PathBuf,
}

// ---- JSON ----------------------------------------------------------------------

/// The lossless JSON representation of an item.
pub fn item_to_json(doc: &ItemDoc) -> anyhow::Result<J> {
    Ok(json!({
        "format": JSON_FORMAT,
        "v": JSON_VERSION,
        "id": doc.id().to_string(),
        "meta": serde_json::to_value(doc.meta()?)?,
        "doc": doc.to_json(),
    }))
}

/// Unique batch id for one converter import (format spec §6.3).
fn new_batch() -> String {
    format!("convert-{}", ItemId::new())
}

fn load_or_create(library: &Library, meta: &ItemMeta) -> anyhow::Result<(ItemDoc, bool)> {
    match library.load_item(meta.id) {
        Ok(doc) => Ok((doc, false)),
        Err(StoreError::NotFound(_)) => Ok((library.create_item(meta)?, true)),
        Err(e) => Err(e.into()),
    }
}

/// Creates or overwrites the item described by `value` (from [`item_to_json`]).
/// Returns the id and whether the item was new.
pub fn import_json(library: &Library, value: &J) -> anyhow::Result<(ItemId, bool)> {
    if value.get("format").and_then(J::as_str) != Some(JSON_FORMAT) {
        bail!("not a {JSON_FORMAT} JSON file");
    }
    match value.get("v").and_then(J::as_u64) {
        Some(JSON_VERSION) => {}
        other => bail!("unsupported converter JSON version {other:?}"),
    }
    let meta: ItemMeta = serde_json::from_value(value.get("meta").cloned().unwrap_or(J::Null))
        .context("invalid meta")?;
    let id: ItemId = value
        .get("id")
        .and_then(J::as_str)
        .context("missing id")?
        .parse()
        .context("invalid id")?;
    if id != meta.id {
        bail!("id and meta.id differ");
    }
    let doc_json = value.get("doc").context("missing doc")?;
    // Check the file in a scratch document first: a bad file must not leave
    // anything behind, not even the skeleton of a new item.
    let scratch = ItemDoc::create(&meta)?;
    scratch.replace_from_json(doc_json)?;
    if scratch.meta()? != meta {
        bail!("meta does not match the document's meta map");
    }
    let (mut doc, created) = load_or_create(library, &meta)?;
    doc.replace_from_json(doc_json)?;
    doc.commit(ChangeOrigin::Import, Some(&new_batch()));
    library.save_item(&mut doc)?;
    Ok((id, created))
}

// ---- Markdown ------------------------------------------------------------------

/// An item as read from Markdown.
#[derive(Debug, Clone, PartialEq)]
pub struct MdItem {
    pub meta: ItemMeta,
    pub fields: Map<String, J>,
    /// Plain paragraphs, in order.
    pub paragraphs: Vec<String>,
}

fn is_plain_key(k: &str) -> bool {
    !k.is_empty()
        && k.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
}

fn write_key(out: &mut String, k: &str) {
    if is_plain_key(k) {
        out.push_str(k);
    } else {
        out.push_str(&J::String(k.to_owned()).to_string());
    }
}

/// Renders meta, fields and plain paragraphs as Markdown.
pub fn render_markdown(meta: &ItemMeta, fields: &Map<String, J>, paragraphs: &[String]) -> String {
    let mut out = String::from("---\n");
    if let Ok(J::Object(m)) = serde_json::to_value(meta) {
        for (k, v) in &m {
            write_key(&mut out, k);
            out.push_str(": ");
            out.push_str(&v.to_string());
            out.push('\n');
        }
    }
    if fields.is_empty() {
        out.push_str("fields: {}\n");
    } else {
        out.push_str("fields:\n");
        for (k, v) in fields {
            out.push_str("  ");
            write_key(&mut out, k);
            out.push_str(": ");
            out.push_str(&v.to_string());
            out.push('\n');
        }
    }
    out.push_str("---\n");
    if !paragraphs.is_empty() {
        out.push('\n');
        let placeholder = OBJECT_CHAR.to_string();
        let body: Vec<String> = paragraphs
            .iter()
            .map(|p| p.replace(&placeholder, LINK_PLACEHOLDER))
            .collect();
        out.push_str(&body.join("\n\n"));
        out.push('\n');
    }
    out
}

/// Paragraphs of an item's body (an empty body has none).
pub fn paragraphs(doc: &ItemDoc) -> Vec<String> {
    let blocks = doc.to_json()["body"]["children"]
        .as_array()
        .map_or(0, Vec::len);
    if blocks == 0 {
        return Vec::new();
    }
    doc.body_text().split('\n').map(str::to_owned).collect()
}

pub fn item_to_markdown(doc: &ItemDoc) -> anyhow::Result<String> {
    Ok(render_markdown(
        &doc.meta()?,
        &doc.fields(),
        &paragraphs(doc),
    ))
}

/// Splits `key: value` where the key may be JSON-quoted.
fn split_line(line: &str) -> anyhow::Result<(String, &str)> {
    let (key, rest) = if line.starts_with('"') {
        let mut it = serde_json::Deserializer::from_str(line).into_iter::<String>();
        let key = it.next().context("bad quoted key")??;
        let end = it.byte_offset();
        (key, &line[end..])
    } else {
        let colon = line.find(':').context("expected `key: value`")?;
        (line[..colon].to_owned(), &line[colon..])
    };
    let value = rest
        .strip_prefix(':')
        .context("expected `:` after the key")?
        .trim_start();
    Ok((key, value))
}

fn parse_value(key: &str, text: &str) -> anyhow::Result<J> {
    serde_json::from_str(text).with_context(|| format!("value of {key:?} is not valid JSON"))
}

/// Parses Markdown written by [`render_markdown`] (or edited by hand).
pub fn parse_markdown(text: &str) -> anyhow::Result<MdItem> {
    let text = text.replace("\r\n", "\n");
    let rest = text
        .strip_prefix("---\n")
        .context("missing front matter (`---` on the first line)")?;
    let mut pos = 0;
    let mut close = None;
    for line in rest.split_inclusive('\n') {
        if line.trim_end_matches('\n') == "---" {
            close = Some((pos, pos + line.len()));
            break;
        }
        pos += line.len();
    }
    let (front_end, after_start) = close.context("front matter is not closed with `---`")?;
    let front = &rest[..front_end];
    let after = &rest[after_start..];

    let mut meta = Map::new();
    let mut fields = Map::new();
    let mut in_fields = false;
    for line in front.lines() {
        if line.trim().is_empty() {
            continue;
        }
        if let Some(inner) = line.strip_prefix("  ") {
            if !in_fields {
                bail!("indented line outside `fields:`");
            }
            let (k, v) = split_line(inner.trim_start())?;
            fields.insert(k.clone(), parse_value(&k, v)?);
            continue;
        }
        let (k, v) = split_line(line)?;
        if k == "fields" {
            in_fields = true;
            if !v.is_empty() {
                match parse_value(&k, v)? {
                    J::Object(m) => fields.extend(m),
                    _ => bail!("fields must be a map"),
                }
            }
        } else {
            in_fields = false;
            meta.insert(k.clone(), parse_value(&k, v)?);
        }
    }
    let meta: ItemMeta =
        serde_json::from_value(J::Object(meta)).context("front matter is not a valid meta")?;

    // Paragraphs are separated by one blank line; a line break inside a block
    // (hand-edited files) is a soft break and becomes a space. Nothing after the
    // front matter means no paragraphs at all.
    let paragraphs = if after.is_empty() {
        Vec::new()
    } else {
        let body = after.strip_prefix('\n').unwrap_or(after);
        let body = body.strip_suffix('\n').unwrap_or(body);
        body.split("\n\n").map(|p| p.replace('\n', " ")).collect()
    };
    Ok(MdItem {
        meta,
        fields,
        paragraphs,
    })
}

/// Creates or overwrites an item from Markdown. Meta, fields and body are
/// replaced; relations outside the body and version labels are kept.
pub fn import_markdown(library: &Library, md: &MdItem) -> anyhow::Result<(ItemId, bool)> {
    // Encode through a scratch document so the meta and body layout come from
    // dem-store, not from this tool.
    let scratch = ItemDoc::create(&md.meta)?;
    if !md.paragraphs.is_empty() {
        scratch.set_body_text(&md.paragraphs.join("\n"))?;
    }
    for (k, v) in &md.fields {
        scratch.set_field(k, v)?;
    }
    let mut want = scratch.to_json();
    let (mut doc, created) = load_or_create(library, &md.meta)?;
    let current = doc.to_json();
    for keep in ["links", "labels"] {
        if let Some(v) = current.get(keep) {
            want[keep] = v.clone();
        }
    }
    doc.replace_from_json(&want)?;
    doc.commit(ChangeOrigin::Import, Some(&new_batch()));
    library.save_item(&mut doc)?;
    Ok((md.meta.id, created))
}

// ---- command -------------------------------------------------------------------

fn emit(out: Option<&Path>, text: &str) -> anyhow::Result<()> {
    match out {
        Some(p) => std::fs::write(p, text).with_context(|| format!("writing {}", p.display())),
        None => {
            print!("{text}");
            Ok(())
        }
    }
}

fn read_file(p: &Path) -> anyhow::Result<String> {
    std::fs::read_to_string(p).with_context(|| format!("reading {}", p.display()))
}

fn report(id: ItemId, created: bool) {
    let what = if created { "created" } else { "updated" };
    eprintln!("{what} item {id}");
}

pub fn run(args: Args) -> anyhow::Result<ExitCode> {
    match args.command {
        ConvertCommand::ToJson(a) => {
            let library = unlock::open(&a.library)?;
            let doc = library.load_item(a.id)?;
            let mut text = serde_json::to_string_pretty(&item_to_json(&doc)?)?;
            text.push('\n');
            emit(a.out.as_deref(), &text)?;
        }
        ConvertCommand::ToMarkdown(a) => {
            let library = unlock::open(&a.library)?;
            let doc = library.load_item(a.id)?;
            emit(a.out.as_deref(), &item_to_markdown(&doc)?)?;
        }
        ConvertCommand::FromJson(a) => {
            let value: J = serde_json::from_str(&read_file(&a.file)?).context("invalid JSON")?;
            let library = unlock::open(&a.library)?;
            let (id, created) = import_json(&library, &value)?;
            report(id, created);
        }
        ConvertCommand::FromMarkdown(a) => {
            let md = parse_markdown(&read_file(&a.file)?)?;
            let library = unlock::open(&a.library)?;
            let (id, created) = import_markdown(&library, &md)?;
            report(id, created);
        }
    }
    Ok(ExitCode::SUCCESS)
}

#[cfg(test)]
mod tests {
    use dem_model::{ItemState, Privacy, SourceInfo, TagId, Timestamp, TypeId};

    use super::*;

    fn meta() -> ItemMeta {
        let now = Timestamp::from_millisecond(1_760_000_000_123).unwrap();
        ItemMeta {
            id: ItemId::new(),
            type_id: TypeId("note".into()),
            title: Some("标题: \"quoted\"\nline".into()),
            state: ItemState::Inbox,
            privacy: Privacy::Sensitive,
            container: Some(ItemId::new()),
            tags: vec![TagId("a b".into()), TagId("法语".into())],
            created: now,
            updated: now,
            time: None,
            source: SourceInfo::default(),
            ai_web: false,
        }
    }

    #[test]
    fn markdown_round_trip() {
        let mut fields = Map::new();
        fields.insert("n".into(), J::from(2));
        fields.insert("weird key: x".into(), J::from("v"));
        fields.insert("f".into(), J::from(1.0));
        let paras = vec![
            "first".to_owned(),
            String::new(),
            "  spaced  ".to_owned(),
            "---".to_owned(),
        ];
        let m = meta();
        let md = render_markdown(&m, &fields, &paras);
        let back = parse_markdown(&md).unwrap();
        assert_eq!(back.meta, m);
        assert_eq!(back.fields, fields);
        assert_eq!(back.paragraphs, paras);
    }

    #[test]
    fn empty_body_and_single_empty_paragraph_differ() {
        let m = meta();
        let none = parse_markdown(&render_markdown(&m, &Map::new(), &[])).unwrap();
        assert!(none.paragraphs.is_empty());
        let one = parse_markdown(&render_markdown(&m, &Map::new(), &[String::new()])).unwrap();
        assert_eq!(one.paragraphs, [""]);
        assert_eq!(one.meta, m);
    }

    #[test]
    fn atoms_become_placeholders_and_soft_breaks_spaces() {
        let m = meta();
        let md = render_markdown(&m, &Map::new(), &[format!("see {OBJECT_CHAR} here")]);
        assert!(md.contains("see [[link]] here"));
        let hand = md.replace("see [[link]] here", "line one\nline two\n\nnext");
        let back = parse_markdown(&hand.replace('\n', "\r\n")).unwrap();
        assert_eq!(back.paragraphs, ["line one line two", "next"]);
    }

    #[test]
    fn rejects_bad_front_matter() {
        assert!(parse_markdown("no front matter").is_err());
        assert!(parse_markdown("---\ntitle: \"x\"\n").is_err());
        assert!(parse_markdown("---\ntitle: not json\n---\n").is_err());
    }
}
