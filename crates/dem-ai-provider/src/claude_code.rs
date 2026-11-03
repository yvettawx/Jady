//! Claude Code as a provider (M6, docs/spikes/05-claude-code-mcp.md). The user installs it and logs
//! in through Anthropic's own flow; the app only starts the unmodified program and never touches
//! its credentials. Each conversation is one long-running process with stream-json in and out and
//! no session file, because a resumable session would write the conversation out in plain text.

use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{Arc, Mutex};

use serde_json::{Value as J, json};

use crate::{
    AiEvent, AiProvider, AiSessionHandle, ProviderError, ProviderStatus, Result, SessionConfig,
};

/// Every built-in tool it must not have. `--tools` already leaves them out; this is the second lock
/// in case a new version changes one of the flags.
const DENY_BUILTINS: &[&str] = &[
    "Bash",
    "PowerShell",
    "Monitor",
    "Read",
    "Write",
    "Edit",
    "MultiEdit",
    "NotebookEdit",
    "NotebookRead",
    "Glob",
    "Grep",
    "LS",
    "Agent",
    "Task",
    "TaskCreate",
    "TodoWrite",
    "Skill",
    "SlashCommand",
    "ToolSearch",
    "LSP",
    "Workflow",
    "CronCreate",
    "RemoteTrigger",
    "ExitPlanMode",
];
/// Page reading happens on this machine, so this machine stays out of reach.
const DENY_LOCAL_FETCH: &[&str] = &[
    "WebFetch(domain:localhost)",
    "WebFetch(domain:*.localhost)",
    "WebFetch(domain:127.0.0.1)",
    "WebFetch(domain:[::1])",
    "WebFetch(domain:0.0.0.0)",
    "WebFetch(domain:*.local)",
];
const SETTINGS: &str = r#"{"disableAllHooks":true,"autoMemoryEnabled":false,"disableClaudeAiConnectors":true,"enableAllProjectMcpServers":false}"#;

#[derive(Debug, Default)]
pub struct ClaudeCode {
    /// Set by tests and by anyone whose install is somewhere unusual.
    pub program: Option<PathBuf>,
    /// The executable that plays the MCP bridge.
    pub shim: Option<PathBuf>,
}

pub fn find_program() -> Option<PathBuf> {
    crate::find_program("claude", &[".claude/local"])
}

/// The command line, per docs/spikes/05-claude-code-mcp.md. Pure, so it can be tested.
pub fn arguments(config: &SessionConfig, mcp_config: &Path) -> Vec<String> {
    let mut args: Vec<String> = [
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--strict-mcp-config",
        "--disable-slash-commands",
        "--permission-mode",
        "dontAsk",
        "--permission-prompts",
        "none",
        "--no-session-persistence",
    ]
    .iter()
    .map(|s| (*s).to_owned())
    .collect();
    let mut push = |k: &str, v: String| {
        args.push(k.to_owned());
        args.push(v);
    };
    push("--mcp-config", mcp_config.display().to_string());
    push("--system-prompt", config.system.clone());
    if config.isolate {
        // Not the user's CLAUDE.md, settings, skills, plugins, hooks or other MCP servers.
        push("--setting-sources", String::new());
        push("--settings", SETTINGS.to_owned());
    }
    let gateway: Vec<String> = config
        .mcp
        .tool_names
        .iter()
        .map(|t| format!("mcp__dem__{t}"))
        .collect();
    let mut allowed = gateway;
    let mut denied: Vec<String> = DENY_BUILTINS.iter().map(|s| (*s).to_owned()).collect();
    if config.web {
        push("--tools", "WebSearch,WebFetch".to_owned());
        allowed.push("WebSearch".to_owned());
        allowed.push("WebFetch".to_owned());
        denied.extend(DENY_LOCAL_FETCH.iter().map(|s| (*s).to_owned()));
    } else {
        push("--tools", String::new());
        denied.push("WebSearch".to_owned());
        denied.push("WebFetch".to_owned());
    }
    push("--allowedTools", allowed.join(","));
    push("--disallowedTools", denied.join(","));
    if let Some(model) = &config.model {
        push("--model", model.clone());
    }
    if config.isolate {
        args.push("--restricted".to_owned());
    }
    args
}

/// What the program says it has, checked against what it may have (M6: 版本变化后隔离自检).
pub fn check_init(init: &J, web: bool) -> std::result::Result<(), String> {
    let tools: Vec<&str> = init["tools"]
        .as_array()
        .map(|a| a.iter().filter_map(J::as_str).collect())
        .unwrap_or_default();
    let mut gateway = 0;
    for t in &tools {
        if t.starts_with("mcp__dem__") {
            gateway += 1;
            continue;
        }
        if !(web && matches!(*t, "WebSearch" | "WebFetch")) {
            return Err(format!("it has a tool it should not: {t}"));
        }
    }
    if gateway == 0 {
        return Err("the gateway did not connect".to_owned());
    }
    let others: Vec<&str> = init["mcp_servers"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|s| s["name"].as_str())
                .filter(|n| *n != "dem")
                .collect()
        })
        .unwrap_or_default();
    if !others.is_empty() {
        return Err(format!(
            "another MCP server is loaded: {}",
            others.join(", ")
        ));
    }
    Ok(())
}

fn write_mcp_config(config: &SessionConfig, shim: &Path) -> Result<PathBuf> {
    let path = config.mcp.private_dir.join("mcp.json");
    let body = json!({
        "mcpServers": {
            "dem": {
                "type": "stdio",
                "command": shim,
                "args": ["--dem-gw-shim"],
                "env": {
                    "DEM_GW_SOCKET": config.mcp.socket,
                    "DEM_GW_TOKEN": config.mcp.token,
                },
            },
        },
    });
    let fail = |e: std::io::Error| ProviderError::Failed(e.to_string());
    std::fs::write(&path, body.to_string()).map_err(fail)?;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).map_err(fail)?;
    Ok(path)
}

struct Running {
    child: Arc<Mutex<Child>>,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    web: bool,
    checked: bool,
    /// Stops the conversation if what started is not what was asked for.
    strict: bool,
}

impl ClaudeCode {
    fn spawn(&self, config: &SessionConfig) -> Result<Running> {
        let program = self
            .program
            .clone()
            .or_else(find_program)
            .ok_or_else(|| ProviderError::Unavailable("Claude Code".to_owned()))?;
        let shim = match &self.shim {
            Some(s) => s.clone(),
            None => std::env::current_exe().map_err(|e| ProviderError::Failed(e.to_string()))?,
        };
        let mcp = write_mcp_config(config, &shim)?;
        let cwd = config.mcp.private_dir.join("work");
        std::fs::create_dir_all(&cwd).map_err(|e| ProviderError::Failed(e.to_string()))?;
        let mut child = Command::new(program)
            .args(arguments(config, &mcp))
            .current_dir(cwd)
            .env("ENABLE_CLAUDEAI_MCP_SERVERS", "false")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| ProviderError::Failed(e.to_string()))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| ProviderError::Failed("no input".into()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| ProviderError::Failed("no output".into()))?;
        Ok(Running {
            child: Arc::new(Mutex::new(child)),
            stdin,
            stdout: BufReader::new(stdout),
            web: config.web,
            checked: false,
            strict: config.isolate,
        })
    }
}

impl Drop for Running {
    fn drop(&mut self) {
        if let Ok(mut c) = self.child.lock() {
            let _ = c.kill();
            let _ = c.wait();
        }
    }
}

fn parse_event(line: &J) -> Option<AiEvent> {
    match line["type"].as_str()? {
        "stream_event" => {
            let event = &line["event"];
            if event["type"] == "content_block_delta" && event["delta"]["type"] == "text_delta" {
                return Some(AiEvent::Text {
                    text: event["delta"]["text"].as_str()?.to_owned(),
                });
            }
            if event["type"] == "content_block_start"
                && matches!(
                    event["content_block"]["type"].as_str(),
                    Some("tool_use" | "server_tool_use")
                )
            {
                return Some(AiEvent::Tool {
                    name: event["content_block"]["name"]
                        .as_str()?
                        .trim_start_matches("mcp__dem__")
                        .to_owned(),
                });
            }
            None
        }
        _ => None,
    }
}

impl AiSessionHandle for Running {
    fn send(&mut self, message: &str, on: &mut dyn FnMut(AiEvent)) -> Result<()> {
        let line = json!({
            "type": "user",
            "message": { "role": "user", "content": message },
        });
        let fail = |e: std::io::Error| ProviderError::Failed(e.to_string());
        writeln!(self.stdin, "{line}").map_err(fail)?;
        self.stdin.flush().map_err(fail)?;
        let mut buf = String::new();
        loop {
            buf.clear();
            let n = self.stdout.read_line(&mut buf).map_err(fail)?;
            if n == 0 {
                return Err(ProviderError::Stopped);
            }
            let Ok(event) = serde_json::from_str::<J>(&buf) else {
                continue;
            };
            if event["type"] == "system" && event["subtype"] == "init" && !self.checked {
                self.checked = true;
                // Limits are checked every time, not only after an update. With isolation off the
                // user's own servers may be there, but its tools still may not be.
                let init = if self.strict {
                    event.clone()
                } else {
                    json!({ "tools": event["tools"], "mcp_servers": [] })
                };
                if let Err(why) = check_init(&init, self.web) {
                    return Err(ProviderError::SelfCheck(why));
                }
            }
            if let Some(e) = parse_event(&event) {
                on(e);
            }
            if event["type"] == "result" {
                let usage = &event["usage"];
                on(AiEvent::Usage {
                    input_tokens: usage["input_tokens"].as_u64().unwrap_or(0)
                        + usage["cache_creation_input_tokens"].as_u64().unwrap_or(0)
                        + usage["cache_read_input_tokens"].as_u64().unwrap_or(0),
                    output_tokens: usage["output_tokens"].as_u64().unwrap_or(0),
                    cost_usd: event["total_cost_usd"].as_f64(),
                });
                if event["is_error"] == true {
                    on(AiEvent::Stopped {
                        reason: event["subtype"].as_str().unwrap_or("error").to_owned(),
                    });
                }
                return Ok(());
            }
        }
    }

    fn stopper(&self) -> Arc<dyn Fn() + Send + Sync> {
        let child = self.child.clone();
        Arc::new(move || {
            if let Ok(mut c) = child.lock() {
                let _ = c.kill();
            }
        })
    }
}

impl AiProvider for ClaudeCode {
    fn id(&self) -> &'static str {
        "claude-code"
    }

    fn status(&self) -> ProviderStatus {
        let Some(program) = self.program.clone().or_else(find_program) else {
            return ProviderStatus {
                available: false,
                detail: String::new(),
                ready: false,
            };
        };
        let run = |args: &[&str]| Command::new(&program).args(args).output().ok();
        let version = run(&["--version"])
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned())
            .unwrap_or_default();
        // Asks whether it is logged in. The answer's yes or no is all that is read.
        let ready = run(&["auth", "status"])
            .and_then(|o| serde_json::from_slice::<J>(&o.stdout).ok())
            .is_some_and(|v| v["loggedIn"] == true);
        ProviderStatus {
            available: true,
            detail: version,
            ready,
        }
    }

    fn start(&self, config: SessionConfig) -> Result<Box<dyn AiSessionHandle>> {
        Ok(Box::new(self.spawn(&config)?))
    }

    /// One tiny turn on a throwaway gateway session with nothing behind it worth reading.
    fn self_check(&self, config: SessionConfig) -> Option<Result<()>> {
        Some((|| {
            let mut running = self.spawn(&config)?;
            running.send("Reply with the single word ok.", &mut |_| {})
        })())
    }

    /// The check is about the tools, not the answer.
    fn check_model(&self) -> Option<&'static str> {
        Some("haiku")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{McpAccess, ToolHost};

    struct NoTools;
    impl ToolHost for NoTools {
        fn tools(&self) -> Vec<J> {
            vec![]
        }
        fn call(&self, _: &str, _: &J) -> std::result::Result<String, String> {
            Err("no".into())
        }
    }

    fn config(web: bool, isolate: bool) -> SessionConfig {
        SessionConfig {
            system: "s".into(),
            model: Some("m".into()),
            web,
            mcp: McpAccess {
                socket: "/x".into(),
                token: "t".into(),
                reissue: None,
                private_dir: "/p".into(),
                tool_names: vec!["search".into()],
            },
            tools: Arc::new(NoTools),
            isolate,
        }
    }

    fn value_of<'a>(args: &'a [String], key: &str) -> &'a str {
        let i = args.iter().position(|a| a == key).unwrap();
        &args[i + 1]
    }

    #[test]
    fn a_plain_session_has_the_gateway_and_the_web_and_nothing_else() {
        let a = arguments(&config(true, true), Path::new("/m.json"));
        assert_eq!(value_of(&a, "--tools"), "WebSearch,WebFetch");
        assert!(value_of(&a, "--allowedTools").contains("mcp__dem__search"));
        let denied = value_of(&a, "--disallowedTools");
        for t in [
            "Bash",
            "Read",
            "Write",
            "Edit",
            "Agent",
            "WebFetch(domain:127.0.0.1)",
        ] {
            assert!(denied.contains(t), "{t}");
        }
        assert!(a.contains(&"--no-session-persistence".to_owned()));
        assert!(a.contains(&"--strict-mcp-config".to_owned()));
        assert!(a.contains(&"--restricted".to_owned()));
    }

    #[test]
    fn an_authorized_session_has_no_web_at_all() {
        let a = arguments(&config(false, true), Path::new("/m.json"));
        assert_eq!(value_of(&a, "--tools"), "");
        let allowed = value_of(&a, "--allowedTools");
        assert!(!allowed.contains("Web"));
        let denied = value_of(&a, "--disallowedTools");
        assert!(denied.contains("WebSearch") && denied.contains("WebFetch"));
    }

    #[test]
    fn with_isolation_off_the_tool_limits_still_hold() {
        let a = arguments(&config(true, false), Path::new("/m.json"));
        assert!(!a.contains(&"--setting-sources".to_owned()));
        assert_eq!(value_of(&a, "--tools"), "WebSearch,WebFetch");
        assert!(value_of(&a, "--disallowedTools").contains("Bash"));
    }

    #[test]
    fn the_self_check_catches_a_tool_or_server_that_should_not_be_there() {
        let good = json!({ "tools": ["mcp__dem__search", "WebSearch"], "mcp_servers": [{ "name": "dem" }] });
        assert!(check_init(&good, true).is_ok());
        assert!(
            check_init(&good, false).is_err(),
            "web in an authorized session"
        );
        let bash =
            json!({ "tools": ["mcp__dem__search", "Bash"], "mcp_servers": [{ "name": "dem" }] });
        assert!(check_init(&bash, true).is_err());
        let other = json!({ "tools": ["mcp__dem__search"], "mcp_servers": [{ "name": "dem" }, { "name": "gmail" }] });
        assert!(check_init(&other, true).is_err());
        let none = json!({ "tools": ["WebSearch"], "mcp_servers": [] });
        assert!(check_init(&none, true).is_err(), "no gateway");
    }

    #[test]
    fn reads_text_and_tool_names_from_the_stream() {
        let text = json!({ "type": "stream_event", "event": { "type": "content_block_delta", "delta": { "type": "text_delta", "text": "你好" } } });
        assert_eq!(
            parse_event(&text),
            Some(AiEvent::Text {
                text: "你好".into()
            })
        );
        let tool = json!({ "type": "stream_event", "event": { "type": "content_block_start", "content_block": { "type": "tool_use", "name": "mcp__dem__search" } } });
        assert_eq!(
            parse_event(&tool),
            Some(AiEvent::Tool {
                name: "search".into()
            })
        );
        assert_eq!(parse_event(&json!({ "type": "assistant" })), None);
    }
}
