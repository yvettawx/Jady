//! AI sessions in the app (M6): which provider, the gateway for each session, what comes back. The
//! interface only sees ids and events; providers only see the `dem-ai-provider` trait.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use dem_ai_gateway::mcp::run_tool;
use dem_ai_gateway::{
    GatewayServer, Mode, SharedAppTools, ToolEvents, all_tools, prompts, system_prompt,
};
use dem_ai_provider::api_key::ApiKey;
use dem_ai_provider::claude_code::ClaudeCode;
use dem_ai_provider::codex::Codex;
use dem_ai_provider::openai_compat::{OpenAiCompat, normalize_endpoint};
use dem_ai_provider::{
    AiEvent, AiProvider, AiSessionHandle, McpAccess, ProviderRegistry, SessionConfig, ToolHost,
};
use dem_core::ai_tools::{Effects, Offered, ToolSession};
use dem_core::proposal::{Change, ProposalView};
use dem_core::{AiSearchPreview, AiSession, Core, CoreError, CoreHandle, NewItem};
use serde::{Deserialize, Serialize};
use serde_json::{Value as J, json};
use specta::Type;
use tauri::State;

use crate::{Changes, R};

const KEY_ACCOUNT: &str = "dev.dem.ai-api-key";
const OPENAI_KEY_ACCOUNT: &str = "dev.dem.ai-openai-compatible-key";
const SETTINGS_KEY: &str = "ai-settings";
const VERIFIED_KEY: &str = "ai-verified-version";

fn err(code: &str, message: impl Into<String>) -> CoreError {
    CoreError {
        code: code.to_owned(),
        message: message.into(),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AiSettings {
    /// `claude-code`, `codex`, `api-key`, `openai-compatible`, or what a plugin registered.
    pub provider: Option<String>,
    pub model: Option<String>,
    /// Keep the user's own Claude Code setup out of it. On unless turned off (M6).
    pub isolate: bool,
    /// The address for `openai-compatible`. Only the user sets it, here.
    #[serde(default)]
    pub endpoint: Option<String>,
}

impl Default for AiSettings {
    fn default() -> Self {
        AiSettings {
            provider: None,
            model: None,
            isolate: true,
            endpoint: None,
        }
    }
}

/// Which keychain entry holds the key for a provider that takes one.
fn key_account(provider: &str) -> Option<&'static str> {
    match provider {
        "api-key" => Some(KEY_ACCOUNT),
        "openai-compatible" => Some(OPENAI_KEY_ACCOUNT),
        _ => None,
    }
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInfo {
    pub id: String,
    pub available: bool,
    pub ready: bool,
    pub detail: String,
    /// A key for it is in the keychain. The key itself never comes back.
    pub key_saved: bool,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AiStatus {
    pub settings: AiSettings,
    /// The one that would be used now, if any can be.
    pub current: Option<String>,
    pub providers: Vec<ProviderInfo>,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct StartSession {
    /// `plain`, `authorized` or `webAuthorized`: the user's own choice, in the interface.
    pub kind: String,
    /// `chat`, `lecture`, `talk`, `explain`, `judge` or `task`.
    pub mode: String,
    /// The domain or project it works in.
    pub container: Option<String>,
}

struct Running {
    handle: Arc<Mutex<Box<dyn AiSessionHandle>>>,
    stop: Arc<dyn Fn() + Send + Sync>,
    _gateway: GatewayServer,
    tool: ToolSession,
    mode: Mode,
    container: Option<String>,
    log: Arc<Mutex<Vec<J>>>,
    offered: Arc<Mutex<Vec<Offered>>>,
}

/// Session id, event type, what it carries.
type EventSink = Arc<dyn Fn(&str, &str, J) + Send + Sync>;

/// Sends an event to the interface; held as state so commands need not name the runtime.
pub struct AiRuntime {
    pub registry: ProviderRegistry,
    sessions: Mutex<HashMap<String, Arc<Running>>>,
    sink: EventSink,
    /// Self-check passed for this version of the provider, in this run.
    verified: Mutex<Option<String>>,
}

impl AiRuntime {
    pub fn new(emit: Box<dyn Fn(J) + Send + Sync>) -> AiRuntime {
        AiRuntime {
            registry: ProviderRegistry::default(),
            sessions: Mutex::new(HashMap::new()),
            sink: Arc::new(move |session, kind, mut payload| {
                payload["session"] = json!(session);
                payload["type"] = json!(kind);
                emit(payload);
            }),
            verified: Mutex::new(None),
        }
    }

    /// The ones this build ships with.
    pub fn register_builtin(&self, core: &Core) {
        self.registry.register(Arc::new(ClaudeCode::default()));
        self.registry.register(Arc::new(Codex::default()));
        let secrets = core.secret_reader();
        let read = move |account: &str| secrets(account).and_then(|b| String::from_utf8(b).ok());
        let reader = read.clone();
        self.registry.register(Arc::new(ApiKey {
            key: Arc::new(move || reader(KEY_ACCOUNT)),
            base: None,
        }));
        let handle = core.handle();
        self.registry.register(Arc::new(OpenAiCompat {
            key: Arc::new(move || read(OPENAI_KEY_ACCOUNT)),
            endpoint: Arc::new(move || {
                handle
                    .with(|s| s.local_get(SETTINGS_KEY))
                    .ok()
                    .flatten()
                    .and_then(|j| serde_json::from_str::<AiSettings>(&j).ok())
                    .and_then(|s| s.endpoint)
            }),
        }));
    }

    /// A way to send events from another thread.
    fn event_sink(&self) -> EventSink {
        self.sink.clone()
    }

    fn get(&self, id: &str) -> R<Arc<Running>> {
        self.sessions
            .lock()
            .ok()
            .and_then(|s| s.get(id).cloned())
            .ok_or_else(|| err("not-found", "session"))
    }
}

fn read_settings(core: &Core) -> AiSettings {
    core.with(|s| s.local_get(SETTINGS_KEY))
        .ok()
        .flatten()
        .and_then(|j| serde_json::from_str(&j).ok())
        .unwrap_or_default()
}

fn choose(ai: &AiRuntime, settings: &AiSettings) -> Option<Arc<dyn AiProvider>> {
    if let Some(id) = &settings.provider {
        return ai.registry.get(id);
    }
    // With nothing chosen: whatever is ready, Claude Code first.
    let all = ai.registry.all();
    let ready = |p: &Arc<dyn AiProvider>| {
        let s = p.status();
        s.available && s.ready
    };
    ai.registry
        .get("claude-code")
        .filter(ready)
        .or_else(|| all.into_iter().find(ready))
}

fn kind_of(kind: &str) -> R<AiSession> {
    Ok(match kind {
        "plain" => AiSession::Plain,
        "authorized" => AiSession::Authorized,
        "webAuthorized" => AiSession::WebAuthorized,
        _ => return Err(err("invalid", "session kind")),
    })
}

struct Host {
    core: CoreHandle,
    tool: ToolSession,
    events: ToolEvents,
    /// The app's own tools for this session, such as the dedicated browser.
    app: SharedAppTools,
}

impl ToolHost for Host {
    fn tools(&self) -> Vec<J> {
        all_tools(&self.app)
    }

    fn call(&self, name: &str, args: &J) -> Result<String, String> {
        self.app
            .as_ref()
            .and_then(|a| a.call(name, args))
            .unwrap_or_else(|| run_tool(&self.core, &self.tool, &self.events, name, args))
    }
}

fn tool_names(app: &SharedAppTools) -> Vec<String> {
    all_tools(app)
        .iter()
        .filter_map(|t| t["name"].as_str().map(str::to_owned))
        .collect()
}

fn runtime_dir() -> std::path::PathBuf {
    // Short: a socket path has a low limit. Per user on macOS.
    std::env::temp_dir().join("dem-ai")
}

fn make_config(
    gateway: &GatewayServer,
    core: CoreHandle,
    tool: ToolSession,
    events: ToolEvents,
    system: String,
    settings: &AiSettings,
    app: SharedAppTools,
) -> SessionConfig {
    SessionConfig {
        system,
        model: settings.model.clone(),
        web: tool.kind.has_web(),
        mcp: McpAccess {
            socket: gateway.socket().to_path_buf(),
            token: gateway.token().to_owned(),
            reissue: Some(gateway.issuer()),
            private_dir: gateway.dir().to_path_buf(),
            tool_names: tool_names(&app),
        },
        tools: Arc::new(Host {
            core,
            tool,
            events,
            app,
        }),
        isolate: settings.isolate,
    }
}

/// M6: when the provider's version changes, its limits are checked again before real use.
fn ensure_verified(
    ai: &AiRuntime,
    core: &Core,
    provider: &Arc<dyn AiProvider>,
    settings: &AiSettings,
) -> R<()> {
    let version = format!("{}:{}", provider.id(), provider.status().detail);
    let known = ai.verified.lock().ok().and_then(|v| v.clone());
    let saved = core.with(|s| s.local_get(VERIFIED_KEY)).ok().flatten();
    if known.as_ref() == Some(&version) || saved.as_ref() == Some(&version) {
        return Ok(());
    }
    let handle = core.handle();
    let tool = ToolSession {
        id: "self-check".to_owned(),
        kind: AiSession::Plain,
        learning: false,
    };
    let quiet: ToolEvents = Arc::new(|_, _| {});
    let gateway = GatewayServer::start(&runtime_dir(), handle.clone(), tool.clone(), quiet.clone())
        .map_err(|e| err("gateway", e.to_string()))?;
    let cheap = AiSettings {
        // A cheaper model where the provider names one; the check is about the tools.
        model: provider
            .check_model()
            .map(str::to_owned)
            .or_else(|| settings.model.clone()),
        ..settings.clone()
    };
    let config = make_config(
        &gateway,
        handle,
        tool,
        quiet,
        "Reply with one word.".to_owned(),
        &cheap,
        None,
    );
    match provider.self_check(config) {
        None | Some(Ok(())) => {}
        Some(Err(e)) => return Err(err("self-check", e.to_string())),
    }
    if let Ok(mut v) = ai.verified.lock() {
        *v = Some(version.clone());
    }
    core.with(|s| s.local_set(VERIFIED_KEY, &version))
}

#[tauri::command(async)]
#[specta::specta]
pub fn ai_status(ai: State<'_, AiRuntime>, core: State<'_, Core>) -> AiStatus {
    let settings = read_settings(&core);
    let secrets = core.secret_reader();
    let providers = ai
        .registry
        .all()
        .iter()
        .map(|p| {
            let s = p.status();
            ProviderInfo {
                id: p.id().to_owned(),
                available: s.available,
                ready: s.ready,
                detail: s.detail,
                key_saved: key_account(p.id()).is_some_and(|a| secrets(a).is_some()),
            }
        })
        .collect();
    AiStatus {
        current: choose(&ai, &settings).map(|p| p.id().to_owned()),
        settings,
        providers,
    }
}

/// Only the user, through the interface. No AI tool reaches this (CLAUDE.md).
/// The "what AI can find" page: what a session of this kind would get from `search`, and what it
/// would not. Only the interface calls this; it is not a gateway tool.
#[tauri::command(async)]
#[specta::specta]
pub fn ai_search_preview(core: State<'_, Core>, kind: String, query: String) -> R<AiSearchPreview> {
    let kind = kind_of(&kind)?;
    core.with(|s| s.ai_search_preview(kind, &query))
}

#[tauri::command(async)]
#[specta::specta]
pub fn ai_settings_set(core: State<'_, Core>, settings: AiSettings) -> R<()> {
    let settings = checked(settings)?;
    let text = serde_json::to_string(&settings).map_err(|e| err("invalid", e.to_string()))?;
    core.with(|s| s.local_set(SETTINGS_KEY, &text))
}

/// Only plain http or https, tidied; an empty address is no address.
fn checked(mut settings: AiSettings) -> R<AiSettings> {
    settings.endpoint = match settings.endpoint.as_deref().map(str::trim) {
        None | Some("") => None,
        Some(raw) => {
            Some(normalize_endpoint(raw).ok_or_else(|| err("invalid-endpoint", "the address"))?)
        }
    };
    Ok(settings)
}

/// The key goes into the system keychain and is never read back out to the interface.
#[tauri::command(async)]
#[specta::specta]
pub fn ai_key_set(core: State<'_, Core>, provider: String, key: Option<String>) -> R<()> {
    let account = key_account(&provider).ok_or_else(|| err("invalid", "provider"))?;
    core.secret_set(account, key.as_deref().map(str::as_bytes))
}

#[tauri::command(async)]
#[specta::specta]
pub fn ai_start(
    ai: State<'_, AiRuntime>,
    core: State<'_, Core>,
    browser: State<'_, crate::browser::BrowserState>,
    start: StartSession,
) -> R<String> {
    let kind = kind_of(&start.kind)?;
    let mode = Mode::parse(&start.mode);
    let settings = read_settings(&core);
    let provider = choose(&ai, &settings).ok_or_else(|| err("no-provider", "no AI is set up"))?;
    ensure_verified(&ai, &core, &provider, &settings)?;
    let id = uuid::Uuid::now_v7().to_string();
    let tool = ToolSession {
        id: id.clone(),
        kind,
        learning: mode.learning(),
    };
    let log = Arc::new(Mutex::new(Vec::new()));
    let offered = Arc::new(Mutex::new(Vec::<Offered>::new()));
    let events: ToolEvents = {
        let sink = ai.event_sink();
        let id = id.clone();
        let offered = offered.clone();
        Arc::new(move |_tool, fx: Effects| {
            for o in fx.offered {
                let index = {
                    let Ok(mut list) = offered.lock() else { return };
                    list.push(o.clone());
                    list.len() - 1
                };
                sink(
                    &id,
                    "offered",
                    json!({
                        "index": index,
                        "title": o.title,
                        "text": o.markdown,
                        "itemType": o.type_id,
                        "origin": o.origin,
                        "needsCheck": o.needs_check,
                    }),
                );
            }
            for p in fx.proposals {
                sink(&id, "proposal", json!({ "id": p }));
            }
            for a in fx.annotations {
                sink(&id, "annotation", json!({ "id": a }));
            }
            for r in fx.reviewed {
                sink(&id, "reviewed", json!({ "id": r }));
            }
        })
    };
    let handle = core.handle();
    let system = core.with(|s| system_prompt(s, &tool, mode, start.container.as_deref()))?;
    // Only sessions that may use the web, and only if the user turned the browser on.
    let app = crate::browser::tools_for(&browser, &core, kind);
    let gateway = GatewayServer::start_with(
        &runtime_dir(),
        handle.clone(),
        tool.clone(),
        events.clone(),
        app.clone(),
    )
    .map_err(|e| err("gateway", e.to_string()))?;
    let config = make_config(
        &gateway,
        handle,
        tool.clone(),
        events,
        system,
        &settings,
        app,
    );
    let session = provider
        .start(config)
        .map_err(|e| err("provider", e.to_string()))?;
    let stop = session.stopper();
    let running = Arc::new(Running {
        handle: Arc::new(Mutex::new(session)),
        stop,
        _gateway: gateway,
        tool,
        mode,
        container: start.container,
        log,
        offered,
    });
    if let Ok(mut all) = ai.sessions.lock() {
        all.insert(id.clone(), running);
    }
    Ok(id)
}

#[tauri::command(async)]
#[specta::specta]
pub fn ai_send(
    ai: State<'_, AiRuntime>,
    changes: State<'_, Changes>,
    id: String,
    text: String,
) -> R<()> {
    let running = ai.get(&id)?;
    let sink = ai.event_sink();
    let fire = changes.handle();
    std::thread::spawn(move || send_turn(&running, &id, &text, &*sink, &*fire));
    Ok(())
}

fn send_turn(
    running: &Running,
    id: &str,
    text: &str,
    sink: &(dyn Fn(&str, &str, J) + Send + Sync),
    fire: &(dyn Fn() + Send + Sync),
) {
    if let Ok(mut log) = running.log.lock() {
        log.push(json!({ "who": "me", "text": text }));
    }
    let mut answer = String::new();
    let result = match running.handle.lock() {
        Ok(mut session) => session.send(text, &mut |event| match event {
            AiEvent::Text { text } => {
                answer.push_str(&text);
                sink(id, "text", json!({ "text": text }));
            }
            AiEvent::Tool { name } => sink(id, "tool", json!({ "name": name })),
            AiEvent::Usage {
                input_tokens,
                output_tokens,
                cost_usd,
            } => sink(
                id,
                "usage",
                json!({
                    "inputTokens": input_tokens,
                    "outputTokens": output_tokens,
                    "costUsd": cost_usd,
                }),
            ),
            AiEvent::Stopped { reason } => sink(id, "stopped", json!({ "reason": reason })),
        }),
        Err(_) => Err(dem_ai_provider::ProviderError::Stopped),
    };
    if let Ok(mut log) = running.log.lock() {
        log.push(json!({ "who": "ai", "text": answer }));
    }
    match result {
        Ok(()) | Err(dem_ai_provider::ProviderError::Stopped) => {
            sink(id, "done", json!({ "text": answer }));
        }
        Err(e) => sink(id, "error", json!({ "message": e.to_string() })),
    }
    fire();
}

#[tauri::command(async)]
#[specta::specta]
pub fn ai_stop(ai: State<'_, AiRuntime>, id: String) -> R<()> {
    let running = ai.get(&id)?;
    (running.stop)();
    Ok(())
}

/// The closing turn: 本次收获 in a learning chat, a summary in any other (D7, M6).
#[tauri::command(async)]
#[specta::specta]
pub fn ai_close_turn(ai: State<'_, AiRuntime>, changes: State<'_, Changes>, id: String) -> R<()> {
    let running = ai.get(&id)?;
    let prompt = if running.mode.learning() {
        prompts::HARVEST
    } else {
        prompts::WRAP_UP
    };
    let sink = ai.event_sink();
    let fire = changes.handle();
    std::thread::spawn(move || send_turn(&running, &id, prompt, &*sink, &*fire));
    Ok(())
}

/// A task the app starts (D6, E4, E6, E7): the first message of a session.
#[tauri::command(async)]
#[specta::specta]
pub fn ai_task_prompt(task: String) -> Option<String> {
    prompts::task_prompt(&task).map(str::to_owned)
}

/// Ends a session and keeps its record. What stayed open goes to the 待补清单 (D7).
#[tauri::command(async)]
#[specta::specta]
pub fn ai_end(
    ai: State<'_, AiRuntime>,
    core: State<'_, Core>,
    changes: State<'_, Changes>,
    id: String,
    summary: Option<String>,
    loose: Vec<String>,
) -> R<()> {
    let running = {
        let mut all = ai.sessions.lock().map_err(|_| err("locked", "sessions"))?;
        all.remove(&id)
    };
    let Some(running) = running else {
        return Ok(());
    };
    (running.stop)();
    let log = running.log.lock().map(|l| l.clone()).unwrap_or_default();
    // The closing turn's request is the app's, not part of the conversation.
    let kept: Vec<J> = log
        .into_iter()
        .filter(|m| {
            let t = m["text"].as_str().unwrap_or("");
            !(t == prompts::HARVEST || t == prompts::WRAP_UP || t.is_empty())
        })
        .collect();
    let first = kept
        .iter()
        .find(|m| m["who"] == "me")
        .and_then(|m| m["text"].as_str())
        .map(|t| t.chars().take(40).collect::<String>());
    if first.is_none() {
        return Ok(());
    }
    let private = running.tool.kind != AiSession::Plain;
    let level = private.then(|| "sensitive".to_owned());
    core.with(|s| {
        s.create_item(NewItem {
            type_id: "ai_session".into(),
            title: first,
            state: None,
            container: running.container.clone(),
            privacy: level.clone(),
            fields: Some(
                json!({
                    "summary": summary.clone().unwrap_or_default(),
                    "messages": serde_json::to_string(&kept).unwrap_or_default(),
                    "mode": format!("{:?}", running.mode),
                })
                .to_string(),
            ),
            tags: None,
            due: None,
            markdown: None,
        })?;
        for text in &loose {
            s.create_item(NewItem {
                type_id: "followup".into(),
                title: Some(text.clone()),
                state: None,
                container: running.container.clone(),
                privacy: level.clone(),
                fields: Some(json!({ "status": "open" }).to_string()),
                tags: None,
                due: None,
                markdown: None,
            })?;
        }
        Ok(())
    })?;
    changes.fire();
    Ok(())
}

/// Keeps something AI offered as a new item, or adds it to the end of one. Adding is an ordinary
/// proposal, confirmed by this press, so it can be undone like any other.
#[tauri::command(async)]
#[specta::specta]
pub fn ai_place(
    ai: State<'_, AiRuntime>,
    core: State<'_, Core>,
    changes: State<'_, Changes>,
    id: String,
    index: u32,
    into: Option<String>,
) -> R<PlacedItem> {
    let running = ai.get(&id)?;
    let offered = running
        .offered
        .lock()
        .ok()
        .and_then(|l| l.get(index as usize).cloned())
        .ok_or_else(|| err("not-found", "offered item"))?;
    let placed = core.with(|s| match &into {
        None => {
            let view = s.place_offered(&offered, running.tool.kind, running.container.clone())?;
            Ok(PlacedItem {
                item: view.id,
                proposal: None,
            })
        }
        Some(target) => {
            let view = s.get_item(target)?;
            let p = s.propose_from_user(
                &view,
                vec![Change::AppendBody {
                    markdown: offered.markdown.clone(),
                }],
                Some(offered.title.clone()),
            )?;
            Ok(PlacedItem {
                item: view.id,
                proposal: Some(p.id),
            })
        }
    })?;
    changes.fire();
    Ok(placed)
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PlacedItem {
    pub item: String,
    pub proposal: Option<String>,
}

#[tauri::command(async)]
#[specta::specta]
pub fn proposal_list(core: State<'_, Core>) -> R<Vec<ProposalView>> {
    core.with(|s| s.proposal_list())
}

#[tauri::command(async)]
#[specta::specta]
pub fn proposal_confirm(
    core: State<'_, Core>,
    changes: State<'_, Changes>,
    id: String,
) -> R<ProposalView> {
    let v = core.with(|s| s.confirm_proposal(&id))?;
    changes.fire();
    Ok(v)
}

#[tauri::command(async)]
#[specta::specta]
pub fn proposal_ignore(
    core: State<'_, Core>,
    changes: State<'_, Changes>,
    id: String,
) -> R<ProposalView> {
    let v = core.with(|s| s.ignore_proposal(&id))?;
    changes.fire();
    Ok(v)
}

#[tauri::command(async)]
#[specta::specta]
pub fn proposal_undo(
    core: State<'_, Core>,
    changes: State<'_, Changes>,
    id: String,
) -> R<ProposalView> {
    let v = core.with(|s| s.undo_proposal(&id))?;
    changes.fire();
    Ok(v)
}

/// Runs a check with the installed compiler (C7): syntax only, nothing from the answer is executed.
#[tauri::command(async)]
#[specta::specta]
pub fn code_check(language: String, code: String) -> R<CodeCheck> {
    crate::compile::check(&language, &code).map_err(|e| err("compile", e))
}

/// Runs an answer against its test cases in the sandbox (C7).
#[tauri::command(async)]
#[specta::specta]
pub fn code_run(
    language: String,
    code: String,
    tests: Vec<crate::coderun::CodeTest>,
) -> R<crate::coderun::CodeRun> {
    crate::coderun::run_tests(&language, &code, &tests).map_err(|e| err("compile", e))
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CodeCheck {
    pub ran: bool,
    pub ok: bool,
    pub output: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use dem_core::MemoryKeychain;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    const PLAIN: &str = "canary-plain-5e1";
    const PRIVATE: &str = "canary-private-9c4";
    const SECRET: &str = "canary-confidential-2b7";

    fn open_core(dir: &std::path::Path) -> Core {
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

    fn note(title: &str, privacy: Option<&str>) -> NewItem {
        NewItem {
            type_id: "note".into(),
            title: Some(title.into()),
            state: None,
            container: None,
            privacy: privacy.map(str::to_owned),
            fields: None,
            tags: None,
            due: None,
            markdown: Some(format!("{title} canary\n")),
        }
    }

    /// Answers each POST with the next Chat Completions stream and keeps the request bodies.
    fn server(replies: Vec<Vec<J>>) -> (String, Arc<Mutex<Vec<J>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = format!("http://{}/v1", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        std::thread::spawn(move || {
            for (chunks, stream) in replies.into_iter().zip(listener.incoming()) {
                let mut s = stream.unwrap();
                let mut raw = Vec::new();
                let mut buf = [0u8; 8192];
                loop {
                    let n = s.read(&mut buf).unwrap();
                    raw.extend_from_slice(&buf[..n]);
                    let text = String::from_utf8_lossy(&raw).into_owned();
                    if let Some((head, body)) = text.split_once("\r\n\r\n") {
                        let len: usize = head
                            .lines()
                            .find_map(|l| {
                                l.to_lowercase()
                                    .strip_prefix("content-length:")
                                    .map(|v| v.trim().parse().unwrap())
                            })
                            .unwrap_or(0);
                        if body.len() >= len {
                            log.lock()
                                .unwrap()
                                .push(serde_json::from_str(body).unwrap());
                            break;
                        }
                    }
                }
                let mut reply: String = chunks.iter().map(|c| format!("data: {c}\n\n")).collect();
                reply.push_str("data: [DONE]\n\n");
                write!(
                    s,
                    "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}",
                    reply.len()
                )
                .unwrap();
            }
        });
        (addr, seen)
    }

    fn calls(list: &[(&str, J)]) -> Vec<J> {
        let pieces: Vec<J> = list
            .iter()
            .enumerate()
            .map(|(i, (name, args))| {
                json!({ "index": i, "id": format!("c{i}"), "function": { "name": name, "arguments": args.to_string() } })
            })
            .collect();
        vec![
            json!({ "choices": [{ "delta": { "tool_calls": pieces }, "finish_reason": "tool_calls" }] }),
        ]
    }

    /// The OpenAI-compatible provider over the real gateway tools: what goes back to the service
    /// holds ordinary content and nothing private or confidential, and no tool reaches the settings.
    #[test]
    fn an_openai_compatible_service_sees_only_the_restricted_view() {
        let d = tempfile::tempdir().unwrap();
        let core = open_core(d.path());
        let (plain, private, secret) = core
            .with(|s| {
                Ok((
                    s.create_item(note(PLAIN, None))?.id,
                    s.create_item(note(PRIVATE, Some("private")))?.id,
                    s.create_item(note(SECRET, Some("confidential")))?.id,
                ))
            })
            .unwrap();
        let before = AiSettings {
            provider: Some("openai-compatible".into()),
            model: Some("m".into()),
            isolate: true,
            endpoint: None,
        };
        let first = calls(&[
            ("search", json!({ "query": "canary" })),
            ("read_item", json!({ "id": plain })),
            ("read_item", json!({ "id": private })),
            ("read_item", json!({ "id": secret })),
            ("related", json!({ "id": private })),
            // Tools that are not there, whatever the model hopes.
            (
                "ai_settings_set",
                json!({ "settings": { "provider": "x" } }),
            ),
            ("set_privacy", json!({ "id": private, "privacy": "normal" })),
        ]);
        let done =
            vec![json!({ "choices": [{ "delta": { "content": "好" }, "finish_reason": "stop" }] })];
        let (base, seen) = server(vec![first, done]);
        let settings = AiSettings {
            endpoint: Some(base),
            ..before.clone()
        };
        core.with(|s| s.local_set(SETTINGS_KEY, &serde_json::to_string(&settings).unwrap()))
            .unwrap();
        let ai = AiRuntime::new(Box::new(|_| {}));
        ai.register_builtin(&core);
        let provider = ai.registry.get("openai-compatible").unwrap();
        assert!(provider.status().ready);
        let tool = ToolSession {
            id: "t".into(),
            kind: AiSession::Plain,
            learning: false,
        };
        let quiet: ToolEvents = Arc::new(|_, _| {});
        let gateway =
            GatewayServer::start(d.path(), core.handle(), tool.clone(), quiet.clone()).unwrap();
        let config = make_config(
            &gateway,
            core.handle(),
            tool,
            quiet,
            "sys".into(),
            &settings,
            None,
        );
        let mut session = provider.start(config).unwrap();
        session.send("找", &mut |_| {}).unwrap();

        let bodies = seen.lock().unwrap();
        let names: Vec<&str> = bodies[0]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|t| t["function"]["name"].as_str())
            .collect();
        assert_eq!(names, tool_names(&None));
        assert!(
            !names
                .iter()
                .any(|n| n.contains("setting") || n.contains("privacy"))
        );
        // What the tools answered; the model's own requests may hold the ids it asked for.
        let back: String = bodies[1]["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|m| m["role"] == "tool")
            .map(|m| format!("{}\n", m["content"].as_str().unwrap_or("")))
            .collect();
        assert!(back.lines().filter(|l| l.starts_with("error:")).count() >= 2);
        assert!(back.contains(PLAIN), "ordinary content comes back");
        for hidden in [PRIVATE, SECRET, private.as_str(), secret.as_str()] {
            assert!(!back.contains(hidden), "{hidden} reached the service");
        }
        drop(bodies);
        // The settings and the item's level are as they were.
        assert_eq!(read_settings(&core), settings);
        let level = core.with(|s| s.get_item(&private)).unwrap().privacy;
        assert_eq!(level, "private");
    }

    #[test]
    fn the_address_must_be_plain_http() {
        let with = |e: &str| AiSettings {
            endpoint: Some(e.into()),
            ..AiSettings::default()
        };
        assert_eq!(
            checked(with("https://api.deepseek.com/v1/"))
                .unwrap()
                .endpoint
                .as_deref(),
            Some("https://api.deepseek.com/v1")
        );
        assert_eq!(checked(with("  ")).unwrap().endpoint, None);
        assert!(checked(with("file:///etc/passwd")).is_err());
        assert!(key_account("codex").is_none() && key_account("claude-code").is_none());
    }

    /// Older saved settings have no address and still read.
    #[test]
    fn settings_saved_before_the_address_still_read() {
        let old: AiSettings =
            serde_json::from_str(r#"{"provider":"api-key","model":null,"isolate":true}"#).unwrap();
        assert_eq!(old.endpoint, None);
        assert_eq!(old.provider.as_deref(), Some("api-key"));
    }
}
