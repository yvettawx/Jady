//! Which storage this computer syncs with, and doing it (F3, M10). The address lives in this
//! computer's own settings, the token in the keychain. A round runs on request and every few
//! minutes while the library is open.

use std::time::Duration;

use dem_core::{Core, CoreError, LibraryRef, SyncSummary};
use dem_sync::{Backend, FolderBackend, HttpBackend};
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

type R<T> = Result<T, CoreError>;

const CONFIG_KEY: &str = "sync-config";
/// Which items a background round changed, so open editors can catch up.
const SYNCED: &str = "sync-changed";
const EVERY: Duration = Duration::from_secs(5 * 60);

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncTarget {
    /// `folder` or `server`.
    pub kind: String,
    /// A folder path, or the server's address.
    pub location: String,
}

fn invalid(what: &str) -> CoreError {
    CoreError::invalid(what)
}

fn backend_for(target: &SyncTarget, token: Option<&str>) -> R<Box<dyn Backend>> {
    match target.kind.as_str() {
        "folder" => {
            let path = std::path::Path::new(&target.location);
            if !path.is_dir() {
                return Err(invalid("folder"));
            }
            Ok(Box::new(FolderBackend::new(path)))
        }
        "server" => {
            let backend = HttpBackend::new(&target.location, token.unwrap_or_default())
                .map_err(|e| CoreError::new("sync-insecure", e.to_string()))?;
            Ok(Box::new(backend))
        }
        _ => Err(invalid("sync kind")),
    }
}

fn target_of(core: &Core) -> R<Option<SyncTarget>> {
    core.with(|s| {
        Ok(s.local_get(CONFIG_KEY)?
            .and_then(|j| serde_json::from_str(&j).ok()))
    })
}

fn round(core: &Core) -> R<Option<SyncSummary>> {
    let Some(target) = target_of(core)? else {
        return Ok(None);
    };
    let token = core.sync_token();
    let backend = backend_for(&target, token.as_deref())?;
    core.sync_now(backend.as_ref()).map(Some)
}

#[tauri::command(async)]
#[specta::specta]
pub fn sync_target(core: State<'_, Core>) -> R<Option<SyncTarget>> {
    target_of(&core)
}

/// Checks it can be reached before saving, so a typo shows now and not in five minutes.
#[tauri::command(async)]
#[specta::specta]
pub fn sync_connect(core: State<'_, Core>, target: SyncTarget, token: Option<String>) -> R<()> {
    let backend = backend_for(&target, token.as_deref())?;
    backend
        .list()
        .map_err(|e| CoreError::new("sync", e.to_string()))?;
    core.set_sync_token(token.as_deref())?;
    let json =
        serde_json::to_string(&target).map_err(|e| CoreError::new("broken", e.to_string()))?;
    core.with(|s| s.local_set(CONFIG_KEY, &json))
}

#[tauri::command(async)]
#[specta::specta]
pub fn sync_disconnect(core: State<'_, Core>) -> R<()> {
    core.set_sync_token(None)?;
    core.with(|s| s.local_set(CONFIG_KEY, "null"))
}

#[tauri::command(async)]
#[specta::specta]
pub fn sync_run(core: State<'_, Core>) -> R<Option<SyncSummary>> {
    round(&core)
}

/// A new computer: everything comes down into `folder`, then the library is opened as usual.
#[tauri::command(async)]
#[specta::specta]
pub fn sync_join(
    core: State<'_, Core>,
    target: SyncTarget,
    token: Option<String>,
    folder: String,
) -> R<LibraryRef> {
    let backend = backend_for(&target, token.as_deref())?;
    let lib = core.sync_join(backend.as_ref(), &folder)?;
    core.set_sync_token(token.as_deref())?;
    // Remembered for after unlocking: the settings live inside the library.
    core.remember_pending_sync(serde_json::to_string(&target).unwrap_or_default());
    Ok(lib)
}

/// Runs a round every few minutes for as long as the app does.
pub fn start_background<R2: Runtime>(app: &AppHandle<R2>) {
    let app = app.clone();
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(EVERY);
            let core = app.state::<Core>();
            if !core.is_open() {
                continue;
            }
            match round(&core) {
                Ok(Some(d)) if !d.items.is_empty() => {
                    let _ = app.emit(crate::ITEMS_CHANGED, ());
                    let _ = app.emit(SYNCED, d.items);
                }
                Ok(_) => {}
                // Offline is normal. The code says what went wrong; the message may hold a path.
                Err(e) => tracing::info!(code = %e.code, "sync round did not finish"),
            }
        }
    });
}
