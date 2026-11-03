//! Rebuildable SQLite index, custom tokenizer and Traditional/Simplified Chinese folding
//! (docs/03-modules.md M3, format spec §14). Everything here can be deleted and rebuilt from
//! the library, so nothing in it is the only copy of anything.

pub mod compare;
// Statistics and tuning switches used by the search evaluation (docs/spikes), not by the app.
#[allow(dead_code)]
mod fold;
#[allow(unsafe_code)]
mod fts5;
mod index;
#[allow(dead_code)]
mod tokenizer;

pub use index::{
    ActivityDay, Filter, Hit, INDEX_VERSION, Index, IndexError, IndexRecord, Order, Row, TagCount,
    TimeColumns,
};
