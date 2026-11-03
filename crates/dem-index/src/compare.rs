//! Comparing two index databases (P0-41, decision Q9: engine and framework in P0,
//! rebuilding the index in P1).
//!
//! Both files are opened read-only; with a key they are opened as SQLCipher
//! databases using the raw 32-byte index key (format spec §14). The comparison
//! covers header pragmas, the schema (`sqlite_master`) and every ordinary table
//! row by row: rows of both sides are read in canonical order (primary key, or all
//! columns for tables without one) and merged, so memory use does not grow with
//! the table size. Virtual tables are skipped because their shadow tables, which
//! hold the actual data, are ordinary tables and are compared themselves.

use std::cmp::Ordering;
use std::fmt;
use std::path::Path;

use rusqlite::types::ValueRef;
use rusqlite::{Connection, ErrorCode, OpenFlags};
use serde::Serialize;
use zeroize::Zeroizing;

/// Test fixtures; compiled only for tests and for `dem-dev` (feature `fixtures`),
/// never into the shipped build.
#[cfg(any(test, feature = "fixtures"))]
pub mod fixtures;

#[derive(Debug, thiserror::Error)]
pub enum CompareError {
    #[error("cannot open {path}: {source}")]
    Open {
        path: String,
        #[source]
        source: rusqlite::Error,
    },
    /// Plain file opened with a key, encrypted file without one, or a wrong key.
    #[error("{path} is not a database, or the key is wrong or missing")]
    NotADatabase { path: String },
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
}

pub type Result<T> = std::result::Result<T, CompareError>;

/// Tuning for [`diff_with`].
#[derive(Debug, Clone)]
pub struct Options {
    /// Row changes recorded per table; the counts are always complete.
    pub max_samples: usize,
    /// Tables not compared row by row (their schema is still compared).
    pub skip_tables: Vec<String>,
}

impl Default for Options {
    fn default() -> Self {
        Options {
            max_samples: 10,
            skip_tables: Vec::new(),
        }
    }
}

/// One SQLite value, owned, for reports.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", content = "value", rename_all = "lowercase")]
pub enum Cell {
    Null,
    Integer(i64),
    Real(f64),
    Text(String),
    Blob(#[serde(serialize_with = "hex_bytes")] Vec<u8>),
}

fn hex_bytes<S: serde::Serializer>(b: &[u8], s: S) -> std::result::Result<S::Ok, S::Error> {
    s.serialize_str(&hex(b))
}

fn hex(b: &[u8]) -> String {
    use std::fmt::Write;
    let mut out = String::with_capacity(b.len() * 2);
    for x in b {
        let _ = write!(out, "{x:02x}");
    }
    out
}

impl From<ValueRef<'_>> for Cell {
    fn from(v: ValueRef<'_>) -> Self {
        match v {
            ValueRef::Null => Cell::Null,
            ValueRef::Integer(i) => Cell::Integer(i),
            ValueRef::Real(f) => Cell::Real(f),
            ValueRef::Text(t) => Cell::Text(String::from_utf8_lossy(t).into_owned()),
            ValueRef::Blob(b) => Cell::Blob(b.to_vec()),
        }
    }
}

impl fmt::Display for Cell {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        const MAX_CHARS: usize = 60;
        const MAX_BYTES: usize = 24;
        match self {
            Cell::Null => f.write_str("NULL"),
            Cell::Integer(i) => write!(f, "{i}"),
            Cell::Real(x) => write!(f, "{x:?}"),
            Cell::Text(t) if t.chars().count() > MAX_CHARS => {
                let head: String = t.chars().take(MAX_CHARS).collect();
                write!(f, "{head:?}… ({} chars)", t.chars().count())
            }
            Cell::Text(t) => write!(f, "{t:?}"),
            Cell::Blob(b) if b.len() > MAX_BYTES => {
                write!(f, "x'{}…' ({} bytes)", hex(&b[..MAX_BYTES]), b.len())
            }
            Cell::Blob(b) => write!(f, "x'{}'", hex(b)),
        }
    }
}

impl Cell {
    /// SQLite's ORDER BY order with BINARY collation: NULL, numbers, text, blobs.
    fn sort_cmp(&self, other: &Cell) -> Ordering {
        fn class(c: &Cell) -> u8 {
            match c {
                Cell::Null => 0,
                Cell::Integer(_) | Cell::Real(_) => 1,
                Cell::Text(_) => 2,
                Cell::Blob(_) => 3,
            }
        }
        match (self, other) {
            (Cell::Integer(a), Cell::Integer(b)) => a.cmp(b),
            (Cell::Integer(a), Cell::Real(b)) => int_real_cmp(*a, *b),
            (Cell::Real(a), Cell::Integer(b)) => int_real_cmp(*b, *a).reverse(),
            (Cell::Real(a), Cell::Real(b)) => a.total_cmp(b),
            (Cell::Text(a), Cell::Text(b)) => a.as_bytes().cmp(b.as_bytes()),
            (Cell::Blob(a), Cell::Blob(b)) => a.cmp(b),
            _ => class(self).cmp(&class(other)),
        }
    }
}

/// Exact integer/real comparison as SQLite does it (no rounding of the integer
/// to f64, which would merge neighbours above 2^53). SQLite never stores NaN.
fn int_real_cmp(i: i64, r: f64) -> Ordering {
    // 2^63 is exactly representable; every i64 is below it and at or above -2^63.
    const TWO_63: f64 = 9_223_372_036_854_775_808.0;
    if r.is_nan() {
        return Ordering::Greater;
    }
    if r >= TWO_63 {
        return Ordering::Less;
    }
    if r < -TWO_63 {
        return Ordering::Greater;
    }
    let t = r.trunc();
    // In range, so the truncated value converts exactly.
    match i.cmp(&(t as i64)) {
        // Same integer part: the fraction decides.
        Ordering::Equal if r > t => Ordering::Less,
        Ordering::Equal if r < t => Ordering::Greater,
        o => o,
    }
}

/// A header value that differs (`user_version`, `application_id`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PragmaChange {
    pub pragma: String,
    pub a: i64,
    pub b: i64,
}

/// One entry of `sqlite_master`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SchemaObject {
    /// `table`, `index`, `view` or `trigger`.
    pub kind: String,
    pub name: String,
    pub table: String,
    /// The `CREATE` statement with whitespace collapsed; None for automatic indexes.
    pub sql: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "change", rename_all = "snake_case")]
pub enum SchemaChange {
    OnlyInA { object: SchemaObject },
    OnlyInB { object: SchemaObject },
    Changed { a: SchemaObject, b: SchemaObject },
}

/// How rows were matched.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "by", content = "columns", rename_all = "snake_case")]
pub enum RowKey {
    /// By these primary-key columns; same key with other values is "changed".
    PrimaryKey(Vec<String>),
    /// By the whole row, as a multiset; differences are only added or removed rows.
    AllColumns,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ColumnChange {
    pub column: String,
    pub a: Cell,
    pub b: Cell,
}

/// A row difference. "Added" means present in B but not in A.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "change", rename_all = "snake_case")]
pub enum RowChange {
    Added {
        key: Vec<Cell>,
        row: Vec<Cell>,
    },
    Removed {
        key: Vec<Cell>,
        row: Vec<Cell>,
    },
    Changed {
        key: Vec<Cell>,
        columns: Vec<ColumnChange>,
    },
}

/// Row-level result for one table present in both databases.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TableDiff {
    pub table: String,
    pub key: RowKey,
    /// Columns compared: those present in both databases, in A's order.
    pub columns: Vec<String>,
    pub rows_a: u64,
    pub rows_b: u64,
    pub added: u64,
    pub removed: u64,
    pub changed: u64,
    /// At most `Options::max_samples` changes, in canonical row order.
    pub samples: Vec<RowChange>,
}

impl TableDiff {
    pub fn is_empty(&self) -> bool {
        self.added == 0 && self.removed == 0 && self.changed == 0
    }
}

/// Everything that differs between database A and database B.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Diff {
    pub pragmas: Vec<PragmaChange>,
    pub schema: Vec<SchemaChange>,
    /// Only tables with row differences.
    pub tables: Vec<TableDiff>,
    /// Ordinary tables present in both and compared row by row.
    pub tables_compared: Vec<String>,
    /// Virtual tables (compared through their shadow tables) and skipped tables.
    pub tables_skipped: Vec<String>,
}

impl Diff {
    pub fn is_empty(&self) -> bool {
        self.pragmas.is_empty() && self.schema.is_empty() && self.tables.is_empty()
    }
}

/// Compares two index databases with default options. `key` is the raw SQLCipher
/// key for both files; None opens them as plain SQLite.
pub fn diff(a: &Path, b: &Path, key: Option<&[u8; 32]>) -> Result<Diff> {
    diff_with(a, b, key, &Options::default())
}

pub fn diff_with(a: &Path, b: &Path, key: Option<&[u8; 32]>, opts: &Options) -> Result<Diff> {
    let ca = open(a, key)?;
    let cb = open(b, key)?;

    let mut pragmas = Vec::new();
    for p in ["user_version", "application_id"] {
        let (va, vb) = (pragma_i64(&ca, p)?, pragma_i64(&cb, p)?);
        if va != vb {
            pragmas.push(PragmaChange {
                pragma: p.to_owned(),
                a: va,
                b: vb,
            });
        }
    }

    let sa = schema(&ca)?;
    let sb = schema(&cb)?;
    let mut schema_changes = Vec::new();
    for oa in &sa {
        match sb.iter().find(|o| o.kind == oa.kind && o.name == oa.name) {
            None => schema_changes.push(SchemaChange::OnlyInA { object: oa.clone() }),
            Some(ob) if ob != oa => schema_changes.push(SchemaChange::Changed {
                a: oa.clone(),
                b: ob.clone(),
            }),
            Some(_) => {}
        }
    }
    for ob in &sb {
        if !sa.iter().any(|o| o.kind == ob.kind && o.name == ob.name) {
            schema_changes.push(SchemaChange::OnlyInB { object: ob.clone() });
        }
    }

    let mut tables = Vec::new();
    let mut compared = Vec::new();
    let mut skipped = Vec::new();
    for ta in sa.iter().filter(|o| o.kind == "table") {
        if !sb.iter().any(|o| o.kind == "table" && o.name == ta.name) {
            continue;
        }
        let is_virtual = ta
            .sql
            .as_deref()
            .is_some_and(|s| s.to_ascii_uppercase().starts_with("CREATE VIRTUAL TABLE"));
        if is_virtual || opts.skip_tables.contains(&ta.name) {
            skipped.push(ta.name.clone());
            continue;
        }
        compared.push(ta.name.clone());
        let td = diff_table(&ca, &cb, &ta.name, opts.max_samples)?;
        if !td.is_empty() {
            tables.push(td);
        }
    }

    Ok(Diff {
        pragmas,
        schema: schema_changes,
        tables,
        tables_compared: compared,
        tables_skipped: skipped,
    })
}

/// Opens a database read-only, keyed when `key` is given, and checks it is readable.
pub fn open(path: &Path, key: Option<&[u8; 32]>) -> Result<Connection> {
    let shown = path.display().to_string();
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|source| CompareError::Open {
        path: shown.clone(),
        source,
    })?;
    if let Some(k) = key {
        apply_key(&conn, k)?;
    }
    conn.query_row("SELECT count(*) FROM sqlite_master", [], |r| {
        r.get::<_, i64>(0)
    })
    .map_err(|e| match e.sqlite_error_code() {
        Some(ErrorCode::NotADatabase) => CompareError::NotADatabase { path: shown },
        _ => CompareError::Sqlite(e),
    })?;
    Ok(conn)
}

/// Raw-key form (`x'…'`) skips SQLCipher's own PBKDF2 (format spec §14).
pub(crate) fn apply_key(conn: &Connection, key: &[u8; 32]) -> Result<()> {
    let stmt = Zeroizing::new(format!(
        "PRAGMA key = \"x'{}'\";",
        Zeroizing::new(hex(key)).as_str()
    ));
    conn.execute_batch(&stmt)?;
    Ok(())
}

fn pragma_i64(conn: &Connection, name: &str) -> Result<i64> {
    Ok(conn.query_row(&format!("PRAGMA {name}"), [], |r| r.get(0))?)
}

fn collapse_ws(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn schema(conn: &Connection) -> Result<Vec<SchemaObject>> {
    let mut stmt = conn.prepare(
        "SELECT type, name, tbl_name, sql FROM sqlite_master \
         ORDER BY type COLLATE BINARY, name COLLATE BINARY",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(SchemaObject {
            kind: r.get(0)?,
            name: r.get(1)?,
            table: r.get(2)?,
            sql: r.get::<_, Option<String>>(3)?.map(|s| collapse_ws(&s)),
        })
    })?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}

fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// `(column name, position in primary key or 0)` in declaration order.
fn table_columns(conn: &Connection, table: &str) -> Result<Vec<(String, i64)>> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({})", quote_ident(table)))?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(1)?, r.get::<_, i64>(5)?)))?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}

fn diff_table(
    ca: &Connection,
    cb: &Connection,
    table: &str,
    max_samples: usize,
) -> Result<TableDiff> {
    let cols_a = table_columns(ca, table)?;
    let cols_b = table_columns(cb, table)?;
    let columns: Vec<String> = cols_a
        .iter()
        .filter(|(n, _)| cols_b.iter().any(|(m, _)| m == n))
        .map(|(n, _)| n.clone())
        .collect();

    // Primary key only if both sides declare the same one over shared columns.
    let pk_of = |cols: &[(String, i64)]| {
        let mut pk: Vec<(i64, String)> = cols
            .iter()
            .filter(|(_, p)| *p > 0)
            .map(|(n, p)| (*p, n.clone()))
            .collect();
        pk.sort();
        pk.into_iter().map(|(_, n)| n).collect::<Vec<_>>()
    };
    let (pk_a, pk_b) = (pk_of(&cols_a), pk_of(&cols_b));
    let key = if !pk_a.is_empty() && pk_a == pk_b && pk_a.iter().all(|c| columns.contains(c)) {
        RowKey::PrimaryKey(pk_a)
    } else {
        RowKey::AllColumns
    };
    let key_idx: Vec<usize> = match &key {
        RowKey::PrimaryKey(pk) => pk
            .iter()
            .filter_map(|c| columns.iter().position(|x| x == c))
            .collect(),
        RowKey::AllColumns => (0..columns.len()).collect(),
    };

    let mut td = TableDiff {
        table: table.to_owned(),
        key,
        columns: columns.clone(),
        rows_a: 0,
        rows_b: 0,
        added: 0,
        removed: 0,
        changed: 0,
        samples: Vec::new(),
    };
    if columns.is_empty() {
        return Ok(td);
    }
    let n = columns.len();

    let select = columns
        .iter()
        .map(|c| quote_ident(c))
        .collect::<Vec<_>>()
        .join(", ");
    // Key columns first, then the others: a primary key of a rowid table may hold
    // several NULLs, and those rows must still come in the same order on both sides.
    let order = key_idx
        .iter()
        .copied()
        .chain((0..n).filter(|i| !key_idx.contains(i)))
        .map(|i| format!("{} COLLATE BINARY", quote_ident(&columns[i])))
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "SELECT {select} FROM {} ORDER BY {order}",
        quote_ident(table)
    );
    let mut stmt_a = ca.prepare(&sql)?;
    let mut stmt_b = cb.prepare(&sql)?;
    let mut rows_a = stmt_a.query([])?;
    let mut rows_b = stmt_b.query([])?;
    let fetch = |rows: &mut rusqlite::Rows<'_>| -> Result<Option<Vec<Cell>>> {
        match rows.next()? {
            None => Ok(None),
            Some(r) => {
                let mut out = Vec::with_capacity(n);
                for i in 0..n {
                    out.push(Cell::from(r.get_ref(i)?));
                }
                Ok(Some(out))
            }
        }
    };
    let key_of = |row: &[Cell]| key_idx.iter().map(|&i| row[i].clone()).collect::<Vec<_>>();
    let cmp_keys = |a: &[Cell], b: &[Cell]| {
        key_idx
            .iter()
            .map(|&i| a[i].sort_cmp(&b[i]))
            .find(|o| o.is_ne())
            .unwrap_or(Ordering::Equal)
    };

    let mut next_a = fetch(&mut rows_a)?;
    let mut next_b = fetch(&mut rows_b)?;
    loop {
        let step = match (&next_a, &next_b) {
            (None, None) => break,
            (Some(_), None) => Ordering::Less,
            (None, Some(_)) => Ordering::Greater,
            (Some(a), Some(b)) => cmp_keys(a, b),
        };
        match step {
            Ordering::Less => {
                let Some(a) = next_a.take() else { break };
                td.rows_a += 1;
                td.removed += 1;
                if td.samples.len() < max_samples {
                    td.samples.push(RowChange::Removed {
                        key: key_of(&a),
                        row: a,
                    });
                }
                next_a = fetch(&mut rows_a)?;
            }
            Ordering::Greater => {
                let Some(b) = next_b.take() else { break };
                td.rows_b += 1;
                td.added += 1;
                if td.samples.len() < max_samples {
                    td.samples.push(RowChange::Added {
                        key: key_of(&b),
                        row: b,
                    });
                }
                next_b = fetch(&mut rows_b)?;
            }
            Ordering::Equal => {
                let (Some(a), Some(b)) = (next_a.take(), next_b.take()) else {
                    break;
                };
                td.rows_a += 1;
                td.rows_b += 1;
                let changes: Vec<ColumnChange> = (0..n)
                    .filter(|i| !key_idx.contains(i) && a[*i] != b[*i])
                    .map(|i| ColumnChange {
                        column: columns[i].clone(),
                        a: a[i].clone(),
                        b: b[i].clone(),
                    })
                    .collect();
                if !changes.is_empty() {
                    td.changed += 1;
                    if td.samples.len() < max_samples {
                        td.samples.push(RowChange::Changed {
                            key: key_of(&a),
                            columns: changes,
                        });
                    }
                }
                next_a = fetch(&mut rows_a)?;
                next_b = fetch(&mut rows_b)?;
            }
        }
    }
    Ok(td)
}

#[cfg(test)]
mod tests {
    use super::fixtures::{self, Variant};
    use super::*;

    const KEY: [u8; 32] = [7u8; 32];

    fn pair(key: Option<&[u8; 32]>, b: Variant) -> (tempfile::TempDir, Diff) {
        let dir = tempfile::tempdir().unwrap();
        let pa = dir.path().join("a.sqlite");
        let pb = dir.path().join("b.sqlite");
        fixtures::write(&pa, key, Variant::A).unwrap();
        fixtures::write(&pb, key, b).unwrap();
        let d = diff(&pa, &pb, key).unwrap();
        (dir, d)
    }

    #[test]
    fn identical_content_in_a_different_insert_order_has_no_differences() {
        for key in [None, Some(&KEY)] {
            let (_dir, d) = pair(key, Variant::AReordered);
            assert!(d.is_empty(), "{d:#?}");
            // FTS5 data is compared through its shadow tables.
            assert_eq!(
                d.tables_compared,
                [
                    "fts_config",
                    "fts_content",
                    "fts_data",
                    "fts_docsize",
                    "fts_idx",
                    "items",
                    "links",
                    "meta",
                    "postings"
                ]
            );
            assert_eq!(d.tables_skipped, ["fts"]);
        }
    }

    #[test]
    fn known_differences_are_reported_exactly() {
        for key in [None, Some(&KEY)] {
            let (_dir, d) = pair(key, Variant::B);
            assert_eq!(fixtures::check_expected_b(&d), Ok(()), "{d:#?}");
        }
    }

    #[test]
    fn sample_limit_keeps_counts_complete() {
        let dir = tempfile::tempdir().unwrap();
        let pa = dir.path().join("a.sqlite");
        let pb = dir.path().join("b.sqlite");
        for (p, n) in [(&pa, 100), (&pb, 250)] {
            let c = Connection::open(p).unwrap();
            c.execute_batch("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT);")
                .unwrap();
            for i in 0..n {
                c.execute("INSERT INTO t VALUES (?1, 'x')", [i]).unwrap();
            }
        }
        let d = diff_with(
            &pa,
            &pb,
            None,
            &Options {
                max_samples: 3,
                skip_tables: vec![],
            },
        )
        .unwrap();
        assert_eq!(d.tables[0].added, 150);
        assert_eq!(d.tables[0].samples.len(), 3);
        assert_eq!(
            d.tables[0].samples[0],
            RowChange::Added {
                key: vec![Cell::Integer(100)],
                row: vec![Cell::Integer(100), Cell::Text("x".into())],
            }
        );
    }

    #[test]
    fn wrong_or_missing_key_is_reported_not_misread() {
        let dir = tempfile::tempdir().unwrap();
        let enc = dir.path().join("enc.sqlite");
        let plain = dir.path().join("plain.sqlite");
        fixtures::write(&enc, Some(&KEY), Variant::A).unwrap();
        fixtures::write(&plain, None, Variant::A).unwrap();
        let wrong = [8u8; 32];
        assert!(matches!(
            open(&enc, Some(&wrong)),
            Err(CompareError::NotADatabase { .. })
        ));
        assert!(matches!(
            open(&enc, None),
            Err(CompareError::NotADatabase { .. })
        ));
        assert!(matches!(
            open(&plain, Some(&KEY)),
            Err(CompareError::NotADatabase { .. })
        ));
        assert!(open(&dir.path().join("missing.sqlite"), None).is_err());
    }

    #[test]
    fn encrypted_file_contains_no_plaintext() {
        let dir = tempfile::tempdir().unwrap();
        let enc = dir.path().join("enc.sqlite");
        fixtures::write(&enc, Some(&KEY), Variant::A).unwrap();
        let bytes = std::fs::read(&enc).unwrap();
        let has = |needle: &[u8]| bytes.windows(needle.len()).any(|w| w == needle);
        assert!(!has(b"SQLite format 3"));
        assert!(!has("独角兽".as_bytes()));
        assert!(!has(b"postings"));
    }

    #[test]
    fn sort_order_matches_sqlite() {
        let dir = tempfile::tempdir().unwrap();
        let c = Connection::open(dir.path().join("o.sqlite")).unwrap();
        c.execute_batch(
            "CREATE TABLE t(v);
             INSERT INTO t VALUES (x'00'), ('b'), ('B'), ('é'), (2.5), (2), (-1), (NULL), ('a'),
               (9007199254740993), (9007199254740992.0), (9223372036854775807),
               (9223372036854775808.0), (-2.5), (-3), (-9223372036854775808), (-1e300);",
        )
        .unwrap();
        let mut stmt = c
            .prepare("SELECT v FROM t ORDER BY v COLLATE BINARY")
            .unwrap();
        let from_sqlite: Vec<Cell> = stmt
            .query_map([], |r| Ok(Cell::from(r.get_ref(0)?)))
            .unwrap()
            .map(|x| x.unwrap())
            .collect();
        let mut ours = from_sqlite.clone();
        ours.reverse();
        ours.sort_by(Cell::sort_cmp);
        assert_eq!(ours, from_sqlite);
    }

    #[test]
    fn integers_and_reals_compare_exactly() {
        let two53 = 9_007_199_254_740_992_i64;
        assert_eq!(
            Cell::Integer(two53 + 1).sort_cmp(&Cell::Real(two53 as f64)),
            Ordering::Greater
        );
        assert_eq!(
            Cell::Integer(i64::MAX).sort_cmp(&Cell::Real(2f64.powi(63))),
            Ordering::Less
        );
        assert_eq!(
            Cell::Real(-2.5).sort_cmp(&Cell::Integer(-2)),
            Ordering::Less
        );
        assert_eq!(Cell::Real(3.0).sort_cmp(&Cell::Integer(3)), Ordering::Equal);
    }

    #[test]
    fn duplicate_null_keys_do_not_produce_false_changes() {
        // A TEXT primary key of a rowid table accepts several NULLs.
        let dir = tempfile::tempdir().unwrap();
        let pa = dir.path().join("a.sqlite");
        let pb = dir.path().join("b.sqlite");
        for (p, rows) in [(&pa, ["a", "b", "c"]), (&pb, ["c", "b", "a"])] {
            let c = Connection::open(p).unwrap();
            c.execute_batch("CREATE TABLE t(k TEXT PRIMARY KEY, v TEXT);")
                .unwrap();
            for v in rows {
                c.execute("INSERT INTO t VALUES (NULL, ?1)", [v]).unwrap();
            }
        }
        let d = diff(&pa, &pb, None).unwrap();
        assert!(d.is_empty(), "{d:#?}");
    }

    #[test]
    fn cells_display_compactly() {
        assert_eq!(
            Cell::Blob(vec![0xab; 30]).to_string().len(),
            "x'…' (30 bytes)".len() + 48
        );
        assert_eq!(Cell::Text("a\"b".into()).to_string(), "\"a\\\"b\"");
        assert_eq!(Cell::Null.to_string(), "NULL");
    }
}
