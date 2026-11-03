//! The 密码库 commands. Passwords stay on this side wherever they can: copying goes straight from
//! the core to the system clipboard, and the clipboard is cleared again after a while.

use std::time::Duration;

use dem_core::vault::{VaultItem, VaultRow, VaultStatus};
use dem_core::{Core, CoreError};
use tauri::State;
use zeroize::Zeroizing;

type R<T> = Result<T, CoreError>;

const CLEAR_AFTER: Duration = Duration::from_secs(30);

fn root(core: &Core) -> R<std::path::PathBuf> {
    core.library_root()
}

#[tauri::command(async)]
#[specta::specta]
pub fn vault_status(core: State<'_, Core>) -> R<VaultStatus> {
    Ok(core.vault().status(&root(&core)?))
}

#[tauri::command(async)]
#[specta::specta]
pub fn vault_create(core: State<'_, Core>, password: String) -> R<()> {
    let password = Zeroizing::new(password);
    core.vault()
        .create(&root(&core)?, &password, core.vault_kdf())
}

#[tauri::command(async)]
#[specta::specta]
pub fn vault_unlock(core: State<'_, Core>, password: String) -> R<()> {
    let password = Zeroizing::new(password);
    core.vault().unlock(&root(&core)?, &password)
}

#[tauri::command(async)]
#[specta::specta]
pub fn vault_lock(core: State<'_, Core>) {
    core.vault().lock();
}

#[tauri::command(async)]
#[specta::specta]
pub fn vault_rows(core: State<'_, Core>) -> R<Vec<VaultRow>> {
    core.vault().rows()
}

#[tauri::command(async)]
#[specta::specta]
pub fn vault_item(core: State<'_, Core>, id: String) -> R<VaultItem> {
    core.vault().item(&id)
}

#[tauri::command(async)]
#[specta::specta]
pub fn vault_save(core: State<'_, Core>, item: VaultItem) -> R<String> {
    core.vault().save(item)
}

#[tauri::command(async)]
#[specta::specta]
pub fn vault_remove(core: State<'_, Core>, id: String) -> R<()> {
    core.vault().remove(&id)
}

/// Puts the password on the clipboard and takes it off again, unless something else was copied
/// meanwhile.
#[tauri::command(async)]
#[specta::specta]
pub fn vault_copy(core: State<'_, Core>, id: String) -> R<()> {
    let password = core.vault().password(&id)?;
    let fail = |e: arboard::Error| CoreError::new("clipboard", e.to_string());
    let mut board = arboard::Clipboard::new().map_err(fail)?;
    board.set_text(password.as_str()).map_err(fail)?;
    std::thread::spawn(move || {
        std::thread::sleep(CLEAR_AFTER);
        if let Ok(mut board) = arboard::Clipboard::new()
            && board
                .get_text()
                .is_ok_and(|now| now.as_str() == password.as_str())
        {
            let _ = board.clear();
        }
    });
    Ok(())
}

#[tauri::command(async)]
#[specta::specta]
pub fn vault_generate(length: u32) -> String {
    dem_core::vault::generate_password(length)
}

#[tauri::command(async)]
#[specta::specta]
pub fn vault_import(core: State<'_, Core>, path: String) -> R<u32> {
    core.vault().import_csv(std::path::Path::new(&path))
}

#[tauri::command(async)]
#[specta::specta]
pub fn vault_export(core: State<'_, Core>, path: String) -> R<u32> {
    core.vault().export_csv(std::path::Path::new(&path))
}
