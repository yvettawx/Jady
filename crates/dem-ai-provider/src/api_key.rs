//! An API key as a provider (M6): the user's own key from the Claude Console, kept in the system
//! keychain and handed in only for the moment it is needed. The Messages API over HTTP, with the
//! tool loop here: there is no official Rust SDK. Same tools, same gateway rules as Claude Code.

use std::io::{BufRead, BufReader};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::{Value as J, json};

use crate::{
    AiEvent, AiProvider, AiSessionHandle, ProviderError, ProviderStatus, Result, SessionConfig,
    ToolHost,
};

pub const DEFAULT_MODEL: &str = "claude-opus-5-5";
const API: &str = "https://api.anthropic.com";
const MAX_TOKENS: u64 = 64_000;
/// How many model turns one message may take, as a brake on a loop.
const MAX_ROUNDS: u32 = 30;

/// Where the key comes from; asked each time, so it is held no longer than a request.
pub type KeySource = Arc<dyn Fn() -> Option<String> + Send + Sync>;

pub struct ApiKey {
    pub key: KeySource,
    /// Tests point this at a local server.
    pub base: Option<String>,
}

impl std::fmt::Debug for ApiKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ApiKey")
    }
}

impl AiProvider for ApiKey {
    fn id(&self) -> &'static str {
        "api-key"
    }

    fn status(&self) -> ProviderStatus {
        let ready = (self.key)().is_some();
        ProviderStatus {
            available: true,
            detail: String::new(),
            ready,
        }
    }

    fn start(&self, config: SessionConfig) -> Result<Box<dyn AiSessionHandle>> {
        Ok(Box::new(Conversation {
            key: self.key.clone(),
            base: self.base.clone().unwrap_or_else(|| API.to_owned()),
            system: config.system,
            model: config.model.unwrap_or_else(|| DEFAULT_MODEL.to_owned()),
            web: config.web,
            tools: config.tools,
            messages: Vec::new(),
            stop: Arc::new(AtomicBool::new(false)),
        }))
    }
}

struct Conversation {
    key: KeySource,
    base: String,
    system: String,
    model: String,
    web: bool,
    tools: Arc<dyn ToolHost>,
    messages: Vec<J>,
    stop: Arc<AtomicBool>,
}

impl Conversation {
    /// The request body. Pure, so the rules about tools can be tested.
    fn body(&self) -> J {
        let mut tools: Vec<J> = self.tools.tools();
        // Dynamic filtering needs a larger model; Haiku has the basic versions.
        let small = self.model.contains("haiku");
        if self.web {
            let (search, fetch) = if small {
                ("web_search_20250305", "web_fetch_20250910")
            } else {
                ("web_search_20260209", "web_fetch_20260209")
            };
            tools.push(json!({ "type": search, "name": "web_search" }));
            tools.push(json!({ "type": fetch, "name": "web_fetch" }));
        }
        let mut body = json!({
            "model": self.model,
            "max_tokens": MAX_TOKENS,
            "stream": true,
            "system": self.system,
            "thinking": { "type": "adaptive" },
            "output_config": { "effort": "medium" },
            "tools": tools,
            "messages": self.messages,
        });
        // A refusal by a safety check falls back to another model on the server; Haiku has none.
        if !small {
            body["fallbacks"] = json!("default");
        }
        body
    }

    /// One request; returns the assistant's content blocks, whole, and why it stopped.
    fn round(&mut self, on: &mut dyn FnMut(AiEvent)) -> Result<(Vec<J>, String)> {
        let key = (self.key)().ok_or_else(|| ProviderError::Unavailable("API key".to_owned()))?;
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .build()
            .into();
        let body = self.body();
        let mut response = agent
            .post(format!("{}/v1/messages", self.base))
            .header("x-api-key", &key)
            .header("anthropic-version", "2023-06-01")
            .header("anthropic-beta", "server-side-fallback-2026-07-01")
            .header("content-type", "application/json")
            .send(body.to_string())
            .map_err(|e| ProviderError::Failed(e.to_string()))?;
        let status = response.status();
        if !status.is_success() {
            let text = response.body_mut().read_to_string().unwrap_or_default();
            let message = serde_json::from_str::<J>(&text)
                .ok()
                .and_then(|v| v["error"]["message"].as_str().map(str::to_owned))
                .unwrap_or_else(|| status.to_string());
            return Err(ProviderError::Failed(crate::redact(&message, Some(&key))));
        }
        drop(key);
        let reader = BufReader::new(response.body_mut().as_reader());
        let mut blocks: Vec<J> = Vec::new();
        let mut partial: Vec<String> = Vec::new();
        let mut stop_reason = String::new();
        let mut input_tokens = 0;
        let mut output_tokens = 0;
        for line in reader.lines() {
            if self.stop.load(Ordering::Relaxed) {
                return Err(ProviderError::Stopped);
            }
            let line = line.map_err(|e| ProviderError::Failed(e.to_string()))?;
            let Some(data) = line.strip_prefix("data:") else {
                continue;
            };
            let Ok(event) = serde_json::from_str::<J>(data.trim()) else {
                continue;
            };
            match event["type"].as_str().unwrap_or("") {
                "message_start" => {
                    let u = &event["message"]["usage"];
                    input_tokens = u["input_tokens"].as_u64().unwrap_or(0)
                        + u["cache_read_input_tokens"].as_u64().unwrap_or(0)
                        + u["cache_creation_input_tokens"].as_u64().unwrap_or(0);
                }
                "content_block_start" => {
                    let block = event["content_block"].clone();
                    if matches!(block["type"].as_str(), Some("tool_use" | "server_tool_use")) {
                        on(AiEvent::Tool {
                            name: block["name"].as_str().unwrap_or("").to_owned(),
                        });
                    }
                    blocks.push(block);
                    partial.push(String::new());
                }
                "content_block_delta" => {
                    let i = event["index"].as_u64().unwrap_or(0) as usize;
                    let delta = &event["delta"];
                    let Some(block) = blocks.get_mut(i) else {
                        continue;
                    };
                    match delta["type"].as_str().unwrap_or("") {
                        "text_delta" => {
                            let t = delta["text"].as_str().unwrap_or("");
                            let whole = format!("{}{t}", block["text"].as_str().unwrap_or(""));
                            block["text"] = J::String(whole);
                            on(AiEvent::Text { text: t.to_owned() });
                        }
                        "thinking_delta" => {
                            let t = delta["thinking"].as_str().unwrap_or("");
                            let whole = format!("{}{t}", block["thinking"].as_str().unwrap_or(""));
                            block["thinking"] = J::String(whole);
                        }
                        "signature_delta" => {
                            block["signature"] = delta["signature"].clone();
                        }
                        "input_json_delta" => {
                            if let Some(p) = partial.get_mut(i) {
                                p.push_str(delta["partial_json"].as_str().unwrap_or(""));
                            }
                        }
                        _ => {}
                    }
                }
                "content_block_stop" => {
                    let i = event["index"].as_u64().unwrap_or(0) as usize;
                    if let (Some(block), Some(p)) = (blocks.get_mut(i), partial.get(i))
                        && !p.is_empty()
                    {
                        block["input"] = serde_json::from_str(p).unwrap_or_else(|_| json!({}));
                    }
                }
                "message_delta" => {
                    stop_reason = event["delta"]["stop_reason"]
                        .as_str()
                        .unwrap_or("")
                        .to_owned();
                    output_tokens = event["usage"]["output_tokens"].as_u64().unwrap_or(0);
                }
                "error" => {
                    return Err(ProviderError::Failed(
                        event["error"]["message"]
                            .as_str()
                            .unwrap_or("error")
                            .to_owned(),
                    ));
                }
                _ => {}
            }
        }
        on(AiEvent::Usage {
            input_tokens,
            output_tokens,
            cost_usd: None,
        });
        Ok((blocks, stop_reason))
    }
}

impl AiSessionHandle for Conversation {
    fn send(&mut self, message: &str, on: &mut dyn FnMut(AiEvent)) -> Result<()> {
        self.stop.store(false, Ordering::Relaxed);
        self.messages
            .push(json!({ "role": "user", "content": message }));
        for _ in 0..MAX_ROUNDS {
            let (blocks, stop_reason) = self.round(on)?;
            // Whole, thinking blocks included: the API needs them back unchanged.
            self.messages
                .push(json!({ "role": "assistant", "content": blocks }));
            match stop_reason.as_str() {
                // A long server-side search paused; sending it back lets it carry on.
                "pause_turn" => continue,
                "tool_use" => {
                    let mut results = Vec::new();
                    for b in &blocks {
                        if b["type"] != "tool_use" {
                            continue;
                        }
                        let name = b["name"].as_str().unwrap_or("");
                        let args = if b["input"].is_object() {
                            b["input"].clone()
                        } else {
                            json!({})
                        };
                        let (text, is_error) = match self.tools.call(name, &args) {
                            Ok(t) => (t, false),
                            Err(t) => (t, true),
                        };
                        results.push(json!({
                            "type": "tool_result",
                            "tool_use_id": b["id"],
                            "content": text,
                            "is_error": is_error,
                        }));
                    }
                    // All in one message, as the API wants them.
                    self.messages
                        .push(json!({ "role": "user", "content": results }));
                }
                "refusal" | "max_tokens" => {
                    on(AiEvent::Stopped {
                        reason: stop_reason,
                    });
                    return Ok(());
                }
                _ => return Ok(()),
            }
        }
        on(AiEvent::Stopped {
            reason: "too many rounds".to_owned(),
        });
        Ok(())
    }

    fn stopper(&self) -> Arc<dyn Fn() + Send + Sync> {
        let stop = self.stop.clone();
        Arc::new(move || stop.store(true, Ordering::Relaxed))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::McpAccess;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::Mutex;

    struct Host(Mutex<Vec<(String, J)>>);
    impl ToolHost for Host {
        fn tools(&self) -> Vec<J> {
            vec![
                json!({ "name": "search", "description": "d", "input_schema": { "type": "object" } }),
            ]
        }
        fn call(&self, name: &str, args: &J) -> std::result::Result<String, String> {
            self.0.lock().unwrap().push((name.to_owned(), args.clone()));
            if name == "read_item" {
                Err("item not found or not accessible".into())
            } else {
                Ok("结果".into())
            }
        }
    }

    fn config(web: bool, host: Arc<Host>) -> SessionConfig {
        SessionConfig {
            system: "sys".into(),
            model: None,
            web,
            mcp: McpAccess {
                socket: "/x".into(),
                token: "t".into(),
                reissue: None,
                private_dir: "/p".into(),
                tool_names: vec![],
            },
            tools: host,
            isolate: true,
        }
    }

    type Seen = Arc<Mutex<Vec<(String, J)>>>;

    /// Answers each POST with the next canned event stream and keeps the bodies.
    fn server(replies: Vec<String>) -> (String, Seen) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = format!("http://{}", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        std::thread::spawn(move || {
            for (reply, stream) in replies.into_iter().zip(listener.incoming()) {
                let mut s = stream.unwrap();
                let mut raw = Vec::new();
                let mut buf = [0u8; 4096];
                loop {
                    let n = s.read(&mut buf).unwrap();
                    raw.extend_from_slice(&buf[..n]);
                    let text = String::from_utf8_lossy(&raw);
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
                                .push((head.to_owned(), serde_json::from_str(body).unwrap()));
                            break;
                        }
                    }
                }
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

    fn sse(events: &[J]) -> String {
        events.iter().map(|e| format!("data: {e}\n\n")).collect()
    }

    fn start(base: String, web: bool, host: Arc<Host>) -> Box<dyn AiSessionHandle> {
        ApiKey {
            key: Arc::new(|| Some("sk-test".to_owned())),
            base: Some(base),
        }
        .start(config(web, host))
        .unwrap()
    }

    #[test]
    fn runs_the_tool_loop_and_sends_thinking_back_unchanged() {
        let first = sse(&[
            json!({ "type": "message_start", "message": { "usage": { "input_tokens": 5 } } }),
            json!({ "type": "content_block_start", "index": 0, "content_block": { "type": "thinking", "thinking": "" } }),
            json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "signature_delta", "signature": "SIG" } }),
            json!({ "type": "content_block_stop", "index": 0 }),
            json!({ "type": "content_block_start", "index": 1, "content_block": { "type": "tool_use", "id": "t1", "name": "search", "input": {} } }),
            json!({ "type": "content_block_delta", "index": 1, "delta": { "type": "input_json_delta", "partial_json": "{\"query\":" } }),
            json!({ "type": "content_block_delta", "index": 1, "delta": { "type": "input_json_delta", "partial_json": "\"法语\"}" } }),
            json!({ "type": "content_block_stop", "index": 1 }),
            json!({ "type": "message_delta", "delta": { "stop_reason": "tool_use" }, "usage": { "output_tokens": 3 } }),
        ]);
        let second = sse(&[
            json!({ "type": "content_block_start", "index": 0, "content_block": { "type": "text", "text": "" } }),
            json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "text_delta", "text": "答案" } }),
            json!({ "type": "message_delta", "delta": { "stop_reason": "end_turn" }, "usage": { "output_tokens": 2 } }),
        ]);
        let (base, seen) = server(vec![first, second]);
        let host = Arc::new(Host(Mutex::new(vec![])));
        let mut s = start(base, true, host.clone());
        let mut events = Vec::new();
        s.send("问", &mut |e| events.push(e)).unwrap();
        assert!(events.contains(&AiEvent::Text {
            text: "答案".into()
        }));
        assert!(events.contains(&AiEvent::Tool {
            name: "search".into()
        }));
        assert_eq!(host.0.lock().unwrap()[0].1["query"], "法语");
        let bodies = seen.lock().unwrap();
        let (head, second_body) = &bodies[1];
        assert!(head.to_lowercase().contains("x-api-key: sk-test"));
        let messages = second_body["messages"].as_array().unwrap();
        assert_eq!(messages[1]["content"][0]["signature"], "SIG");
        assert_eq!(messages[2]["content"][0]["tool_use_id"], "t1");
    }

    #[test]
    fn an_authorized_session_never_offers_web_tools() {
        let (base, seen) = server(vec![sse(&[json!({
            "type": "message_delta", "delta": { "stop_reason": "end_turn" }, "usage": {}
        })])]);
        let mut s = start(base, false, Arc::new(Host(Mutex::new(vec![]))));
        s.send("问", &mut |_| {}).unwrap();
        let bodies = seen.lock().unwrap();
        let tools = bodies[0].1["tools"].to_string();
        assert!(!tools.contains("web_"), "{tools}");
        assert!(tools.contains("search"));
    }

    #[test]
    fn a_plain_session_offers_them() {
        let (base, seen) = server(vec![sse(&[json!({
            "type": "message_delta", "delta": { "stop_reason": "end_turn" }, "usage": {}
        })])]);
        let mut s = start(base, true, Arc::new(Host(Mutex::new(vec![]))));
        s.send("问", &mut |_| {}).unwrap();
        let tools = seen.lock().unwrap()[0].1["tools"].to_string();
        assert!(tools.contains("web_search_20260209") && tools.contains("web_fetch_20260209"));
    }

    #[test]
    fn a_tool_refusal_goes_back_as_an_error_result() {
        let first = sse(&[
            json!({ "type": "content_block_start", "index": 0, "content_block": { "type": "tool_use", "id": "t1", "name": "read_item", "input": {} } }),
            json!({ "type": "content_block_stop", "index": 0 }),
            json!({ "type": "message_delta", "delta": { "stop_reason": "tool_use" }, "usage": {} }),
        ]);
        let second = sse(&[
            json!({ "type": "message_delta", "delta": { "stop_reason": "end_turn" }, "usage": {} }),
        ]);
        let (base, seen) = server(vec![first, second]);
        let mut s = start(base, true, Arc::new(Host(Mutex::new(vec![]))));
        s.send("问", &mut |_| {}).unwrap();
        let bodies = seen.lock().unwrap();
        assert_eq!(bodies[1].1["messages"][2]["content"][0]["is_error"], true);
    }
}
