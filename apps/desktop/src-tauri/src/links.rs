//! `dem://capture?text=…&url=…`: how Shortcuts, scripts and other apps hand something over (A13).
//! A link can only ever add a line to the inbox, and does nothing while the library is locked.

use dem_core::{Core, NewItem};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_deep_link::DeepLinkExt;

pub fn register<R: Runtime>(app: &AppHandle<R>) {
    let handle = app.clone();
    app.deep_link().on_open_url(move |event| {
        for url in event.urls() {
            if url.scheme() != "dem" || url.host_str() != Some("capture") {
                continue;
            }
            let get = |key: &str| {
                url.query_pairs()
                    .find(|(k, _)| k == key)
                    .map(|(_, v)| v.into_owned())
            };
            let link = get("url");
            let Some(text) = get("text").or_else(|| link.clone()) else {
                continue;
            };
            let markdown = get("text").and(link);
            let done = handle.state::<Core>().with(|s| {
                s.create_item(NewItem {
                    type_id: "note".into(),
                    title: Some(text),
                    state: Some("inbox".into()),
                    container: None,
                    privacy: None,
                    fields: None,
                    tags: None,
                    due: None,
                    markdown,
                })
            });
            match done {
                Ok(_) => {
                    let _ = handle.emit(crate::ITEMS_CHANGED, ());
                }
                Err(e) => tracing::warn!(code = %e.code, "a capture link was not taken"),
            }
        }
    });
}
