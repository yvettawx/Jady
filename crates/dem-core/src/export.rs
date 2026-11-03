//! Taking things out (M4, "数据永远能带走"): Markdown with the fields up front, and the attachments
//! beside them. An export is not encrypted, so 机密 items stay out unless asked for by name.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use dem_index::Filter;
use dem_model::ItemId;
use serde_json::Value as J;

use crate::dto::ExportResult;
use crate::error::{CoreError, CoreResult};
use crate::session::{Session, parse_id};

fn io(path: &Path) -> impl Fn(std::io::Error) -> CoreError + '_ {
    move |e| CoreError::new("io", format!("{}: {e}", path.display()))
}

/// Text as a file name: nothing that could leave the folder.
fn safe_name(text: &str) -> String {
    let safe: String = text
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\n' | '\r' | '\t' => ' ',
            c => c,
        })
        .collect();
    safe.trim_start_matches(|c: char| c == '.' || c.is_whitespace())
        .trim()
        .to_owned()
}

/// The last six characters of an id, to tell apart files that would share a name.
fn short_id(id: &str) -> String {
    let n = id.chars().count();
    id.chars().skip(n.saturating_sub(6)).collect()
}

/// A title as a file name, and something when there is none.
fn file_name(title: Option<&str>, id: &str) -> String {
    let safe = safe_name(title.unwrap_or_default());
    if safe.is_empty() {
        short_id(id)
    } else {
        format!("{safe} {}", short_id(id))
    }
}

/// The extension a Markdown app needs to show an attachment, from its first bytes.
fn extension(bytes: &[u8]) -> &'static str {
    let head = &bytes[..bytes.len().min(512)];
    if head.starts_with(b"\x89PNG") {
        ".png"
    } else if head.starts_with(&[0xFF, 0xD8, 0xFF]) {
        ".jpg"
    } else if head.starts_with(b"GIF8") {
        ".gif"
    } else if head.starts_with(b"RIFF") && head.get(8..12) == Some(b"WEBP") {
        ".webp"
    } else if head.starts_with(b"%PDF") {
        ".pdf"
    } else if String::from_utf8_lossy(head).contains("<svg") {
        ".svg"
    } else {
        ""
    }
}

/// The attachment names a body points at, in the form the Markdown writer gives them.
fn linked_attachments(text: &str) -> Vec<String> {
    const MARK: &str = "](attachments/";
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(i) = rest.find(MARK) {
        rest = &rest[i + MARK.len()..];
        let end = rest.find(')').unwrap_or(rest.len());
        let name = &rest[..end];
        if !out.iter().any(|n| n == name) {
            out.push(name.to_owned());
        }
        rest = &rest[end..];
    }
    out
}

/// Where a whole export puts the files its items point at, one folder per type folder.
#[derive(Default)]
struct Attachments {
    /// (folder, attachment) → the file name written there.
    written: HashMap<(PathBuf, String), String>,
}

fn yaml_quote(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".to_owned())
}

impl Session {
    /// Writes one attachment into `folder/attachments` once, and gives the name to link it by;
    /// `None` when it cannot be read, and the link stays as it was.
    fn attach(
        &self,
        files: &mut Attachments,
        folder: &Path,
        blob: &str,
        filename: Option<&str>,
    ) -> CoreResult<Option<String>> {
        if blob.is_empty()
            || !blob
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        {
            return Ok(None);
        }
        let key = (folder.to_path_buf(), blob.to_owned());
        if let Some(name) = files.written.get(&key) {
            return Ok(Some(name.clone()));
        }
        let mut bytes = Vec::new();
        if self.lib.read_blob(blob, &mut bytes).is_err() {
            return Ok(None);
        }
        let dir = folder.join("attachments");
        let mut name = match filename.map(safe_name).filter(|n| !n.is_empty()) {
            Some(n) => n,
            None => format!("{blob}{}", extension(&bytes)),
        };
        if dir.join(&name).exists() {
            name = format!("{} {name}", short_id(blob));
        }
        std::fs::create_dir_all(&dir).map_err(io(&dir))?;
        let p = dir.join(&name);
        std::fs::write(&p, &bytes).map_err(io(&p))?;
        files.written.insert(key, name.clone());
        Ok(Some(name))
    }

    /// One item as Markdown. With somewhere to put them, its attachments are written out too.
    fn markdown_of(
        &mut self,
        id: ItemId,
        titles: &HashMap<String, String>,
        mut out: Option<(&mut Attachments, &Path)>,
    ) -> CoreResult<String> {
        let view = self.get_item(&id.to_string())?;
        let doc = self.lib.load_item(id)?;
        let mut front = String::from("---\n");
        if let Some(t) = &view.title {
            front.push_str(&format!("title: {}\n", yaml_quote(t)));
        }
        front.push_str(&format!("type: {}\n", yaml_quote(&view.type_id)));
        front.push_str(&format!("state: {}\n", view.state));
        front.push_str(&format!("privacy: {}\n", view.privacy));
        if !view.tags.is_empty() {
            let tags: Vec<String> = view.tags.iter().map(|t| yaml_quote(t)).collect();
            front.push_str(&format!("tags: [{}]\n", tags.join(", ")));
        }
        if let Ok(J::Object(mut fields)) = serde_json::from_str::<J>(&view.fields) {
            // A file item keeps its content as an attachment: link the copy instead of the name
            // it has inside the library.
            if let (Some((files, folder)), Some(blob)) = (
                out.as_mut(),
                fields.get("blob").and_then(J::as_str).map(str::to_owned),
            ) {
                let filename = fields.get("filename").and_then(J::as_str);
                if let Some(name) = self.attach(files, folder, &blob, filename)? {
                    fields.remove("blob");
                    fields.insert("file".into(), J::String(format!("[[{name}]]")));
                }
            }
            for (k, v) in fields {
                front.push_str(&format!("{}: {v}\n", yaml_quote(&k)));
            }
        }
        front.push_str("---\n\n");
        let mut body = doc.body_markdown(&|target| titles.get(target).cloned())?;
        if let Some((files, folder)) = out {
            for name in linked_attachments(&body) {
                if let Some(new) = self.attach(files, folder, &name, None)? {
                    body = body.replace(
                        &format!("](attachments/{name})"),
                        &format!("](attachments/{new})"),
                    );
                }
            }
        }
        Ok(front + &body)
    }

    fn all_titles(&self) -> CoreResult<HashMap<String, String>> {
        Ok(self
            .index
            .list(&Filter::default())?
            .into_iter()
            .filter_map(|r| Some((r.id, r.title?)))
            .collect())
    }

    /// One item to one Markdown file, at the path the user picked.
    pub fn export_item(&mut self, id: &str, path: &str) -> CoreResult<()> {
        let id = parse_id(id)?;
        let titles = self.all_titles()?;
        let text = self.markdown_of(id, &titles, None)?;
        let p = PathBuf::from(path);
        std::fs::write(&p, text).map_err(io(&p))
    }

    /// Everything, into a new folder inside `dir`, one sub-folder per type. Files are named by
    /// their titles, so `[[title]]` links find them in Markdown apps; only a second item with
    /// the same title in a folder gets the end of its id added.
    pub fn export_all(
        &mut self,
        dir: &str,
        include_confidential: bool,
    ) -> CoreResult<ExportResult> {
        let root = PathBuf::from(dir).join(format!("Jady {}", crate::session::today()));
        if root.exists() {
            return Err(CoreError::new("exists", "that export is already there"));
        }
        std::fs::create_dir_all(&root).map_err(io(&root))?;
        let titles = self.all_titles()?;
        let rows = self.index.list(&Filter {
            states: vec!["inbox".into(), "active".into(), "archived".into()],
            ..Default::default()
        })?;
        let mut files = Attachments::default();
        let mut used: HashMap<PathBuf, HashSet<String>> = HashMap::new();
        let mut items = 0;
        let mut skipped_confidential = 0;
        for row in rows {
            if row.privacy == "confidential" && !include_confidential {
                skipped_confidential += 1;
                continue;
            }
            let id = parse_id(&row.id)?;
            let view = self.get_item(&row.id)?;
            let mut folder_name = safe_name(&row.type_id);
            if folder_name.is_empty() {
                folder_name = "other".into();
            }
            let folder = root.join(folder_name);
            std::fs::create_dir_all(&folder).map_err(io(&folder))?;
            let taken = used.entry(folder.clone()).or_default();
            let mut name = safe_name(view.title.as_deref().unwrap_or_default());
            // Case-blind, like the Mac's disks.
            if name.is_empty() || taken.contains(&name.to_lowercase()) {
                name = file_name(view.title.as_deref(), &row.id);
            }
            taken.insert(name.to_lowercase());
            let text = self.markdown_of(id, &titles, Some((&mut files, &folder)))?;
            let p = folder.join(format!("{name}.md"));
            std::fs::write(&p, text).map_err(io(&p))?;
            items += 1;
        }
        Ok(ExportResult {
            path: root.display().to_string(),
            items,
            skipped_confidential,
        })
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use crate::dto::NewItem;
    use crate::session::tests::{new_note, open_core};
    use data_encoding::BASE64;

    #[test]
    fn writes_one_file_with_its_fields_and_links_by_title() {
        let d = tempfile::tempdir().unwrap();
        let c = open_core(d.path());
        let out = d.path().join("a.md");
        c.with(|s| {
            s.create_item(new_note("第 11 课"))?;
            let id = s
                .create_item(NewItem {
                    markdown: Some("见 [[第 11 课]]。\n".into()),
                    tags: Some(vec!["法语".into()]),
                    ..new_note("第 12 课")
                })?
                .id;
            s.export_item(&id, out.to_str().unwrap())?;
            Ok(())
        })
        .unwrap();
        let text = std::fs::read_to_string(&out).unwrap();
        assert!(text.contains("title: \"第 12 课\""));
        assert!(text.contains("tags: [\"法语\"]"));
        assert!(text.contains("见 [[第 11 课]]。"));
    }

    #[test]
    fn leaves_confidential_items_out_unless_asked_and_trash_out_always() {
        let d = tempfile::tempdir().unwrap();
        let c = open_core(d.path());
        c.with(|s| {
            s.create_item(new_note("留着的"))?;
            s.create_item(NewItem {
                privacy: Some("confidential".into()),
                ..new_note("机密的")
            })?;
            let gone = s.create_item(new_note("扔掉的"))?.id;
            s.update_item(
                &gone,
                crate::dto::ItemPatch {
                    state: Some("trashed".into()),
                    ..Default::default()
                },
            )?;
            let out1 = d.path().join("one");
            std::fs::create_dir_all(&out1).unwrap();
            let r = s.export_all(out1.to_str().unwrap(), false)?;
            assert_eq!((r.items, r.skipped_confidential), (1, 1));
            let out2 = d.path().join("two");
            std::fs::create_dir_all(&out2).unwrap();
            let r = s.export_all(out2.to_str().unwrap(), true)?;
            assert_eq!((r.items, r.skipped_confidential), (2, 0));
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn files_are_named_by_title_so_links_find_them_and_attachments_come_along() {
        let d = tempfile::tempdir().unwrap();
        let c = open_core(d.path());
        let out = d.path().join("out");
        std::fs::create_dir_all(&out).unwrap();
        let r = c
            .with(|s| {
                let png = s.put_blob(&BASE64.encode(b"\x89PNG\r\n\x1a\n rest"))?;
                s.create_item(new_note("第 11 课"))?;
                s.create_item(new_note("第 11 课"))?;
                s.create_item(NewItem {
                    markdown: Some("见 [[第 11 课]]。\n".into()),
                    ..new_note("第 12 课")
                })?;
                s.create_item(NewItem {
                    type_id: "file".into(),
                    fields: Some(format!(r#"{{"blob": "{png}", "filename": "板书.png"}}"#)),
                    ..new_note("板书")
                })?;
                s.export_all(out.to_str().unwrap(), false)
            })
            .unwrap();
        let root = PathBuf::from(&r.path);
        let notes = root.join("note");
        let mut names: Vec<String> = std::fs::read_dir(&notes)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        // The first of two same titles keeps the plain name; the other gets its id's end.
        assert!(names.contains(&"第 11 课.md".to_owned()));
        assert!(names.contains(&"第 12 课.md".to_owned()));
        assert_eq!(names.len(), 3);
        let text = std::fs::read_to_string(notes.join("第 12 课.md")).unwrap();
        assert!(text.contains("见 [[第 11 课]]。"));
        let file = std::fs::read_to_string(root.join("file/板书.md")).unwrap();
        assert!(file.contains("\"file\": \"[[板书.png]]\""), "{file}");
        assert!(!file.contains("\"blob\""));
        let copied = std::fs::read(root.join("file/attachments/板书.png")).unwrap();
        assert!(copied.starts_with(b"\x89PNG"));
    }

    #[test]
    fn body_attachments_are_found_and_get_an_extension() {
        let text = "a ![图](attachments/abc123) b ![](attachments/abc123) ![](attachments/ff)";
        assert_eq!(linked_attachments(text), vec!["abc123", "ff"]);
        assert_eq!(extension(b"\x89PNG\r\n"), ".png");
        assert_eq!(extension(&[0xFF, 0xD8, 0xFF, 0xE0]), ".jpg");
        assert_eq!(extension(b"RIFF\0\0\0\0WEBPVP8"), ".webp");
        assert_eq!(extension(b"<?xml?><svg/>"), ".svg");
        assert_eq!(extension(b"plain"), "");
    }

    #[test]
    fn file_names_cannot_leave_the_folder() {
        let name = file_name(Some("../../etc/passwd"), "abcdef");
        assert!(!name.contains('/') && !name.starts_with('.'));
        assert!(!file_name(Some("a/b"), "abcdef").contains('/'));
        assert_eq!(file_name(None, "abcdef"), "abcdef");
    }
}
