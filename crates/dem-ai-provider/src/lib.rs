//! How AI is reached (M6, CLAUDE.md). The rest of the app sees only [`AiProvider`] and [`AiEvent`];
//! Claude Code, Codex, an Anthropic API key and an OpenAI-compatible endpoint are the built-in
//! implementations, and a plugin can add more through the registry. Whatever the implementation,
//! data comes only through the gateway's tools.

pub mod api_key;
pub mod claude_code;
pub mod codex;
pub mod openai_compat;

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::Value as J;

#[derive(Debug, thiserror::Error)]
pub enum ProviderError {
    #[error("{0} is not available")]
    Unavailable(String),
    #[error("{0}")]
    Failed(String),
    #[error("isolation self-check failed: {0}")]
    SelfCheck(String),
    #[error("stopped")]
    Stopped,
}

pub type Result<T> = std::result::Result<T, ProviderError>;

/// What comes back while AI works.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AiEvent {
    /// More of the answer.
    Text { text: String },
    /// A tool is being called. Names only: inputs can hold content.
    Tool { name: String },
    /// What this turn cost, as far as the provider can tell.
    Usage {
        input_tokens: u64,
        output_tokens: u64,
        cost_usd: Option<f64>,
    },
    /// The provider stopped short of an answer for its own reason (a refusal, a limit).
    Stopped { reason: String },
}

/// The tools, for providers that call them from this process.
pub trait ToolHost: Send + Sync {
    /// Tool definitions, each with name, description and input_schema.
    fn tools(&self) -> Vec<J>;
    fn call(&self, name: &str, args: &J) -> std::result::Result<String, String>;
}

/// Gives out a new one-time token for the same gateway, for a program that connects once per turn.
pub type TokenIssuer = Arc<dyn Fn() -> String + Send + Sync>;

/// How to reach the gateway from another process.
#[derive(Clone)]
pub struct McpAccess {
    pub socket: PathBuf,
    /// Works for one connection.
    pub token: String,
    /// Another token for each later connection. `None` where one connection is all there is.
    pub reissue: Option<TokenIssuer>,
    /// Written here, readable only by this user.
    pub private_dir: PathBuf,
    /// Tool names, without the MCP prefix.
    pub tool_names: Vec<String>,
}

impl std::fmt::Debug for McpAccess {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("McpAccess")
            .field("socket", &self.socket)
            .field("private_dir", &self.private_dir)
            .field("tool_names", &self.tool_names)
            .finish_non_exhaustive()
    }
}

pub struct SessionConfig {
    pub system: String,
    pub model: Option<String>,
    /// Whether AI gets web search and page reading. Off in sensitive authorized sessions.
    pub web: bool,
    pub mcp: McpAccess,
    pub tools: Arc<dyn ToolHost>,
    /// Keep the user's own Claude Code setup out of it (default on, M6). Tool limits apply either way.
    pub isolate: bool,
}

impl std::fmt::Debug for SessionConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SessionConfig")
            .field("web", &self.web)
            .field("isolate", &self.isolate)
            .finish_non_exhaustive()
    }
}

/// One conversation with AI.
pub trait AiSessionHandle: Send {
    /// Sends one message and reports what comes back until the turn is over.
    fn send(&mut self, message: &str, on: &mut dyn FnMut(AiEvent)) -> Result<()>;
    /// Stops the turn in progress from another thread.
    fn stopper(&self) -> Arc<dyn Fn() + Send + Sync>;
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProviderStatus {
    pub available: bool,
    /// Short, for showing: a version, or what is missing.
    pub detail: String,
    /// Whether the user has logged in or given a key, as far as can be told.
    pub ready: bool,
}

pub trait AiProvider: Send + Sync {
    fn id(&self) -> &'static str;
    fn status(&self) -> ProviderStatus;
    fn start(&self, config: SessionConfig) -> Result<Box<dyn AiSessionHandle>>;
    /// Checks the limits really hold in this version, before any real data is near it. `None`
    /// means there is nothing to check.
    fn self_check(&self, _config: SessionConfig) -> Option<Result<()>> {
        None
    }
    /// The model the self-check asks for, when a cheaper one than the user's will do.
    fn check_model(&self) -> Option<&'static str> {
        None
    }
}

/// A program on PATH or in one of the usual install places. A GUI app starts with a short PATH, so
/// those are searched too; `extra` is relative to the home folder.
pub fn find_program(name: &str, extra: &[&str]) -> Option<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        dirs.push(home.join(".local/bin"));
        dirs.extend(extra.iter().map(|e| home.join(e)));
        dirs.push(home.join(".npm-global/bin"));
    }
    dirs.push("/opt/homebrew/bin".into());
    dirs.push("/usr/local/bin".into());
    dirs.into_iter().map(|d| d.join(name)).find(|p| p.is_file())
}

/// An error from a service, with the key taken out in case the service repeated it back.
pub(crate) fn redact(message: &str, key: Option<&str>) -> String {
    match key {
        Some(k) if k.len() >= 4 => message.replace(k, "***"),
        _ => message.to_owned(),
    }
}

/// The providers this build has. Plugins add theirs here.
#[derive(Default)]
pub struct ProviderRegistry {
    providers: Mutex<BTreeMap<&'static str, Arc<dyn AiProvider>>>,
}

impl std::fmt::Debug for ProviderRegistry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ProviderRegistry")
    }
}

impl ProviderRegistry {
    pub fn register(&self, provider: Arc<dyn AiProvider>) {
        if let Ok(mut map) = self.providers.lock() {
            map.insert(provider.id(), provider);
        }
    }

    pub fn get(&self, id: &str) -> Option<Arc<dyn AiProvider>> {
        self.providers.lock().ok()?.get(id).cloned()
    }

    pub fn all(&self) -> Vec<Arc<dyn AiProvider>> {
        self.providers
            .lock()
            .map(|m| m.values().cloned().collect())
            .unwrap_or_default()
    }
}
