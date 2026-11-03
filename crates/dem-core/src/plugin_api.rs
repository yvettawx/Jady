//! What an external plugin may do with the library (docs/spikes/plugin-sandbox.md). Plugins run in a
//! sandboxed frame and reach data only through [`Session::plugin_call`], with the permissions the
//! user granted. Reads go through the same restricted view as a plain AI chat: whatever a plugin may
//! not read looks exactly like what does not exist.

use dem_model::{AiSession, Privacy, is_system_type};
use serde::Deserialize;
use serde_json::{Value as J, json};

use crate::ai_tools::NOT_FOUND;
use crate::dto::{ItemPatch, ListQuery, NewItem};
use crate::error::CoreError;
use crate::session::Session;

pub const READ: &str = "items:read";
pub const CREATE: &str = "items:create";
pub const WRITE: &str = "items:write";
/// Every permission a manifest may ask for.
pub const PERMISSIONS: [&str; 3] = [READ, CREATE, WRITE];

/// A plugin's own space in this device's settings.
pub const STORAGE_LIMIT: usize = 1024 * 1024;

const LIST_LIMIT: u32 = 200;

/// A plugin id: lowercase letters, digits and hyphens, so it is safe in paths and settings keys.
pub fn valid_id(id: &str) -> bool {
    (1..=40).contains(&id.len())
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !id.starts_with('-')
}

fn parse<T: for<'de> Deserialize<'de>>(args: &J) -> Result<T, String> {
    serde_json::from_value(args.clone()).map_err(|e| format!("invalid arguments: {e}"))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SearchArgs {
    #[serde(default)]
    query: String,
    limit: Option<u32>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ListArgs {
    type_id: Option<String>,
    tag: Option<String>,
    limit: Option<u32>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct IdArgs {
    id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct CreateArgs {
    type_id: String,
    title: Option<String>,
    markdown: Option<String>,
    tags: Option<Vec<String>>,
    fields: Option<serde_json::Map<String, J>>,
    /// `inbox` or `active`.
    state: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct UpdateArgs {
    id: String,
    title: Option<String>,
    markdown: Option<String>,
    tags: Option<Vec<String>>,
    fields: Option<serde_json::Map<String, J>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StoreArgs {
    value: J,
}

fn item_json(it: &crate::dto::ItemView) -> J {
    json!({
        "id": it.id,
        "typeId": it.type_id,
        "title": it.title,
        "tags": it.tags,
        "state": it.state,
        "created": it.created,
        "updated": it.updated,
        "fields": serde_json::from_str::<J>(&it.fields).unwrap_or(J::Null),
    })
}

impl Session {
    /// Runs one call from the plugin `plugin`, which holds `granted`. `Err` is what the plugin is
    /// told went wrong; it never says whether a hidden item exists.
    pub fn plugin_call(
        &mut self,
        plugin: &str,
        granted: &[String],
        method: &str,
        args: &J,
    ) -> Result<J, String> {
        if !valid_id(plugin) {
            return Err("not allowed".into());
        }
        let need = match method {
            "search" | "list" | "get" | "types" => Some(READ),
            "create" => Some(CREATE),
            "update" => Some(WRITE),
            "storage.get" | "storage.set" => None,
            _ => return Err(format!("no method {method}")),
        };
        if let Some(p) = need
            && !granted.iter().any(|g| g == p)
        {
            return Err(format!("this plugin was not granted {p}"));
        }
        let internal = |e: CoreError| {
            tracing::warn!(code = %e.code, "a plugin call failed");
            "something went wrong on our side".to_owned()
        };
        // The same view a plain AI chat gets: 普通 content only, no app records, nothing trashed.
        let mut view = self.ai_view(AiSession::Plain);
        match method {
            "search" => {
                let a: SearchArgs = parse(args)?;
                let hits = view
                    .search(&a.query, a.limit.unwrap_or(20).clamp(1, 50))
                    .map_err(internal)?;
                Ok(J::Array(
                    hits.iter()
                        .map(|h| {
                            let mut j = item_json(&h.item);
                            j["snippet"] = json!(h.snippet.replace(['⁅', '⁆'], ""));
                            j
                        })
                        .collect(),
                ))
            }
            "list" => {
                let a: ListArgs = parse(args)?;
                let limit = a.limit.unwrap_or(50).clamp(1, LIST_LIMIT);
                let rows = view
                    .session
                    .list_items(&ListQuery {
                        type_id: a.type_id,
                        states: Some(vec!["inbox".into(), "active".into()]),
                        container: None,
                        tag: a.tag,
                        order: Some("updated".into()),
                        limit: None,
                    })
                    .map_err(internal)?;
                let mut out = Vec::new();
                for row in rows {
                    if out.len() as u32 == limit {
                        break;
                    }
                    if let Ok(it) = view.get(&row.id) {
                        out.push(item_json(&it));
                    }
                }
                Ok(J::Array(out))
            }
            "get" => {
                let a: IdArgs = parse(args)?;
                let it = view.get(&a.id).map_err(|_| NOT_FOUND.to_owned())?;
                let mut j = item_json(&it);
                j["markdown"] = json!(view.session.body_markdown(&it.id).map_err(internal)?);
                Ok(j)
            }
            "types" => Ok(J::Array(
                self.types()
                    .into_iter()
                    .filter(|t| !is_system_type(&t.id))
                    .map(|t| {
                        json!({
                            "id": t.id,
                            "name": t.name,
                            "builtin": t.builtin,
                            "fields": t.fields.iter().map(|f| json!({ "key": f.key, "name": f.name })).collect::<Vec<_>>(),
                        })
                    })
                    .collect(),
            )),
            "create" => {
                let a: CreateArgs = parse(args)?;
                let starts = self
                    .type_def(&a.type_id)
                    .filter(|_| !is_system_type(&a.type_id))
                    .map(|t| Privacy::from(t.default_privacy))
                    .ok_or_else(|| "no such type".to_owned())?;
                // A type that starts above 普通 would hide the item from the plugin that made it,
                // and the plugin cannot choose a level: leave those to the user.
                if starts != Privacy::Normal {
                    return Err("items of this type start above the normal level".into());
                }
                let state = a.state.unwrap_or_else(|| "inbox".into());
                if state != "inbox" && state != "active" {
                    return Err("state is inbox or active".into());
                }
                let made = self
                    .create_item(NewItem {
                        type_id: a.type_id,
                        title: a.title,
                        state: Some(state),
                        container: None,
                        privacy: Some("normal".into()),
                        fields: a.fields.map(|f| J::Object(f).to_string()),
                        tags: a.tags,
                        due: None,
                        markdown: a.markdown,
                    })
                    .map_err(|e| e.message)?;
                Ok(json!({ "id": made.id }))
            }
            "update" => {
                let a: UpdateArgs = parse(args)?;
                let it = view.get(&a.id).map_err(|_| NOT_FOUND.to_owned())?;
                // Working agreements are readable, but they change only through a proposal.
                if is_system_type(&it.type_id) {
                    return Err(NOT_FOUND.into());
                }
                let patch = ItemPatch {
                    title: a.title.map(Some),
                    tags: a.tags,
                    fields: a.fields.map(|f| J::Object(f).to_string()),
                    ..Default::default()
                };
                self.update_item(&it.id, patch).map_err(|e| e.message)?;
                if let Some(md) = a.markdown {
                    self.body_set_markdown(&it.id, &md).map_err(|e| e.message)?;
                }
                Ok(json!({ "id": it.id }))
            }
            "storage.get" => Ok(self
                .local_get(&storage_key(plugin))
                .map_err(internal)?
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or(J::Null)),
            "storage.set" => {
                let a: StoreArgs = parse(args)?;
                let text = a.value.to_string();
                if text.len() > STORAGE_LIMIT {
                    return Err("more than 1 MB".into());
                }
                self.local_set(&storage_key(plugin), &text)
                    .map_err(internal)?;
                Ok(J::Null)
            }
            _ => Err(format!("no method {method}")),
        }
    }
}

fn storage_key(plugin: &str) -> String {
    format!("plugin-data-{plugin}")
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use crate::dto::NewItem;
    use crate::session::tests::{new_note, open_core};

    fn all() -> Vec<String> {
        PERMISSIONS.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn ids_are_safe_in_paths_and_keys() {
        assert!(valid_id("word-count"));
        assert!(valid_id("a1"));
        for bad in ["", "-x", "A", "a/b", "..", "a b", "a_b", &"x".repeat(41)] {
            assert!(!valid_id(bad), "{bad}");
        }
    }

    #[test]
    fn a_plugin_reads_only_normal_content_and_only_with_the_permission() {
        let d = tempfile::tempdir().unwrap();
        let c = open_core(d.path());
        c.with(|s| {
            let make = |s: &mut Session, level: &str, title: &str| {
                s.create_item(NewItem {
                    privacy: Some(level.into()),
                    markdown: Some("插件用的词\n".into()),
                    ..new_note(title)
                })
                .map(|i| i.id)
            };
            let normal = make(s, "normal", "普通")?;
            let hidden: Vec<String> = ["sensitive", "private", "confidential"]
                .iter()
                .map(|l| make(s, l, l))
                .collect::<Result<_, _>>()?;

            assert!(
                s.plugin_call("p", &[], "search", &json!({ "query": "插件用的词" }))
                    .is_err()
            );
            let found = s
                .plugin_call("p", &all(), "search", &json!({ "query": "插件用的词" }))
                .unwrap();
            let ids: Vec<&str> = found
                .as_array()
                .unwrap()
                .iter()
                .map(|h| h["id"].as_str().unwrap())
                .collect();
            assert_eq!(ids, vec![normal.as_str()]);
            let listed = s.plugin_call("p", &all(), "list", &json!({})).unwrap();
            assert!(
                listed
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(|i| !hidden.contains(&i["id"].as_str().unwrap().to_owned()))
            );

            let got = s
                .plugin_call("p", &all(), "get", &json!({ "id": normal }))
                .unwrap();
            assert!(got["markdown"].as_str().unwrap().contains("插件用的词"));
            let missing = s
                .plugin_call(
                    "p",
                    &all(),
                    "get",
                    &json!({ "id": "019a0000-0000-7000-8000-000000000000" }),
                )
                .unwrap_err();
            for id in &hidden {
                // The same answer as for something that does not exist.
                assert_eq!(
                    s.plugin_call("p", &all(), "get", &json!({ "id": id }))
                        .unwrap_err(),
                    missing
                );
                assert_eq!(
                    s.plugin_call("p", &all(), "update", &json!({ "id": id, "title": "x" }))
                        .unwrap_err(),
                    missing
                );
            }
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn writes_stay_inside_what_was_granted() {
        let d = tempfile::tempdir().unwrap();
        let c = open_core(d.path());
        c.with(|s| {
            let read = vec![READ.to_owned()];
            let made = s
                .plugin_call(
                    "p",
                    &all(),
                    "create",
                    &json!({ "typeId": "note", "title": "插件建的" }),
                )
                .unwrap();
            let id = made["id"].as_str().unwrap().to_owned();
            let it = s.get_item(&id)?;
            assert_eq!(
                (it.privacy.as_str(), it.state.as_str()),
                ("normal", "inbox")
            );
            assert!(
                s.plugin_call("p", &read, "create", &json!({ "typeId": "note" }))
                    .is_err()
            );
            assert!(
                s.plugin_call("p", &all(), "create", &json!({ "typeId": "proposal" }))
                    .is_err()
            );
            assert!(
                s.plugin_call(
                    "p",
                    &all(),
                    "create",
                    &json!({ "typeId": "note", "state": "trashed" })
                )
                .is_err()
            );
            // Nothing in the arguments reaches privacy, state or the container.
            assert!(
                s.plugin_call(
                    "p",
                    &all(),
                    "create",
                    &json!({ "typeId": "note", "privacy": "private" })
                )
                .is_err()
            );
            assert!(
                s.plugin_call(
                    "p",
                    &all(),
                    "update",
                    &json!({ "id": id, "privacy": "normal" })
                )
                .is_err()
            );
            assert!(
                s.plugin_call(
                    "p",
                    &all(),
                    "update",
                    &json!({ "id": id, "state": "trashed" })
                )
                .is_err()
            );

            assert!(
                s.plugin_call("p", &read, "update", &json!({ "id": id, "title": "x" }))
                    .is_err()
            );
            s.plugin_call(
                "p",
                &all(),
                "update",
                &json!({ "id": id, "title": "改过的", "markdown": "新的正文\n", "tags": ["插件"] }),
            )
            .unwrap();
            let it = s.get_item(&id)?;
            assert_eq!(it.title.as_deref(), Some("改过的"));
            assert_eq!(it.tags, vec!["插件".to_owned()]);
            assert!(s.body_markdown(&id)?.contains("新的正文"));
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn each_plugin_has_its_own_small_storage() {
        let d = tempfile::tempdir().unwrap();
        let c = open_core(d.path());
        c.with(|s| {
            assert_eq!(
                s.plugin_call("a", &[], "storage.get", &json!({})).unwrap(),
                J::Null
            );
            s.plugin_call("a", &[], "storage.set", &json!({ "value": { "n": 1 } }))
                .unwrap();
            assert_eq!(
                s.plugin_call("a", &[], "storage.get", &json!({})).unwrap(),
                json!({ "n": 1 })
            );
            assert_eq!(
                s.plugin_call("b", &[], "storage.get", &json!({})).unwrap(),
                J::Null
            );
            let big = "x".repeat(STORAGE_LIMIT);
            assert!(
                s.plugin_call("a", &[], "storage.set", &json!({ "value": big }))
                    .is_err()
            );
            assert!(
                s.plugin_call("../x", &[], "storage.get", &json!({}))
                    .is_err()
            );
            Ok(())
        })
        .unwrap();
    }
}
