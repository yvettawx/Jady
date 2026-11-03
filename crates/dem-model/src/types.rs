//! The type system (docs/03-modules.md M1): built-in and custom types are the same thing, a
//! definition stored as data. A field's kind decides how it is shown and edited; values live in
//! the item's `fields` map.

use serde::{Deserialize, Serialize};

use crate::{Privacy, TypeId};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct SelectOption {
    pub id: String,
    pub name: String,
    /// A token name such as `info`; the interface picks the colour.
    #[serde(default)]
    pub tone: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "snake_case", tag = "type")]
pub enum FieldKind {
    Text,
    Number,
    Checkbox,
    Rating { max: u8 },
    Date,
    Url,
    Select { options: Vec<SelectOption> },
    MultiSelect { options: Vec<SelectOption> },
    Link,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct FieldDef {
    pub key: String,
    pub name: String,
    pub kind: FieldKind,
    #[serde(default)]
    pub required: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum ViewKind {
    Note,
    Table,
    Board,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct TypeDef {
    pub id: String,
    /// For built-in types this is a key in the interface's string table.
    pub name: String,
    pub builtin: bool,
    pub default_view: ViewKind,
    pub default_privacy: PrivacyDto,
    /// A `content-*` token name, or a hex colour for custom types.
    pub color: Option<String>,
    pub fields: Vec<FieldDef>,
}

/// `Privacy`, in the form that crosses to the interface.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum PrivacyDto {
    Normal,
    Sensitive,
    Private,
    Confidential,
}

impl From<Privacy> for PrivacyDto {
    fn from(p: Privacy) -> Self {
        match p {
            Privacy::Normal => PrivacyDto::Normal,
            Privacy::Sensitive => PrivacyDto::Sensitive,
            Privacy::Private => PrivacyDto::Private,
            Privacy::Confidential => PrivacyDto::Confidential,
        }
    }
}

impl From<PrivacyDto> for Privacy {
    fn from(p: PrivacyDto) -> Self {
        match p {
            PrivacyDto::Normal => Privacy::Normal,
            PrivacyDto::Sensitive => Privacy::Sensitive,
            PrivacyDto::Private => Privacy::Private,
            PrivacyDto::Confidential => Privacy::Confidential,
        }
    }
}

impl TypeDef {
    pub fn type_id(&self) -> TypeId {
        TypeId(self.id.clone())
    }
}

fn option(id: &str, tone: Option<&str>) -> SelectOption {
    SelectOption {
        id: id.to_owned(),
        // Built-in option names are string-table keys too.
        name: format!("option.{id}"),
        tone: tone.map(str::to_owned),
    }
}

fn select(key: &str, options: &[&str]) -> FieldDef {
    field(
        key,
        FieldKind::Select {
            options: options.iter().map(|o| option(o, None)).collect(),
        },
    )
}

fn field(key: &str, kind: FieldKind) -> FieldDef {
    FieldDef {
        key: key.to_owned(),
        name: format!("field.{key}"),
        kind,
        required: false,
    }
}

fn builtin(
    id: &str,
    view: ViewKind,
    privacy: PrivacyDto,
    color: Option<&str>,
    fields: Vec<FieldDef>,
) -> TypeDef {
    TypeDef {
        id: id.to_owned(),
        name: format!("type.{id}"),
        builtin: true,
        default_view: view,
        default_privacy: privacy,
        color: color.map(str::to_owned),
        fields,
    }
}

/// The app's own records. They stay out of ordinary lists and search, and the AI's restricted view
/// never hands them out as items: a proposal or a chat can quote what that session was allowed to
/// read, and that must not reach another session. A scheduled task is a prompt that will run later,
/// so an AI that could see or change one could leave instructions for its future self.
pub fn is_system_type(id: &str) -> bool {
    matches!(
        id,
        "proposal" | "ai_session" | "agreement" | "annotation" | "scheduled_task"
    )
}

/// The types a new library starts with. P1's share of M1's table: the rest arrive with the
/// modules that use them.
pub fn builtin_types() -> Vec<TypeDef> {
    use FieldKind as K;
    use PrivacyDto as P;
    use ViewKind as V;
    vec![
        builtin("note", V::Note, P::Normal, Some("note"), vec![]),
        builtin("idea", V::Note, P::Normal, Some("note"), vec![]),
        builtin(
            "diary",
            V::Note,
            P::Private,
            Some("diary"),
            vec![field("date", K::Date)],
        ),
        builtin(
            "article",
            V::Note,
            P::Normal,
            Some("file"),
            vec![field("url", K::Url), field("author", K::Text)],
        ),
        builtin("reference", V::Table, P::Normal, Some("file"), vec![]),
        builtin("file", V::Note, P::Normal, Some("file"), vec![]),
        builtin(
            "todo",
            V::Board,
            P::Normal,
            Some("todo"),
            vec![
                field(
                    "status",
                    K::Select {
                        options: vec![
                            option("next", Some("info")),
                            option("waiting", Some("warn")),
                            option("someday", None),
                            option("done", Some("ok")),
                        ],
                    },
                ),
                field("important", K::Checkbox),
                field("urgent", K::Checkbox),
            ],
        ),
        builtin(
            "card",
            V::Note,
            P::Normal,
            Some("card"),
            vec![
                field("front", K::Text),
                field("back", K::Text),
                field("review", K::Checkbox),
            ],
        ),
        builtin("domain", V::Note, P::Normal, None, vec![]),
        builtin(
            "project",
            V::Note,
            P::Normal,
            None,
            vec![
                field("goal", K::Text),
                field("deadline", K::Date),
                field("advances", K::Link),
            ],
        ),
        builtin("person", V::Table, P::Sensitive, Some("entity"), vec![]),
        // P2: organizing (M5). Everything is an ordinary item.
        builtin(
            "question",
            V::Table,
            P::Normal,
            Some("todo"),
            vec![select("status", &["open", "settled"])],
        ),
        builtin(
            "decision",
            V::Note,
            P::Normal,
            Some("todo"),
            vec![
                field("options", K::Text),
                field("thinking", K::Text),
                field("expected", K::Text),
                field("decided", K::Text),
                field("review_on", K::Date),
                field("looked_back", K::Text),
            ],
        ),
        builtin(
            "followup",
            V::Table,
            P::Normal,
            Some("todo"),
            vec![select("status", &["open", "done"])],
        ),
        builtin(
            "experience",
            V::Table,
            P::Sensitive,
            Some("entity"),
            vec![
                field("org", K::Text),
                field("role", K::Text),
                field("from", K::Text),
                field("to", K::Text),
            ],
        ),
        builtin(
            "skill",
            V::Table,
            P::Sensitive,
            Some("entity"),
            vec![field("level", K::Text)],
        ),
        builtin("document", V::Note, P::Sensitive, Some("file"), vec![]),
        builtin(
            "review",
            V::Note,
            P::Sensitive,
            Some("diary"),
            vec![
                select("period", &["day", "week", "month", "year"]),
                field("date", K::Date),
            ],
        ),
        builtin("objective", V::Note, P::Normal, Some("todo"), vec![]),
        builtin(
            "key_result",
            V::Table,
            P::Normal,
            Some("todo"),
            vec![
                field("objective", K::Link),
                select("measure", &["manual", "count", "mastery"]),
                field("current", K::Number),
                field("target", K::Number),
                field("count_type", K::Text),
                field("count_tag", K::Text),
            ],
        ),
        // P3: learning (M7).
        builtin(
            "problem",
            V::Table,
            P::Normal,
            Some("card"),
            vec![
                select("kind", &["text", "code", "choice"]),
                field("language", K::Text),
                field("answer", K::Text),
                field("tests", K::Text),
                field("origin_url", K::Url),
                field("review", K::Checkbox),
                field("wrong", K::Number),
            ],
        ),
        builtin(
            "error_pattern",
            V::Table,
            P::Normal,
            Some("card"),
            vec![field("times", K::Number)],
        ),
        builtin(
            "learning_project",
            V::Note,
            P::Normal,
            Some("project"),
            vec![
                field("goal", K::Text),
                select("aim", &["speak", "read", "exam", "know"]),
                field("deadline", K::Date),
                field("outline", K::Text),
                field("materials", K::Text),
                field("progress", K::Number),
            ],
        ),
        // System types (M6): the app's own records; see `is_system_type`.
        builtin("proposal", V::Table, P::Normal, None, vec![]),
        builtin("ai_session", V::Table, P::Normal, None, vec![]),
        builtin("agreement", V::Note, P::Normal, None, vec![]),
        builtin("annotation", V::Table, P::Normal, None, vec![]),
        builtin(
            "place",
            V::Table,
            P::Normal,
            Some("entity"),
            vec![field("lat", K::Number), field("lng", K::Number)],
        ),
        builtin("event", V::Table, P::Normal, Some("entity"), vec![]),
        // P4: the calendar and the whiteboard. A block of time keeps its to-do's due date apart.
        builtin(
            "schedule",
            V::Table,
            P::Normal,
            Some("todo"),
            vec![field("place", K::Text), field("todo", K::Link)],
        ),
        builtin("whiteboard", V::Note, P::Normal, Some("note"), vec![]),
        builtin(
            "scheduled_task",
            V::Table,
            P::Normal,
            None,
            vec![
                select("frequency", &["daily", "weekly", "monthly"]),
                field("at", K::Text),
                field("last_run", K::Text),
                field("paused", K::Checkbox),
            ],
        ),
        builtin(
            "organization",
            V::Table,
            P::Normal,
            Some("entity"),
            vec![field("url", K::Url)],
        ),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn built_in_ids_are_unique_and_todo_has_a_status() {
        let all = builtin_types();
        let mut ids: Vec<_> = all.iter().map(|t| t.id.clone()).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), all.len());
        assert!(all.iter().all(|t| t.builtin));
        let todo = all.iter().find(|t| t.id == "todo");
        assert!(todo.is_some_and(|t| t.fields.iter().any(|f| f.key == "status")));
    }

    #[test]
    fn a_definition_round_trips_through_json() {
        for t in builtin_types() {
            let s = serde_json::to_string(&t).unwrap_or_default();
            assert_eq!(serde_json::from_str::<TypeDef>(&s).ok(), Some(t));
        }
    }
}
