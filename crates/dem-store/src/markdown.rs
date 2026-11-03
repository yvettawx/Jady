//! Between Markdown and an item's body (format spec §6.2): imports write the same structure the
//! editor does, exports read it back. Node and mark names are the editor's schema
//! (`apps/desktop/src/editor/schema.ts`); changing one here means changing it there.

use dem_model::ItemId;
use loro::{
    Container, ExpandType, LoroList, LoroMap, LoroText, LoroValue, StyleConfig, StyleConfigMap,
    ToJson, ValueOrContainer,
};
use pulldown_cmark::{
    CodeBlockKind, Event, HeadingLevel, Options, Parser, Tag, TagEnd, TextMergeStream,
};
use serde_json::Value as J;

use crate::item::ItemDoc;
use crate::{Result, StoreError};

/// One run of text with its marks, or an inline atom.
#[derive(Debug, Clone, PartialEq)]
enum Inline {
    Text { text: String, marks: Vec<Mark> },
    Link { target: String, label: String },
    Break,
}

#[derive(Debug, Clone, PartialEq)]
enum Mark {
    Strong,
    Em,
    Strike,
    Code,
    Href(String),
}

#[derive(Debug, Clone, PartialEq)]
enum Block {
    Paragraph(Vec<Inline>),
    Heading(u8, Vec<Inline>),
    Quote(Vec<Block>),
    Bullets(Vec<Vec<Block>>),
    Numbers(Vec<Vec<Block>>),
    Code(String, String),
    Rule,
}

/// Marks must be configured on every replica that writes them (format spec §6.1).
pub(crate) fn config_marks(doc: &loro::LoroDoc) {
    let mut styles = StyleConfigMap::new();
    for name in ["strong", "em", "underline", "strike", "code", "highlight"] {
        styles.insert(
            name.into(),
            StyleConfig {
                expand: ExpandType::After,
            },
        );
    }
    styles.insert(
        "link".into(),
        StyleConfig {
            expand: ExpandType::None,
        },
    );
    doc.config_text_style(styles);
}

fn level(l: HeadingLevel) -> u8 {
    match l {
        HeadingLevel::H1 => 1,
        HeadingLevel::H2 => 2,
        HeadingLevel::H3 => 3,
        HeadingLevel::H4 => 4,
        HeadingLevel::H5 => 5,
        HeadingLevel::H6 => 6,
    }
}

/// Reads Markdown into blocks. `[[标题]]` links are resolved by `link`.
fn parse(md: &str, link: &dyn Fn(&str) -> Option<ItemId>) -> Vec<Block> {
    #[derive(Debug)]
    enum Frame {
        Root(Vec<Block>),
        Paragraph(Vec<Inline>),
        Heading(u8, Vec<Inline>),
        Quote(Vec<Block>),
        List(bool, Vec<Vec<Block>>),
        Item(Vec<Block>, Vec<Inline>),
        Code(String, String),
    }
    let mut stack = vec![Frame::Root(Vec::new())];
    let mut marks: Vec<Mark> = Vec::new();

    fn push_block(stack: &mut [Frame], b: Block) {
        match stack.last_mut() {
            Some(Frame::Root(v) | Frame::Quote(v)) => v.push(b),
            Some(Frame::Item(v, inline)) => {
                if !inline.is_empty() {
                    v.push(Block::Paragraph(std::mem::take(inline)));
                }
                v.push(b);
            }
            _ => {}
        }
    }
    fn inlines(stack: &mut [Frame]) -> Option<&mut Vec<Inline>> {
        match stack.last_mut() {
            Some(Frame::Paragraph(v) | Frame::Heading(_, v) | Frame::Item(_, v)) => Some(v),
            _ => None,
        }
    }
    let push_text = |stack: &mut Vec<Frame>, text: &str, marks: &[Mark]| {
        if let Some(Frame::Code(_, code)) = stack.last_mut() {
            code.push_str(text);
            return;
        }
        let Some(out) = inlines(stack) else { return };
        // `[[标题]]` is a link to another item; anything unresolved stays as typed.
        let mut rest = text;
        while let Some(open) = rest.find("[[") {
            let Some(close) = rest[open..].find("]]") else {
                break;
            };
            let label = &rest[open + 2..open + close];
            let Some(target) = link(label) else {
                out.push(Inline::Text {
                    text: rest[..open + close + 2].to_owned(),
                    marks: marks.to_vec(),
                });
                rest = &rest[open + close + 2..];
                continue;
            };
            if open > 0 {
                out.push(Inline::Text {
                    text: rest[..open].to_owned(),
                    marks: marks.to_vec(),
                });
            }
            out.push(Inline::Link {
                target: target.to_string(),
                label: label.to_owned(),
            });
            rest = &rest[open + close + 2..];
        }
        if !rest.is_empty() {
            out.push(Inline::Text {
                text: rest.to_owned(),
                marks: marks.to_vec(),
            });
        }
    };

    let parser = Parser::new_ext(
        md,
        Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS,
    );
    for ev in TextMergeStream::new(parser) {
        match ev {
            Event::Start(tag) => match tag {
                Tag::Paragraph => {
                    // Tight list items have no paragraph events; loose ones do.
                    if !matches!(stack.last(), Some(Frame::Item(..))) {
                        stack.push(Frame::Paragraph(Vec::new()));
                    }
                }
                Tag::Heading { level: l, .. } => stack.push(Frame::Heading(level(l), Vec::new())),
                Tag::BlockQuote(_) => stack.push(Frame::Quote(Vec::new())),
                Tag::List(start) => stack.push(Frame::List(start.is_some(), Vec::new())),
                Tag::Item => stack.push(Frame::Item(Vec::new(), Vec::new())),
                Tag::CodeBlock(kind) => {
                    let lang = match kind {
                        CodeBlockKind::Fenced(l) => l.to_string(),
                        CodeBlockKind::Indented => String::new(),
                    };
                    stack.push(Frame::Code(lang, String::new()));
                }
                Tag::Strong => marks.push(Mark::Strong),
                Tag::Emphasis => marks.push(Mark::Em),
                Tag::Strikethrough => marks.push(Mark::Strike),
                Tag::Link { dest_url, .. } => marks.push(Mark::Href(dest_url.to_string())),
                _ => {}
            },
            Event::End(tag) => match tag {
                TagEnd::Paragraph => {
                    if matches!(stack.last(), Some(Frame::Paragraph(_)))
                        && let Some(Frame::Paragraph(v)) = stack.pop()
                    {
                        push_block(&mut stack, Block::Paragraph(v));
                    } else if let Some(Frame::Item(v, inline)) = stack.last_mut()
                        && !inline.is_empty()
                    {
                        v.push(Block::Paragraph(std::mem::take(inline)));
                    }
                }
                TagEnd::Heading(_) => {
                    if let Some(Frame::Heading(l, v)) = stack.pop() {
                        push_block(&mut stack, Block::Heading(l, v));
                    }
                }
                TagEnd::BlockQuote(_) => {
                    if let Some(Frame::Quote(v)) = stack.pop() {
                        push_block(&mut stack, Block::Quote(v));
                    }
                }
                TagEnd::List(_) => {
                    if let Some(Frame::List(numbered, items)) = stack.pop() {
                        push_block(
                            &mut stack,
                            if numbered {
                                Block::Numbers(items)
                            } else {
                                Block::Bullets(items)
                            },
                        );
                    }
                }
                TagEnd::Item => {
                    if let Some(Frame::Item(mut v, inline)) = stack.pop() {
                        if !inline.is_empty() {
                            v.push(Block::Paragraph(inline));
                        }
                        if let Some(Frame::List(_, items)) = stack.last_mut() {
                            items.push(v);
                        }
                    }
                }
                TagEnd::CodeBlock => {
                    if let Some(Frame::Code(lang, code)) = stack.pop() {
                        push_block(
                            &mut stack,
                            Block::Code(lang, code.trim_end_matches('\n').to_owned()),
                        );
                    }
                }
                TagEnd::Strong | TagEnd::Emphasis | TagEnd::Strikethrough | TagEnd::Link => {
                    marks.pop();
                }
                _ => {}
            },
            Event::Text(t) => push_text(&mut stack, &t, &marks),
            Event::Code(t) => {
                let mut with = marks.clone();
                with.push(Mark::Code);
                push_text(&mut stack, &t, &with);
            }
            Event::SoftBreak => push_text(&mut stack, " ", &marks),
            Event::HardBreak => {
                if let Some(out) = inlines(&mut stack) {
                    out.push(Inline::Break);
                }
            }
            Event::Rule => push_block(&mut stack, Block::Rule),
            Event::TaskListMarker(done) => {
                let text = if done { "[x] " } else { "[ ] " };
                push_text(&mut stack, text, &[]);
            }
            _ => {}
        }
    }
    match stack.into_iter().next() {
        Some(Frame::Root(v)) => v,
        _ => Vec::new(),
    }
}

fn new_node(list: &LoroList, name: &str) -> Result<(LoroMap, LoroMap, LoroList)> {
    let node: LoroMap = list.push_container(LoroMap::new())?;
    node.insert("nodeName", name)?;
    let attrs: LoroMap = node.insert_container("attributes", LoroMap::new())?;
    let kids: LoroList = node.insert_container("children", LoroList::new())?;
    Ok((node, attrs, kids))
}

fn write_inlines(kids: &LoroList, inlines: &[Inline]) -> Result<()> {
    // Text first, marks after: a mark that expands would swallow text inserted behind it.
    type Pending = (usize, usize, Mark);
    fn flush(text: &mut Option<LoroText>, pending: &mut Vec<Pending>) -> Result<()> {
        if let Some(t) = text.take() {
            for (start, end, m) in pending.drain(..) {
                let (key, value): (&str, LoroValue) = match m {
                    Mark::Strong => ("strong", true.into()),
                    Mark::Em => ("em", true.into()),
                    Mark::Strike => ("strike", true.into()),
                    Mark::Code => ("code", true.into()),
                    Mark::Href(h) => {
                        let mut map = std::collections::HashMap::new();
                        map.insert("href".to_owned(), LoroValue::from(h.as_str()));
                        ("link", map.into())
                    }
                };
                t.mark(start..end, key, value)?;
            }
        }
        Ok(())
    }
    let mut text: Option<LoroText> = None;
    let mut pending: Vec<Pending> = Vec::new();
    for inline in inlines {
        match inline {
            Inline::Text { text: s, marks } => {
                if s.is_empty() {
                    continue;
                }
                if text.is_none() {
                    text = Some(kids.push_container(LoroText::new())?);
                }
                if let Some(t) = &text {
                    let start = t.len_unicode();
                    t.insert(start, s)?;
                    let end = t.len_unicode();
                    pending.extend(marks.iter().map(|m| (start, end, m.clone())));
                }
            }
            Inline::Link { target, label } => {
                flush(&mut text, &mut pending)?;
                let (_, attrs, _) = new_node(kids, "item_link")?;
                attrs.insert("target", target.as_str())?;
                attrs.insert("label", label.as_str())?;
            }
            Inline::Break => {
                flush(&mut text, &mut pending)?;
                new_node(kids, "hard_break")?;
            }
        }
    }
    flush(&mut text, &mut pending)
}

fn write_blocks(list: &LoroList, blocks: &[Block]) -> Result<()> {
    for b in blocks {
        match b {
            Block::Paragraph(i) => {
                let (_, _, kids) = new_node(list, "paragraph")?;
                write_inlines(&kids, i)?;
            }
            Block::Heading(l, i) => {
                let (_, attrs, kids) = new_node(list, "heading")?;
                attrs.insert("level", i64::from(*l))?;
                write_inlines(&kids, i)?;
            }
            Block::Quote(v) => {
                let (_, _, kids) = new_node(list, "blockquote")?;
                write_blocks(&kids, v)?;
            }
            Block::Bullets(items) | Block::Numbers(items) => {
                let name = if matches!(b, Block::Bullets(_)) {
                    "bullet_list"
                } else {
                    "ordered_list"
                };
                let (_, attrs, kids) = new_node(list, name)?;
                if matches!(b, Block::Numbers(_)) {
                    attrs.insert("order", 1_i64)?;
                }
                for item in items {
                    let (_, _, inner) = new_node(&kids, "list_item")?;
                    if item.is_empty() {
                        new_node(&inner, "paragraph")?;
                    }
                    write_blocks(&inner, item)?;
                }
            }
            Block::Code(lang, code) => {
                let (_, attrs, kids) = new_node(list, "code_block")?;
                attrs.insert("language", lang.as_str())?;
                write_inlines(
                    &kids,
                    &[Inline::Text {
                        text: code.clone(),
                        marks: Vec::new(),
                    }],
                )?;
            }
            Block::Rule => {
                new_node(list, "horizontal_rule")?;
            }
        }
    }
    Ok(())
}

fn body_children(doc: &ItemDoc) -> Result<LoroList> {
    match doc.loro().get_map("body").get("children") {
        Some(ValueOrContainer::Container(Container::List(l))) => Ok(l),
        _ => Err(StoreError::InvalidDocument("body.children".into())),
    }
}

impl ItemDoc {
    /// Replaces the body with this Markdown. `[[标题]]` becomes a link when `link` knows the title.
    pub fn set_body_markdown(&self, md: &str, link: &dyn Fn(&str) -> Option<ItemId>) -> Result<()> {
        config_marks(self.loro());
        let list = body_children(self)?;
        list.clear()?;
        write_blocks(&list, &parse(md, link))
    }

    /// Adds Markdown after what is there, leaving what is there untouched.
    pub fn append_body_markdown(
        &self,
        md: &str,
        link: &dyn Fn(&str) -> Option<ItemId>,
    ) -> Result<()> {
        config_marks(self.loro());
        write_blocks(&body_children(self)?, &parse(md, link))
    }

    /// The body as Markdown. `title` turns a link's target into the name shown in `[[…]]`.
    pub fn body_markdown(&self, title: &dyn Fn(&str) -> Option<String>) -> Result<String> {
        let list = body_children(self)?;
        let mut out = String::new();
        render_list(&list, &mut out, "", title);
        Ok(out.trim_end().to_owned() + "\n")
    }
}

fn node_of(v: Option<ValueOrContainer>) -> Option<LoroMap> {
    match v {
        Some(ValueOrContainer::Container(Container::Map(m))) => Some(m),
        _ => None,
    }
}

fn children_of(m: &LoroMap) -> Option<LoroList> {
    match m.get("children") {
        Some(ValueOrContainer::Container(Container::List(l))) => Some(l),
        _ => None,
    }
}

fn name_of(m: &LoroMap) -> String {
    match m.get("nodeName") {
        Some(ValueOrContainer::Value(LoroValue::String(s))) => s.to_string(),
        _ => String::new(),
    }
}

fn attr(m: &LoroMap, key: &str) -> J {
    match m.get("attributes") {
        Some(ValueOrContainer::Container(Container::Map(a))) => a
            .get_deep_value()
            .to_json_value()
            .get(key)
            .cloned()
            .unwrap_or(J::Null),
        _ => J::Null,
    }
}

fn render_inline(list: &LoroList, out: &mut String, title: &dyn Fn(&str) -> Option<String>) {
    for i in 0..list.len() {
        match list.get(i) {
            Some(ValueOrContainer::Container(Container::Text(t))) => {
                for d in t.to_delta() {
                    let loro::TextDelta::Insert { insert, attributes } = d else {
                        continue;
                    };
                    let mut before = String::new();
                    let mut after = String::new();
                    let attrs = attributes.unwrap_or_default();
                    for (key, open) in [
                        ("code", "`"),
                        ("strong", "**"),
                        ("em", "*"),
                        ("strike", "~~"),
                    ] {
                        if attrs.contains_key(key) {
                            before.push_str(open);
                            after.insert_str(0, open);
                        }
                    }
                    let mut piece = format!("{before}{insert}{after}");
                    if let Some(link) = attrs.get("link") {
                        let href = link
                            .to_json_value()
                            .get("href")
                            .and_then(J::as_str)
                            .unwrap_or_default()
                            .to_owned();
                        piece = format!("[{piece}]({href})");
                    }
                    out.push_str(&piece);
                }
            }
            Some(ValueOrContainer::Container(Container::Map(m))) => match name_of(&m).as_str() {
                "item_link" => {
                    let target = attr(&m, "target");
                    let target = target.as_str().unwrap_or_default();
                    let label = title(target).unwrap_or_else(|| {
                        attr(&m, "label").as_str().unwrap_or_default().to_owned()
                    });
                    out.push_str(&format!("[[{label}]]"));
                }
                "hard_break" => out.push_str("  \n"),
                "image" => {
                    let src = attr(&m, "src");
                    let alt = attr(&m, "alt");
                    out.push_str(&format!(
                        "![{}](attachments/{})",
                        alt.as_str().unwrap_or_default(),
                        src.as_str().unwrap_or_default()
                    ));
                }
                _ => {}
            },
            _ => {}
        }
    }
}

fn render_list(
    list: &LoroList,
    out: &mut String,
    prefix: &str,
    title: &dyn Fn(&str) -> Option<String>,
) {
    for i in 0..list.len() {
        let Some(node) = node_of(list.get(i)) else {
            continue;
        };
        let kids = children_of(&node);
        match name_of(&node).as_str() {
            "paragraph" => {
                out.push_str(prefix);
                if let Some(k) = &kids {
                    render_inline(k, out, title);
                }
                out.push_str("\n\n");
            }
            "heading" => {
                let level = attr(&node, "level").as_u64().unwrap_or(1).clamp(1, 6) as usize;
                out.push_str(prefix);
                out.push_str(&"#".repeat(level));
                out.push(' ');
                if let Some(k) = &kids {
                    render_inline(k, out, title);
                }
                out.push_str("\n\n");
            }
            "blockquote" => {
                if let Some(k) = &kids {
                    render_list(k, out, &format!("{prefix}> "), title);
                }
            }
            "bullet_list" | "ordered_list" => {
                let numbered = name_of(&node) == "ordered_list";
                let Some(k) = kids else { continue };
                for j in 0..k.len() {
                    let Some(item) = node_of(k.get(j)) else {
                        continue;
                    };
                    let marker = if numbered {
                        format!("{}. ", j + 1)
                    } else {
                        "- ".to_owned()
                    };
                    let mut inner = String::new();
                    if let Some(c) = children_of(&item) {
                        render_list(&c, &mut inner, "", title);
                    }
                    let indent = " ".repeat(marker.len());
                    for (n, line) in inner.trim_end().lines().enumerate() {
                        out.push_str(prefix);
                        out.push_str(if n == 0 { &marker } else { &indent });
                        out.push_str(line);
                        out.push('\n');
                    }
                }
                out.push('\n');
            }
            "code_block" => {
                let lang = attr(&node, "language");
                let mut code = String::new();
                if let Some(k) = &kids {
                    render_inline(k, &mut code, title);
                }
                out.push_str(&format!(
                    "{prefix}```{}\n{code}\n{prefix}```\n\n",
                    lang.as_str().unwrap_or_default()
                ));
            }
            "horizontal_rule" => {
                out.push_str(prefix);
                out.push_str("---\n\n");
            }
            "image" => {
                if let Some(wrapper) = kids.as_ref() {
                    render_inline(wrapper, out, title);
                }
                let src = attr(&node, "src");
                let alt = attr(&node, "alt");
                out.push_str(&format!(
                    "{prefix}![{}](attachments/{})\n\n",
                    alt.as_str().unwrap_or_default(),
                    src.as_str().unwrap_or_default()
                ));
            }
            _ => {
                if let Some(k) = &kids {
                    render_list(k, out, prefix, title);
                }
            }
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use crate::item::tests::sample_meta;

    fn round(md: &str) -> String {
        let doc = ItemDoc::create(&sample_meta()).unwrap();
        doc.set_body_markdown(md, &|_| None).unwrap();
        doc.commit(dem_model::ChangeOrigin::Import, Some("t"));
        doc.body_markdown(&|_| None).unwrap()
    }

    #[test]
    fn keeps_headings_paragraphs_and_marks() {
        let md = "# 标题\n\n一段 **加粗** 和 *斜体* 和 `code` 和 ~~删掉~~。\n";
        assert_eq!(round(md), md);
    }

    #[test]
    fn keeps_lists_quotes_code_and_rules() {
        let md = "- 一\n- 二\n\n1. 甲\n2. 乙\n\n> 引用\n\n```rust\nfn main() {}\n```\n\n---\n";
        assert_eq!(round(md), md);
    }

    #[test]
    fn keeps_web_links() {
        let md = "看 [这里](https://example.org/a) 吧\n";
        assert_eq!(round(md), md);
    }

    #[test]
    fn turns_known_titles_into_item_links_and_back() {
        let target = ItemId::new();
        let doc = ItemDoc::create(&sample_meta()).unwrap();
        doc.set_body_markdown("见 [[第 11 课]] 和 [[没有的]]。\n", &|t| {
            (t == "第 11 课").then_some(target)
        })
        .unwrap();
        assert_eq!(doc.body_links(), vec![target]);
        let back = doc
            .body_markdown(&|id| (id == target.to_string()).then(|| "第 11 课".to_owned()))
            .unwrap();
        assert_eq!(back, "见 [[第 11 课]] 和 [[没有的]]。\n");
    }

    #[test]
    fn plain_text_sees_imported_blocks() {
        let doc = ItemDoc::create(&sample_meta()).unwrap();
        doc.set_body_markdown("# 甲\n\n乙\n", &|_| None).unwrap();
        assert_eq!(doc.body_text(), "甲\n乙");
    }
}
