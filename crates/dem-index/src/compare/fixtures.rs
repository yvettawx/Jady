//! Hand-built index databases with known differences, shared by this crate's tests
//! and `dem-dev index-diff`'s integration tests (which may not use SQLite
//! directly). Test support only; not used by shipped code paths.

use std::path::Path;

use rusqlite::Connection;

use super::{
    Cell, ColumnChange, Diff, Result, RowChange, RowKey, SchemaChange, SchemaObject, TableDiff,
    apply_key,
};

/// Which fixture database to write.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Variant {
    /// The reference database.
    A,
    /// Same content as A, inserted in a different order with differently
    /// formatted `CREATE` statements: must compare as identical.
    AReordered,
    /// A with the differences checked by [`check_expected_b`].
    B,
}

const SCHEMA_A: &str = "
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE items(id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT, updated INTEGER, privacy TEXT);
CREATE TABLE links(src TEXT, dst TEXT, kind TEXT);
CREATE TABLE postings(term TEXT, doc INTEGER, pos BLOB, PRIMARY KEY(term, doc)) WITHOUT ROWID;
CREATE INDEX items_type ON items(type);
CREATE VIRTUAL TABLE fts USING fts5(title);
";

/// Same statements, different whitespace (the schema compare collapses it).
const SCHEMA_A_REFORMATTED: &str = "
CREATE TABLE postings(term TEXT,  doc INTEGER,
    pos BLOB, PRIMARY KEY(term, doc)) WITHOUT ROWID;
CREATE TABLE links(src TEXT,
    dst TEXT, kind TEXT);
CREATE TABLE items(id TEXT PRIMARY KEY,
    type TEXT NOT NULL, title TEXT, updated INTEGER, privacy TEXT);
CREATE INDEX items_type ON   items(type);
CREATE TABLE meta(key TEXT PRIMARY KEY,   value TEXT);
CREATE VIRTUAL TABLE fts USING fts5(title);
";

const B_EXTRA_INDEX: &str = "CREATE INDEX items_updated ON items(updated)";
const B_EXTRA_TABLE: &str = "CREATE TABLE extra(x)";

type ItemRow = (
    &'static str,
    &'static str,
    Option<&'static str>,
    i64,
    &'static str,
);

const ITEMS_A: &[ItemRow] = &[
    ("i1", "note", Some("独角兽"), 100, "normal"),
    ("i2", "article", Some("Paris"), 200, "sensitive"),
    ("i3", "todo", None, 300, "private"),
    ("i4", "card", Some("café"), 400, "normal"),
];

const LINKS_A: &[(&str, &str, &str)] = &[
    ("i2", "i1", "ref"),
    ("i3", "i1", "ref"),
    ("i4", "i2", "ref"),
];

const POSTINGS_A: &[(&str, i64, &[u8])] = &[
    ("独", 1, &[0, 1]),
    ("角", 1, &[1, 2]),
    ("paris", 2, &[0]),
    ("发", 1, &[5]),
];

/// Writes one fixture database; with `key` it is a SQLCipher database.
pub fn write(path: &Path, key: Option<&[u8; 32]>, variant: Variant) -> Result<()> {
    let c = Connection::open(path)?;
    if let Some(k) = key {
        apply_key(&c, k)?;
    }
    let mut items: Vec<ItemRow> = ITEMS_A.to_vec();
    let mut links: Vec<(&str, &str, &str)> = LINKS_A.to_vec();
    let mut postings: Vec<(&str, i64, Vec<u8>)> = POSTINGS_A
        .iter()
        .map(|(t, d, p)| (*t, *d, p.to_vec()))
        .collect();
    let mut meta = vec![
        ("index_version", "schema-1/tok-1/opencc-1.4.1-chars-v1"),
        ("built", "2026-10-18T03:00:00Z"),
    ];
    let mut user_version = 1;

    match variant {
        Variant::A => c.execute_batch(SCHEMA_A)?,
        Variant::AReordered => {
            c.execute_batch(SCHEMA_A_REFORMATTED)?;
            items.reverse();
            links.reverse();
            postings.reverse();
            meta.reverse();
        }
        Variant::B => {
            c.execute_batch(SCHEMA_A)?;
            c.execute_batch(&format!("{B_EXTRA_INDEX}; {B_EXTRA_TABLE};"))?;
            user_version = 2;
            meta[1].1 = "2026-10-19T03:00:00Z";
            items[1].2 = Some("Lyon");
            items[1].3 = 250;
            items.remove(2);
            items.push(("i5", "idea", Some("西夏"), 500, "normal"));
            links.remove(1);
            links.push(("i4", "i2", "ref"));
            postings[1].2 = vec![1, 3];
        }
    }

    c.execute_batch(&format!("PRAGMA user_version = {user_version};"))?;
    for (k, v) in &meta {
        c.execute("INSERT INTO meta VALUES (?1, ?2)", (k, v))?;
    }
    for it in &items {
        c.execute("INSERT INTO items VALUES (?1, ?2, ?3, ?4, ?5)", *it)?;
    }
    for l in &links {
        c.execute("INSERT INTO links VALUES (?1, ?2, ?3)", *l)?;
    }
    for (t, d, p) in &postings {
        c.execute("INSERT INTO postings VALUES (?1, ?2, ?3)", (t, d, p))?;
    }
    // Same FTS content in the same order everywhere: its shadow tables are compared.
    for title in ["独角兽", "Paris", "café"] {
        c.execute("INSERT INTO fts(title) VALUES (?1)", [title])?;
    }
    Ok(())
}

fn text(s: &str) -> Cell {
    Cell::Text(s.to_owned())
}

/// The exact differences between [`Variant::A`] and [`Variant::B`]. Returns the
/// first mismatch as a message.
pub fn check_expected_b(d: &Diff) -> std::result::Result<(), String> {
    let pragmas = vec![super::PragmaChange {
        pragma: "user_version".into(),
        a: 1,
        b: 2,
    }];
    let only_b = |kind: &str, name: &str, sql: &str| SchemaChange::OnlyInB {
        object: SchemaObject {
            kind: kind.into(),
            name: name.into(),
            table: if kind == "index" { "items" } else { name }.into(),
            sql: Some(sql.into()),
        },
    };
    let schema = vec![
        only_b("index", "items_updated", B_EXTRA_INDEX),
        only_b("table", "extra", B_EXTRA_TABLE),
    ];
    let item_row = |id: &str, ty: &str, title: Option<&str>, updated: i64, privacy: &str| {
        vec![
            text(id),
            text(ty),
            title.map_or(Cell::Null, text),
            Cell::Integer(updated),
            text(privacy),
        ]
    };
    let names = |xs: &[&str]| xs.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    let link = |a: &str, b: &str| vec![text(a), text(b), text("ref")];
    let tables = vec![
        TableDiff {
            table: "items".into(),
            key: RowKey::PrimaryKey(names(&["id"])),
            columns: names(&["id", "type", "title", "updated", "privacy"]),
            rows_a: 4,
            rows_b: 4,
            added: 1,
            removed: 1,
            changed: 1,
            samples: vec![
                RowChange::Changed {
                    key: vec![text("i2")],
                    columns: vec![
                        ColumnChange {
                            column: "title".into(),
                            a: text("Paris"),
                            b: text("Lyon"),
                        },
                        ColumnChange {
                            column: "updated".into(),
                            a: Cell::Integer(200),
                            b: Cell::Integer(250),
                        },
                    ],
                },
                RowChange::Removed {
                    key: vec![text("i3")],
                    row: item_row("i3", "todo", None, 300, "private"),
                },
                RowChange::Added {
                    key: vec![text("i5")],
                    row: item_row("i5", "idea", Some("西夏"), 500, "normal"),
                },
            ],
        },
        TableDiff {
            table: "links".into(),
            key: RowKey::AllColumns,
            columns: names(&["src", "dst", "kind"]),
            rows_a: 3,
            rows_b: 3,
            added: 1,
            removed: 1,
            changed: 0,
            samples: vec![
                RowChange::Removed {
                    key: link("i3", "i1"),
                    row: link("i3", "i1"),
                },
                RowChange::Added {
                    key: link("i4", "i2"),
                    row: link("i4", "i2"),
                },
            ],
        },
        TableDiff {
            table: "meta".into(),
            key: RowKey::PrimaryKey(names(&["key"])),
            columns: names(&["key", "value"]),
            rows_a: 2,
            rows_b: 2,
            added: 0,
            removed: 0,
            changed: 1,
            samples: vec![RowChange::Changed {
                key: vec![text("built")],
                columns: vec![ColumnChange {
                    column: "value".into(),
                    a: text("2026-10-18T03:00:00Z"),
                    b: text("2026-10-19T03:00:00Z"),
                }],
            }],
        },
        TableDiff {
            table: "postings".into(),
            key: RowKey::PrimaryKey(names(&["term", "doc"])),
            columns: names(&["term", "doc", "pos"]),
            rows_a: 4,
            rows_b: 4,
            added: 0,
            removed: 0,
            changed: 1,
            samples: vec![RowChange::Changed {
                key: vec![text("角"), Cell::Integer(1)],
                columns: vec![ColumnChange {
                    column: "pos".into(),
                    a: Cell::Blob(vec![1, 2]),
                    b: Cell::Blob(vec![1, 3]),
                }],
            }],
        },
    ];
    if d.pragmas != pragmas {
        return Err(format!("pragmas: {:?}", d.pragmas));
    }
    if d.schema != schema {
        return Err(format!("schema: {:#?}", d.schema));
    }
    if d.tables != tables {
        return Err(format!("tables: {:#?}", d.tables));
    }
    if d.tables_skipped != ["fts"] {
        return Err(format!("skipped: {:?}", d.tables_skipped));
    }
    Ok(())
}
