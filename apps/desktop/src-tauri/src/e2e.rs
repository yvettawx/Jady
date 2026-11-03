//! The real commands and the real core behind a local HTTP port, so a browser driving the real
//! interface tests the whole app end to end (probe/app.mjs). macOS has no WebDriver for WKWebView.
//! Built only with the `e2e` feature; it never ships, and it holds nothing but a throwaway library.

#![allow(clippy::expect_used, clippy::print_stdout)]

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use dem_ai_provider::{AiEvent, AiProvider, AiSessionHandle, ProviderStatus, SessionConfig};
use dem_core::{Core, MemoryKeychain};
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{
    INVOKE_KEY, MockRuntime, get_ipc_response, mock_builder, mock_context, noop_assets,
};
use tauri::webview::InvokeRequest;
use tauri::{Manager, WebviewWindow, WebviewWindowBuilder};

fn call(
    window: &WebviewWindow<MockRuntime>,
    cmd: String,
    args: serde_json::Value,
) -> (u16, String) {
    let request = InvokeRequest {
        cmd,
        callback: CallbackFn(0),
        error: CallbackFn(1),
        url: "tauri://localhost".parse().expect("a fixed address"),
        body: InvokeBody::Json(args),
        headers: Default::default(),
        invoke_key: INVOKE_KEY.to_string(),
    };
    match get_ipc_response(window, request) {
        Ok(body) => match body.deserialize::<serde_json::Value>() {
            Ok(v) => (200, v.to_string()),
            Err(e) => (500, serde_json::json!(e.to_string()).to_string()),
        },
        Err(e) => (400, e.to_string()),
    }
}

/// A provider with no AI behind it, for testing everything around it without using any quota. It
/// plays what the real ones send, and every tool call goes through the real gateway.
/// `@tool name {json}` calls a tool; anything else is echoed.
struct Fake;

struct FakeSession {
    config: SessionConfig,
}

impl AiSessionHandle for FakeSession {
    fn send(&mut self, message: &str, on: &mut dyn FnMut(AiEvent)) -> dem_ai_provider::Result<()> {
        let mut said = String::new();
        for line in message.lines() {
            if let Some(rest) = line.strip_prefix("@tool ") {
                let (name, args) = rest.split_once(' ').unwrap_or((rest, "{}"));
                on(AiEvent::Tool {
                    name: name.to_owned(),
                });
                let args = serde_json::from_str(args).unwrap_or(serde_json::Value::Null);
                let out = self.config.tools.call(name, &args);
                let text = out.unwrap_or_else(|e| format!("error: {e}"));
                on(AiEvent::Text {
                    text: format!("{text}\n"),
                });
            } else if !line.is_empty() {
                said.push_str(line);
            }
        }
        let closing = message.contains("```harvest");
        let reply = if closing {
            r#"```harvest
{"summary":"练习了问路。","words":[{"word":"le quai","meaning":"站台","example":"Le train part du quai 3."},{"word":"la voie","meaning":"轨道","example":"Sur la voie 2."}],"grammar":[{"title":"复合过去时","note":"助动词加过去分词"}],"mistakes":[{"wrong":"je suis allé à gare","right":"je suis allé à la gare","why":"地点前要冠词"}],"loose":["还没练时间表达"]}
```"#
                .to_owned()
        } else if self.config.system.contains("conversation practice") {
            format!(
                "Très bien ! Le train part du quai 3.\n\n```corrections\n{}\n```",
                r#"[{"wrong":"je suis allé à gare","right":"je suis allé à la gare","why":"地点前要冠词"}]"#
            )
        } else if self.config.system.contains("Mark one attempt") {
            "答错了：边界没处理。\n\n```verdict\n{\"correct\": false, \"mistake\": \"边界条件\", \"pattern\": \"\"}\n```".to_owned()
        } else if said.is_empty() {
            String::new()
        } else {
            format!("收到：{said}")
        };
        if !reply.is_empty() {
            on(AiEvent::Text { text: reply });
        }
        on(AiEvent::Usage {
            input_tokens: 10,
            output_tokens: 5,
            cost_usd: None,
        });
        Ok(())
    }

    fn stopper(&self) -> Arc<dyn Fn() + Send + Sync> {
        Arc::new(|| {})
    }
}

impl AiProvider for Fake {
    fn id(&self) -> &'static str {
        "fake"
    }

    fn status(&self) -> ProviderStatus {
        ProviderStatus {
            available: true,
            ready: true,
            detail: "e2e".to_owned(),
        }
    }

    fn start(&self, config: SessionConfig) -> dem_ai_provider::Result<Box<dyn AiSessionHandle>> {
        Ok(Box::new(FakeSession { config }))
    }
}

/// `POST /<command>` with the arguments as JSON. Serves until killed.
pub fn serve(port: u16, dir: PathBuf) {
    std::fs::create_dir_all(dir.join("documents")).expect("a place for the test library");
    let builder = crate::specta_builder::<MockRuntime>();
    let app = mock_builder()
        .invoke_handler(builder.invoke_handler())
        .build(mock_context(noop_assets()))
        .expect("the mock app builds");
    app.manage(Core::new(
        dir.join("config"),
        dir.join("documents"),
        Box::new(MemoryKeychain::default()),
    ));
    app.manage(crate::Changes(std::sync::Arc::new(|| {})));
    let queue: Arc<Mutex<Vec<serde_json::Value>>> = Arc::default();
    let sink = queue.clone();
    let runtime = crate::ai::AiRuntime::new(Box::new(move |event| {
        if let Ok(mut q) = sink.lock() {
            q.push(event);
        }
    }));
    runtime.register_builtin(&app.state::<Core>());
    if std::env::var_os("DEM_E2E_REAL_AI").is_none() {
        runtime.registry.register(Arc::new(Fake));
    }
    app.manage(runtime);
    // The browser is never started in these tests: its settings page only reads.
    app.manage(crate::browser::BrowserState::new(
        Arc::new(|_, _| true),
        &std::env::temp_dir().join("dem-e2e-browser"),
    ));
    app.manage(crate::plugins::PluginsState::new(dir.join("plugins")));
    let window = WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .expect("the mock window builds");
    let listener = TcpListener::bind(("127.0.0.1", port)).expect("the port is free");
    println!("bridge ready on {port}");
    for stream in listener.incoming().flatten() {
        let window = window.clone();
        let queue = queue.clone();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stream);
            let mut line = String::new();
            if reader.read_line(&mut line).is_err() {
                return;
            }
            let path = line.split_whitespace().nth(1).unwrap_or("/").to_string();
            let mut length = 0usize;
            loop {
                let mut h = String::new();
                if reader.read_line(&mut h).is_err() || h.trim().is_empty() {
                    break;
                }
                if let Some(v) = h.to_ascii_lowercase().strip_prefix("content-length:") {
                    length = v.trim().parse().unwrap_or(0);
                }
            }
            let mut body = vec![0u8; length];
            if reader.read_exact(&mut body).is_err() {
                return;
            }
            // Stands in for the jadyplugin: protocol, with the same files and the same policy.
            let plugin_path = path
                .strip_prefix("/__plugin")
                .or_else(|| path.starts_with("/_sdk/").then_some(path.as_str()));
            if let Some(rest) = plugin_path {
                let (status, kind, body) = crate::plugins::serve(
                    &window.state::<crate::plugins::PluginsState>(),
                    &window.state::<Core>(),
                    rest,
                );
                let mut stream = reader.into_inner();
                let _ = write!(
                    stream,
                    "HTTP/1.1 {status} OK\r\nContent-Type: {kind}\r\n\
                     Content-Security-Policy: {}\r\nX-Content-Type-Options: nosniff\r\n\
                     Content-Length: {}\r\nConnection: close\r\n\r\n",
                    crate::plugins::policy(&format!("http://127.0.0.1:{port}")),
                    body.len()
                );
                let _ = stream.write_all(&body);
                return;
            }
            let (status, text) = if line.starts_with("OPTIONS") {
                (200, String::new())
            } else if path == "/__events" {
                // Stands in for Tauri's events: everything since the last time asked.
                let drained: Vec<_> = queue
                    .lock()
                    .map(|mut q| q.drain(..).collect())
                    .unwrap_or_default();
                let list: Vec<_> = drained
                    .into_iter()
                    .map(|e| serde_json::json!(["ai-event", e]))
                    .collect();
                (200, serde_json::Value::Array(list).to_string())
            } else {
                let args = serde_json::from_slice(&body).unwrap_or(serde_json::json!({}));
                call(&window, path.trim_start_matches('/').to_string(), args)
            };
            let mut stream = reader.into_inner();
            let _ = write!(
                stream,
                "HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\n\
                 Access-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: *\r\n\
                 Access-Control-Allow-Methods: POST, OPTIONS\r\n\
                 Content-Length: {}\r\nConnection: close\r\n\r\n{text}",
                text.len()
            );
        });
    }
}
