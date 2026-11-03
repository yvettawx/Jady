//! The index itself: an encrypted SQLite database holding what search, lists and statistics need.
//!
//! 机密 items only get their metadata here (format spec §14): no title, no body, no search.

use std::path::Path;
use std::sync::Arc;

use rusqlite::{Connection, OpenFlags, OptionalExtension, params, params_from_iter};
use zeroize::Zeroizing;

use crate::fold::{FOLD_TABLE_VERSION, HanFold};
use crate::fts5::register_tokenizer;
use crate::tokenizer::{Tokenizer, user_query_to_match};

const TOKENIZER_NAME: &str = "dem";
const CONFIDENTIAL: &str = "confidential";

/// Schema version, tokenizer rules and folding table: if any of them changes, the index is
/// thrown away and rebuilt (format spec §14).
pub const INDEX_VERSION: &str = "schema-2/tok-1/";

#[derive(Debug, thiserror::Error)]
pub enum IndexError {
    #[error(transparent)]
    Sql(#[from] rusqlite::Error),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}
type Result<T> = std::result::Result<T, IndexError>;

/// What the core tells the index about one item.
#[derive(Debug, Clone, Default)]
pub struct IndexRecord {
    pub id: String,
    pub type_id: String,
    pub title: Option<String>,
    pub state: String,
    pub privacy: String,
    pub container: Option<String>,
    pub created: i64,
    pub updated: i64,
    pub due: Option<i64>,
    pub time: TimeColumns,
    /// 复查日期, "yyyy-mm-dd".
    pub recheck: Option<String>,
    pub tags: Vec<String>,
    pub fields: serde_json::Value,
    pub body: String,
    /// Target item and kind, from the body's links and the links map.
    pub links: Vec<(String, String)>,
}

/// A scheduled span or "when it happened", for the calendar and the timeline. Left empty for 机密
/// items: they do not appear on either.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TimeColumns {
    pub start: Option<i64>,
    pub end: Option<i64>,
    pub tz: Option<String>,
    pub recurrence: Option<String>,
    pub occurred: Option<String>,
    /// Sorts `occurred`, BCE included.
    pub occurred_key: Option<i64>,
}

#[derive(Clone, PartialEq, Eq)]
pub struct Row {
    pub id: String,
    pub type_id: String,
    pub title: Option<String>,
    pub state: String,
    pub privacy: String,
    pub container: Option<String>,
    pub created: i64,
    pub updated: i64,
    pub due: Option<i64>,
    pub time: TimeColumns,
    pub tags: Vec<String>,
    pub fields: String,
    pub preview: String,
}

/// Titles and previews are content: Debug leaves them out, so a row can be logged.
impl std::fmt::Debug for Row {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Row")
            .field("id", &self.id)
            .field("type_id", &self.type_id)
            .field("state", &self.state)
            .field("privacy", &self.privacy)
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum Order {
    #[default]
    Updated,
    Created,
    Due,
    Title,
}

#[derive(Debug, Clone, Default)]
pub struct Filter {
    pub type_id: Option<String>,
    /// Empty means every state except trashed.
    pub states: Vec<String>,
    pub container: Option<String>,
    pub tag: Option<String>,
    pub due_before: Option<i64>,
    pub order: Order,
    pub limit: Option<u32>,
}

#[derive(Clone, PartialEq, Eq)]
pub struct Hit {
    pub row: Row,
    /// A piece of the body around the match, with ⁅ and ⁆ around what matched.
    pub snippet: String,
}

impl std::fmt::Debug for Hit {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Hit")
            .field("row", &self.row)
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActivityDay {
    pub day: String,
    pub type_id: String,
    pub count: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TagCount {
    pub tag: String,
    pub count: i64,
}

pub struct Index {
    conn: Connection,
}

impl std::fmt::Debug for Index {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Index").finish_non_exhaustive()
    }
}

fn full_version() -> String {
    format!("{INDEX_VERSION}{FOLD_TABLE_VERSION}")
}

fn open_conn(path: &Path, key: &[u8; 32]) -> Result<Connection> {
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE,
    )?;
    let hex: String = key.iter().map(|b| format!("{b:02x}")).collect();
    let pragma = Zeroizing::new(format!("PRAGMA key = \"x'{hex}'\";"));
    conn.execute_batch(&pragma)?;
    // Fails if the key is wrong or the file is not a database.
    conn.query_row("SELECT count(*) FROM sqlite_master", [], |_| Ok(()))?;
    conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;")?;
    let tokenizer = Arc::new(Tokenizer::new(HanFold::from_opencc()));
    register_tokenizer(&conn, TOKENIZER_NAME, tokenizer)?;
    Ok(conn)
}

fn remove_files(path: &Path) -> Result<()> {
    for suffix in ["", "-wal", "-shm"] {
        let mut p = path.as_os_str().to_owned();
        p.push(suffix);
        match std::fs::remove_file(&p) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
    }
    Ok(())
}

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS index_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS items(
    rowid INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    type_id TEXT NOT NULL,
    title TEXT,
    state TEXT NOT NULL,
    privacy TEXT NOT NULL,
    container TEXT,
    created INTEGER NOT NULL,
    updated INTEGER NOT NULL,
    due INTEGER,
    recheck TEXT,
    fields TEXT NOT NULL,
    preview TEXT NOT NULL,
    time_start INTEGER,
    time_end INTEGER,
    tz TEXT,
    recurrence TEXT,
    occurred TEXT,
    occurred_key INTEGER
);
CREATE INDEX IF NOT EXISTS items_type ON items(type_id, updated);
CREATE INDEX IF NOT EXISTS items_container ON items(container);
CREATE INDEX IF NOT EXISTS items_due ON items(due);
CREATE INDEX IF NOT EXISTS items_time ON items(time_start);
CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(title, body, tokenize='dem');
CREATE TABLE IF NOT EXISTS links(src TEXT NOT NULL, dst TEXT NOT NULL, kind TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS links_dst ON links(dst);
CREATE INDEX IF NOT EXISTS links_src ON links(src);
CREATE TABLE IF NOT EXISTS tags(item TEXT NOT NULL, tag TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS tags_tag ON tags(tag);
CREATE INDEX IF NOT EXISTS tags_item ON tags(item);
CREATE TABLE IF NOT EXISTS activity_daily(
    day TEXT NOT NULL, type_id TEXT NOT NULL, count INTEGER NOT NULL,
    PRIMARY KEY(day, type_id)
);
";

const ROW_COLUMNS: &str = "i.id, i.type_id, i.title, i.state, i.privacy, i.container, i.created, i.updated, i.due, i.fields, i.preview, (SELECT json_group_array(tag) FROM tags t WHERE t.item = i.id), i.time_start, i.time_end, i.recurrence, i.occurred, i.occurred_key, i.tz";

fn row_of(r: &rusqlite::Row<'_>) -> rusqlite::Result<Row> {
    let tags: Option<String> = r.get(11)?;
    Ok(Row {
        id: r.get(0)?,
        type_id: r.get(1)?,
        title: r.get(2)?,
        state: r.get(3)?,
        privacy: r.get(4)?,
        container: r.get(5)?,
        created: r.get(6)?,
        updated: r.get(7)?,
        due: r.get(8)?,
        time: TimeColumns {
            start: r.get(12)?,
            end: r.get(13)?,
            recurrence: r.get(14)?,
            occurred: r.get(15)?,
            occurred_key: r.get(16)?,
            tz: r.get(17)?,
        },
        fields: r.get(9)?,
        preview: r.get(10)?,
        tags: tags
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default(),
    })
}

fn preview_of(body: &str) -> String {
    body.split('\n')
        .map(|l| l.replace('\u{fffc}', "").trim().to_owned())
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(160)
        .collect()
}

impl Index {
    /// Opens the index. Returns whether it is empty and needs a rebuild: first use, a different
    /// index version, or a file that cannot be read with this key. A broken index is only ever
    /// thrown away, because it can always be rebuilt.
    pub fn open(path: &Path, key: &[u8; 32]) -> Result<(Index, bool)> {
        let existed = path.exists();
        let conn = match open_conn(path, key) {
            Ok(c) => c,
            Err(_) if existed => {
                tracing::warn!("index could not be opened; rebuilding");
                remove_files(path)?;
                open_conn(path, key)?
            }
            Err(e) => return Err(e),
        };
        let version: Option<String> = conn
            .query_row(
                "SELECT value FROM index_meta WHERE key = 'version'",
                [],
                |r| r.get(0),
            )
            .optional()
            .unwrap_or(None);
        if version.as_deref() == Some(full_version().as_str()) {
            return Ok((Index { conn }, false));
        }
        drop(conn);
        remove_files(path)?;
        let conn = open_conn(path, key)?;
        conn.execute_batch(SCHEMA)?;
        conn.execute(
            "INSERT INTO index_meta(key, value) VALUES ('version', ?1)",
            params![full_version()],
        )?;
        Ok((Index { conn }, true))
    }

    /// Runs `f` in one transaction: much faster for a rebuild, and all-or-nothing.
    pub fn transaction<T>(&mut self, f: impl FnOnce(&Index) -> Result<T>) -> Result<T> {
        self.conn.execute_batch("BEGIN")?;
        match f(self) {
            Ok(v) => {
                self.conn.execute_batch("COMMIT")?;
                Ok(v)
            }
            Err(e) => {
                self.conn.execute_batch("ROLLBACK")?;
                Err(e)
            }
        }
    }

    /// Removes everything, ready for a rebuild.
    pub fn clear(&self) -> Result<()> {
        self.conn.execute_batch(
            "DELETE FROM items; DELETE FROM items_fts; DELETE FROM links; DELETE FROM tags; DELETE FROM activity_daily;",
        )?;
        Ok(())
    }

    pub fn upsert(&self, rec: &IndexRecord) -> Result<()> {
        self.remove(&rec.id)?;
        let secret = rec.privacy == CONFIDENTIAL;
        let time = if secret {
            TimeColumns::default()
        } else {
            rec.time.clone()
        };
        let (title, preview, fields) = if secret {
            (None, String::new(), "{}".to_owned())
        } else {
            (
                rec.title.clone(),
                preview_of(&rec.body),
                serde_json::to_string(&rec.fields)?,
            )
        };
        self.conn.execute(
            "INSERT INTO items(id, type_id, title, state, privacy, container, created, updated, due, recheck, fields, preview, time_start, time_end, recurrence, occurred, occurred_key, tz)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)",
            params![
                rec.id, rec.type_id, title, rec.state, rec.privacy, rec.container, rec.created,
                rec.updated, rec.due, rec.recheck, fields, preview, time.start, time.end,
                time.recurrence, time.occurred, time.occurred_key, time.tz
            ],
        )?;
        let rowid = self.conn.last_insert_rowid();
        if !secret {
            self.conn.execute(
                "INSERT INTO items_fts(rowid, title, body) VALUES (?1, ?2, ?3)",
                params![rowid, rec.title.clone().unwrap_or_default(), rec.body],
            )?;
            for tag in &rec.tags {
                self.conn.execute(
                    "INSERT INTO tags(item, tag) VALUES (?1, ?2)",
                    params![rec.id, tag],
                )?;
            }
        }
        for (dst, kind) in &rec.links {
            self.conn.execute(
                "INSERT INTO links(src, dst, kind) VALUES (?1, ?2, ?3)",
                params![rec.id, dst, kind],
            )?;
        }
        Ok(())
    }

    pub fn remove(&self, id: &str) -> Result<()> {
        let rowid: Option<i64> = self
            .conn
            .query_row("SELECT rowid FROM items WHERE id = ?1", params![id], |r| {
                r.get(0)
            })
            .optional()?;
        if let Some(rowid) = rowid {
            self.conn
                .execute("DELETE FROM items_fts WHERE rowid = ?1", params![rowid])?;
            self.conn
                .execute("DELETE FROM items WHERE rowid = ?1", params![rowid])?;
        }
        self.conn
            .execute("DELETE FROM links WHERE src = ?1", params![id])?;
        self.conn
            .execute("DELETE FROM tags WHERE item = ?1", params![id])?;
        Ok(())
    }

    pub fn get(&self, id: &str) -> Result<Option<Row>> {
        let sql = format!("SELECT {ROW_COLUMNS} FROM items i WHERE i.id = ?1");
        Ok(self.conn.query_row(&sql, params![id], row_of).optional()?)
    }

    pub fn list(&self, f: &Filter) -> Result<Vec<Row>> {
        let mut sql = format!("SELECT {ROW_COLUMNS} FROM items i WHERE 1=1");
        let mut args: Vec<rusqlite::types::Value> = Vec::new();
        if let Some(t) = &f.type_id {
            sql.push_str(" AND i.type_id = ?");
            args.push(t.clone().into());
        }
        if f.states.is_empty() {
            sql.push_str(" AND i.state != 'trashed'");
        } else {
            let marks = vec!["?"; f.states.len()].join(",");
            sql.push_str(&format!(" AND i.state IN ({marks})"));
            for s in &f.states {
                args.push(s.clone().into());
            }
        }
        if let Some(c) = &f.container {
            sql.push_str(" AND i.container = ?");
            args.push(c.clone().into());
        }
        if let Some(t) = &f.tag {
            sql.push_str(" AND EXISTS (SELECT 1 FROM tags x WHERE x.item = i.id AND x.tag = ?)");
            args.push(t.clone().into());
        }
        if let Some(d) = f.due_before {
            sql.push_str(" AND i.due IS NOT NULL AND i.due <= ?");
            args.push(d.into());
        }
        sql.push_str(match f.order {
            Order::Updated => " ORDER BY i.updated DESC",
            Order::Created => " ORDER BY i.created DESC",
            Order::Due => " ORDER BY i.due IS NULL, i.due ASC",
            Order::Title => " ORDER BY i.title COLLATE NOCASE ASC",
        });
        if let Some(n) = f.limit {
            sql.push_str(&format!(" LIMIT {n}"));
        }
        let mut st = self.conn.prepare(&sql)?;
        let rows = st.query_map(params_from_iter(args), row_of)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// What is scheduled and could fall before `until`: recurring items count from their start.
    pub fn scheduled(&self, until: i64) -> Result<Vec<Row>> {
        let sql = format!(
            "SELECT {ROW_COLUMNS} FROM items i
             WHERE i.time_start IS NOT NULL AND i.time_start < ?1
               AND i.state IN ('active', 'inbox')
             ORDER BY i.time_start"
        );
        let mut st = self.conn.prepare(&sql)?;
        let rows = st.query_map(params![until], row_of)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Full-text search, best matches first; trashed items and 机密 items never come back.
    pub fn search(&self, query: &str, limit: u32) -> Result<Vec<Hit>> {
        let Some(m) = user_query_to_match(query) else {
            return Ok(Vec::new());
        };
        let sql = format!(
            "SELECT {ROW_COLUMNS}, snippet(items_fts, 1, '\u{2045}', '\u{2046}', '…', 24)
             FROM items_fts JOIN items i ON i.rowid = items_fts.rowid
             WHERE items_fts MATCH ?1 AND i.state != 'trashed'
             ORDER BY rank LIMIT ?2"
        );
        let mut st = self.conn.prepare(&sql)?;
        let rows = st.query_map(params![m, limit], |r| {
            Ok(Hit {
                row: row_of(r)?,
                snippet: r.get(18)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Items whose 复查日期 has come (not 机密: no title to show).
    pub fn recheck_due(&self, day: &str) -> Result<Vec<Row>> {
        let sql = format!(
            "SELECT {ROW_COLUMNS} FROM items i
             WHERE i.recheck IS NOT NULL AND i.recheck <= ?1 AND i.state != 'trashed' AND i.privacy != 'confidential'
             ORDER BY i.recheck"
        );
        let mut st = self.conn.prepare(&sql)?;
        let rows = st.query_map(params![day], row_of)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Every link between items that are not 机密 and not in the trash, for the star map.
    pub fn all_links(&self) -> Result<Vec<(String, String)>> {
        let mut st = self.conn.prepare(
            "SELECT l.src, l.dst FROM links l
             JOIN items a ON a.id = l.src JOIN items b ON b.id = l.dst
             WHERE a.state != 'trashed' AND b.state != 'trashed'
               AND a.privacy != 'confidential' AND b.privacy != 'confidential'",
        )?;
        let rows = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Items that link to this one (M1: computed, never stored in the item).
    pub fn backlinks(&self, id: &str) -> Result<Vec<Row>> {
        let sql = format!(
            "SELECT DISTINCT {ROW_COLUMNS} FROM links l JOIN items i ON i.id = l.src
             WHERE l.dst = ?1 AND i.state != 'trashed' ORDER BY i.updated DESC"
        );
        let mut st = self.conn.prepare(&sql)?;
        let rows = st.query_map(params![id], row_of)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn tags(&self) -> Result<Vec<TagCount>> {
        let mut st = self
            .conn
            .prepare("SELECT tag, count(*) FROM tags GROUP BY tag ORDER BY count(*) DESC, tag")?;
        let rows = st.query_map([], |r| {
            Ok(TagCount {
                tag: r.get(0)?,
                count: r.get(1)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn clear_activity(&self) -> Result<()> {
        self.conn.execute("DELETE FROM activity_daily", [])?;
        Ok(())
    }

    pub fn add_activity(&self, day: &str, type_id: &str, n: i64) -> Result<()> {
        self.conn.execute(
            "INSERT INTO activity_daily(day, type_id, count) VALUES (?1, ?2, ?3)
             ON CONFLICT(day, type_id) DO UPDATE SET count = count + excluded.count",
            params![day, type_id, n],
        )?;
        Ok(())
    }

    /// Activity from this day on ("yyyy-mm-dd").
    pub fn activity_since(&self, day: &str) -> Result<Vec<ActivityDay>> {
        let mut st = self.conn.prepare(
            "SELECT day, type_id, count FROM activity_daily WHERE day >= ?1 ORDER BY day",
        )?;
        let rows = st.query_map(params![day], |r| {
            Ok(ActivityDay {
                day: r.get(0)?,
                type_id: r.get(1)?,
                count: r.get(2)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn open(dir: &tempfile::TempDir) -> Index {
        Index::open(&dir.path().join("index.sqlite"), &[7; 32])
            .unwrap()
            .0
    }
    fn rec(id: &str, title: &str, body: &str) -> IndexRecord {
        IndexRecord {
            id: id.into(),
            type_id: "note".into(),
            title: Some(title.into()),
            state: "active".into(),
            privacy: "normal".into(),
            fields: serde_json::json!({}),
            body: body.into(),
            ..Default::default()
        }
    }

    #[test]
    fn finds_chinese_across_traditional_and_simplified() {
        let dir = tempfile::tempdir().unwrap();
        let idx = open(&dir);
        idx.upsert(&rec("a", "复习计划", "這週要復習法語")).unwrap();
        idx.upsert(&rec("b", "别的", "没有关系")).unwrap();
        assert_eq!(idx.search("复习", 10).unwrap()[0].row.id, "a");
        assert_eq!(idx.search("復習", 10).unwrap()[0].row.id, "a");
        assert_eq!(idx.search("法语", 10).unwrap().len(), 1);
        assert!(idx.search("  ", 10).unwrap().is_empty());
    }

    #[test]
    fn user_syntax_cannot_break_the_query() {
        let dir = tempfile::tempdir().unwrap();
        let idx = open(&dir);
        idx.upsert(&rec("a", "title", "body")).unwrap();
        for q in ["\"", "a OR", "NEAR(", "title:x", "*"] {
            idx.search(q, 10).unwrap();
        }
    }

    #[test]
    fn keeps_confidential_out_of_search_and_stores_no_title() {
        let dir = tempfile::tempdir().unwrap();
        let idx = open(&dir);
        let mut secret = rec("s", "护照号码", "号码是一串数字");
        secret.privacy = CONFIDENTIAL.into();
        secret.tags = vec!["证件".into()];
        idx.upsert(&secret).unwrap();
        assert!(idx.search("护照", 10).unwrap().is_empty());
        assert!(idx.search("号码", 10).unwrap().is_empty());
        let row = idx.get("s").unwrap().unwrap();
        assert_eq!(row.title, None);
        assert_eq!(row.preview, "");
        assert!(idx.tags().unwrap().is_empty());
    }

    #[test]
    fn replaces_old_text_when_an_item_changes() {
        let dir = tempfile::tempdir().unwrap();
        let idx = open(&dir);
        idx.upsert(&rec("a", "旧标题", "旧内容")).unwrap();
        idx.upsert(&rec("a", "新标题", "新内容")).unwrap();
        assert!(idx.search("旧内容", 10).unwrap().is_empty());
        assert_eq!(idx.search("新内容", 10).unwrap().len(), 1);
        idx.remove("a").unwrap();
        assert!(idx.search("新内容", 10).unwrap().is_empty());
        assert!(idx.get("a").unwrap().is_none());
    }

    #[test]
    fn hides_trashed_items_from_lists_and_search() {
        let dir = tempfile::tempdir().unwrap();
        let idx = open(&dir);
        let mut gone = rec("g", "扔掉的", "内容");
        gone.recheck = Some("2026-01-01".into());
        gone.state = "trashed".into();
        idx.upsert(&gone).unwrap();
        assert!(idx.search("内容", 10).unwrap().is_empty());
        assert!(idx.list(&Filter::default()).unwrap().is_empty());
        let trash = idx
            .list(&Filter {
                states: vec!["trashed".into()],
                ..Default::default()
            })
            .unwrap();
        assert_eq!(trash.len(), 1);
        assert!(idx.recheck_due("2026-12-31").unwrap().is_empty());
    }

    #[test]
    fn finds_what_is_due_for_a_recheck() {
        let dir = tempfile::tempdir().unwrap();
        let idx = open(&dir);
        let mut a = rec("a", "甲", "");
        a.recheck = Some("2026-11-02".into());
        idx.upsert(&a).unwrap();
        assert!(idx.recheck_due("2026-11-01").unwrap().is_empty());
        assert_eq!(idx.recheck_due("2026-11-02").unwrap().len(), 1);
    }

    #[test]
    fn computes_backlinks() {
        let dir = tempfile::tempdir().unwrap();
        let idx = open(&dir);
        let mut a = rec("a", "甲", "");
        a.links = vec![("b".into(), "link".into())];
        idx.upsert(&a).unwrap();
        idx.upsert(&rec("b", "乙", "")).unwrap();
        assert_eq!(idx.backlinks("b").unwrap()[0].id, "a");
        a.links.clear();
        idx.upsert(&a).unwrap();
        assert!(idx.backlinks("b").unwrap().is_empty());
    }

    #[test]
    fn filters_and_orders_lists() {
        let dir = tempfile::tempdir().unwrap();
        let idx = open(&dir);
        let mut a = rec("a", "甲", "");
        a.type_id = "todo".into();
        a.due = Some(5);
        a.tags = vec!["法语".into()];
        let mut b = rec("b", "乙", "");
        b.type_id = "todo".into();
        b.due = Some(1);
        let mut c = rec("c", "丙", "");
        c.container = Some("p".into());
        for r in [&a, &b, &c] {
            idx.upsert(r).unwrap();
        }
        let todos = idx
            .list(&Filter {
                type_id: Some("todo".into()),
                order: Order::Due,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(
            todos.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
            ["b", "a"]
        );
        assert_eq!(todos[1].tags, ["法语"]);
        let due = idx
            .list(&Filter {
                due_before: Some(2),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(due.len(), 1);
        let inside = idx
            .list(&Filter {
                container: Some("p".into()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(inside[0].id, "c");
        let tagged = idx
            .list(&Filter {
                tag: Some("法语".into()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(tagged[0].id, "a");
        assert_eq!(idx.tags().unwrap()[0].count, 1);
    }

    #[test]
    fn adds_up_activity_by_day_and_type() {
        let dir = tempfile::tempdir().unwrap();
        let idx = open(&dir);
        idx.add_activity("2026-11-01", "note", 2).unwrap();
        idx.add_activity("2026-11-01", "note", 1).unwrap();
        idx.add_activity("2026-11-02", "todo", 1).unwrap();
        let all = idx.activity_since("2026-11-01").unwrap();
        assert_eq!(all[0].count, 3);
        assert_eq!(idx.activity_since("2026-11-02").unwrap().len(), 1);
    }

    #[test]
    fn rebuilds_when_the_file_cannot_be_read() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("index.sqlite");
        let (idx, fresh) = Index::open(&path, &[7; 32]).unwrap();
        assert!(fresh);
        idx.upsert(&rec("a", "甲", "内容")).unwrap();
        drop(idx);
        let (idx, fresh) = Index::open(&path, &[7; 32]).unwrap();
        assert!(!fresh);
        assert_eq!(idx.search("内容", 5).unwrap().len(), 1);
        drop(idx);
        // A different key: the old file is unreadable, so it starts over.
        let (idx, fresh) = Index::open(&path, &[9; 32]).unwrap();
        assert!(fresh);
        assert!(idx.search("内容", 5).unwrap().is_empty());
    }

    #[test]
    fn stores_nothing_readable_on_disk() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("index.sqlite");
        let (mut idx, _) = Index::open(&path, &[7; 32]).unwrap();
        idx.transaction(|i| i.upsert(&rec("a", "UNIQUECANARYTITLE", "UNIQUECANARYBODY")))
            .unwrap();
        idx.conn
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
            .unwrap();
        drop(idx);
        let raw = std::fs::read(&path).unwrap();
        let text = String::from_utf8_lossy(&raw);
        assert!(!text.contains("UNIQUECANARY"));
    }
}
