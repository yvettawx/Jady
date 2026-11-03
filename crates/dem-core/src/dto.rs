//! What crosses to the interface. Times are milliseconds since the epoch as `f64`, because that is
//! what JavaScript has; dates are "yyyy-mm-dd". Debug leaves titles and bodies out.

use dem_index::Row;
use serde::{Deserialize, Serialize};

/// A key that is there, even with `null`, counts: `null` clears and leaving the key out keeps.
fn present<'de, T, D>(d: D) -> Result<Option<Option<T>>, D::Error>
where
    T: Deserialize<'de>,
    D: serde::Deserializer<'de>,
{
    Option::<T>::deserialize(d).map(Some)
}

macro_rules! dto {
    ($(#[$m:meta])* pub struct $name:ident { $($body:tt)* }) => {
        $(#[$m])*
        #[derive(Clone, PartialEq, Serialize, Deserialize)]
        #[cfg_attr(feature = "specta", derive(specta::Type))]
        #[serde(rename_all = "camelCase")]
        pub struct $name { $($body)* }
    };
}

macro_rules! redacted_debug {
    ($($name:ident),*) => {$(
        impl std::fmt::Debug for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.debug_struct(stringify!($name)).finish_non_exhaustive()
            }
        }
    )*};
}

dto! {
    pub struct LibraryRef {
        pub name: String,
        pub path: String,
    }
}

dto! {
    /// What to show when the app starts.
    pub struct StartState {
        /// `first-run`, `unlock`, `missing` or `broken`.
        pub mode: String,
        pub library: Option<LibraryRef>,
        pub details: Option<String>,
        pub default_location: String,
    }
}

dto! {
    pub struct SourceView {
        /// `mine`, `aiMemory`, `aiSearch` or `import`.
        pub origin: String,
        pub needs_check: bool,
        pub conflict: bool,
        pub recheck_on: Option<String>,
        pub refs: Vec<String>,
    }
}

dto! {
    pub struct ItemView {
        pub id: String,
        pub type_id: String,
        pub title: Option<String>,
        /// `inbox`, `active`, `archived` or `trashed`.
        pub state: String,
        /// `normal`, `sensitive`, `private` or `confidential`.
        pub privacy: String,
        pub ai_web: bool,
        pub container: Option<String>,
        pub created: f64,
        pub updated: f64,
        pub due: Option<f64>,
        /// When it happened, for items that say so.
        pub occurred: Option<String>,
        /// When it is scheduled.
        pub span: Option<SpanView>,
        pub tags: Vec<String>,
        /// The type's fields, as a JSON object.
        pub fields: String,
        pub preview: String,
        pub source: Option<SourceView>,
    }
}

dto! {
    /// Times are milliseconds; `tz` an IANA name; `recurrence` an RRULE string.
    pub struct SpanView {
        pub start: f64,
        pub end: f64,
        pub tz: String,
        pub recurrence: Option<String>,
    }
}

dto! {
    /// What one round of sync did. `items` are the ones to refresh on screen.
    pub struct SyncSummary {
        pub uploaded: u32,
        pub downloaded: u32,
        pub merged: u32,
        pub deleted: u32,
        pub items: Vec<String>,
    }
}

dto! {
    /// One occurrence on the calendar.
    pub struct AgendaEntry {
        pub item: ItemView,
        pub start: f64,
        pub end: f64,
    }
}

dto! {
    /// A place on the timeline: `when` as it was written, `key` for sorting.
    pub struct TimelineEntry {
        pub item: ItemView,
        pub when: String,
        pub key: f64,
    }
}

impl From<Row> for ItemView {
    fn from(r: Row) -> Self {
        ItemView {
            id: r.id,
            type_id: r.type_id,
            title: r.title,
            state: r.state,
            privacy: r.privacy,
            ai_web: false,
            container: r.container,
            created: r.created as f64,
            updated: r.updated as f64,
            due: r.due.map(|d| d as f64),
            occurred: r.time.occurred.clone(),
            span: match (r.time.start, r.time.end) {
                (Some(start), Some(end)) => Some(SpanView {
                    start: start as f64,
                    end: end as f64,
                    tz: r.time.tz.clone().unwrap_or_default(),
                    recurrence: r.time.recurrence.clone(),
                }),
                _ => None,
            },
            tags: r.tags,
            fields: r.fields,
            preview: r.preview,
            source: None,
        }
    }
}

dto! {
    pub struct NewItem {
        pub type_id: String,
        pub title: Option<String>,
        /// Defaults to `active`; the quick capture passes `inbox`.
        pub state: Option<String>,
        pub container: Option<String>,
        pub privacy: Option<String>,
        pub fields: Option<String>,
        pub tags: Option<Vec<String>>,
        pub due: Option<f64>,
        /// Plain text or Markdown for the body.
        pub markdown: Option<String>,
    }
}

dto! {
    /// Only what is set changes. An inner `None` clears the value.
    #[derive(Default)]
    pub struct ItemPatch {
        #[serde(default, deserialize_with = "present")]
        #[cfg_attr(feature = "specta", specta(type = Option<String>))]
        pub title: Option<Option<String>>,
        pub state: Option<String>,
        pub privacy: Option<String>,
        pub ai_web: Option<bool>,
        #[serde(default, deserialize_with = "present")]
        #[cfg_attr(feature = "specta", specta(type = Option<String>))]
        pub container: Option<Option<String>>,
        #[serde(default, deserialize_with = "present")]
        #[cfg_attr(feature = "specta", specta(type = Option<f64>))]
        pub due: Option<Option<f64>>,
        pub tags: Option<Vec<String>>,
        /// When it happened, as typed: `公元前221年`, `约1500年3月`, `1200 至 1300`.
        #[serde(default, deserialize_with = "present")]
        #[cfg_attr(feature = "specta", specta(type = Option<String>))]
        pub occurred: Option<Option<String>>,
        #[serde(default, deserialize_with = "present")]
        #[cfg_attr(feature = "specta", specta(type = Option<SpanView>))]
        pub span: Option<Option<SpanView>>,
        /// JSON object of field keys to set; `null` removes a value.
        pub fields: Option<String>,
        pub source: Option<SourceView>,
    }
}

dto! {
    pub struct ListQuery {
        pub type_id: Option<String>,
        pub states: Option<Vec<String>>,
        pub container: Option<String>,
        pub tag: Option<String>,
        /// `updated`, `created`, `due` or `title`.
        pub order: Option<String>,
        pub limit: Option<u32>,
    }
}

dto! {
    pub struct SearchHit {
        pub item: ItemView,
        /// A piece of the body; what matched is between ⁅ and ⁆.
        pub snippet: String,
    }
}

dto! {
    pub struct TreeNode {
        pub id: String,
        /// `domain` or `project`.
        pub kind: String,
        pub parent: Option<String>,
        pub title: Option<String>,
        pub privacy: String,
        pub state: String,
    }
}

dto! {
    pub struct TagCount {
        pub tag: String,
        pub count: u32,
    }
}

dto! {
    pub struct ActivityDay {
        pub date: String,
        pub type_id: String,
        pub count: u32,
    }
}

dto! {
    /// Something that wants attention today.
    pub struct Reminder {
        pub id: String,
        pub title: Option<String>,
        /// `overdue`, `today` or `recheck`.
        pub kind: String,
        pub when: Option<f64>,
    }
}

dto! {
    pub struct GraphData {
        pub items: Vec<ItemView>,
        pub links: Vec<(String, String)>,
    }
}

dto! {
    /// One point in an item's history that can be looked at again.
    pub struct VersionView {
        pub version: String,
        pub at: f64,
        pub label: Option<String>,
        /// `me`, `ai`, `import` or `system`.
        pub origin: String,
    }
}

dto! {
    pub struct ImportResult {
        pub type_id: Option<String>,
        pub created: u32,
        pub skipped: u32,
    }
}

dto! {
    pub struct ExportResult {
        pub path: String,
        pub items: u32,
        pub skipped_confidential: u32,
    }
}

dto! {
    /// What the user's own search finds that a session would not, and why.
    pub struct HiddenHit {
        pub hit: SearchHit,
        /// `private`, `confidential`, `sensitive`, `not-web` (sensitive, not marked for the web)
        /// or `trashed`.
        pub reason: String,
    }
}

dto! {
    /// The "what AI can find" page: what `search` would hand a session of one kind, beside what
    /// it would not.
    pub struct AiSearchPreview {
        pub shown: Vec<SearchHit>,
        pub hidden: Vec<HiddenHit>,
    }
}

redacted_debug!(
    HiddenHit,
    AiSearchPreview,
    SyncSummary,
    SpanView,
    AgendaEntry,
    TimelineEntry,
    LibraryRef,
    StartState,
    SourceView,
    ItemView,
    NewItem,
    ItemPatch,
    ListQuery,
    SearchHit,
    TreeNode,
    TagCount,
    ActivityDay,
    Reminder,
    GraphData,
    VersionView,
    ImportResult,
    ExportResult
);
