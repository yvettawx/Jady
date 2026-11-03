//! A `tracing` layer that writes one JSON object per event and redacts fields
//! whose names indicate content or secrets.

use std::fmt;
use std::io::Write;
use std::sync::Mutex;

use serde_json::{Map, Value};
use tracing::field::{Field, Visit};
use tracing::{Event, Subscriber};
use tracing_subscriber::layer::{Context, Layer};

use crate::{REDACTED, is_redacted_field};

pub struct JsonLayer<W> {
    writer: Mutex<W>,
}

impl<W> fmt::Debug for JsonLayer<W> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("JsonLayer")
    }
}

impl<W: Write> JsonLayer<W> {
    pub fn new(writer: W) -> Self {
        Self {
            writer: Mutex::new(writer),
        }
    }
}

impl<S, W> Layer<S> for JsonLayer<W>
where
    S: Subscriber,
    W: Write + 'static,
{
    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        let meta = event.metadata();
        let mut visitor = JsonVisitor::default();
        event.record(&mut visitor);

        let mut line = Map::new();
        line.insert(
            "ts".into(),
            Value::String(jiff::Timestamp::now().to_string()),
        );
        line.insert("level".into(), Value::String(meta.level().to_string()));
        line.insert("target".into(), Value::String(meta.target().to_owned()));
        line.insert(
            "message".into(),
            visitor.message.map(Value::String).unwrap_or(Value::Null),
        );
        if !visitor.fields.is_empty() {
            line.insert("fields".into(), Value::Object(visitor.fields));
        }

        let Ok(mut text) = serde_json::to_string(&Value::Object(line)) else {
            return;
        };
        text.push('\n');
        // A poisoned lock or failed write must never take the app down.
        if let Ok(mut w) = self.writer.lock() {
            let _ = w.write_all(text.as_bytes());
        }
    }
}

#[derive(Default)]
struct JsonVisitor {
    message: Option<String>,
    fields: Map<String, Value>,
}

impl JsonVisitor {
    fn put(&mut self, field: &Field, value: Value) {
        let name = field.name();
        if name == "message" {
            self.message = Some(match value {
                Value::String(s) => s,
                other => other.to_string(),
            });
        } else if is_redacted_field(name) {
            self.fields
                .insert(name.to_owned(), Value::String(REDACTED.to_owned()));
        } else {
            self.fields.insert(name.to_owned(), value);
        }
    }
}

impl Visit for JsonVisitor {
    fn record_debug(&mut self, field: &Field, value: &dyn fmt::Debug) {
        self.put(field, Value::String(format!("{value:?}")));
    }
    fn record_str(&mut self, field: &Field, value: &str) {
        self.put(field, Value::String(value.to_owned()));
    }
    fn record_i64(&mut self, field: &Field, value: i64) {
        self.put(field, Value::from(value));
    }
    fn record_u64(&mut self, field: &Field, value: u64) {
        self.put(field, Value::from(value));
    }
    fn record_f64(&mut self, field: &Field, value: f64) {
        self.put(field, Value::from(value));
    }
    fn record_bool(&mut self, field: &Field, value: bool) {
        self.put(field, Value::from(value));
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use tracing_subscriber::layer::SubscriberExt;

    use super::*;
    use crate::Sensitive;

    #[derive(Clone, Default)]
    struct Buf(Arc<Mutex<Vec<u8>>>);

    impl Write for Buf {
        fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(data);
            Ok(data.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    fn capture(f: impl FnOnce()) -> String {
        let buf = Buf::default();
        let subscriber = tracing_subscriber::registry().with(JsonLayer::new(buf.clone()));
        tracing::subscriber::with_default(subscriber, f);
        String::from_utf8(buf.0.lock().unwrap().clone()).unwrap()
    }

    const BODY: &str = "CANARY-BODY 我的日记正文";
    const KEY: &str = "CANARY-KEY-0123456789abcdef";

    #[test]
    fn content_and_secrets_never_reach_the_log() {
        let out = capture(|| {
            // Named fields with content-like names, even as plain strings.
            tracing::info!(body = BODY, "saved item");
            tracing::info!(title = %BODY, master_key = KEY, "unlocked");
            tracing::warn!(recovery_code = KEY, "recovery");
            // Wrapped values under innocuous names.
            tracing::info!(value = ?Sensitive(BODY), other = %Sensitive(KEY), "wrapped");
            // Debug of a struct holding a wrapped field.
            #[derive(Debug)]
            #[allow(dead_code)]
            struct Item {
                id: u32,
                body: Sensitive<&'static str>,
            }
            tracing::error!(item = ?Item { id: 7, body: Sensitive(BODY) }, "failed");
        });
        assert!(!out.contains("CANARY"), "log leaked content:\n{out}");
        assert!(!out.contains("日记"), "log leaked content:\n{out}");
        assert_eq!(out.lines().count(), 5);
    }

    #[test]
    fn ordinary_fields_are_kept_as_json() {
        let out = capture(|| tracing::info!(item_id = 42_u64, ok = true, "opened"));
        let v: Value = serde_json::from_str(out.trim()).unwrap();
        assert_eq!(v["message"], "opened");
        assert_eq!(v["level"], "INFO");
        assert_eq!(v["fields"]["item_id"], 42);
        assert_eq!(v["fields"]["ok"], true);
        assert!(v["ts"].as_str().unwrap().ends_with('Z'));
    }
}
