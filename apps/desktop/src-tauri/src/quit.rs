//! Leaving: what is still being typed gets saved first. ⌘Q goes through the interface instead of
//! ending the process at once, and the app ends with its main window, not with the hidden capture
//! window still around.

use std::time::Duration;

use tauri::menu::{Menu, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, Runtime, Window, WindowEvent};

const QUIT: &str = "dem-quit";
const QUIT_REQUESTED: &str = "quit-requested";
/// If the interface does not answer, leave anyway: a stuck window must not trap the user.
const GIVE_UP_AFTER: Duration = Duration::from_secs(3);

/// The standard menu, with its Quit item replaced by ours.
pub fn install<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let menu = Menu::default(app)?;
    let name = app.package_info().name.clone();
    for entry in menu.items()? {
        let MenuItemKind::Submenu(sub) = entry else {
            continue;
        };
        if sub.text()? != name {
            continue;
        }
        replace_quit(app, &sub)?;
    }
    app.set_menu(menu)?;
    Ok(())
}

fn replace_quit<R: Runtime>(app: &AppHandle<R>, sub: &Submenu<R>) -> tauri::Result<()> {
    if let Some(MenuItemKind::Predefined(last)) = sub.items()?.last()
        && last.text()?.to_lowercase().contains("quit")
    {
        let text = last.text()?;
        sub.remove(last)?;
        sub.append(&MenuItem::with_id(app, QUIT, text, true, Some("Cmd+Q"))?)?;
    } else {
        sub.append(&PredefinedMenuItem::separator(app)?)?;
        sub.append(&MenuItem::with_id(app, QUIT, "Quit", true, Some("Cmd+Q"))?)?;
    }
    Ok(())
}

pub fn on_menu<R: Runtime>(app: &AppHandle<R>, event: tauri::menu::MenuEvent) {
    if event.id() != QUIT {
        return;
    }
    if app.emit(QUIT_REQUESTED, ()).is_err() {
        app.exit(0);
        return;
    }
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(GIVE_UP_AFTER);
        handle.exit(0);
    });
}

pub fn on_window<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
    if matches!(event, WindowEvent::Destroyed) && window.label() == "main" {
        window.app_handle().exit(0);
    }
}
