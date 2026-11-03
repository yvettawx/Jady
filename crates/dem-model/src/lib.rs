//! Data model, type definitions and flexible dates. Pure data, no IO.
//!
//! See `docs/03-modules.md` M1.

mod flexdate;
mod recur;
mod types;

use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};

pub use flexdate::{FlexDate, FlexDateError};
pub use jiff::Timestamp;
pub use recur::occurrences;
pub use types::{
    FieldDef, FieldKind, PrivacyDto, SelectOption, TypeDef, ViewKind, builtin_types, is_system_type,
};

/// Item identifier: a UUIDv7, so ids sort by creation time and can be generated
/// offline on any device without coordination.
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ItemId(uuid::Uuid);

impl ItemId {
    pub fn new() -> Self {
        Self(uuid::Uuid::now_v7())
    }

    pub fn from_uuid(u: uuid::Uuid) -> Self {
        Self(u)
    }

    pub fn as_uuid(&self) -> &uuid::Uuid {
        &self.0
    }

    pub fn as_bytes(&self) -> &[u8; 16] {
        self.0.as_bytes()
    }
}

impl Default for ItemId {
    fn default() -> Self {
        Self::new()
    }
}

/// Lowercase hyphenated form, e.g. `0192f3c4-...`.
impl fmt::Display for ItemId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.hyphenated().fmt(f)
    }
}

impl fmt::Debug for ItemId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "ItemId({self})")
    }
}

impl FromStr for ItemId {
    type Err = uuid::Error;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        uuid::Uuid::parse_str(s).map(Self)
    }
}

/// Identifier of a type definition. Built-in types use stable names (`note`, `todo`);
/// custom types use generated ids. Both share one mechanism (M1).
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct TypeId(pub String);

#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct TagId(pub String);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ItemState {
    Inbox,
    Active,
    Archived,
    Trashed,
}

/// Privacy levels (format rule, see `docs/format-spec.md`). Ordered from least to
/// most protected, so `p >= Privacy::Private` means "never visible to AI".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Privacy {
    Normal,
    Sensitive,
    Private,
    Confidential,
}

/// What kind of AI session is asking (M9, CLAUDE.md).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AiSession {
    /// 普通 content only; web on.
    Plain,
    /// 敏感 content too; web off.
    Authorized,
    /// Web on, and of 敏感 content only what the user marked 可以联网给 AI 用.
    WebAuthorized,
}

impl AiSession {
    pub fn has_web(self) -> bool {
        !matches!(self, AiSession::Authorized)
    }
}

impl Privacy {
    /// Whether AI may ever read an item at this level. Sensitive additionally
    /// requires an authorized session, which the restricted view checks.
    pub fn ai_may_read(self, session_authorized: bool) -> bool {
        match self {
            Privacy::Normal => true,
            Privacy::Sensitive => session_authorized,
            Privacy::Private | Privacy::Confidential => false,
        }
    }

    /// The whole rule, for one item in one session. 私密 and 机密: never, whatever the session.
    pub fn ai_may_read_in(self, ai_web: bool, session: AiSession) -> bool {
        match (self, session) {
            (Privacy::Normal, _) => true,
            (Privacy::Sensitive, AiSession::Authorized) => true,
            (Privacy::Sensitive, AiSession::WebAuthorized) => ai_web,
            _ => false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceOrigin {
    Me,
    AiMemory,
    AiSearch,
    Import,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceInfo {
    pub origin: SourceOrigin,
    /// "待查".
    #[serde(default)]
    pub needs_check: bool,
    /// 资料冲突: the sources disagree.
    #[serde(default)]
    pub conflict: bool,
    #[serde(default)]
    pub recheck_on: Option<FlexDate>,
    #[serde(default)]
    pub refs: Vec<String>,
}

impl Default for SourceInfo {
    fn default() -> Self {
        Self {
            origin: SourceOrigin::Me,
            needs_check: false,
            conflict: false,
            recheck_on: None,
            refs: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum TimeAnchor {
    /// Due time of a to-do.
    Due { at: Timestamp },
    /// Scheduled span; `tz` is an IANA zone name, `recurrence` an RRULE string.
    Span {
        start: Timestamp,
        end: Timestamp,
        tz: String,
        recurrence: Option<String>,
    },
    /// When something happened (journal, historical event).
    Occurred { date: FlexDate },
}

/// Who made a change; stored as change metadata in the CRDT history and used to
/// revert AI edits (M2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChangeOrigin {
    Me,
    Ai,
    Import,
}

/// The `meta` map of an item document (M1/M2). Body and type-specific fields live
/// in their own containers of the CRDT document.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ItemMeta {
    pub id: ItemId,
    pub type_id: TypeId,
    pub title: Option<String>,
    pub state: ItemState,
    pub privacy: Privacy,
    /// Domain or project the item belongs to; the hierarchy itself lives in the
    /// structure document.
    pub container: Option<ItemId>,
    #[serde(default)]
    pub tags: Vec<TagId>,
    pub created: Timestamp,
    pub updated: Timestamp,
    #[serde(default)]
    pub time: Option<TimeAnchor>,
    #[serde(default)]
    pub source: SourceInfo,
    /// 可以联网给 AI 用: only the user sets it, only meaningful on Sensitive.
    #[serde(default)]
    pub ai_web: bool,
}

/// Titles are content: Debug never prints them, so metadata can be logged safely.
impl fmt::Debug for ItemMeta {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ItemMeta")
            .field("id", &self.id)
            .field("type_id", &self.type_id)
            .field("title", &self.title.as_ref().map(|_| "[redacted]"))
            .field("state", &self.state)
            .field("privacy", &self.privacy)
            .field("container", &self.container)
            .field("tags", &self.tags.len())
            .field("created", &self.created)
            .field("updated", &self.updated)
            .finish_non_exhaustive()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn item_ids_sort_by_creation() {
        let a = ItemId::new();
        let b = ItemId::new();
        assert!(a < b);
        assert_eq!(a.as_uuid().get_version_num(), 7);
        assert_eq!(a.to_string().parse::<ItemId>().unwrap(), a);
    }

    #[test]
    fn privacy_gate() {
        assert!(Privacy::Normal.ai_may_read(false));
        assert!(!Privacy::Sensitive.ai_may_read(false));
        assert!(Privacy::Sensitive.ai_may_read(true));
        assert!(!Privacy::Private.ai_may_read(true));
        assert!(!Privacy::Confidential.ai_may_read(true));
        assert!(Privacy::Confidential > Privacy::Private);
    }

    #[test]
    fn sessions_read_only_what_they_may() {
        use AiSession::*;
        for s in [Plain, Authorized, WebAuthorized] {
            assert!(Privacy::Normal.ai_may_read_in(false, s));
            assert!(!Privacy::Private.ai_may_read_in(true, s));
            assert!(!Privacy::Confidential.ai_may_read_in(true, s));
        }
        assert!(!Privacy::Sensitive.ai_may_read_in(true, Plain));
        assert!(Privacy::Sensitive.ai_may_read_in(false, Authorized));
        assert!(!Privacy::Sensitive.ai_may_read_in(false, WebAuthorized));
        assert!(Privacy::Sensitive.ai_may_read_in(true, WebAuthorized));
        assert!(!Authorized.has_web());
        assert!(WebAuthorized.has_web());
    }

    #[test]
    fn meta_debug_hides_title() {
        let now = Timestamp::now();
        let meta = ItemMeta {
            id: ItemId::new(),
            type_id: TypeId("note".into()),
            title: Some("CANARY title".into()),
            state: ItemState::Active,
            privacy: Privacy::Normal,
            container: None,
            tags: vec![TagId("secret-tag".into())],
            created: now,
            updated: now,
            time: None,
            source: SourceInfo::default(),
            ai_web: false,
        };
        let shown = format!("{meta:?}");
        assert!(!shown.contains("CANARY"));
        assert!(!shown.contains("secret-tag"));
        let json = serde_json::to_string(&meta).unwrap();
        assert_eq!(serde_json::from_str::<ItemMeta>(&json).unwrap(), meta);
    }
}
