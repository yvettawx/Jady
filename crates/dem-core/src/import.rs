//! Bringing things in (M4): a table becomes a custom type and its rows become items, a Markdown
//! file becomes a note. A column of repeating values becomes a select, so a table with a status
//! column is a working board straight away.

use std::path::Path;

use dem_io::{ColumnKind, Table, column_kind, normalize_date};
use dem_model::{ChangeOrigin, FieldDef, FieldKind, PrivacyDto, SelectOption, TypeDef, ViewKind};
use serde_json::{Map, Value as J, json};

use crate::dto::{ImportResult, NewItem};
use crate::error::{CoreError, CoreResult};
use crate::session::Session;

fn option_id(i: usize) -> String {
    format!("o{i}")
}

impl Session {
    /// Reads a CSV or Excel file into a new type. The first column names the items.
    pub fn import_table(&mut self, path: &str, type_name: &str) -> CoreResult<ImportResult> {
        let p = Path::new(path);
        let ext = p
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        let table = if ext == "csv" || ext == "tsv" || ext == "txt" {
            dem_io::read_csv(p)?
        } else {
            dem_io::read_xlsx(p)?
        };
        self.import_rows(&table, type_name)
    }

    pub(crate) fn import_rows(
        &mut self,
        table: &Table,
        type_name: &str,
    ) -> CoreResult<ImportResult> {
        if table.headers.is_empty() {
            return Err(CoreError::new("import", "no columns"));
        }
        let kinds: Vec<ColumnKind> = (0..table.headers.len())
            .map(|c| column_kind(table, c))
            .collect();
        let mut fields = Vec::new();
        let mut board = false;
        for (i, header) in table.headers.iter().enumerate().skip(1) {
            let kind = match &kinds[i] {
                ColumnKind::Text => FieldKind::Text,
                ColumnKind::Number => FieldKind::Number,
                ColumnKind::Date => FieldKind::Date,
                ColumnKind::Url => FieldKind::Url,
                ColumnKind::Select(values) => {
                    board = true;
                    FieldKind::Select {
                        options: values
                            .iter()
                            .enumerate()
                            .map(|(n, v)| SelectOption {
                                id: option_id(n),
                                name: v.clone(),
                                tone: None,
                            })
                            .collect(),
                    }
                }
            };
            fields.push(FieldDef {
                key: format!("c{i}"),
                name: header.clone(),
                kind,
                required: false,
            });
        }
        let def = self.save_type(TypeDef {
            id: String::new(),
            name: type_name.to_owned(),
            builtin: false,
            default_view: if board {
                ViewKind::Board
            } else {
                ViewKind::Table
            },
            default_privacy: PrivacyDto::Normal,
            color: None,
            fields,
        })?;
        let batch = uuid::Uuid::now_v7().to_string();
        let mut created = 0;
        let mut skipped = 0;
        for row in &table.rows {
            let title = row.first().map(|s| s.trim()).unwrap_or_default();
            if title.is_empty() && row.iter().all(|c| c.trim().is_empty()) {
                skipped += 1;
                continue;
            }
            let mut values = Map::new();
            for (i, cell) in row.iter().enumerate().skip(1) {
                let cell = cell.trim();
                if cell.is_empty() {
                    continue;
                }
                let value = match kinds.get(i) {
                    Some(ColumnKind::Number) => cell.parse::<f64>().map_or(J::Null, |n| json!(n)),
                    Some(ColumnKind::Date) => json!(normalize_date(cell)),
                    Some(ColumnKind::Select(values)) => values
                        .iter()
                        .position(|v| v == cell)
                        .map_or(J::Null, |n| json!(option_id(n))),
                    _ => json!(cell),
                };
                if !value.is_null() {
                    values.insert(format!("c{i}"), value);
                }
            }
            self.create_item_as(
                NewItem {
                    type_id: def.id.clone(),
                    title: Some(title.to_owned()),
                    state: None,
                    container: None,
                    privacy: None,
                    fields: Some(
                        serde_json::to_string(&values)
                            .map_err(|e| CoreError::new("import", e.to_string()))?,
                    ),
                    tags: None,
                    due: None,
                    markdown: None,
                },
                ChangeOrigin::Import,
                Some(&batch),
            )?;
            created += 1;
        }
        Ok(ImportResult {
            type_id: Some(def.id),
            created,
            skipped,
        })
    }

    /// Each Markdown file becomes a note named after its first heading or the file.
    /// Keeps files as they are (encrypted, in the library) and makes each an item whose text is
    /// what could be read out of it, so a PDF or a slide deck can be searched.
    pub fn import_files(&mut self, paths: &[String]) -> CoreResult<ImportResult> {
        let batch = uuid::Uuid::now_v7().to_string();
        let mut created = 0;
        let mut skipped = 0;
        for path in paths {
            let p = Path::new(path);
            let Ok(blob) = self.lib.put_blob_file(p) else {
                skipped += 1;
                continue;
            };
            let name = |s: Option<&std::ffi::OsStr>| {
                s.map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_default()
            };
            let text = dem_io::extract_text(p).ok().flatten();
            let view = self.create_item_as(
                NewItem {
                    type_id: "file".into(),
                    title: Some(name(p.file_stem())),
                    state: None,
                    container: None,
                    privacy: None,
                    fields: Some(
                        json!({ "blob": blob.to_string(), "filename": name(p.file_name()) })
                            .to_string(),
                    ),
                    tags: None,
                    due: None,
                    markdown: None,
                },
                ChangeOrigin::Import,
                Some(&batch),
            )?;
            if let Some(text) = text.filter(|t| !t.trim().is_empty()) {
                let id = crate::session::parse_id(&view.id)?;
                let doc = self.doc(id)?;
                doc.set_body_text(&text)?;
                doc.commit(ChangeOrigin::Import, Some(&batch));
                self.persist(id)?;
            }
            created += 1;
        }
        Ok(ImportResult {
            type_id: Some("file".into()),
            created,
            skipped,
        })
    }

    /// 截图 (A13): the picture goes into the store and an inbox note shows it.
    pub fn capture_image(&mut self, path: &str, title: &str) -> CoreResult<crate::dto::ItemView> {
        let blob = self
            .lib
            .put_blob_file(Path::new(path))
            .map_err(CoreError::from)?;
        self.create_item(NewItem {
            type_id: "note".into(),
            title: Some(title.to_owned()),
            state: Some("inbox".into()),
            container: None,
            privacy: None,
            fields: None,
            tags: None,
            due: None,
            markdown: Some(format!("![]({blob})\n")),
        })
    }

    /// 网页链接 (A13): what the page says, in the inbox, with where it came from.
    pub fn capture_page(
        &mut self,
        url: &str,
        page: &dem_io::WebPage,
    ) -> CoreResult<crate::dto::ItemView> {
        let view = self.create_item(NewItem {
            type_id: "article".into(),
            title: Some(page.title.clone().unwrap_or_else(|| url.to_owned())),
            state: Some("inbox".into()),
            container: None,
            privacy: None,
            fields: Some(json!({ "url": url }).to_string()),
            tags: None,
            due: None,
            markdown: None,
        })?;
        let id = crate::session::parse_id(&view.id)?;
        let doc = self.doc(id)?;
        doc.set_body_text(&page.text)?;
        doc.commit(ChangeOrigin::Me, None);
        self.persist(id)
    }

    pub fn import_markdown(&mut self, paths: &[String]) -> CoreResult<ImportResult> {
        let batch = uuid::Uuid::now_v7().to_string();
        let mut created = 0;
        let mut skipped = 0;
        for path in paths {
            let p = Path::new(path);
            let Ok(text) = std::fs::read_to_string(p) else {
                skipped += 1;
                continue;
            };
            let (title, body) = split_title(&text);
            let title = title.unwrap_or_else(|| {
                p.file_stem()
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_default()
            });
            self.create_item_as(
                NewItem {
                    type_id: "note".into(),
                    title: Some(title),
                    state: None,
                    container: None,
                    privacy: None,
                    fields: None,
                    tags: None,
                    due: None,
                    markdown: Some(body.to_owned()),
                },
                ChangeOrigin::Import,
                Some(&batch),
            )?;
            created += 1;
        }
        Ok(ImportResult {
            type_id: None,
            created,
            skipped,
        })
    }
}

/// A leading `# 标题` is the note's title, not its first line.
fn split_title(text: &str) -> (Option<String>, &str) {
    let trimmed = text.trim_start();
    if let Some(rest) = trimmed.strip_prefix("# ") {
        let (line, body) = rest.split_once('\n').unwrap_or((rest, ""));
        return (Some(line.trim().to_owned()), body.trim_start());
    }
    (None, text)
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use crate::dto::ListQuery;
    use crate::session::tests::open_core;

    fn all(type_id: &str) -> ListQuery {
        ListQuery {
            type_id: Some(type_id.into()),
            states: None,
            container: None,
            tag: None,
            order: None,
            limit: None,
        }
    }

    #[test]
    fn a_table_with_a_status_column_becomes_a_board() {
        let d = tempfile::tempdir().unwrap();
        let c = open_core(d.path());
        let csv = d.path().join("职缺.csv");
        std::fs::write(
            &csv,
            "职位,公司,状态,截止,链接\n后端,甲,已投,2026-11-20,https://a.example\n前端,乙,面试,2026/12/1,https://b.example\n运维,丙,已投,2026-12-05,https://c.example\n算法,丁,面试,2026-12-09,https://d.example\n,,,,\n",
        )
        .unwrap();
        c.with(|s| {
            let r = s.import_table(csv.to_str().unwrap(), "职缺")?;
            assert_eq!(r.created, 4);
            let ty = r.type_id.unwrap();
            let def = s.types().into_iter().find(|t| t.id == ty).unwrap();
            assert_eq!(def.default_view, ViewKind::Board);
            let status = def.fields.iter().find(|f| f.name == "状态").unwrap();
            let FieldKind::Select { options } = &status.kind else {
                panic!("status should be a select");
            };
            assert_eq!(options.len(), 2);
            assert!(matches!(
                def.fields.iter().find(|f| f.name == "截止").unwrap().kind,
                FieldKind::Date
            ));
            let items = s.list_items(&all(&ty))?;
            assert_eq!(items.len(), 4);
            let front = items
                .iter()
                .find(|i| i.title.as_deref() == Some("前端"))
                .unwrap();
            let f: J = serde_json::from_str(&front.fields).unwrap();
            assert_eq!(f[&status.key], json!("o1"));
            assert_eq!(f["c3"], json!("2026-12-01"));
            assert_eq!(s.get_item(&front.id)?.source.unwrap().origin, "import");
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn markdown_files_become_notes() {
        let d = tempfile::tempdir().unwrap();
        let c = open_core(d.path());
        let a = d.path().join("没有标题.md");
        let b = d.path().join("b.md");
        std::fs::write(&a, "只有正文\n").unwrap();
        std::fs::write(&b, "# 第 12 课\n\n复合过去时\n").unwrap();
        c.with(|s| {
            let r = s.import_markdown(&[
                a.display().to_string(),
                b.display().to_string(),
                "/没有这个文件.md".to_owned(),
            ])?;
            assert_eq!((r.created, r.skipped), (2, 1));
            let hits = s.search("复合过去时", 5)?;
            assert_eq!(hits[0].item.title.as_deref(), Some("第 12 课"));
            assert_eq!(
                s.search("只有正文", 5)?[0].item.title.as_deref(),
                Some("没有标题")
            );
            Ok(())
        })
        .unwrap();
    }
}
