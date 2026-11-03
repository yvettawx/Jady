//! The smallest whole provider, and the built-in OpenAI-compatible one, on a stand-in for the
//! gateway. Start a new provider by copying `Echo`. docs/extending/ai-provider.md walks through it.
//!
//! cargo run -p dem-ai-provider --example my_provider
//! cargo run -p dem-ai-provider --example my_provider -- http://localhost:11434/v1 qwen3

#![allow(clippy::print_stdout, clippy::expect_used)]

use std::sync::Arc;

use dem_ai_provider::openai_compat::OpenAiCompat;
use dem_ai_provider::{
    AiEvent, AiProvider, AiSessionHandle, McpAccess, ProviderRegistry, ProviderStatus, Result,
    SessionConfig, ToolHost,
};
use serde_json::{Value as J, json};

/// Answers by calling the first tool it is given. No AI behind it.
struct Echo;

struct EchoSession {
    config: SessionConfig,
}

impl AiProvider for Echo {
    fn id(&self) -> &'static str {
        "echo"
    }

    fn status(&self) -> ProviderStatus {
        ProviderStatus {
            available: true,
            ready: true,
            detail: "example".to_owned(),
        }
    }

    fn start(&self, config: SessionConfig) -> Result<Box<dyn AiSessionHandle>> {
        Ok(Box::new(EchoSession { config }))
    }
}

impl AiSessionHandle for EchoSession {
    fn send(&mut self, message: &str, on: &mut dyn FnMut(AiEvent)) -> Result<()> {
        // Every piece of data comes from the gateway's tools; nothing else is in reach.
        on(AiEvent::Tool {
            name: "search".to_owned(),
        });
        let found = self
            .config
            .tools
            .call("search", &json!({ "query": message }))
            .unwrap_or_else(|e| format!("error: {e}"));
        on(AiEvent::Text {
            text: format!("found: {found}"),
        });
        on(AiEvent::Usage {
            input_tokens: 0,
            output_tokens: 0,
            cost_usd: None,
        });
        Ok(())
    }

    fn stopper(&self) -> Arc<dyn Fn() + Send + Sync> {
        Arc::new(|| {})
    }
}

/// Stands in for the gateway: one tool, one made-up note.
struct Library;

impl ToolHost for Library {
    fn tools(&self) -> Vec<J> {
        vec![json!({
            "name": "search",
            "description": "Find notes by words in them.",
            "input_schema": {
                "type": "object",
                "properties": { "query": { "type": "string" } },
                "required": ["query"],
            },
        })]
    }

    fn call(&self, name: &str, _args: &J) -> std::result::Result<String, String> {
        match name {
            "search" => Ok(r#"[{"id":"n1","title":"Sourdough notes"}]"#.to_owned()),
            _ => Err("no such tool".to_owned()),
        }
    }
}

fn config(model: Option<String>) -> SessionConfig {
    SessionConfig {
        system: "Answer with what the tools find.".to_owned(),
        model,
        // An authorized session would pass false here, and the provider must then have no web.
        web: false,
        mcp: McpAccess {
            socket: "/nowhere".into(),
            token: String::new(),
            reissue: None,
            private_dir: std::env::temp_dir(),
            tool_names: vec!["search".to_owned()],
        },
        tools: Arc::new(Library),
        isolate: true,
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let registry = ProviderRegistry::default();
    registry.register(Arc::new(Echo));
    let endpoint = args.first().cloned();
    let model = args.get(1).cloned();
    registry.register(Arc::new(OpenAiCompat {
        // A real build reads this from the keychain each time; a local model needs none.
        key: Arc::new(|| std::env::var("DEM_EXAMPLE_KEY").ok()),
        endpoint: Arc::new(move || endpoint.clone()),
    }));
    let id = if args.is_empty() {
        "echo"
    } else {
        "openai-compatible"
    };
    let provider = registry.get(id).expect("registered above");
    println!("{id}: {:?}", provider.status());
    let mut session = provider.start(config(model)).expect("starts");
    session
        .send("sourdough", &mut |event| println!("{event:?}"))
        .expect("one turn");
}
