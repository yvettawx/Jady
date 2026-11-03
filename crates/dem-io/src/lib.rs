//! Reading tables from outside (docs/03-modules.md M4). Pure parsing: this crate never touches
//! the library, the core decides what the rows become.

use std::path::Path;

mod text;
mod web;
pub use text::extract_text;
pub use web::{WebPage, fetch_page, page_of, public_url};

use calamine::{Data, Reader, open_workbook_auto};

#[derive(Debug, thiserror::Error)]
pub enum IoError {
    #[error("could not read the file: {0}")]
    Read(String),
    #[error("the file has no rows")]
    Empty,
}

#[derive(Clone, Default, PartialEq, Eq)]
pub struct Table {
    pub headers: Vec<String>,
    pub rows: Vec<Vec<String>>,
}

/// A table holds the user's content: Debug shows only its shape.
impl std::fmt::Debug for Table {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Table")
            .field("columns", &self.headers.len())
            .field("rows", &self.rows.len())
            .finish()
    }
}

/// How a column looks, judged from its values.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ColumnKind {
    Text,
    Number,
    Date,
    Url,
    /// A few values repeating: these become the options.
    Select(Vec<String>),
}

fn clean(mut table: Table) -> Result<Table, IoError> {
    table
        .rows
        .retain(|r| r.iter().any(|c| !c.trim().is_empty()));
    if table.headers.iter().all(|h| h.trim().is_empty()) && table.rows.is_empty() {
        return Err(IoError::Empty);
    }
    for (i, h) in table.headers.iter_mut().enumerate() {
        *h = h.trim().to_owned();
        if h.is_empty() {
            *h = format!("{}", i + 1);
        }
    }
    let width = table.headers.len();
    for r in &mut table.rows {
        r.resize(width, String::new());
    }
    Ok(table)
}

pub fn read_csv(path: &Path) -> Result<Table, IoError> {
    let bytes = std::fs::read(path).map_err(|e| IoError::Read(e.to_string()))?;
    parse_csv(&bytes)
}

pub fn parse_csv(bytes: &[u8]) -> Result<Table, IoError> {
    let bytes = bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(bytes);
    let mut rd = csv::ReaderBuilder::new().flexible(true).from_reader(bytes);
    let headers = rd
        .headers()
        .map_err(|e| IoError::Read(e.to_string()))?
        .iter()
        .map(str::to_owned)
        .collect();
    let mut rows = Vec::new();
    for rec in rd.records() {
        let rec = rec.map_err(|e| IoError::Read(e.to_string()))?;
        rows.push(rec.iter().map(str::to_owned).collect());
    }
    clean(Table { headers, rows })
}

fn cell_text(c: &Data) -> String {
    match c {
        Data::Empty => String::new(),
        Data::String(s) => s.clone(),
        Data::Float(f) if f.fract() == 0.0 => format!("{f:.0}"),
        Data::Float(f) => f.to_string(),
        Data::Int(i) => i.to_string(),
        Data::Bool(b) => b.to_string(),
        Data::DateTime(d) => d
            .as_datetime()
            .map(|t| t.to_string().chars().take(10).collect())
            .unwrap_or_default(),
        Data::DateTimeIso(s) | Data::DurationIso(s) => s.chars().take(10).collect(),
        Data::Error(_) => String::new(),
    }
}

/// The first sheet of a spreadsheet.
pub fn read_xlsx(path: &Path) -> Result<Table, IoError> {
    let mut wb = open_workbook_auto(path).map_err(|e| IoError::Read(e.to_string()))?;
    let name = wb.sheet_names().first().cloned().ok_or(IoError::Empty)?;
    let range = wb
        .worksheet_range(&name)
        .map_err(|e| IoError::Read(e.to_string()))?;
    let mut rows = range
        .rows()
        .map(|r| r.iter().map(cell_text).collect::<Vec<_>>());
    let headers = rows.next().ok_or(IoError::Empty)?;
    clean(Table {
        headers,
        rows: rows.collect(),
    })
}

fn looks_like_date(s: &str) -> bool {
    let parts: Vec<&str> = s.split(['-', '/', '.']).collect();
    matches!(parts.as_slice(), [y, m, d]
        if y.len() == 4 && [y, m, d].iter().all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
            && m.len() <= 2 && d.len() <= 2)
}

/// "2026/3/5" and friends as "2026-03-05"; anything else as it was.
pub fn normalize_date(s: &str) -> String {
    let s = s.trim();
    if !looks_like_date(s) {
        return s.to_owned();
    }
    let p: Vec<&str> = s.split(['-', '/', '.']).collect();
    match p.as_slice() {
        [y, m, d] => format!("{y}-{m:0>2}-{d:0>2}"),
        _ => s.to_owned(),
    }
}

/// Decides what a column is. A repeating handful becomes a select: that is what makes a status
/// column turn into a board without anyone setting it up.
pub fn column_kind(table: &Table, col: usize) -> ColumnKind {
    let values: Vec<&str> = table
        .rows
        .iter()
        .filter_map(|r| r.get(col))
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect();
    if values.is_empty() {
        return ColumnKind::Text;
    }
    if values.iter().all(|v| looks_like_date(v)) {
        return ColumnKind::Date;
    }
    if values
        .iter()
        .all(|v| v.starts_with("http://") || v.starts_with("https://"))
    {
        return ColumnKind::Url;
    }
    if values.iter().all(|v| v.parse::<f64>().is_ok()) {
        return ColumnKind::Number;
    }
    let mut distinct: Vec<&str> = Vec::new();
    for v in &values {
        if !distinct.contains(v) {
            distinct.push(v);
        }
    }
    let short = distinct.iter().all(|v| v.chars().count() <= 16);
    if short && distinct.len() <= 12 && values.len() >= distinct.len() * 2 {
        return ColumnKind::Select(distinct.into_iter().map(str::to_owned).collect());
    }
    ColumnKind::Text
}

#[cfg(test)]
mod xlsx_tests {
    use std::io::Write;

    use super::*;

    /// The smallest workbook Excel would open, written by hand so no binary lives in the repo.
    fn workbook(path: &Path) {
        let mut zip = zip::ZipWriter::new(std::fs::File::create(path).unwrap());
        let mut add = |name: &str, body: &str| {
            zip.start_file::<_, ()>(name, zip::write::FileOptions::default())
                .unwrap();
            zip.write_all(body.as_bytes()).unwrap();
        };
        add(
            "[Content_Types].xml",
            r#"<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>"#,
        );
        add(
            "_rels/.rels",
            r#"<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>"#,
        );
        add(
            "xl/workbook.xml",
            r#"<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>"#,
        );
        add(
            "xl/_rels/workbook.xml.rels",
            r#"<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>"#,
        );
        add(
            "xl/worksheets/sheet1.xml",
            r#"<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>公司</t></is></c><c r="B1" t="inlineStr"><is><t>状态</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>甲</t></is></c><c r="B2" t="inlineStr"><is><t>已投</t></is></c></row></sheetData></worksheet>"#,
        );
        zip.finish().unwrap();
    }

    #[test]
    fn reads_an_excel_workbook() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.xlsx");
        workbook(&path);
        let table = read_xlsx(&path).unwrap();
        assert_eq!(table.headers, ["公司", "状态"]);
        assert_eq!(table.rows.len(), 1);
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn reads_csv_with_a_bom_and_short_rows() {
        let t = parse_csv("\u{feff}公司,状态,链接\n甲,已投,https://a.example\n乙\n\n".as_bytes())
            .unwrap();
        assert_eq!(t.headers, ["公司", "状态", "链接"]);
        assert_eq!(t.rows.len(), 2);
        assert_eq!(t.rows[1], ["乙", "", ""]);
    }

    #[test]
    fn names_empty_headers() {
        let t = parse_csv(b",b\n1,2\n").unwrap();
        assert_eq!(t.headers, ["1", "b"]);
    }

    #[test]
    fn says_so_when_there_is_nothing() {
        assert!(matches!(parse_csv(b""), Err(IoError::Empty)));
    }

    #[test]
    fn judges_columns() {
        let t = Table {
            headers: vec!["a".into(); 6],
            rows: (0..6)
                .map(|i| {
                    vec![
                        format!("名字{i}"),
                        (if i % 2 == 0 { "已投" } else { "面试" }).to_owned(),
                        "2026-03-05".to_owned(),
                        "12.5".to_owned(),
                        "https://x.example".to_owned(),
                        String::new(),
                    ]
                })
                .collect(),
        };
        assert_eq!(column_kind(&t, 0), ColumnKind::Text);
        assert_eq!(
            column_kind(&t, 1),
            ColumnKind::Select(vec!["已投".into(), "面试".into()])
        );
        assert_eq!(column_kind(&t, 2), ColumnKind::Date);
        assert_eq!(column_kind(&t, 3), ColumnKind::Number);
        assert_eq!(column_kind(&t, 4), ColumnKind::Url);
        assert_eq!(column_kind(&t, 5), ColumnKind::Text);
    }

    #[test]
    fn normalizes_dates() {
        assert_eq!(normalize_date("2026/3/5"), "2026-03-05");
        assert_eq!(normalize_date("下周"), "下周");
    }

    #[test]
    fn hides_content_in_debug() {
        let t = parse_csv("姓名\n秘密的名字\n".as_bytes()).unwrap();
        assert!(!format!("{t:?}").contains("秘密"));
    }
}
