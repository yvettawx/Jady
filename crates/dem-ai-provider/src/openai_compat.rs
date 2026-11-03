//! Any service that speaks OpenAI's Chat Completions (M6, D14): DeepSeek, Ollama, LM Studio and the
//! like. The user types the address and model in settings; the key, if there is one, stays in the
//! system keychain and is read only for the moment of a request. The tool loop runs here over the
//! same `ToolHost` as the Anthropic API key, so the gateway's restricted view is all it sees.
//!
//! There is no web in this one: Chat Completions has no standard search tool, and a hand-made one
//! would fetch pages from this machine. Every session gets the gateway's tools and nothing else.

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::{Value as J, json};

use crate::api_key::KeySource;
use crate::{
    AiEvent, AiProvider, AiSessionHandle, ProviderError, ProviderStatus, Result, SessionConfig,
    ToolHost, redact,
};

/// How many model turns one message may take, as a brake on a loop.
const MAX_ROUNDS: u32 = 30;

/// The address the user typed, read each time so a change in settings applies to the next session.
pub type EndpointSource = Arc<dyn Fn() -> Option<String> + Send + Sync>;

pub struct OpenAiCompat {
    /// `None` is fine: a local model usually needs no key.
    pub key: KeySource,
    /// Only ever the user's own setting. Nothing else sets it.
    pub endpoint: EndpointSource,
}

impl std::fmt::Debug for OpenAiCompat {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("OpenAiCompat")
    }
}

/// The address as typed, made usable: no trailing slash, and the path the user may have pasted
/// whole taken off. `None` for anything that is not plain http or https.
pub fn normalize_endpoint(raw: &str) -> Option<String> {
    let s = raw.trim();
    let rest = s
        .strip_prefix("https://")
        .or_else(|| s.strip_prefix("http://"))?;
    if rest.is_empty() || rest.starts_with('/') || s.chars().any(char::is_whitespace) {
        return None;
    }
    let s = s.trim_end_matches('/');
    let s = s.strip_suffix("/chat/completions").unwrap_or(s);
    Some(s.trim_end_matches('/').to_owned())
}

impl AiProvider for OpenAiCompat {
    fn id(&self) -> &'static str {
        "openai-compatible"
    }

    fn status(&self) -> ProviderStatus {
        let endpoint = (self.endpoint)().and_then(|e| normalize_endpoint(&e));
        let detail = endpoint
            .as_deref()
            .and_then(|e| e.split("://").nth(1))
            .and_then(|r| r.split('/').next())
            .unwrap_or("")
            .to_owned();
        ProviderStatus {
            available: true,
            ready: endpoint.is_some(),
            detail,
        }
    }

    fn start(&self, config: SessionConfig) -> Result<Box<dyn AiSessionHandle>> {
        let base = (self.endpoint)()
            .and_then(|e| normalize_endpoint(&e))
            .ok_or_else(|| ProviderError::Unavailable("the address".to_owned()))?;
        let model = config
            .model
            .filter(|m| !m.trim().is_empty())
            .ok_or_else(|| ProviderError::Unavailable("the model".to_owned()))?;
        Ok(Box::new(Conversation {
            key: self.key.clone(),
            base,
            model,
            tools: config.tools,
            messages: vec![json!({ "role": "system", "content": config.system })],
            stop: Arc::new(AtomicBool::new(false)),
        }))
    }
}

struct Conversation {
    key: KeySource,
    base: String,
    model: String,
    tools: Arc<dyn ToolHost>,
    messages: Vec<J>,
    stop: Arc<AtomicBool>,
}

/// One tool call as it comes in pieces.
#[derive(Default)]
struct Call {
    id: String,
    name: String,
    arguments: String,
}

impl Conversation {
    /// The request body. Pure, so the rules about tools can be tested.
    fn body(&self) -> J {
        let tools: Vec<J> = self
            .tools
            .tools()
            .into_iter()
            .map(|t| {
                json!({
                    "type": "function",
                    "function": {
                        "name": t["name"],
                        "description": t["description"],
                        "parameters": t["input_schema"],
                    },
                })
            })
            .collect();
        let mut body = json!({
            "model": self.model,
            "stream": true,
            "stream_options": { "include_usage": true },
            "messages": self.messages,
        });
        // Some servers refuse an empty list.
        if !tools.is_empty() {
            body["tools"] = J::Array(tools);
        }
        body
    }

    /// One request; returns the assistant's message, whole, and why it stopped.
    fn round(&mut self, on: &mut dyn FnMut(AiEvent)) -> Result<(J, Vec<Call>, String)> {
        let key = (self.key)().filter(|k| !k.trim().is_empty());
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .build()
            .into();
        let mut request = agent
            .post(format!("{}/chat/completions", self.base))
            .header("content-type", "application/json");
        if let Some(k) = &key {
            request = request.header("authorization", &format!("Bearer {k}"));
        }
        let sent = request.send(self.body().to_string());
        let mut response =
            sent.map_err(|e| ProviderError::Failed(redact(&e.to_string(), key.as_deref())))?;
        let status = response.status();
        if !status.is_success() {
            let text = response.body_mut().read_to_string().unwrap_or_default();
            let message = serde_json::from_str::<J>(&text)
                .ok()
                .and_then(|v| {
                    v["error"]["message"]
                        .as_str()
                        .or_else(|| v["error"].as_str())
                        .map(str::to_owned)
                })
                .unwrap_or_else(|| status.to_string());
            return Err(ProviderError::Failed(redact(&message, key.as_deref())));
        }
        let key_text = key.clone();
        drop(key);
        let reader = BufReader::new(response.body_mut().as_reader());
        let mut text = String::new();
        let mut reasoning = String::new();
        let mut calls: BTreeMap<u64, Call> = BTreeMap::new();
        let mut finish = String::new();
        let mut usage = (0, 0);
        for line in reader.lines() {
            if self.stop.load(Ordering::Relaxed) {
                return Err(ProviderError::Stopped);
            }
            let line = line.map_err(|e| ProviderError::Failed(e.to_string()))?;
            let Some(data) = line.strip_prefix("data:") else {
                continue;
            };
            let data = data.trim();
            if data == "[DONE]" {
                break;
            }
            let Ok(chunk) = serde_json::from_str::<J>(data) else {
                continue;
            };
            if let Some(message) = chunk["error"]["message"].as_str() {
                return Err(ProviderError::Failed(redact(message, key_text.as_deref())));
            }
            if chunk["usage"].is_object() {
                usage = (
                    chunk["usage"]["prompt_tokens"].as_u64().unwrap_or(0),
                    chunk["usage"]["completion_tokens"].as_u64().unwrap_or(0),
                );
            }
            let Some(choice) = chunk["choices"].get(0) else {
                continue;
            };
            let delta = &choice["delta"];
            if let Some(t) = delta["content"].as_str()
                && !t.is_empty()
            {
                text.push_str(t);
                on(AiEvent::Text { text: t.to_owned() });
            }
            if let Some(t) = delta["reasoning_content"].as_str() {
                reasoning.push_str(t);
            }
            for piece in delta["tool_calls"].as_array().into_iter().flatten() {
                let index = piece["index"].as_u64().unwrap_or(calls.len() as u64);
                let call = calls.entry(index).or_default();
                if let Some(id) = piece["id"].as_str() {
                    call.id = id.to_owned();
                }
                let function = &piece["function"];
                if let Some(name) = function["name"].as_str()
                    && call.name.is_empty()
                {
                    call.name = name.to_owned();
                    on(AiEvent::Tool {
                        name: name.to_owned(),
                    });
                }
                match &function["arguments"] {
                    J::String(s) => call.arguments.push_str(s),
                    // A few local servers send the arguments whole, as an object.
                    J::Object(_) => call.arguments = function["arguments"].to_string(),
                    _ => {}
                }
            }
            if let Some(reason) = choice["finish_reason"].as_str() {
                finish = reason.to_owned();
            }
        }
        on(AiEvent::Usage {
            input_tokens: usage.0,
            output_tokens: usage.1,
            cost_usd: None,
        });
        let calls: Vec<Call> = calls
            .into_values()
            .enumerate()
            .map(|(i, mut c)| {
                if c.id.is_empty() {
                    c.id = format!("call_{i}");
                }
                c
            })
            .collect();
        let mut message = json!({
            "role": "assistant",
            "content": if text.is_empty() { J::Null } else { J::String(text) },
        });
        if !calls.is_empty() {
            message["tool_calls"] = calls
                .iter()
                .map(|c| {
                    json!({
                        "id": c.id,
                        "type": "function",
                        "function": { "name": c.name, "arguments": c.arguments },
                    })
                })
                .collect();
            // DeepSeek's thinking models want their reasoning back within a tool loop; only servers
            // that sent it get it back.
            if !reasoning.is_empty() {
                message["reasoning_content"] = J::String(reasoning);
            }
        }
        Ok((message, calls, finish))
    }
}

impl AiSessionHandle for Conversation {
    fn send(&mut self, message: &str, on: &mut dyn FnMut(AiEvent)) -> Result<()> {
        self.stop.store(false, Ordering::Relaxed);
        self.messages
            .push(json!({ "role": "user", "content": message }));
        for _ in 0..MAX_ROUNDS {
            let (reply, calls, finish) = self.round(on)?;
            self.messages.push(reply);
            if calls.is_empty() {
                match finish.as_str() {
                    "length" => on(AiEvent::Stopped {
                        reason: "max_tokens".to_owned(),
                    }),
                    "content_filter" => on(AiEvent::Stopped {
                        reason: "refusal".to_owned(),
                    }),
                    _ => {}
                }
                return Ok(());
            }
            for call in &calls {
                let args = serde_json::from_str::<J>(&call.arguments)
                    .ok()
                    .filter(J::is_object)
                    .unwrap_or_else(|| json!({}));
                let content = match self.tools.call(&call.name, &args) {
                    Ok(t) => t,
                    Err(t) => format!("error: {t}"),
                };
                self.messages.push(json!({
                    "role": "tool",
                    "tool_call_id": call.id,
                    "content": content,
                }));
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
                json!({ "name": "read_item", "description": "d", "input_schema": { "type": "object" } }),
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

    fn config(web: bool, host: Arc<Host>, model: Option<&str>) -> SessionConfig {
        SessionConfig {
            system: "sys".into(),
            model: model.map(str::to_owned),
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

    /// Answers each POST with the next canned reply (status, body) and keeps the requests.
    fn server(replies: Vec<(u16, String)>) -> (String, Seen) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = format!("http://{}/v1", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        std::thread::spawn(move || {
            for ((code, reply), stream) in replies.into_iter().zip(listener.incoming()) {
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
                    "HTTP/1.1 {code} X\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}",
                    reply.len()
                )
                .unwrap();
            }
        });
        (addr, seen)
    }

    fn sse(chunks: &[J]) -> (u16, String) {
        let mut s: String = chunks.iter().map(|e| format!("data: {e}\n\n")).collect();
        s.push_str("data: [DONE]\n\n");
        (200, s)
    }

    fn provider(base: String, key: Option<&'static str>) -> OpenAiCompat {
        OpenAiCompat {
            key: Arc::new(move || key.map(str::to_owned)),
            endpoint: Arc::new(move || Some(base.clone())),
        }
    }

    fn done() -> (u16, String) {
        sse(&[json!({ "choices": [{ "delta": { "content": "好" }, "finish_reason": "stop" }] })])
    }

    #[test]
    fn runs_the_tool_loop_with_tools_from_the_gateway_only() {
        let first = sse(&[
            json!({ "choices": [{ "delta": { "reasoning_content": "想" } }] }),
            json!({ "choices": [{ "delta": { "tool_calls": [{ "index": 0, "id": "c1", "function": { "name": "search", "arguments": "{\"query\":" } }] } }] }),
            json!({ "choices": [{ "delta": { "tool_calls": [{ "index": 0, "function": { "arguments": "\"法语\"}" } }] }, "finish_reason": "tool_calls" }] }),
            json!({ "choices": [], "usage": { "prompt_tokens": 7, "completion_tokens": 3 } }),
        ]);
        let second = sse(&[
            json!({ "choices": [{ "delta": { "content": "答案" }, "finish_reason": "stop" }] }),
        ]);
        let (base, seen) = server(vec![first, second]);
        let host = Arc::new(Host(Mutex::new(vec![])));
        let mut s = provider(base, Some("sk-local"))
            .start(config(true, host.clone(), Some("deepseek-chat")))
            .unwrap();
        let mut events = Vec::new();
        s.send("问", &mut |e| events.push(e)).unwrap();
        assert!(events.contains(&AiEvent::Text {
            text: "答案".into()
        }));
        assert!(events.contains(&AiEvent::Tool {
            name: "search".into()
        }));
        assert!(events.contains(&AiEvent::Usage {
            input_tokens: 7,
            output_tokens: 3,
            cost_usd: None
        }));
        assert_eq!(host.0.lock().unwrap()[0].1["query"], "法语");
        let bodies = seen.lock().unwrap();
        let (head, first_body) = &bodies[0];
        assert!(head.contains("POST /v1/chat/completions"));
        assert!(
            head.to_lowercase()
                .contains("authorization: bearer sk-local")
        );
        // Exactly the gateway's tools, and no web of any kind, even in a plain session.
        let names: Vec<&str> = first_body["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["function"]["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, ["search", "read_item"]);
        assert!(!first_body.to_string().contains("web"));
        let messages = bodies[1].1["messages"].as_array().unwrap();
        assert_eq!(messages[0]["role"], "system");
        assert_eq!(messages[2]["tool_calls"][0]["id"], "c1");
        assert_eq!(messages[2]["reasoning_content"], "想");
        assert_eq!(messages[3]["tool_call_id"], "c1");
        assert_eq!(messages[3]["content"], "结果");
    }

    #[test]
    fn a_local_model_needs_no_key_and_gets_none() {
        let (base, seen) = server(vec![done()]);
        let mut s = provider(base, None)
            .start(config(
                false,
                Arc::new(Host(Mutex::new(vec![]))),
                Some("qwen3"),
            ))
            .unwrap();
        s.send("问", &mut |_| {}).unwrap();
        let head = seen.lock().unwrap()[0].0.to_lowercase();
        assert!(!head.contains("authorization"), "{head}");
    }

    #[test]
    fn a_tool_refusal_goes_back_as_an_error() {
        let first = sse(&[
            json!({ "choices": [{ "delta": { "tool_calls": [{ "index": 0, "function": { "name": "read_item", "arguments": { "id": "x" } } }] }, "finish_reason": "tool_calls" }] }),
        ]);
        let (base, seen) = server(vec![first, done()]);
        let mut s = provider(base, None)
            .start(config(true, Arc::new(Host(Mutex::new(vec![]))), Some("m")))
            .unwrap();
        s.send("问", &mut |_| {}).unwrap();
        let bodies = seen.lock().unwrap();
        let tool = &bodies[1].1["messages"][3];
        assert_eq!(tool["tool_call_id"], "call_0");
        assert!(
            tool["content"]
                .as_str()
                .unwrap()
                .starts_with("error: item not found")
        );
    }

    #[test]
    fn without_an_address_or_a_model_it_does_not_start() {
        let none = OpenAiCompat {
            key: Arc::new(|| None),
            endpoint: Arc::new(|| None),
        };
        assert!(!none.status().ready);
        let host = Arc::new(Host(Mutex::new(vec![])));
        assert!(none.start(config(true, host.clone(), Some("m"))).is_err());
        let p = provider("http://127.0.0.1:1/v1".into(), None);
        assert!(p.start(config(true, host, None)).is_err());
    }

    #[test]
    fn only_plain_http_addresses_are_taken() {
        assert_eq!(
            normalize_endpoint(" https://api.deepseek.com/ ").as_deref(),
            Some("https://api.deepseek.com")
        );
        assert_eq!(
            normalize_endpoint("http://localhost:11434/v1/chat/completions").as_deref(),
            Some("http://localhost:11434/v1")
        );
        for bad in [
            "",
            "localhost:1234",
            "file:///etc",
            "https://",
            "http:// x",
            "ftp://a",
        ] {
            assert_eq!(normalize_endpoint(bad), None, "{bad}");
        }
    }

    /// Records every log event, fields and all.
    struct Capture(Arc<Mutex<String>>);
    impl<S: tracing::Subscriber> tracing_subscriber::Layer<S> for Capture {
        fn on_event(
            &self,
            event: &tracing::Event<'_>,
            _: tracing_subscriber::layer::Context<'_, S>,
        ) {
            struct V<'a>(&'a mut String);
            impl tracing::field::Visit for V<'_> {
                fn record_debug(&mut self, f: &tracing::field::Field, v: &dyn std::fmt::Debug) {
                    self.0.push_str(&format!("{}={v:?} ", f.name()));
                }
            }
            if let Ok(mut s) = self.0.lock() {
                event.record(&mut V(&mut s));
            }
        }
    }

    #[test]
    fn the_key_stays_out_of_errors_and_logs() {
        use tracing_subscriber::layer::SubscriberExt;
        const KEY: &str = "sk-canary-8d1f0c";
        // A server that repeats the key back, the worst case.
        let echo = json!({ "error": { "message": format!("bad key Bearer {KEY}") } }).to_string();
        let (base, _) = server(vec![(401, echo)]);
        let logs = Arc::new(Mutex::new(String::new()));
        let subscriber = tracing_subscriber::registry().with(Capture(logs.clone()));
        let error = tracing::subscriber::with_default(subscriber, || {
            tracing::info!(probe = "on", "capture works");
            let p = provider(base, Some(KEY));
            let mut s = p
                .start(config(true, Arc::new(Host(Mutex::new(vec![]))), Some("m")))
                .unwrap();
            let e = s.send("问", &mut |_| {}).unwrap_err().to_string();
            tracing::info!(error = %e, provider = ?p, "turn failed");
            e
        });
        assert!(error.contains("bad key"), "{error}");
        assert!(!error.contains(KEY), "{error}");
        let logs = logs.lock().unwrap();
        assert!(logs.contains("capture works"), "{logs}");
        assert!(!logs.contains(KEY), "{logs}");
    }
}
