//! MCP over a local socket, one line of JSON-RPC at a time. Only `initialize`, `tools/list`,
//! `tools/call` and `ping`: that is all the app offers and all Claude Code asks for here.

use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use dem_core::CoreHandle;
use dem_core::ai_tools::{Effects, ToolSession, tool_list};
use serde_json::{Value as J, json};

/// Told about what each call did besides answering.
pub type ToolEvents = Arc<dyn Fn(&str, Effects) + Send + Sync>;

/// Tools the app adds for one session beside the library's, such as the dedicated browser. They
/// reach no library data, so the restricted view has nothing to say about them; whether a session
/// gets them at all is decided where the session starts.
pub trait AppTools: Send + Sync {
    /// Definitions in the same shape as `tool_list`.
    fn tools(&self) -> Vec<J>;
    /// `None` when `name` is not one of these.
    fn call(&self, name: &str, args: &J) -> Option<Result<String, String>>;
}

pub type SharedAppTools = Option<Arc<dyn AppTools>>;

/// The library's tools and then the app's, for one session.
pub fn all_tools(app: &SharedAppTools) -> Vec<J> {
    let mut all = tool_list();
    if let Some(app) = app {
        all.extend(app.tools());
    }
    all
}

/// Runs one tool for this session: what the MCP server and the API-key provider both call.
pub fn run_tool(
    core: &CoreHandle,
    session: &ToolSession,
    events: &ToolEvents,
    tool: &str,
    args: &J,
) -> Result<String, String> {
    let mut effects = Effects::default();
    let out = core
        .with(|s| Ok(s.ai_call(session, tool, args, &mut effects)))
        .map_err(|_| "the library is locked".to_owned())?;
    events(tool, effects);
    out
}

fn respond(id: &J, result: J) -> String {
    json!({ "jsonrpc": "2.0", "id": id, "result": result }).to_string()
}

fn handle_line(
    line: &str,
    core: &CoreHandle,
    session: &ToolSession,
    events: &ToolEvents,
    app: &SharedAppTools,
) -> Option<String> {
    let msg: J = serde_json::from_str(line).ok()?;
    let id = msg.get("id")?.clone();
    let method = msg.get("method").and_then(J::as_str).unwrap_or("");
    let params = msg.get("params").cloned().unwrap_or(J::Null);
    Some(match method {
        "initialize" => {
            let version = params
                .get("protocolVersion")
                .cloned()
                .unwrap_or_else(|| json!("2025-06-18"));
            respond(
                &id,
                json!({
                    "protocolVersion": version,
                    "capabilities": { "tools": {} },
                    "serverInfo": { "name": "dem", "version": env!("CARGO_PKG_VERSION") },
                }),
            )
        }
        "ping" => respond(&id, json!({})),
        "tools/list" => {
            let tools: Vec<J> = all_tools(app)
                .into_iter()
                .map(|t| {
                    json!({
                        "name": t["name"],
                        "description": t["description"],
                        "inputSchema": t["input_schema"],
                    })
                })
                .collect();
            respond(&id, json!({ "tools": tools }))
        }
        "tools/call" => {
            let name = params.get("name").and_then(J::as_str).unwrap_or("");
            let args = params
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            let answer = app
                .as_ref()
                .and_then(|a| a.call(name, &args))
                .unwrap_or_else(|| run_tool(core, session, events, name, &args));
            let (text, is_error) = match answer {
                Ok(t) => (t, false),
                Err(t) => (t, true),
            };
            respond(
                &id,
                json!({ "content": [{ "type": "text", "text": text }], "isError": is_error }),
            )
        }
        other => json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": -32601, "message": format!("no method {other}") },
        })
        .to_string(),
    })
}

/// The gateway for one AI session. Dropping it closes the socket; once the app is gone, AI can read
/// nothing at all.
#[derive(Debug)]
pub struct GatewayServer {
    dir: PathBuf,
    socket: PathBuf,
    token: String,
    /// The one token that would be accepted now, if any.
    expected: Arc<Mutex<Option<String>>>,
    closed: Arc<AtomicBool>,
}

impl GatewayServer {
    pub fn start(
        runtime_dir: &Path,
        core: CoreHandle,
        session: ToolSession,
        events: ToolEvents,
    ) -> std::io::Result<GatewayServer> {
        GatewayServer::start_with(runtime_dir, core, session, events, None)
    }

    /// With the app's own tools for this session as well.
    pub fn start_with(
        runtime_dir: &Path,
        core: CoreHandle,
        session: ToolSession,
        events: ToolEvents,
        app: SharedAppTools,
    ) -> std::io::Result<GatewayServer> {
        let dir = runtime_dir.join(format!("gw-{}", uuid::Uuid::now_v7().simple()));
        std::fs::create_dir_all(&dir)?;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
        let socket = dir.join("gw.sock");
        let listener = UnixListener::bind(&socket)?;
        std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o600))?;
        let token = dem_core::random_token();
        let closed = Arc::new(AtomicBool::new(false));
        let expected = Arc::new(Mutex::new(Some(token.clone())));
        let stop = closed.clone();
        let waiting = expected.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                if stop.load(Ordering::Relaxed) {
                    break;
                }
                let (core, session, events) = (core.clone(), session.clone(), events.clone());
                let (expected, app) = (waiting.clone(), app.clone());
                std::thread::spawn(move || {
                    serve(stream, &expected, &core, &session, &events, &app);
                });
            }
        });
        Ok(GatewayServer {
            dir,
            socket,
            token,
            expected,
            closed,
        })
    }

    pub fn socket(&self) -> &Path {
        &self.socket
    }

    pub fn token(&self) -> &str {
        &self.token
    }

    /// For a program that connects once per turn (Codex): each call makes a new one-time token and
    /// drops any that was not used. Still one connection per token, and still this session only.
    pub fn issuer(&self) -> Arc<dyn Fn() -> String + Send + Sync> {
        let expected = self.expected.clone();
        Arc::new(move || {
            let token = dem_core::random_token();
            if let Ok(mut t) = expected.lock() {
                *t = Some(token.clone());
            }
            token
        })
    }

    /// Where to put per-session files that only this user can read.
    pub fn dir(&self) -> &Path {
        &self.dir
    }
}

impl Drop for GatewayServer {
    fn drop(&mut self) {
        self.closed.store(true, Ordering::Relaxed);
        // Wakes the listener so its thread can see it is closed.
        let _ = UnixStream::connect(&self.socket);
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn same_user(stream: &UnixStream) -> bool {
    nix::unistd::getpeereid(stream).is_ok_and(|(uid, _)| uid == nix::unistd::getuid())
}

fn serve(
    stream: UnixStream,
    expected: &Mutex<Option<String>>,
    core: &CoreHandle,
    session: &ToolSession,
    events: &ToolEvents,
    app: &SharedAppTools,
) {
    if !same_user(&stream) {
        return;
    }
    let Ok(reader) = stream.try_clone() else {
        return;
    };
    let mut reader = BufReader::new(reader);
    let mut first = String::new();
    if reader.read_line(&mut first).is_err() {
        return;
    }
    // Used once, then gone.
    let accepted = expected
        .lock()
        .ok()
        .is_some_and(|mut t| t.as_deref() == Some(first.trim()) && t.take().is_some());
    if !accepted {
        return;
    }
    let mut out = stream;
    for line in reader.lines() {
        let Ok(line) = line else { break };
        if let Some(answer) = handle_line(&line, core, session, events, app)
            && writeln!(out, "{answer}").is_err()
        {
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dem_core::{Core, MemoryKeychain};
    use dem_model::AiSession;

    fn start(core: &Core, dir: &Path) -> GatewayServer {
        GatewayServer::start(
            dir,
            core.handle(),
            ToolSession {
                id: "s".into(),
                kind: AiSession::Plain,
                learning: false,
            },
            Arc::new(|_, _| {}),
        )
        .unwrap()
    }

    fn talk(stream: &mut UnixStream, line: &str) -> Option<J> {
        writeln!(stream, "{line}").ok()?;
        let mut reader = BufReader::new(stream.try_clone().ok()?);
        let mut answer = String::new();
        reader.read_line(&mut answer).ok()?;
        serde_json::from_str(&answer).ok()
    }

    fn core_in(dir: &Path) -> Core {
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
    fn a_token_works_once_and_a_wrong_one_gets_nothing() {
        let d = tempfile::tempdir().unwrap();
        let core = core_in(d.path());
        let gw = start(&core, d.path());
        let mut wrong = UnixStream::connect(gw.socket()).unwrap();
        writeln!(wrong, "not the token").unwrap();
        assert!(
            talk(
                &mut wrong,
                r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#
            )
            .is_none()
        );

        let mut good = UnixStream::connect(gw.socket()).unwrap();
        writeln!(good, "{}", gw.token()).unwrap();
        let tools = talk(
            &mut good,
            r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#,
        )
        .unwrap();
        let names: Vec<&str> = tools["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap())
            .collect();
        assert!(names.contains(&"search") && names.contains(&"propose_changes"));
        assert!(
            !names
                .iter()
                .any(|n| n.contains("delete") || n.contains("setting"))
        );

        let mut replay = UnixStream::connect(gw.socket()).unwrap();
        writeln!(replay, "{}", gw.token()).unwrap();
        assert!(
            talk(
                &mut replay,
                r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#
            )
            .is_none()
        );
    }

    #[test]
    fn a_reissued_token_works_once_and_retires_the_one_before() {
        let d = tempfile::tempdir().unwrap();
        let core = core_in(d.path());
        let gw = start(&core, d.path());
        let list = r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#;
        let issue = gw.issuer();
        let unused = issue();
        let second = issue();
        let connect = |token: &str| {
            let mut s = UnixStream::connect(gw.socket()).unwrap();
            writeln!(s, "{token}").unwrap();
            talk(&mut s, list)
        };
        assert!(connect(gw.token()).is_none(), "the first was replaced");
        assert!(connect(&unused).is_none(), "and so was the unused one");
        assert!(connect(&second).is_some());
        assert!(connect(&second).is_none(), "once only");
    }

    #[test]
    fn the_socket_is_private_and_goes_away_with_the_session() {
        let d = tempfile::tempdir().unwrap();
        let core = core_in(d.path());
        let gw = start(&core, d.path());
        let mode = std::fs::metadata(gw.dir()).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o700);
        let path = gw.socket().to_path_buf();
        drop(gw);
        assert!(!path.exists());
    }

    #[test]
    fn tool_errors_are_flagged_and_nothing_answers_a_locked_library() {
        let d = tempfile::tempdir().unwrap();
        let core = core_in(d.path());
        let gw = start(&core, d.path());
        let mut s = UnixStream::connect(gw.socket()).unwrap();
        writeln!(s, "{}", gw.token()).unwrap();
        let call = r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"read_item","arguments":{"id":"x"}}}"#;
        let r = talk(&mut s, call).unwrap();
        assert_eq!(r["result"]["isError"], true);
        core.lock().unwrap();
        let r = talk(&mut s, call).unwrap();
        assert_eq!(r["result"]["isError"], true);
        assert_eq!(r["result"]["content"][0]["text"], "the library is locked");
    }

    struct Pages;

    impl AppTools for Pages {
        fn tools(&self) -> Vec<J> {
            vec![
                json!({ "name": "browser_read", "description": "d", "input_schema": { "type": "object" } }),
            ]
        }

        fn call(&self, name: &str, _args: &J) -> Option<Result<String, String>> {
            (name == "browser_read").then(|| Ok("a page".to_owned()))
        }
    }

    #[test]
    fn the_apps_tools_are_offered_beside_the_librarys_and_answer_for_themselves() {
        let d = tempfile::tempdir().unwrap();
        let core = core_in(d.path());
        let session = ToolSession {
            id: "s".into(),
            kind: AiSession::Plain,
            learning: false,
        };
        let gw = GatewayServer::start_with(
            d.path(),
            core.handle(),
            session,
            Arc::new(|_, _| {}),
            Some(Arc::new(Pages)),
        )
        .unwrap();
        let mut s = UnixStream::connect(gw.socket()).unwrap();
        writeln!(s, "{}", gw.token()).unwrap();
        let tools = talk(&mut s, r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#).unwrap();
        let names: Vec<&str> = tools["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap())
            .collect();
        assert!(names.contains(&"search") && names.contains(&"browser_read"));
        let r = talk(
            &mut s,
            r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"browser_read","arguments":{}}}"#,
        )
        .unwrap();
        assert_eq!(r["result"]["content"][0]["text"], "a page");
        // Library tools still go through the restricted view.
        let r = talk(
            &mut s,
            r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"read_item","arguments":{"id":"x"}}}"#,
        )
        .unwrap();
        assert_eq!(r["result"]["isError"], true);
    }
}
