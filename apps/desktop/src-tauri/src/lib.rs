//! Tauri shell: exposes dem-core to the React UI as commands and events.
//! No business logic lives here.

mod ai;
mod browser;
mod capture;
mod coderun;
mod compile;
#[cfg(feature = "e2e")]
pub mod e2e;
mod git;
mod keychain;
mod links;
mod local_cli;
mod plugins;
mod quit;
mod sync;
mod system;
mod vault;

use dem_core::learn::{DueCard, MasteryGroup, ReviewInput};
use dem_core::{
    ActivityDay, AgendaEntry, AppInfo, Core, CoreError, ExportResult, GraphData, ImportResult,
    ItemPatch, ItemView, LibraryRef, ListQuery, NewItem, Reminder, SearchHit, StartState, TagCount,
    TimelineEntry, TreeNode, TypeDef, VersionView,
};
use tauri::{Emitter, Manager, State};
use tauri_specta::{Builder, collect_commands};

type R<T> = Result<T, CoreError>;

/// The interface refreshes its lists when this fires: an item changed, possibly in another window.
const ITEMS_CHANGED: &str = "items-changed";

/// Tells every window; held as state so commands need not name the runtime.
struct Changes(std::sync::Arc<dyn Fn() + Send + Sync>);

impl Changes {
    fn fire(&self) {
        (self.0)();
    }

    /// For what finishes on another thread.
    fn handle(&self) -> std::sync::Arc<dyn Fn() + Send + Sync> {
        self.0.clone()
    }
}

#[tauri::command]
#[specta::specta]
fn app_info() -> AppInfo {
    dem_core::app_info()
}

/// The system's accessibility display settings. The UI asks again whenever the window
/// regains focus, so a change made in System Settings shows up on return.
#[tauri::command]
#[specta::specta]
fn system_appearance() -> system::SystemAppearance {
    system::appearance()
}

// ---- the library ----------------------------------------------------------------------------

#[tauri::command(async)]
#[specta::specta]
fn library_start(core: State<'_, Core>) -> StartState {
    core.start_state()
}

/// Makes the library under a temporary name; returns the recovery code to show once.
#[tauri::command(async)]
#[specta::specta]
fn library_prepare(
    core: State<'_, Core>,
    name: String,
    dir: String,
    password: String,
) -> R<String> {
    core.prepare_library(&name, &dir, &password)
}

#[tauri::command(async)]
#[specta::specta]
fn library_commit(core: State<'_, Core>) -> R<()> {
    core.commit_library()
}

#[tauri::command(async)]
#[specta::specta]
fn library_cancel(core: State<'_, Core>) {
    core.cancel_library();
}

#[tauri::command(async)]
#[specta::specta]
fn library_unlock_keychain(core: State<'_, Core>, path: String) -> R<bool> {
    core.unlock_keychain(&path)
}

#[tauri::command(async)]
#[specta::specta]
fn library_unlock_password(core: State<'_, Core>, path: String, password: String) -> R<bool> {
    core.unlock_password(&path, &password)
}

#[tauri::command(async)]
#[specta::specta]
fn library_recover(
    core: State<'_, Core>,
    path: String,
    code: String,
    new_password: String,
) -> R<bool> {
    core.recover(&path, &code, &new_password)
}

#[tauri::command(async)]
#[specta::specta]
fn library_adopt(core: State<'_, Core>, path: String) -> R<LibraryRef> {
    core.adopt_library(&path)
}

/// The interface's own problems go in the local diagnostic log (M0). Only a short line: an error's
/// name and message, never content, and it is cut short in case one quotes something.
#[tauri::command(async)]
#[specta::specta]
fn diag(line: String) {
    let short: String = line.chars().take(200).collect();
    tracing::warn!(target: "interface", line = %short);
}

/// Saves text where the user chose in a save dialog: the recovery code, nothing from the library.
#[tauri::command(async)]
#[specta::specta]
fn file_write_text(path: String, text: String) -> R<()> {
    std::fs::write(&path, text).map_err(|e| CoreError {
        code: "io".into(),
        message: e.to_string(),
    })
}

/// A link clicked in the text opens in the browser. Only web links and mail: never local files.
#[tauri::command(async)]
#[specta::specta]
fn open_external(url: String) -> R<()> {
    let allowed = ["http://", "https://", "mailto:"]
        .iter()
        .any(|s| url.to_ascii_lowercase().starts_with(s));
    if !allowed {
        return Err(CoreError {
            code: "invalid".into(),
            message: "not a web link".into(),
        });
    }
    std::process::Command::new("open")
        .arg(&url)
        .status()
        .map_err(|e| CoreError {
            code: "io".into(),
            message: e.to_string(),
        })?;
    Ok(())
}

#[tauri::command(async)]
#[specta::specta]
fn library_lock(core: State<'_, Core>) -> R<()> {
    core.lock()
}

#[tauri::command(async)]
#[specta::specta]
fn library_is_open(core: State<'_, Core>) -> bool {
    core.is_open()
}

#[tauri::command(async)]
#[specta::specta]
fn library_path(core: State<'_, Core>) -> R<String> {
    core.with(|s| Ok(s.library_path()))
}

/// 机密内容打开前再验证: the master password, checked without closing anything.
#[tauri::command(async)]
#[specta::specta]
fn verify_password(core: State<'_, Core>, password: String) -> R<bool> {
    core.with(|s| Ok(s.verify_password(&password)))
}

// ---- items ----------------------------------------------------------------------------------

#[tauri::command(async)]
#[specta::specta]
fn item_create(changes: State<'_, Changes>, core: State<'_, Core>, item: NewItem) -> R<ItemView> {
    let v = core.with(|s| s.create_item(item))?;
    changes.fire();
    Ok(v)
}

#[tauri::command(async)]
#[specta::specta]
fn item_get(core: State<'_, Core>, id: String) -> R<ItemView> {
    core.with(|s| s.get_item(&id))
}

#[tauri::command(async)]
#[specta::specta]
fn item_update(
    changes: State<'_, Changes>,
    core: State<'_, Core>,
    id: String,
    patch: ItemPatch,
) -> R<ItemView> {
    let v = core.with(|s| s.update_item(&id, patch))?;
    changes.fire();
    Ok(v)
}

#[tauri::command(async)]
#[specta::specta]
fn item_purge(changes: State<'_, Changes>, core: State<'_, Core>, id: String) -> R<()> {
    core.with(|s| s.purge_item(&id))?;
    changes.fire();
    Ok(())
}

#[tauri::command(async)]
#[specta::specta]
fn trash_empty(changes: State<'_, Changes>, core: State<'_, Core>) -> R<u32> {
    let n = core.with(|s| s.empty_trash())?;
    changes.fire();
    Ok(n)
}

#[tauri::command(async)]
#[specta::specta]
fn item_list(core: State<'_, Core>, query: ListQuery) -> R<Vec<ItemView>> {
    core.with(|s| s.list_items(&query))
}

#[tauri::command(async)]
#[specta::specta]
fn directory_list(core: State<'_, Core>) -> R<Vec<ItemView>> {
    core.with(|s| s.directory_titles())
}

#[tauri::command(async)]
#[specta::specta]
fn search(core: State<'_, Core>, query: String, limit: u32) -> R<Vec<SearchHit>> {
    core.with(|s| s.search(&query, limit))
}

#[tauri::command(async)]
#[specta::specta]
fn backlinks(core: State<'_, Core>, id: String) -> R<Vec<ItemView>> {
    core.with(|s| s.backlinks(&id))
}

#[tauri::command(async)]
#[specta::specta]
fn tag_list(core: State<'_, Core>) -> R<Vec<TagCount>> {
    core.with(|s| s.tags())
}

#[tauri::command(async)]
#[specta::specta]
fn activity_since(core: State<'_, Core>, day: String) -> R<Vec<ActivityDay>> {
    core.with(|s| s.activity_since(&day))
}

#[tauri::command(async)]
#[specta::specta]
fn canvas_get(core: State<'_, Core>, id: String) -> R<std::collections::HashMap<String, String>> {
    core.with(|s| s.canvas(&id))
}

#[tauri::command(async)]
#[specta::specta]
fn canvas_update(
    core: State<'_, Core>,
    id: String,
    changes: std::collections::HashMap<String, Option<String>>,
) -> R<()> {
    core.with(|s| s.canvas_update(&id, changes))
}

#[tauri::command(async)]
#[specta::specta]
fn git_activity(core: State<'_, Core>, day: String) -> R<Vec<ActivityDay>> {
    let repos = git::repos(&core)?;
    Ok(git::activity(&repos, &day))
}

#[tauri::command(async)]
#[specta::specta]
fn git_digest(core: State<'_, Core>, days: u32) -> R<String> {
    let repos = git::repos(&core)?;
    Ok(git::digest(&repos, days))
}

#[tauri::command(async)]
#[specta::specta]
fn agenda(core: State<'_, Core>, from: f64, to: f64) -> R<Vec<AgendaEntry>> {
    core.with(|s| s.agenda(from, to))
}

#[tauri::command(async)]
#[specta::specta]
fn timeline(core: State<'_, Core>, type_id: Option<String>) -> R<Vec<TimelineEntry>> {
    core.with(|s| s.timeline(type_id.as_deref()))
}

#[tauri::command(async)]
#[specta::specta]
fn reminder_list(core: State<'_, Core>) -> R<Vec<Reminder>> {
    core.with(|s| s.reminders())
}

#[tauri::command(async)]
#[specta::specta]
fn graph_data(core: State<'_, Core>) -> R<GraphData> {
    core.with(|s| s.graph())
}

// ---- the body and its versions ---------------------------------------------------------------

#[tauri::command(async)]
#[specta::specta]
fn body_open(core: State<'_, Core>, id: String) -> R<String> {
    core.with(|s| s.open_body(&id))
}

#[tauri::command(async)]
#[specta::specta]
fn body_apply(
    changes: State<'_, Changes>,
    core: State<'_, Core>,
    id: String,
    update: String,
) -> R<ItemView> {
    let v = core.with(|s| s.apply_body(&id, &update))?;
    changes.fire();
    Ok(v)
}

#[tauri::command(async)]
#[specta::specta]
fn body_words(core: State<'_, Core>, id: String) -> R<u32> {
    core.with(|s| s.body_words(&id))
}

#[tauri::command(async)]
#[specta::specta]
fn version_list(core: State<'_, Core>, id: String) -> R<Vec<VersionView>> {
    core.with(|s| s.history(&id))
}

#[tauri::command(async)]
#[specta::specta]
fn version_text(core: State<'_, Core>, id: String, version: String) -> R<Vec<String>> {
    core.with(|s| s.version_text(&id, &version))
}

#[tauri::command(async)]
#[specta::specta]
fn version_restore(
    changes: State<'_, Changes>,
    core: State<'_, Core>,
    id: String,
    version: String,
    before: String,
) -> R<ItemView> {
    let view = core.with(|s| s.restore_version(&id, &version, &before))?;
    changes.fire();
    Ok(view)
}

#[tauri::command(async)]
#[specta::specta]
fn version_name(core: State<'_, Core>, id: String, version: String, name: String) -> R<()> {
    core.with(|s| s.name_version(&id, &version, &name))
}

// ---- structure and types ----------------------------------------------------------------------

#[tauri::command(async)]
#[specta::specta]
fn tree_list(core: State<'_, Core>) -> R<Vec<TreeNode>> {
    core.with(|s| s.tree())
}

#[tauri::command(async)]
#[specta::specta]
fn tree_move(
    changes: State<'_, Changes>,
    core: State<'_, Core>,
    id: String,
    parent: Option<String>,
) -> R<()> {
    core.with(|s| s.move_node(&id, parent.as_deref()))?;
    changes.fire();
    Ok(())
}

#[tauri::command(async)]
#[specta::specta]
fn type_list(core: State<'_, Core>) -> R<Vec<TypeDef>> {
    core.with(|s| Ok(s.types()))
}

#[tauri::command(async)]
#[specta::specta]
fn type_save(changes: State<'_, Changes>, core: State<'_, Core>, def: TypeDef) -> R<TypeDef> {
    let v = core.with(|s| s.save_type(def))?;
    changes.fire();
    Ok(v)
}

// ---- files, settings, in and out --------------------------------------------------------------

#[tauri::command(async)]
#[specta::specta]
fn blob_put(core: State<'_, Core>, data: String) -> R<String> {
    core.with(|s| s.put_blob(&data))
}

#[tauri::command(async)]
#[specta::specta]
fn blob_get(core: State<'_, Core>, name: String) -> R<String> {
    core.with(|s| s.get_blob(&name))
}

#[tauri::command(async)]
#[specta::specta]
fn local_get(core: State<'_, Core>, key: String) -> R<Option<String>> {
    core.with(|s| s.local_get(&key))
}

#[tauri::command(async)]
#[specta::specta]
fn local_set(core: State<'_, Core>, key: String, value: String) -> R<()> {
    core.with(|s| s.local_set(&key, &value))
}

#[tauri::command(async)]
#[specta::specta]
fn import_table(
    changes: State<'_, Changes>,
    core: State<'_, Core>,
    path: String,
    type_name: String,
) -> R<ImportResult> {
    let r = core.with(|s| s.import_table(&path, &type_name))?;
    changes.fire();
    Ok(r)
}

#[tauri::command(async)]
#[specta::specta]
fn review_queue(core: State<'_, Core>, limit: u32) -> R<Vec<DueCard>> {
    core.with(|s| s.review_queue(limit))
}

#[tauri::command(async)]
#[specta::specta]
fn practice_queue(core: State<'_, Core>, limit: u32) -> R<Vec<DueCard>> {
    core.with(|s| s.practice_queue(limit))
}

#[tauri::command(async)]
#[specta::specta]
fn recite_due(core: State<'_, Core>, item: String, lines: u32) -> R<Vec<bool>> {
    core.with(|s| Ok(s.recite_due(&item, lines)))
}

#[tauri::command(async)]
#[specta::specta]
fn review_record(core: State<'_, Core>, input: ReviewInput) -> R<()> {
    core.with(|s| s.record_review(&input))
}

#[tauri::command(async)]
#[specta::specta]
fn mastery_overview(core: State<'_, Core>) -> R<Vec<MasteryGroup>> {
    core.with(|s| s.mastery_overview())
}

#[tauri::command(async)]
#[specta::specta]
fn mastery_of(core: State<'_, Core>, tag: String) -> R<Option<f64>> {
    core.with(|s| s.mastery_of(&tag))
}

/// 间隙日志: one more line at the end of an item's text.
#[tauri::command(async)]
#[specta::specta]
fn body_append(
    changes: State<'_, Changes>,
    core: State<'_, Core>,
    id: String,
    line: String,
) -> R<ItemView> {
    let view = core.with(|s| s.body_append(&id, &line))?;
    changes.fire();
    Ok(view)
}

#[tauri::command(async)]
#[specta::specta]
fn body_set_markdown(
    changes: State<'_, Changes>,
    core: State<'_, Core>,
    id: String,
    markdown: String,
) -> R<ItemView> {
    let view = core.with(|s| s.body_set_markdown(&id, &markdown))?;
    changes.fire();
    Ok(view)
}

#[tauri::command(async)]
#[specta::specta]
fn body_markdown(core: State<'_, Core>, id: String) -> R<String> {
    core.with(|s| s.body_markdown(&id))
}

/// 截图: the system's own area picker; nothing is kept if the user cancels it.
#[tauri::command(async)]
#[specta::specta]
fn capture_screenshot(
    changes: State<'_, Changes>,
    core: State<'_, Core>,
    title: String,
) -> R<Option<ItemView>> {
    let dir = core.with(|s| Ok(std::path::PathBuf::from(s.library_path()).join("tmp")))?;
    let io = |e: std::io::Error| CoreError {
        code: "io".into(),
        message: e.to_string(),
    };
    std::fs::create_dir_all(&dir).map_err(io)?;
    let path = dir.join("capture.png");
    let _ = std::fs::remove_file(&path);
    std::process::Command::new("screencapture")
        .args(["-i", "-x"])
        .arg(&path)
        .status()
        .map_err(io)?;
    if !path.exists() {
        return Ok(None);
    }
    let view = core.with(|s| s.capture_image(&path.to_string_lossy(), &title));
    let _ = std::fs::remove_file(&path);
    changes.fire();
    view.map(Some)
}

/// 网页链接: what the page says goes into the inbox. Public web only.
#[tauri::command(async)]
#[specta::specta]
fn capture_url(changes: State<'_, Changes>, core: State<'_, Core>, url: String) -> R<ItemView> {
    let page = dem_core::fetch_page(&url).map_err(|e| CoreError {
        code: "fetch".into(),
        message: e.to_string(),
    })?;
    let view = core.with(|s| s.capture_page(&url, &page))?;
    changes.fire();
    Ok(view)
}

#[tauri::command(async)]
#[specta::specta]
fn import_files(
    changes: State<'_, Changes>,
    core: State<'_, Core>,
    paths: Vec<String>,
) -> R<ImportResult> {
    let r = core.with(|s| s.import_files(&paths))?;
    changes.fire();
    Ok(r)
}

#[tauri::command(async)]
#[specta::specta]
fn blob_save(core: State<'_, Core>, name: String, path: String) -> R<()> {
    core.with(|s| s.save_blob(&name, &path))
}

#[tauri::command(async)]
#[specta::specta]
fn import_markdown(
    changes: State<'_, Changes>,
    core: State<'_, Core>,
    paths: Vec<String>,
) -> R<ImportResult> {
    let r = core.with(|s| s.import_markdown(&paths))?;
    changes.fire();
    Ok(r)
}

#[tauri::command(async)]
#[specta::specta]
fn export_item(core: State<'_, Core>, id: String, path: String) -> R<()> {
    core.with(|s| s.export_item(&id, &path))
}

#[tauri::command(async)]
#[specta::specta]
fn export_all(core: State<'_, Core>, dir: String, include_confidential: bool) -> R<ExportResult> {
    core.with(|s| s.export_all(&dir, include_confidential))
}

#[tauri::command(async)]
#[specta::specta]
fn index_rebuild(changes: State<'_, Changes>, core: State<'_, Core>) -> R<u32> {
    let n = core.with(|s| s.rebuild_index())?;
    changes.fire();
    Ok(n)
}

/// All commands the UI may call. The TypeScript bindings are generated from this list.
pub fn specta_builder<R: tauri::Runtime>() -> Builder<R> {
    Builder::<R>::new().commands(collect_commands![
        app_info,
        system_appearance,
        library_start,
        library_prepare,
        library_commit,
        library_cancel,
        library_unlock_keychain,
        library_unlock_password,
        library_recover,
        library_adopt,
        library_lock,
        diag,
        ai::ai_status,
        ai::ai_search_preview,
        ai::ai_settings_set,
        ai::ai_key_set,
        ai::ai_start,
        ai::ai_send,
        ai::ai_stop,
        ai::ai_close_turn,
        ai::ai_task_prompt,
        ai::ai_end,
        ai::ai_place,
        ai::proposal_list,
        ai::proposal_confirm,
        ai::proposal_ignore,
        ai::proposal_undo,
        ai::code_check,
        ai::code_run,
        browser::browser_settings,
        browser::browser_settings_set,
        browser::browser_status,
        browser::browser_show,
        browser::browser_decide,
        plugins::plugin_list,
        plugins::plugin_enable,
        plugins::plugin_disable,
        plugins::plugin_install,
        plugins::plugin_remove,
        plugins::plugin_folder,
        plugins::plugin_call,
        review_queue,
        practice_queue,
        recite_due,
        review_record,
        mastery_overview,
        mastery_of,
        body_append,
        body_set_markdown,
        body_markdown,
        capture_screenshot,
        capture_url,
        file_write_text,
        open_external,
        library_is_open,
        library_path,
        verify_password,
        item_create,
        item_get,
        item_update,
        item_purge,
        trash_empty,
        item_list,
        directory_list,
        search,
        backlinks,
        tag_list,
        activity_since,
        agenda,
        timeline,
        sync::sync_target,
        sync::sync_connect,
        sync::sync_disconnect,
        sync::sync_run,
        sync::sync_join,
        vault::vault_status,
        vault::vault_create,
        vault::vault_unlock,
        vault::vault_lock,
        vault::vault_rows,
        vault::vault_item,
        vault::vault_save,
        vault::vault_remove,
        vault::vault_copy,
        vault::vault_generate,
        vault::vault_import,
        vault::vault_export,
        git_activity,
        git_digest,
        canvas_get,
        canvas_update,
        reminder_list,
        graph_data,
        body_open,
        body_apply,
        body_words,
        version_list,
        version_text,
        version_name,
        version_restore,
        tree_list,
        tree_move,
        type_list,
        type_save,
        blob_put,
        blob_get,
        local_get,
        local_set,
        import_table,
        import_markdown,
        import_files,
        blob_save,
        export_item,
        export_all,
        index_rebuild,
    ])
}

pub fn run() -> tauri::Result<()> {
    let builder = specta_builder::<tauri::Wry>();
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        // The window and every frame in it stay on the app's own pages (docs/spikes/plugin-sandbox.md).
        .plugin(
            tauri::plugin::Builder::<tauri::Wry>::new("nav-guard")
                .on_navigation(|_, url| {
                    let ok = plugins::may_navigate(url);
                    if !ok {
                        tracing::warn!(
                            scheme = url.scheme(),
                            "stopped a page from leaving the app"
                        );
                    }
                    ok
                })
                .build(),
        )
        .register_uri_scheme_protocol(plugins::SCHEME, |ctx, request| {
            let app = ctx.app_handle();
            let (status, kind, body) = match (
                app.try_state::<plugins::PluginsState>(),
                app.try_state::<Core>(),
            ) {
                (Some(state), Some(core)) => plugins::serve(&state, &core, request.uri().path()),
                _ => (503, "text/plain; charset=utf-8", Vec::new()),
            };
            tauri::http::Response::builder()
                .status(status)
                .header("Content-Type", kind)
                .header(
                    "Content-Security-Policy",
                    plugins::policy("jadyplugin: http://jadyplugin.localhost"),
                )
                .header("X-Content-Type-Options", "nosniff")
                .body(body)
                .unwrap_or_default()
        });
    // Windows: no system frame (tauri.windows.conf.json); the plugin draws the caption buttons
    // at the height of our title bar and keeps the snap layout flyout.
    #[cfg(windows)]
    let app = app.plugin(
        tauri_plugin_frame::FramePluginBuilder::new()
            .auto_titlebar(true)
            .titlebar_height(44)
            .build(),
    );
    app.invoke_handler(builder.invoke_handler())
        .setup(move |app| {
            builder.mount_events(app);
            // Local diagnostic log in the per-machine app log directory. Failure to
            // set it up must not stop the app.
            if let Ok(dir) = app.path().app_log_dir()
                && let Ok(guard) = dem_diag::init(&dem_diag::DiagConfig::new(dir))
            {
                app.manage(guard);
            }
            sync::start_background(app.handle());
            tracing::info!(version = env!("CARGO_PKG_VERSION"), "app started");
            let config = app.path().app_config_dir()?;
            let documents = app.path().document_dir()?;
            app.manage(Core::new(
                config,
                documents,
                Box::new(keychain::SystemKeychain::new()),
            ));
            let handle = app.handle().clone();
            app.manage(Changes(std::sync::Arc::new(move || {
                if let Err(e) = handle.emit(ITEMS_CHANGED, ()) {
                    tracing::warn!(error = %e, "could not tell the windows about a change");
                }
            })));
            let events = app.handle().clone();
            let runtime = ai::AiRuntime::new(Box::new(move |event| {
                if let Err(e) = events.emit("ai-event", event) {
                    tracing::warn!(error = %e, "could not tell the window about AI");
                }
            }));
            runtime.register_builtin(&app.state::<Core>());
            app.manage(runtime);
            let window = app.handle().clone();
            app.manage(browser::BrowserState::new(
                std::sync::Arc::new(move |event, payload| window.emit(event, payload).is_ok()),
                &app.path().app_data_dir()?,
            ));
            app.manage(plugins::PluginsState::new(
                app.path().app_data_dir()?.join("plugins"),
            ));
            capture::register(app.handle());
            local_cli::serve(app.handle());
            links::register(app.handle());
            quit::install(app.handle())?;
            Ok(())
        })
        .on_menu_event(quit::on_menu)
        .on_window_event(quit::on_window)
        .run(tauri::generate_context!())
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use tauri::ipc::{CallbackFn, InvokeBody};
    use tauri::test::{INVOKE_KEY, get_ipc_response, mock_builder};
    use tauri::webview::InvokeRequest;

    // Origin of the bundled frontend; it differs per platform.
    #[cfg(windows)]
    const LOCAL_ORIGIN: &str = "http://tauri.localhost";
    #[cfg(not(windows))]
    const LOCAL_ORIGIN: &str = "tauri://localhost";

    /// Calls `app_info` through Tauri's IPC layer (mock runtime), as the UI would.
    #[test]
    fn app_info_over_ipc() {
        let app = mock_builder()
            .invoke_handler(super::specta_builder().invoke_handler())
            .build(tauri::generate_context!(test = true))
            .expect("build mock app");
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("build webview");
        let response = get_ipc_response(
            &webview,
            InvokeRequest {
                cmd: "app_info".into(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url: LOCAL_ORIGIN.parse().expect("url"),
                body: InvokeBody::default(),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_string(),
            },
        )
        .expect("app_info succeeds");
        let info: serde_json::Value = response.deserialize().expect("json");
        assert_eq!(info["formatVersion"], dem_core::app_info().format_version);
        assert_eq!(info["name"], "Jady");
    }

    /// The system setting is readable on this machine and reaches the UI as a boolean.
    #[test]
    fn system_appearance_over_ipc() {
        let app = mock_builder()
            .invoke_handler(super::specta_builder().invoke_handler())
            .build(tauri::generate_context!(test = true))
            .expect("build mock app");
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("build webview");
        let response = get_ipc_response(
            &webview,
            InvokeRequest {
                cmd: "system_appearance".into(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url: LOCAL_ORIGIN.parse().expect("url"),
                body: InvokeBody::default(),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_string(),
            },
        )
        .expect("system_appearance succeeds");
        let v: serde_json::Value = response.deserialize().expect("json");
        assert!(v["reduceTransparency"].is_boolean());
    }

    /// Regenerates `src/bindings.ts`. CI runs this and fails if the file changed,
    /// so the frontend always compiles against the current Rust types.
    #[test]
    fn export_bindings() {
        let out = Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/bindings.ts");
        super::specta_builder::<tauri::Wry>()
            .export(
                specta_typescript::Typescript::default().header(
                    "// Generated by `cargo test -p dem-desktop export_bindings`. Do not edit.\n",
                ),
                &out,
            )
            .expect("export TypeScript bindings");
    }
}
