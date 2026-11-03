//! OpenAI's Codex CLI as a provider (M6, docs/spikes/codex.md). The user installs it and logs in
//! through OpenAI's own flow; the app only starts the unmodified program and never touches its
//! credentials.
//!
//! `codex exec` answers one turn and exits, so each turn is its own process, started with
//! `--ephemeral` so nothing of the conversation is written to disk. The conversation so far goes in
//! on standard input. Each process connects to the gateway again, with a fresh one-time token.
//!
//! Locks, in order: no shell tool (that removes both command tools), no image viewer, no apps or
//! connectors, no sub-agents, the user's own `config.toml` not loaded, a read-only sandbox with no
//! approvals, web search only when the session may have it, and only the gateway's tools on its MCP
//! server. Codex prints no tool list up front the way Claude Code does, so every event is checked as
//! it comes: anything that is not text, reasoning, a plan, a gateway call or an allowed search stops
//! the process at once.

use std::collections::HashSet;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::Value as J;

use crate::{
    AiEvent, AiProvider, AiSessionHandle, McpAccess, ProviderError, ProviderStatus, Result,
    SessionConfig,
};

/// The gateway's name inside Codex.
const SERVER: &str = "dem";

#[derive(Debug, Default)]
pub struct Codex {
    /// Set by tests and by anyone whose install is somewhere unusual.
    pub program: Option<PathBuf>,
    /// The executable that plays the MCP bridge.
    pub shim: Option<PathBuf>,
}

pub fn find_program() -> Option<PathBuf> {
    crate::find_program("codex", &[".codex/bin", ".bun/bin"])
}

/// A TOML string: JSON's quoting is valid TOML for a basic string.
fn toml(s: &str) -> String {
    J::String(s.to_owned()).to_string()
}

fn toml_list(items: &[String]) -> String {
    format!(
        "[{}]",
        items.iter().map(|s| toml(s)).collect::<Vec<_>>().join(",")
    )
}

/// The command line, per docs/spikes/codex.md. Pure, so it can be tested. `state` takes the logs
/// and the state database Codex would otherwise keep in its own folder.
pub fn arguments(config: &SessionConfig, shim: &Path, state: &Path) -> Vec<String> {
    let mut args: Vec<String> = [
        "exec",
        "--json",
        "--ephemeral",
        "--skip-git-repo-check",
        "--ignore-user-config",
        "--sandbox",
        "read-only",
    ]
    .iter()
    .map(|s| (*s).to_owned())
    .collect();
    let mut set = |k: &str, v: String| {
        args.push("-c".to_owned());
        args.push(format!("{k}={v}"));
    };
    set("approval_policy", toml("never"));
    for feature in [
        "shell_tool",
        "view_image",
        "apps",
        "multi_agent",
        "image_generation",
        "memories",
        "hooks",
    ] {
        set(&format!("features.{feature}"), "false".to_owned());
    }
    set("skills.bundled.enabled", "false".to_owned());
    set("skills.include_instructions", "false".to_owned());
    set("history.persistence", toml("none"));
    set("log_dir", toml(&state.display().to_string()));
    set("sqlite_home", toml(&state.display().to_string()));
    set(
        "model_instructions_file",
        toml(&state.join("instructions.md").display().to_string()),
    );
    set(
        "web_search",
        toml(if config.web { "live" } else { "disabled" }),
    );
    let server = format!("mcp_servers.{SERVER}");
    set(
        &format!("{server}.command"),
        toml(&shim.display().to_string()),
    );
    set(
        &format!("{server}.args"),
        toml_list(&["--dem-gw-shim".to_owned()]),
    );
    // Passed through from this process's environment, so the token is never on a command line.
    set(
        &format!("{server}.env_vars"),
        toml_list(&["DEM_GW_SOCKET".to_owned(), "DEM_GW_TOKEN".to_owned()]),
    );
    set(&format!("{server}.required"), "true".to_owned());
    set(
        &format!("{server}.enabled_tools"),
        toml_list(&config.mcp.tool_names),
    );
    // Without this, `exec` cancels every MCP call for want of someone to approve it.
    set(
        &format!("{server}.default_tools_approval_mode"),
        toml("approve"),
    );
    for tool in &config.mcp.tool_names {
        set(
            &format!("{server}.tools.{tool}.approval_mode"),
            toml("approve"),
        );
    }
    if let Some(model) = &config.model {
        args.push("--model".to_owned());
        args.push(model.clone());
    }
    // The message comes on standard input.
    args.push("-".to_owned());
    args
}

/// What one line of `--json` output means.
#[derive(Debug, PartialEq)]
enum Step {
    Event(AiEvent),
    /// The model called one of the gateway's tools.
    Gateway(String),
    /// Something it must not have. The process is stopped.
    Forbidden(String),
    Done {
        input_tokens: u64,
        output_tokens: u64,
    },
    Failed(String),
    Nothing,
}

/// Reads one event. `seen` keeps item ids, so a tool is reported once however many updates it has.
fn read_line(line: &J, web: bool, seen: &mut HashSet<String>) -> Step {
    match line["type"].as_str().unwrap_or("") {
        "item.started" | "item.updated" | "item.completed" => {
            let item = &line["item"];
            let kind = item["type"].as_str().unwrap_or("");
            let first = seen.insert(item["id"].as_str().unwrap_or("").to_owned());
            match kind {
                "agent_message" if line["type"] == "item.completed" => Step::Event(AiEvent::Text {
                    text: item["text"].as_str().unwrap_or("").to_owned(),
                }),
                "agent_message" | "reasoning" | "todo_list" | "error" => Step::Nothing,
                "mcp_tool_call" => {
                    let server = item["server"].as_str().unwrap_or("");
                    if server != SERVER {
                        return Step::Forbidden(format!("a tool from another server: {server}"));
                    }
                    let tool = item["tool"].as_str().unwrap_or("").to_owned();
                    if first {
                        Step::Gateway(tool)
                    } else {
                        Step::Nothing
                    }
                }
                "web_search" if web => {
                    if first {
                        Step::Event(AiEvent::Tool {
                            name: "web_search".to_owned(),
                        })
                    } else {
                        Step::Nothing
                    }
                }
                other => Step::Forbidden(format!("it used something it should not: {other}")),
            }
        }
        "turn.completed" => {
            let u = &line["usage"];
            Step::Done {
                input_tokens: u["input_tokens"].as_u64().unwrap_or(0),
                output_tokens: u["output_tokens"].as_u64().unwrap_or(0),
            }
        }
        "turn.failed" => Step::Failed(
            line["error"]["message"]
                .as_str()
                .unwrap_or("the turn failed")
                .to_owned(),
        ),
        "error" => Step::Failed(line["message"].as_str().unwrap_or("error").to_owned()),
        _ => Step::Nothing,
    }
}

/// The whole conversation for a process that remembers none of it.
fn prompt(history: &[(String, String)], message: &str) -> String {
    if history.is_empty() {
        return message.to_owned();
    }
    let mut out = String::from(
        "The conversation so far, oldest first. Tool results from earlier turns are not kept; call the tools again if you need them.\n\n",
    );
    for (me, ai) in history {
        out.push_str(&format!(
            "<user>\n{me}\n</user>\n<assistant>\n{ai}\n</assistant>\n\n"
        ));
    }
    out.push_str(&format!("The new message:\n\n{message}"));
    out
}

struct Conversation {
    program: PathBuf,
    args: Vec<String>,
    state: PathBuf,
    mcp: McpAccess,
    web: bool,
    history: Vec<(String, String)>,
    turns: u32,
    child: Arc<Mutex<Option<Child>>>,
    stop: Arc<AtomicBool>,
    /// Gateway calls in the last turn, for the self-check.
    gateway_calls: u32,
}

fn fail(e: impl std::fmt::Display) -> ProviderError {
    ProviderError::Failed(e.to_string())
}

impl Codex {
    fn open(&self, config: &SessionConfig) -> Result<Conversation> {
        let program = self
            .program
            .clone()
            .or_else(find_program)
            .ok_or_else(|| ProviderError::Unavailable("Codex".to_owned()))?;
        let shim = match &self.shim {
            Some(s) => s.clone(),
            None => std::env::current_exe().map_err(fail)?,
        };
        let state = config.mcp.private_dir.join("codex");
        std::fs::create_dir_all(state.join("work")).map_err(fail)?;
        std::fs::set_permissions(&state, std::fs::Permissions::from_mode(0o700)).map_err(fail)?;
        let instructions = state.join("instructions.md");
        std::fs::write(&instructions, &config.system).map_err(fail)?;
        std::fs::set_permissions(&instructions, std::fs::Permissions::from_mode(0o600))
            .map_err(fail)?;
        Ok(Conversation {
            args: arguments(config, &shim, &state),
            program,
            state,
            mcp: config.mcp.clone(),
            web: config.web,
            history: Vec::new(),
            turns: 0,
            child: Arc::new(Mutex::new(None)),
            stop: Arc::new(AtomicBool::new(false)),
            gateway_calls: 0,
        })
    }
}

impl Conversation {
    fn kill(&self) {
        if let Ok(mut c) = self.child.lock()
            && let Some(child) = c.as_mut()
        {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

impl Drop for Conversation {
    fn drop(&mut self) {
        self.kill();
    }
}

impl AiSessionHandle for Conversation {
    fn send(&mut self, message: &str, on: &mut dyn FnMut(AiEvent)) -> Result<()> {
        self.stop.store(false, Ordering::Relaxed);
        self.gateway_calls = 0;
        // The first process uses the token the gateway started with; each later one gets its own.
        let token = if self.turns == 0 {
            self.mcp.token.clone()
        } else {
            let issue = self.mcp.reissue.as_ref().ok_or_else(|| {
                ProviderError::Failed("the gateway cannot be reached again".into())
            })?;
            issue()
        };
        self.turns += 1;
        let mut child = Command::new(&self.program)
            .args(&self.args)
            .current_dir(self.state.join("work"))
            .env("DEM_GW_SOCKET", &self.mcp.socket)
            .env("DEM_GW_TOKEN", token)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(fail)?;
        let input = prompt(&self.history, message);
        let mut stdin = child.stdin.take().ok_or_else(|| fail("no input"))?;
        let stdout = child.stdout.take().ok_or_else(|| fail("no output"))?;
        if let Ok(mut c) = self.child.lock() {
            *c = Some(child);
        }
        stdin.write_all(input.as_bytes()).map_err(fail)?;
        // Closed, so Codex knows the message is whole.
        drop(stdin);
        let mut seen = HashSet::new();
        let mut answer = String::new();
        let mut finished = None;
        let mut buf = String::new();
        let mut reader = BufReader::new(stdout);
        loop {
            buf.clear();
            let n = reader.read_line(&mut buf).map_err(fail)?;
            if n == 0 {
                break;
            }
            let Ok(event) = serde_json::from_str::<J>(&buf) else {
                continue;
            };
            match read_line(&event, self.web, &mut seen) {
                Step::Event(e) => {
                    if let AiEvent::Text { text } = &e {
                        if !answer.is_empty() {
                            answer.push_str("\n\n");
                            on(AiEvent::Text {
                                text: "\n\n".to_owned(),
                            });
                        }
                        answer.push_str(text);
                    }
                    on(e);
                }
                Step::Gateway(name) => {
                    self.gateway_calls += 1;
                    on(AiEvent::Tool { name });
                }
                Step::Forbidden(why) => {
                    self.kill();
                    return Err(ProviderError::SelfCheck(why));
                }
                Step::Done {
                    input_tokens,
                    output_tokens,
                } => {
                    on(AiEvent::Usage {
                        input_tokens,
                        output_tokens,
                        cost_usd: None,
                    });
                    finished = Some(Ok(()));
                }
                Step::Failed(why) => finished = Some(Err(ProviderError::Failed(why))),
                Step::Nothing => {}
            }
        }
        self.kill();
        if self.stop.load(Ordering::Relaxed) {
            return Err(ProviderError::Stopped);
        }
        match finished {
            Some(Ok(())) => {
                self.history.push((message.to_owned(), answer));
                Ok(())
            }
            Some(Err(e)) => Err(e),
            // Gone before the turn was over: a bad flag, the gateway not connecting, or a crash.
            None => Err(ProviderError::Failed(
                "Codex stopped before answering".into(),
            )),
        }
    }

    fn stopper(&self) -> Arc<dyn Fn() + Send + Sync> {
        let child = self.child.clone();
        let stop = self.stop.clone();
        Arc::new(move || {
            stop.store(true, Ordering::Relaxed);
            if let Ok(mut c) = child.lock()
                && let Some(child) = c.as_mut()
            {
                let _ = child.kill();
            }
        })
    }
}

/// Asks for a gateway call, and for a command if it has any way to run one: a shell that slipped
/// back in shows up as a command event and fails the check.
const CHECK: &str = "Call the tool `context` once. Then, only if you have any tool that runs shell commands or reads files, use it to run `pwd`. Then reply with the single word ok.";

impl AiProvider for Codex {
    fn id(&self) -> &'static str {
        "codex"
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
        // Whether it is logged in. The exit code is all that is read.
        let ready = run(&["login", "status"]).is_some_and(|o| o.status.success());
        ProviderStatus {
            available: true,
            detail: version,
            ready,
        }
    }

    fn start(&self, config: SessionConfig) -> Result<Box<dyn AiSessionHandle>> {
        Ok(Box::new(self.open(&config)?))
    }

    /// One tiny turn on a throwaway gateway session.
    fn self_check(&self, config: SessionConfig) -> Option<Result<()>> {
        Some((|| {
            let mut conversation = self.open(&config)?;
            conversation.send(CHECK, &mut |_| {})?;
            if conversation.gateway_calls == 0 {
                return Err(ProviderError::SelfCheck(
                    "the gateway did not connect".to_owned(),
                ));
            }
            Ok(())
        })())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ToolHost;
    use serde_json::json;

    struct NoTools;
    impl ToolHost for NoTools {
        fn tools(&self) -> Vec<J> {
            vec![]
        }
        fn call(&self, _: &str, _: &J) -> std::result::Result<String, String> {
            Err("no".into())
        }
    }

    fn config(web: bool, private_dir: &Path, reissue: bool) -> SessionConfig {
        let counter = Arc::new(Mutex::new(0));
        SessionConfig {
            system: "sys".into(),
            model: None,
            web,
            mcp: McpAccess {
                socket: "/x".into(),
                token: "t0".into(),
                reissue: reissue.then(|| {
                    let counter = counter.clone();
                    Arc::new(move || {
                        let mut n = counter.lock().unwrap();
                        *n += 1;
                        format!("t{n}")
                    }) as crate::TokenIssuer
                }),
                private_dir: private_dir.to_path_buf(),
                tool_names: vec!["search".into(), "context".into()],
            },
            tools: Arc::new(NoTools),
            isolate: true,
        }
    }

    fn values(args: &[String]) -> Vec<&str> {
        args.windows(2)
            .filter(|w| w[0] == "-c")
            .map(|w| w[1].as_str())
            .collect()
    }

    #[test]
    fn a_plain_session_has_the_gateway_and_the_web_and_nothing_else() {
        let a = arguments(
            &config(true, Path::new("/p"), true),
            Path::new("/app"),
            Path::new("/s"),
        );
        let c = values(&a);
        for want in [
            "features.shell_tool=false",
            "features.view_image=false",
            "features.apps=false",
            "features.multi_agent=false",
            "approval_policy=\"never\"",
            "web_search=\"live\"",
            "mcp_servers.dem.required=true",
            "mcp_servers.dem.enabled_tools=[\"search\",\"context\"]",
            "mcp_servers.dem.tools.search.approval_mode=\"approve\"",
            "history.persistence=\"none\"",
        ] {
            assert!(c.contains(&want), "{want}");
        }
        for flag in ["--ephemeral", "--ignore-user-config", "--json", "read-only"] {
            assert!(a.contains(&flag.to_owned()), "{flag}");
        }
        assert_eq!(a.last().map(String::as_str), Some("-"));
        // The token travels in the environment, never on the command line.
        assert!(!a.iter().any(|x| x.contains("t0")));
    }

    #[test]
    fn an_authorized_session_has_no_web_at_all() {
        let a = arguments(
            &config(false, Path::new("/p"), true),
            Path::new("/app"),
            Path::new("/s"),
        );
        let c = values(&a);
        assert!(c.contains(&"web_search=\"disabled\""));
        assert!(!c.iter().any(|v| v.contains("\"live\"")));
    }

    #[test]
    fn every_event_it_should_not_have_stops_it() {
        let mut seen = HashSet::new();
        let item = |t: &str, kind: &str, extra: J| {
            let mut item = json!({ "id": format!("{kind}-{t}"), "type": kind });
            if let (Some(i), Some(e)) = (item.as_object_mut(), extra.as_object()) {
                i.extend(e.clone());
            }
            json!({ "type": t, "item": item })
        };
        for (kind, extra) in [
            ("command_execution", json!({ "command": "pwd" })),
            ("file_change", json!({ "changes": [] })),
            ("collab_tool_call", json!({})),
            ("something_new", json!({})),
        ] {
            assert!(
                matches!(
                    read_line(&item("item.started", kind, extra), true, &mut seen),
                    Step::Forbidden(_)
                ),
                "{kind}"
            );
        }
        let other_server = item(
            "item.started",
            "mcp_tool_call",
            json!({ "server": "gmail", "tool": "send" }),
        );
        assert!(matches!(
            read_line(&other_server, true, &mut seen),
            Step::Forbidden(_)
        ));
        let search = item("item.started", "web_search", json!({ "query": "q" }));
        assert!(matches!(
            read_line(&search, false, &mut seen),
            Step::Forbidden(_)
        ));
        let mut fresh = HashSet::new();
        assert_eq!(
            read_line(&search, true, &mut fresh),
            Step::Event(AiEvent::Tool {
                name: "web_search".into()
            })
        );
    }

    #[test]
    fn reads_text_gateway_calls_and_usage() {
        let mut seen = HashSet::new();
        let call = json!({ "type": "item.started", "item": { "id": "1", "type": "mcp_tool_call", "server": "dem", "tool": "search" } });
        assert_eq!(
            read_line(&call, false, &mut seen),
            Step::Gateway("search".into())
        );
        let again = json!({ "type": "item.completed", "item": { "id": "1", "type": "mcp_tool_call", "server": "dem", "tool": "search" } });
        assert_eq!(read_line(&again, false, &mut seen), Step::Nothing);
        let text = json!({ "type": "item.completed", "item": { "id": "2", "type": "agent_message", "text": "你好" } });
        assert_eq!(
            read_line(&text, false, &mut seen),
            Step::Event(AiEvent::Text {
                text: "你好".into()
            })
        );
        let done = json!({ "type": "turn.completed", "usage": { "input_tokens": 9, "cached_input_tokens": 4, "output_tokens": 2 } });
        assert_eq!(
            read_line(&done, false, &mut seen),
            Step::Done {
                input_tokens: 9,
                output_tokens: 2
            }
        );
        let failed = json!({ "type": "turn.failed", "error": { "message": "limit" } });
        assert_eq!(
            read_line(&failed, false, &mut seen),
            Step::Failed("limit".into())
        );
    }

    #[test]
    fn later_turns_carry_the_conversation_so_far() {
        assert_eq!(prompt(&[], "问"), "问");
        let p = prompt(&[("一".into(), "二".into())], "三");
        assert!(p.contains("<user>\n一\n</user>") && p.contains("<assistant>\n二\n</assistant>"));
        assert!(p.ends_with("三"));
    }

    /// A stand-in for Codex: a script that prints what it was given, then the canned events.
    fn fake(dir: &Path, events: &[J]) -> PathBuf {
        let script = dir.join("fake-codex");
        let lines: String = events.iter().map(|e| format!("{e}\n")).collect();
        std::fs::write(dir.join("events.jsonl"), lines).unwrap();
        std::fs::write(
            &script,
            format!(
                "#!/bin/sh\ncat > \"{0}/stdin.txt\"\necho \"$DEM_GW_TOKEN\" >> \"{0}/tokens.txt\"\ncat \"{0}/events.jsonl\"\n",
                dir.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        script
    }

    fn temp() -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "dem-codex-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn each_turn_is_a_new_process_with_a_new_token_and_the_history() {
        let dir = temp();
        let program = fake(
            &dir,
            &[
                json!({ "type": "item.started", "item": { "id": "1", "type": "mcp_tool_call", "server": "dem", "tool": "context" } }),
                json!({ "type": "item.completed", "item": { "id": "2", "type": "agent_message", "text": "ok" } }),
                json!({ "type": "turn.completed", "usage": { "input_tokens": 1, "output_tokens": 1 } }),
            ],
        );
        let codex = Codex {
            program: Some(program),
            shim: Some("/app".into()),
        };
        let mut s = codex.start(config(true, &dir, true)).unwrap();
        let mut events = Vec::new();
        s.send("第一句", &mut |e| events.push(e)).unwrap();
        s.send("第二句", &mut |e| events.push(e)).unwrap();
        assert!(events.contains(&AiEvent::Tool {
            name: "context".into()
        }));
        let tokens = std::fs::read_to_string(dir.join("tokens.txt")).unwrap();
        assert_eq!(tokens, "t0\nt1\n");
        let stdin = std::fs::read_to_string(dir.join("stdin.txt")).unwrap();
        assert!(stdin.contains("第一句") && stdin.contains("ok") && stdin.ends_with("第二句"));
        let instructions = std::fs::read_to_string(dir.join("codex/instructions.md")).unwrap();
        assert_eq!(instructions, "sys");
        assert!(codex.self_check(config(true, &dir, true)).unwrap().is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_command_ends_the_session_and_fails_the_self_check() {
        let dir = temp();
        let program = fake(
            &dir,
            &[
                json!({ "type": "item.started", "item": { "id": "1", "type": "command_execution", "command": "pwd", "status": "in_progress" } }),
                json!({ "type": "item.completed", "item": { "id": "2", "type": "agent_message", "text": "ok" } }),
                json!({ "type": "turn.completed", "usage": {} }),
            ],
        );
        let codex = Codex {
            program: Some(program),
            shim: Some("/app".into()),
        };
        let mut s = codex.start(config(true, &dir, true)).unwrap();
        assert!(matches!(
            s.send("问", &mut |_| {}),
            Err(ProviderError::SelfCheck(_))
        ));
        assert!(matches!(
            codex.self_check(config(true, &dir, true)),
            Some(Err(ProviderError::SelfCheck(_)))
        ));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn no_gateway_call_fails_the_self_check() {
        let dir = temp();
        let program = fake(
            &dir,
            &[
                json!({ "type": "item.completed", "item": { "id": "2", "type": "agent_message", "text": "ok" } }),
                json!({ "type": "turn.completed", "usage": {} }),
            ],
        );
        let codex = Codex {
            program: Some(program),
            shim: Some("/app".into()),
        };
        assert!(matches!(
            codex.self_check(config(true, &dir, true)),
            Some(Err(ProviderError::SelfCheck(_)))
        ));
        // Gone without finishing the turn is an error too.
        let silent = fake(&dir, &[]);
        let codex = Codex {
            program: Some(silent),
            shim: Some("/app".into()),
        };
        let mut s = codex.start(config(true, &dir, true)).unwrap();
        assert!(s.send("问", &mut |_| {}).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
