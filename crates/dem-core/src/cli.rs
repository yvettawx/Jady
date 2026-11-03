//! The command line (M13, F7): the same operations whether it reaches the running app over its
//! socket or opens the library itself. The user is the one asking, so writes take effect at once.
//! 私密 and 机密 stay out unless asked for; 机密 never shows a title in a list either way, as in
//! every list. The password store, when it comes, is out of reach here.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::dto::{ItemPatch, ItemView, ListQuery, NewItem};
use crate::error::CoreResult;
use crate::session::Session;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Request {
    /// New item; into the inbox unless a type is named.
    Add {
        text: String,
        #[serde(default)]
        type_id: Option<String>,
        #[serde(default)]
        due: Option<String>,
    },
    List {
        #[serde(default)]
        type_id: Option<String>,
        #[serde(default)]
        tag: Option<String>,
        #[serde(default)]
        limit: Option<u32>,
        /// Also 私密 and 机密 (without titles).
        #[serde(default)]
        all: bool,
    },
    Search {
        query: String,
        #[serde(default)]
        all: bool,
    },
    /// What is due today or overdue, and next steps.
    Today {
        #[serde(default)]
        all: bool,
    },
    Done {
        id: String,
    },
}

fn shown(item: &ItemView, all: bool) -> bool {
    all || !matches!(item.privacy.as_str(), "private" | "confidential")
}

fn brief(item: &ItemView) -> Value {
    let hide = item.privacy == "confidential";
    json!({
        "id": item.id,
        "type": item.type_id,
        "title": if hide { None } else { item.title.clone() },
        "state": item.state,
        "privacy": item.privacy,
        "due": item.due,
        "tags": item.tags,
    })
}

fn parse_due(text: &str) -> CoreResult<f64> {
    let date: jiff::civil::Date = text
        .parse()
        .map_err(|_| crate::error::CoreError::invalid("date"))?;
    let at = date
        .at(12, 0, 0, 0)
        .to_zoned(jiff::tz::TimeZone::system())
        .map_err(|_| crate::error::CoreError::invalid("date"))?;
    Ok(at.timestamp().as_millisecond() as f64)
}

pub fn handle(session: &mut Session, request: Request) -> CoreResult<Value> {
    match request {
        Request::Add { text, type_id, due } => {
            let (ty, state) = match type_id {
                Some(t) => (t, None),
                None => ("note".to_owned(), Some("inbox".to_owned())),
            };
            let fields = (ty == "todo").then(|| json!({ "status": "next" }).to_string());
            let due = due.as_deref().map(parse_due).transpose()?;
            let item = session.create_item(NewItem {
                type_id: ty,
                title: Some(text),
                state,
                container: None,
                privacy: None,
                fields,
                tags: None,
                due,
                markdown: None,
            })?;
            Ok(brief(&item))
        }
        Request::List {
            type_id,
            tag,
            limit,
            all,
        } => {
            let items = session.list_items(&ListQuery {
                type_id,
                states: Some(vec!["active".into(), "inbox".into()]),
                container: None,
                tag,
                order: Some("updated".into()),
                limit,
            })?;
            Ok(json!(
                items
                    .iter()
                    .filter(|i| shown(i, all))
                    .map(brief)
                    .collect::<Vec<_>>()
            ))
        }
        Request::Search { query, all } => {
            let hits = session.search(&query, 50)?;
            Ok(json!(
                hits.iter()
                    .filter(|h| shown(&h.item, all))
                    .map(|h| brief(&h.item))
                    .collect::<Vec<_>>()
            ))
        }
        Request::Today { all } => {
            let items = session.list_items(&ListQuery {
                type_id: Some("todo".into()),
                states: Some(vec!["active".into(), "inbox".into()]),
                container: None,
                tag: None,
                order: Some("due".into()),
                limit: None,
            })?;
            let end = jiff::Timestamp::now().as_millisecond() as f64 + 86_400_000.0;
            let status = |i: &ItemView| {
                serde_json::from_str::<Value>(&i.fields)
                    .ok()
                    .and_then(|f| f.get("status").and_then(Value::as_str).map(str::to_owned))
            };
            Ok(json!(
                items
                    .iter()
                    .filter(|i| shown(i, all))
                    .filter(|i| {
                        let s = status(i);
                        s.as_deref() != Some("done")
                            && (s.as_deref() == Some("next") || i.due.is_some_and(|d| d < end))
                    })
                    .map(brief)
                    .collect::<Vec<_>>()
            ))
        }
        Request::Done { id } => {
            let item = session.update_item(
                &id,
                ItemPatch {
                    fields: Some(json!({ "status": "done" }).to_string()),
                    ..Default::default()
                },
            )?;
            Ok(brief(&item))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::tests::open_core;

    #[test]
    fn private_and_confidential_stay_out_unless_asked_and_confidential_has_no_title() {
        let dir = tempfile::tempdir().unwrap();
        let core = open_core(dir.path());
        core.with(|s| {
            let mk = |title: &str, privacy: &str| NewItem {
                type_id: "note".into(),
                title: Some(title.into()),
                state: None,
                container: None,
                privacy: Some(privacy.into()),
                fields: None,
                tags: None,
                due: None,
                markdown: None,
            };
            s.create_item(mk("公开", "normal"))?;
            s.create_item(mk("日记", "private"))?;
            s.create_item(mk("证件", "confidential"))?;
            let list = |s: &mut Session, all| {
                handle(
                    s,
                    Request::List {
                        type_id: None,
                        tag: None,
                        limit: None,
                        all,
                    },
                )
            };
            let plain = list(s, false)?.to_string();
            assert!(plain.contains("公开"));
            assert!(!plain.contains("日记"));
            assert!(!plain.contains("证件"));
            let everything = list(s, true)?.to_string();
            assert!(everything.contains("日记"));
            assert!(!everything.contains("证件"), "{everything}");
            let found = handle(
                s,
                Request::Search {
                    query: "日记".into(),
                    all: false,
                },
            )?;
            assert_eq!(found, json!([]));
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn adds_to_the_inbox_and_finishes_a_todo() {
        let dir = tempfile::tempdir().unwrap();
        let core = open_core(dir.path());
        core.with(|s| {
            let a = handle(
                s,
                Request::Add {
                    text: "想到的事".into(),
                    type_id: None,
                    due: None,
                },
            )?;
            assert_eq!(a["state"], "inbox");
            let t = handle(
                s,
                Request::Add {
                    text: "买票".into(),
                    type_id: Some("todo".into()),
                    due: Some("2020-01-01".into()),
                },
            )?;
            let today = handle(s, Request::Today { all: false })?;
            assert!(today.to_string().contains("买票"));
            handle(
                s,
                Request::Done {
                    id: t["id"].as_str().unwrap().to_owned(),
                },
            )?;
            let today = handle(s, Request::Today { all: false })?;
            assert!(!today.to_string().contains("买票"));
            Ok(())
        })
        .unwrap();
    }
}
