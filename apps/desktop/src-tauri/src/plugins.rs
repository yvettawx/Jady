//! External plugins (docs/spikes/plugin-sandbox.md): the folders on this computer, what the user
//! granted each, the calls their frames make, and the `jadyplugin:` protocol the frames load from.
//!
//! A plugin's frame is sandboxed without the same origin, so it can neither read this window nor
//! hold Tauri's invoke key; everything it asks comes through the window as a message and lands in
//! [`plugin_call`], which hands the core only the permissions the user granted.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};

use dem_core::plugin_api::{PERMISSIONS, READ, WRITE, valid_id};
use dem_core::{Core, CoreError};
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::State;

use crate::R;

pub const SCHEME: &str = "jadyplugin";
/// Goes up when something a plugin uses changes in a way that can break it. Additions do not count.
pub const API_VERSION: u32 = 1;
const GRANTS_KEY: &str = "plugin-grants";
const SDK: &str = include_str!("../plugin-sdk/jady.js");
const MANIFEST_LIMIT: u64 = 64 * 1024;
const FILE_LIMIT: u64 = 20 * 1024 * 1024;
const INSTALL_LIMIT: u64 = 100 * 1024 * 1024;
const INSTALL_FILES: usize = 2000;

/// Text in several languages, by locale (`zh-CN`, `en`).
pub type Localized = BTreeMap<String, String>;

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PanelDecl {
    pub id: String,
    pub title: Localized,
    #[serde(default)]
    pub icon: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommandDecl {
    pub id: String,
    pub title: Localized,
    /// Opens this panel instead of telling the plugin's background page.
    #[serde(default)]
    pub panel: Option<String>,
}

/// `manifest.json`, see docs/extending/external-plugins.md.
#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub id: String,
    pub name: Localized,
    pub version: String,
    #[serde(default = "one")]
    pub api_version: u32,
    #[serde(default)]
    pub description: Localized,
    #[serde(default)]
    pub permissions: Vec<String>,
    #[serde(default)]
    pub panels: Vec<PanelDecl>,
    #[serde(default)]
    pub commands: Vec<CommandDecl>,
}

fn one() -> u32 {
    1
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PluginInfo {
    /// The folder's name.
    pub folder: String,
    pub manifest: Option<Manifest>,
    pub enabled: bool,
    /// Enabled once, and now asks for more than was granted: off until the user agrees again.
    pub asks_more: bool,
    /// Why it cannot run, in English for the log; the interface says it its own way.
    pub problem: Option<String>,
}

/// Held as app state: where the plugins live on this computer.
pub struct PluginsState {
    root: PathBuf,
}

impl PluginsState {
    pub fn new(root: PathBuf) -> PluginsState {
        PluginsState { root }
    }
}

fn err(code: &str, message: impl Into<String>) -> CoreError {
    CoreError {
        code: code.to_owned(),
        message: message.into(),
    }
}

/// Reads and checks a plugin folder's manifest.
pub fn read_manifest(dir: &Path) -> Result<Manifest, String> {
    let file = dir.join("manifest.json");
    let size = std::fs::metadata(&file)
        .map_err(|_| "no manifest.json".to_owned())?
        .len();
    if size > MANIFEST_LIMIT {
        return Err("manifest.json is too big".into());
    }
    let text = std::fs::read_to_string(&file).map_err(|e| e.to_string())?;
    let m: Manifest = serde_json::from_str(&text).map_err(|e| format!("manifest.json: {e}"))?;
    if !valid_id(&m.id) {
        return Err("the id is lowercase letters, digits and hyphens".into());
    }
    if m.name.is_empty() {
        return Err("no name".into());
    }
    if m.api_version > API_VERSION {
        return Err("needs a newer version of the app".into());
    }
    if let Some(p) = m
        .permissions
        .iter()
        .find(|p| !PERMISSIONS.contains(&p.as_str()))
    {
        return Err(format!("unknown permission {p}"));
    }
    if m.permissions.iter().any(|p| p == WRITE) && !m.permissions.iter().any(|p| p == READ) {
        return Err("items:write needs items:read".into());
    }
    for id in m
        .panels
        .iter()
        .map(|p| &p.id)
        .chain(m.commands.iter().map(|c| &c.id))
    {
        if !valid_id(id) {
            return Err(format!("bad panel or command id {id}"));
        }
    }
    for c in &m.commands {
        if let Some(p) = &c.panel
            && !m.panels.iter().any(|x| &x.id == p)
        {
            return Err(format!("command {} opens no panel {p}", c.id));
        }
    }
    if !dir.join("index.html").is_file() {
        return Err("no index.html".into());
    }
    Ok(m)
}

type Grants = HashMap<String, Vec<String>>;

fn grants(core: &Core) -> Grants {
    core.with(|s| s.local_get(GRANTS_KEY))
        .ok()
        .flatten()
        .and_then(|j| serde_json::from_str(&j).ok())
        .unwrap_or_default()
}

fn save_grants(core: &Core, g: &Grants) -> R<()> {
    let text = serde_json::to_string(g).map_err(|e| err("io", e.to_string()))?;
    core.with(|s| s.local_set(GRANTS_KEY, &text))
}

/// Granted, and for everything it asks now: an update that asks for more stops it until the user
/// agrees again.
fn is_enabled(m: &Manifest, g: &Grants) -> bool {
    g.get(&m.id)
        .is_some_and(|granted| m.permissions.iter().all(|p| granted.contains(p)))
}

impl PluginsState {
    fn dir_of(&self, id: &str) -> R<PathBuf> {
        if !valid_id(id) {
            return Err(err("invalid", "plugin id"));
        }
        Ok(self.root.join(id))
    }

    fn manifest(&self, id: &str) -> R<Manifest> {
        let m = read_manifest(&self.dir_of(id)?).map_err(|e| err("plugin", e))?;
        if m.id != id {
            return Err(err("plugin", "the folder is not named after the id"));
        }
        Ok(m)
    }

    /// The plugin, if it is installed, sound and enabled.
    fn running(&self, core: &Core, id: &str) -> Option<Manifest> {
        self.manifest(id)
            .ok()
            .filter(|m| is_enabled(m, &grants(core)))
    }

    pub fn list(&self, core: &Core) -> Vec<PluginInfo> {
        let g = grants(core);
        let mut out: Vec<PluginInfo> = std::fs::read_dir(&self.root)
            .into_iter()
            .flatten()
            .flatten()
            .filter(|e| e.path().is_dir())
            .filter_map(|e| e.file_name().to_str().map(str::to_owned))
            .filter(|name| !name.starts_with('.'))
            .map(|folder| match self.manifest(&folder) {
                Ok(m) => PluginInfo {
                    enabled: is_enabled(&m, &g),
                    asks_more: g.contains_key(&m.id) && !is_enabled(&m, &g),
                    folder,
                    manifest: Some(m),
                    problem: None,
                },
                Err(e) => {
                    tracing::info!(folder = %folder, problem = %e.message, "a plugin folder cannot run");
                    PluginInfo {
                    folder,
                    manifest: None,
                    enabled: false,
                    asks_more: false,
                    problem: Some(e.message),
                }
                }
            })
            .collect();
        out.sort_by(|a, b| a.folder.cmp(&b.folder));
        out
    }
}

/// Copies a plugin folder in, replacing an older copy. Symbolic links are refused, so nothing
/// outside the folder comes along.
fn copy_plugin(from: &Path, to: &Path) -> Result<(), String> {
    fn walk(dir: &Path, base: &Path, out: &mut Vec<PathBuf>, size: &mut u64) -> Result<(), String> {
        for e in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
            let e = e.map_err(|e| e.to_string())?;
            let kind = e.file_type().map_err(|e| e.to_string())?;
            let path = e.path();
            if kind.is_symlink() {
                return Err("the folder has a symbolic link".into());
            }
            if kind.is_dir() {
                walk(&path, base, out, size)?;
            } else {
                *size += e.metadata().map_err(|e| e.to_string())?.len();
                out.push(
                    path.strip_prefix(base)
                        .map_err(|e| e.to_string())?
                        .to_owned(),
                );
            }
            if out.len() > INSTALL_FILES || *size > INSTALL_LIMIT {
                return Err("the folder is too big".into());
            }
        }
        Ok(())
    }
    let mut files = Vec::new();
    walk(from, from, &mut files, &mut 0)?;
    let parent = to.parent().ok_or("no place for plugins")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    // Copy beside, then swap, so a failed copy leaves the old one working.
    let fresh = parent.join(format!(".installing-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&fresh);
    for f in &files {
        let target = fresh.join(f);
        if let Some(p) = target.parent() {
            std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
        }
        std::fs::copy(from.join(f), &target).map_err(|e| e.to_string())?;
    }
    if to.exists() {
        std::fs::remove_dir_all(to).map_err(|e| e.to_string())?;
    }
    std::fs::rename(&fresh, to).map_err(|e| e.to_string())
}

#[tauri::command(async)]
#[specta::specta]
pub fn plugin_list(state: State<'_, PluginsState>, core: State<'_, Core>) -> Vec<PluginInfo> {
    state.list(&core)
}

/// Turns a plugin on with what it asks for now. The interface shows those permissions first; no
/// AI tool reaches this.
#[tauri::command(async)]
#[specta::specta]
pub fn plugin_enable(state: State<'_, PluginsState>, core: State<'_, Core>, id: String) -> R<()> {
    let m = state.manifest(&id)?;
    let mut g = grants(&core);
    g.insert(id, m.permissions);
    save_grants(&core, &g)
}

#[tauri::command(async)]
#[specta::specta]
pub fn plugin_disable(core: State<'_, Core>, id: String) -> R<()> {
    let mut g = grants(&core);
    g.remove(&id);
    save_grants(&core, &g)
}

/// Installs the plugin in `from`, replacing an older copy; returns its id. It stays off until the
/// user enables it, and an enabled one that now asks for more turns off.
#[tauri::command(async)]
#[specta::specta]
pub fn plugin_install(state: State<'_, PluginsState>, from: String) -> R<String> {
    let from = PathBuf::from(from);
    let m = read_manifest(&from).map_err(|e| err("plugin", e))?;
    let to = state.dir_of(&m.id)?;
    if from.canonicalize().ok() == to.canonicalize().ok() {
        return Ok(m.id);
    }
    copy_plugin(&from, &to).map_err(|e| err("plugin", e))?;
    Ok(m.id)
}

/// Deletes a plugin's folder. The interface asks first.
#[tauri::command(async)]
#[specta::specta]
pub fn plugin_remove(state: State<'_, PluginsState>, core: State<'_, Core>, id: String) -> R<()> {
    let dir = state.dir_of(&id)?;
    let mut g = grants(&core);
    g.remove(&id);
    save_grants(&core, &g)?;
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| err("io", e.to_string()))?;
    }
    Ok(())
}

/// Shows the plugins folder in the Finder.
#[tauri::command(async)]
#[specta::specta]
pub fn plugin_folder(state: State<'_, PluginsState>) -> R<()> {
    std::fs::create_dir_all(&state.root).map_err(|e| err("io", e.to_string()))?;
    std::process::Command::new("open")
        .arg(&state.root)
        .status()
        .map_err(|e| err("io", e.to_string()))?;
    Ok(())
}

/// One call from a plugin's frame, as JSON text both ways. Only an enabled plugin gets an answer,
/// and only within what the user granted it.
#[tauri::command(async)]
#[specta::specta]
pub fn plugin_call(
    state: State<'_, PluginsState>,
    core: State<'_, Core>,
    id: String,
    method: String,
    args: String,
) -> R<String> {
    let m = state
        .running(&core, &id)
        .ok_or_else(|| err("plugin", "this plugin is not enabled"))?;
    let args: serde_json::Value =
        serde_json::from_str(&args).map_err(|e| err("plugin", e.to_string()))?;
    let out = core
        .with(|s| Ok(s.plugin_call(&id, &m.permissions, &method, &args)))?
        .map_err(|e| err("plugin", e))?;
    Ok(out.to_string())
}

/// The content security policy on everything the protocol serves: files from `source` only, no
/// network, no frames, no forms. `source` is `jadyplugin:` in the app.
pub fn policy(source: &str) -> String {
    format!(
        "default-src 'none'; script-src {source} 'wasm-unsafe-eval'; \
         style-src {source} 'unsafe-inline'; img-src {source} data: blob:; \
         font-src {source} data:; media-src {source} data: blob:; connect-src 'none'; \
         frame-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none'"
    )
}

fn mime(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).unwrap_or("") {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "wasm" => "application/wasm",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "txt" | "md" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = std::str::from_utf8(b.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// What the protocol answers for `path` (`/<id>/<file>` or `/_sdk/jady.js`): status, type, bytes.
/// Only enabled plugins are served, and nothing outside their own folder.
pub fn serve(state: &PluginsState, core: &Core, path: &str) -> (u16, &'static str, Vec<u8>) {
    let missing = (404, "text/plain; charset=utf-8", b"not found".to_vec());
    let path = path.split(['?', '#']).next().unwrap_or("");
    let Some(path) = decode(path) else {
        return missing;
    };
    let mut parts = path.trim_start_matches('/').split('/');
    let first = parts.next().unwrap_or("");
    let rest: Vec<&str> = parts.collect();
    if first == "_sdk" && rest == ["jady.js"] {
        return (
            200,
            "text/javascript; charset=utf-8",
            SDK.as_bytes().to_vec(),
        );
    }
    if state.running(core, first).is_none()
        || rest.is_empty()
        || rest
            .iter()
            .any(|p| p.is_empty() || p.starts_with('.') || p.contains('\\'))
    {
        return missing;
    }
    let Ok(dir) = state.root.join(first).canonicalize() else {
        return missing;
    };
    let Ok(file) = rest
        .iter()
        .fold(dir.clone(), |p, part| p.join(part))
        .canonicalize()
    else {
        return missing;
    };
    let small = std::fs::metadata(&file).is_ok_and(|m| m.is_file() && m.len() <= FILE_LIMIT);
    if !file.starts_with(&dir) || !small {
        return missing;
    }
    match std::fs::read(&file) {
        Ok(bytes) => (200, mime(&file), bytes),
        Err(_) => missing,
    }
}

/// Where the window and its frames may go: the app's own pages and the plugin protocol. Links to
/// the web open in the browser through `open_external`; anything else trying to load in the window,
/// such as a plugin frame sending itself away with what it read, is stopped.
pub fn may_navigate(url: &tauri::Url) -> bool {
    match url.scheme() {
        "tauri" | SCHEME | "about" => true,
        "http" | "https" => matches!(
            url.host_str(),
            Some("localhost" | "127.0.0.1" | "tauri.localhost" | "jadyplugin.localhost")
        ),
        _ => false,
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use dem_core::MemoryKeychain;

    fn plugin(root: &Path, id: &str, manifest: serde_json::Value) -> PathBuf {
        let dir = root.join(id);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("manifest.json"), manifest.to_string()).unwrap();
        std::fs::write(dir.join("index.html"), "<p>hi</p>").unwrap();
        dir
    }

    fn manifest(id: &str, permissions: &[&str]) -> serde_json::Value {
        serde_json::json!({
            "id": id,
            "name": { "en": "Test" },
            "version": "1.0.0",
            "permissions": permissions,
            "panels": [{ "id": "main", "title": { "en": "Main" } }],
            "commands": [{ "id": "go", "title": { "en": "Go" }, "panel": "main" }],
        })
    }

    fn open_core(dir: &Path) -> Core {
        let core = Core::new(
            dir.join("config"),
            dir.join("docs"),
            Box::new(MemoryKeychain::default()),
        );
        std::fs::create_dir_all(dir.join("docs")).unwrap();
        core.prepare_library("t", dir.join("docs").to_str().unwrap(), "correct horse")
            .unwrap();
        core.commit_library().unwrap();
        core
    }

    #[test]
    fn a_manifest_says_only_what_the_app_knows() {
        let d = tempfile::tempdir().unwrap();
        let ok = plugin(d.path(), "ok", manifest("ok", &["items:read"]));
        assert!(read_manifest(&ok).is_ok());
        for (id, bad) in [
            ("a", manifest("a", &["network"])),
            ("b", manifest("b", &["items:write"])),
            ("c", manifest("Bad Id", &[])),
            (
                "d",
                serde_json::json!({ "id": "d", "name": {}, "version": "1" }),
            ),
            (
                "e",
                serde_json::json!({ "id": "e", "name": { "en": "E" }, "version": "1", "apiVersion": 99 }),
            ),
            (
                "f",
                serde_json::json!({ "id": "f", "name": { "en": "F" }, "version": "1", "extra": true }),
            ),
            (
                "g",
                serde_json::json!({ "id": "g", "name": { "en": "G" }, "version": "1",
                    "commands": [{ "id": "x", "title": { "en": "X" }, "panel": "nope" }] }),
            ),
        ] {
            let dir = plugin(d.path(), id, bad);
            assert!(read_manifest(&dir).is_err(), "{id}");
        }
        let no_page = plugin(d.path(), "h", manifest("h", &[]));
        std::fs::remove_file(no_page.join("index.html")).unwrap();
        assert!(read_manifest(&no_page).is_err());
    }

    #[test]
    fn a_plugin_runs_only_once_granted_and_stops_when_it_asks_for_more() {
        let d = tempfile::tempdir().unwrap();
        let core = open_core(d.path());
        let root = d.path().join("plugins");
        let state = PluginsState::new(root.clone());
        plugin(&root, "p", manifest("p", &["items:read"]));
        plugin(&root, "wrong-name", manifest("other", &[]));
        let list = state.list(&core);
        assert_eq!(list.len(), 2);
        assert!(list.iter().all(|p| !p.enabled));
        assert!(
            list.iter()
                .any(|p| p.folder == "wrong-name" && p.problem.is_some())
        );
        assert!(state.running(&core, "p").is_none());
        assert_eq!(serve(&state, &core, "/p/index.html").0, 404);

        let mut g = Grants::new();
        g.insert("p".into(), vec!["items:read".into()]);
        save_grants(&core, &g).unwrap();
        assert!(state.running(&core, "p").is_some());
        assert_eq!(serve(&state, &core, "/p/index.html").0, 200);

        // The update asks for more: off until the user agrees again.
        plugin(&root, "p", manifest("p", &["items:read", "items:create"]));
        assert!(state.running(&core, "p").is_none());
        let p = state
            .list(&core)
            .into_iter()
            .find(|p| p.folder == "p")
            .unwrap();
        assert!(!p.enabled && p.asks_more);
    }

    #[test]
    fn the_protocol_serves_only_inside_the_plugins_folder() {
        let d = tempfile::tempdir().unwrap();
        let core = open_core(d.path());
        let root = d.path().join("plugins");
        let state = PluginsState::new(root.clone());
        let dir = plugin(&root, "p", manifest("p", &[]));
        std::fs::create_dir_all(dir.join("js")).unwrap();
        std::fs::write(dir.join("js").join("a b.js"), "1").unwrap();
        std::fs::write(d.path().join("secret.txt"), "no").unwrap();
        std::os::unix::fs::symlink(d.path().join("secret.txt"), dir.join("link.txt")).unwrap();
        let mut g = Grants::new();
        g.insert("p".into(), vec![]);
        save_grants(&core, &g).unwrap();

        let (status, kind, body) = serve(&state, &core, "/p/js/a%20b.js?x=1");
        assert_eq!(
            (status, kind, body.as_slice()),
            (200, "text/javascript; charset=utf-8", &b"1"[..])
        );
        assert_eq!(serve(&state, &core, "/_sdk/jady.js").0, 200);
        for bad in [
            "/p/../secret.txt",
            "/p/%2e%2e/secret.txt",
            "/p/link.txt",
            "/p/.hidden",
            "/p/",
            "/p",
            "/../secret.txt",
            "/q/index.html",
            "/p/manifest.json/x",
        ] {
            assert_eq!(serve(&state, &core, bad).0, 404, "{bad}");
        }
    }

    #[test]
    fn installing_copies_the_folder_and_refuses_links() {
        let d = tempfile::tempdir().unwrap();
        let src = plugin(&d.path().join("src"), "p", manifest("p", &[]));
        std::fs::create_dir_all(src.join("img")).unwrap();
        std::fs::write(src.join("img").join("a.png"), "png").unwrap();
        let to = d.path().join("plugins").join("p");
        copy_plugin(&src, &to).unwrap();
        assert!(to.join("img").join("a.png").is_file());
        std::fs::write(src.join("index.html"), "<p>new</p>").unwrap();
        copy_plugin(&src, &to).unwrap();
        assert_eq!(
            std::fs::read_to_string(to.join("index.html")).unwrap(),
            "<p>new</p>"
        );

        std::os::unix::fs::symlink("/etc/hosts", src.join("hosts")).unwrap();
        assert!(copy_plugin(&src, &to).is_err());
        // The old copy still works.
        assert!(to.join("index.html").is_file());
    }

    #[test]
    fn the_window_goes_only_to_the_apps_own_pages() {
        let ok = |u: &str| may_navigate(&tauri::Url::parse(u).unwrap());
        assert!(ok("tauri://localhost/index.html"));
        assert!(ok("jadyplugin://localhost/p/index.html"));
        assert!(ok("http://localhost:1420/"));
        assert!(ok("about:blank"));
        // A data: page may not carry the plugin's policy along.
        assert!(!ok("data:text/html,<img src=https://example.com>"));
        assert!(!ok("https://example.com/?data=secret"));
        assert!(!ok("http://192.168.1.1/"));
        assert!(!ok("file:///etc/hosts"));
    }

    #[test]
    fn the_policy_leaves_no_way_out() {
        let p = policy("jadyplugin:");
        assert!(p.contains("connect-src 'none'"));
        assert!(p.contains("default-src 'none'"));
        assert!(!p.contains('*'));
        assert!(!p.contains("https:"));
    }
}
