//! 全局收集 (docs/05-design.md §10): ⌥⌘N from anywhere opens a small window for one line.

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

const LABEL: &str = "capture";

fn toggle(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(LABEL) {
        if let Err(e) = w.show().and_then(|()| w.set_focus()) {
            tracing::warn!(error = %e, "capture window could not show");
        }
        return;
    }
    let built =
        WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("index.html#/capture".into()))
            .title("Jady")
            .inner_size(560.0, 96.0)
            .resizable(false)
            .decorations(false)
            .transparent(true)
            .always_on_top(true)
            .center()
            .build();
    if let Err(e) = built {
        tracing::warn!(error = %e, "capture window could not open");
    }
}

/// Failing to get the shortcut (another app has it) must not stop the app: settings say so.
pub fn register(app: &AppHandle) {
    let shortcut = Shortcut::new(Some(Modifiers::ALT | Modifiers::SUPER), Code::KeyN);
    let handle = app.clone();
    let result = app
        .global_shortcut()
        .on_shortcut(shortcut, move |_, _, event| {
            if event.state() == ShortcutState::Pressed {
                toggle(&handle);
            }
        });
    if let Err(e) = result {
        tracing::warn!(error = %e, "global shortcut is taken");
    }
}
