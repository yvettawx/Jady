//! The dedicated browser in the app (D11, D15): the user's settings for it, the tools a session gets,
//! and the question to the user when AI's action would send something.
//!
//! Only the user turns it on and lists the sites, here in the interface; no AI tool reaches these
//! settings (CLAUDE.md). Sessions without web, the ones that may read sensitive content, never get
//! it.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::mpsc::{Sender, channel};
use std::sync::{Arc, Mutex, OnceLock};

use dem_ai_gateway::{AppTools, SharedAppTools};
use dem_browser::{ASK_WAIT, Browser, BrowserError, Confirm, Hold, Options, find_chrome};
use dem_core::{AiSession, Core, CoreError};
use serde::{Deserialize, Serialize};
use serde_json::{Value as J, json};
use specta::Type;
use tauri::State;

use crate::R;

const SETTINGS_KEY: &str = "browser-settings";
pub const CONFIRM_EVENT: &str = "browser-confirm";

#[derive(Debug, Clone, Default, Serialize, Deserialize, Type, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSettings {
    /// AI may use the dedicated browser. Off for a new library.
    #[serde(default)]
    pub enabled: bool,
    /// The sites it may go to, such as `example.com`, which also covers its subdomains.
    #[serde(default)]
    pub sites: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BrowserStatus {
    /// The browser found on this computer, by name, if any.
    pub chrome: Option<String>,
    pub running: bool,
}

/// Sends an event to the window.
pub type Emit = Arc<dyn Fn(&str, J) -> bool + Send + Sync>;

/// Held as app state: one browser for the whole app, made when first needed.
pub struct BrowserState {
    emit: Emit,
    profile: PathBuf,
    browser: OnceLock<Arc<Browser>>,
    asking: Arc<Mutex<HashMap<u64, Sender<bool>>>>,
}

impl BrowserState {
    /// `app_data` is the app's own data folder; the profile lives there, on this computer only.
    pub fn new(emit: Emit, app_data: &std::path::Path) -> BrowserState {
        BrowserState {
            emit,
            profile: dem_browser::profile_in(app_data),
            browser: OnceLock::new(),
            asking: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    fn get(&self) -> R<Arc<Browser>> {
        if let Some(b) = self.browser.get() {
            return Ok(b.clone());
        }
        let chrome =
            find_chrome().ok_or_else(|| err("no-chrome", BrowserError::NoChrome.to_string()))?;
        let emit = self.emit.clone();
        let asking = self.asking.clone();
        // Shows the question in the window and waits; no answer in time is a no.
        let confirm: Confirm = Arc::new(move |hold: &Hold| {
            let (tx, rx) = channel();
            if let Ok(mut a) = asking.lock() {
                a.insert(hold.id, tx);
            }
            let asked = emit(
                CONFIRM_EVENT,
                json!({
                    "id": hold.id,
                    "method": hold.method,
                    "url": hold.url,
                    "host": dem_browser::host_of(&hold.url).unwrap_or_default(),
                }),
            );
            let reply = if asked {
                rx.recv_timeout(ASK_WAIT).ok()
            } else {
                None
            };
            if let Ok(mut a) = asking.lock() {
                a.remove(&hold.id);
            }
            // Unanswered: nobody was there. A scheduled task keeps it for when the user is back.
            emit(
                CONFIRM_EVENT,
                json!({ "id": hold.id, "done": true, "unanswered": reply.is_none() }),
            );
            reply.unwrap_or(false)
        });
        let browser = Arc::new(Browser::new(
            Options {
                chrome,
                profile: self.profile.clone(),
                headless: false,
            },
            confirm,
        ));
        Ok(self.browser.get_or_init(|| browser).clone())
    }
}

fn err(code: &str, message: impl Into<String>) -> CoreError {
    CoreError {
        code: code.to_owned(),
        message: message.into(),
    }
}

pub fn read_settings(core: &Core) -> BrowserSettings {
    core.with(|s| s.local_get(SETTINGS_KEY))
        .ok()
        .flatten()
        .and_then(|j| serde_json::from_str(&j).ok())
        .unwrap_or_default()
}

/// Whether a session of this kind gets the browser. A session that may read sensitive content
/// has no web, so no browser either.
fn gets_browser(settings: &BrowserSettings, kind: AiSession) -> bool {
    settings.enabled && kind.has_web() && !settings.sites.is_empty()
}

/// The browser tools for a session, if the user turned the browser on and the session may use
/// the web at all.
pub fn tools_for(state: &BrowserState, core: &Core, kind: AiSession) -> SharedAppTools {
    let settings = read_settings(core);
    if !gets_browser(&settings, kind) {
        return None;
    }
    let browser = state.get().ok()?;
    browser.set_allowed(settings.sites.clone());
    Some(Arc::new(BrowserTools {
        browser,
        sites: settings.sites,
    }))
}

struct BrowserTools {
    browser: Arc<Browser>,
    sites: Vec<String>,
}

fn tool(name: &str, description: String, props: J, required: &[&str]) -> J {
    json!({
        "name": name,
        "description": description,
        "input_schema": {
            "type": "object",
            "properties": props,
            "required": required,
            "additionalProperties": false,
        },
    })
}

impl AppTools for BrowserTools {
    fn tools(&self) -> Vec<J> {
        let sites = self.sites.join(", ");
        vec![
            tool(
                "browser_open",
                format!(
                    "Open a page in the user's dedicated browser, where they may be signed in. Only these sites, set by the user: {sites}. Returns the page's text and numbered elements. Anything that would send data (a form, a post) waits for the user to allow it."
                ),
                json!({ "url": { "type": "string" } }),
                &["url"],
            ),
            tool(
                "browser_read",
                "Read the page open in the dedicated browser again, with fresh element numbers.".into(),
                json!({}),
                &[],
            ),
            tool(
                "browser_click",
                "Click an element of the open page by its number. If this would send data, the user is asked first.".into(),
                json!({ "number": { "type": "integer" } }),
                &["number"],
            ),
            tool(
                "browser_type",
                "Type into a field of the open page by its number, replacing what is there. submit presses Enter after. Never for passwords.".into(),
                json!({
                    "number": { "type": "integer" },
                    "text": { "type": "string" },
                    "submit": { "type": "boolean" },
                }),
                &["number", "text"],
            ),
        ]
    }

    fn call(&self, name: &str, args: &J) -> Option<Result<String, String>> {
        let number = || {
            args["number"]
                .as_u64()
                .and_then(|n| u32::try_from(n).ok())
                .ok_or_else(|| BrowserError::Refused("number is required".into()))
        };
        let result = match name {
            "browser_open" => self.browser.goto(args["url"].as_str().unwrap_or_default()),
            "browser_read" => self.browser.snapshot(),
            "browser_click" => number().and_then(|n| self.browser.click(n)),
            "browser_type" => number().and_then(|n| {
                self.browser.type_text(
                    n,
                    args["text"].as_str().unwrap_or_default(),
                    args["submit"].as_bool().unwrap_or(false),
                )
            }),
            _ => return None,
        };
        Some(result.map(|s| s.render()).map_err(|e| e.to_string()))
    }
}

/// Only the user, through the interface.
#[tauri::command(async)]
#[specta::specta]
pub fn browser_settings(core: State<'_, Core>) -> BrowserSettings {
    read_settings(&core)
}

/// Only the user, through the interface. No AI tool reaches this (CLAUDE.md).
#[tauri::command(async)]
#[specta::specta]
pub fn browser_settings_set(core: State<'_, Core>, settings: BrowserSettings) -> R<()> {
    let tidy = BrowserSettings {
        enabled: settings.enabled,
        sites: settings
            .sites
            .iter()
            .map(|s| s.trim().to_lowercase())
            .map(|s| {
                dem_browser::host_of(&s)
                    .or_else(|| dem_browser::host_of(&format!("https://{s}")))
                    .unwrap_or(s)
            })
            .filter(|s| !s.is_empty())
            .collect(),
    };
    let text = serde_json::to_string(&tidy).map_err(|e| err("invalid", e.to_string()))?;
    core.with(|s| s.local_set(SETTINGS_KEY, &text))
}

#[tauri::command(async)]
#[specta::specta]
pub fn browser_status(state: State<'_, BrowserState>) -> BrowserStatus {
    BrowserStatus {
        chrome: find_chrome().and_then(|p| {
            p.ancestors()
                .find(|a| a.extension().is_some_and(|e| e == "app"))
                .and_then(|a| a.file_stem())
                .map(|n| n.to_string_lossy().into_owned())
        }),
        running: state.browser.get().is_some_and(|b| b.running()),
    }
}

/// Opens the browser window so the user can sign in to their sites.
#[tauri::command(async)]
#[specta::specta]
pub fn browser_show(state: State<'_, BrowserState>) -> R<()> {
    state
        .get()?
        .show()
        .map_err(|e| err("browser", e.to_string()))
}

/// The user's answer to a write AI wanted to make.
#[tauri::command(async)]
#[specta::specta]
pub fn browser_decide(state: State<'_, BrowserState>, id: u32, allow: bool) {
    if let Ok(a) = state.asking.lock()
        && let Some(tx) = a.get(&u64::from(id))
    {
        let _ = tx.send(allow);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_web_sessions_get_the_browser_and_only_when_the_user_turned_it_on() {
        let on = BrowserSettings {
            enabled: true,
            sites: vec!["example.com".into()],
        };
        assert!(gets_browser(&on, AiSession::Plain));
        assert!(gets_browser(&on, AiSession::WebAuthorized));
        assert!(!gets_browser(&on, AiSession::Authorized));
        let off = BrowserSettings {
            enabled: false,
            ..on.clone()
        };
        assert!(!gets_browser(&off, AiSession::Plain));
        let nowhere = BrowserSettings {
            sites: vec![],
            ..on
        };
        assert!(!gets_browser(&nowhere, AiSession::Plain));
        // A new library starts with it off.
        assert!(!BrowserSettings::default().enabled);
    }
}
