//! The Chrome DevTools protocol over `--remote-debugging-pipe`: Chrome reads commands on fd 3 and
//! writes answers and events on fd 4, each message ending in a NUL byte. No network port is
//! opened, so no other program on this machine can take over the browser.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use serde_json::{Value as J, json};

use crate::{BrowserError, Result};

/// Called for every event, with the session it came from (empty for the browser itself).
pub type EventHandler = Arc<dyn Fn(&Cdp, &str, &str, &J) + Send + Sync>;

/// One connection to one Chrome process.
pub struct Cdp {
    child: Mutex<Child>,
    input: Mutex<ChildStdin>,
    next: AtomicU64,
    waiting: Arc<Mutex<HashMap<u64, Sender<J>>>>,
    alive: Arc<std::sync::atomic::AtomicBool>,
    me: Weak<Cdp>,
}

impl std::fmt::Debug for Cdp {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Cdp")
    }
}

const ANSWER_WAIT: Duration = Duration::from_secs(30);

impl Cdp {
    /// Starts Chrome with the given arguments and the pipe, and reads from it on its own thread.
    pub fn launch(
        chrome: &std::path::Path,
        args: &[String],
        on_event: EventHandler,
    ) -> Result<Arc<Cdp>> {
        // The shell moves our pipes onto the descriptors Chrome expects, so no unsafe code is
        // needed to set them up.
        let mut child = Command::new("/bin/sh")
            .args(["-c", "exec \"$@\" 3<&0 4>&1 0</dev/null 1>/dev/null", "sh"])
            .arg(chrome)
            .args(args)
            .arg("--remote-debugging-pipe")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| BrowserError::Start(e.to_string()))?;
        let input = child
            .stdin
            .take()
            .ok_or_else(|| BrowserError::Start("no pipe".into()))?;
        let output = child
            .stdout
            .take()
            .ok_or_else(|| BrowserError::Start("no pipe".into()))?;
        let cdp = Arc::new_cyclic(|me| Cdp {
            child: Mutex::new(child),
            input: Mutex::new(input),
            next: AtomicU64::new(1),
            waiting: Arc::new(Mutex::new(HashMap::new())),
            alive: Arc::new(std::sync::atomic::AtomicBool::new(true)),
            me: me.clone(),
        });
        let weak = Arc::downgrade(&cdp);
        let waiting = cdp.waiting.clone();
        let alive = cdp.alive.clone();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(output);
            let mut buf = Vec::new();
            loop {
                buf.clear();
                match reader.read_until(0, &mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {}
                }
                if buf.last() == Some(&0) {
                    buf.pop();
                }
                let Ok(msg) = serde_json::from_slice::<J>(&buf) else {
                    continue;
                };
                if let Some(id) = msg.get("id").and_then(J::as_u64) {
                    let to = waiting.lock().ok().and_then(|mut w| w.remove(&id));
                    if let Some(to) = to {
                        let _ = to.send(msg);
                    }
                } else if let (Some(method), Some(cdp)) =
                    (msg.get("method").and_then(J::as_str), weak.upgrade())
                {
                    let session = msg.get("sessionId").and_then(J::as_str).unwrap_or("");
                    let params = msg.get("params").cloned().unwrap_or(J::Null);
                    on_event(&cdp, session, method, &params);
                }
            }
            alive.store(false, Ordering::Relaxed);
            // Whoever is still waiting gets an answer: the browser is gone.
            if let Ok(mut w) = waiting.lock() {
                w.clear();
            }
        });
        Ok(cdp)
    }

    /// The shared handle, for a thread that outlives the call it starts from.
    pub fn shared(&self) -> Option<Arc<Cdp>> {
        self.me.upgrade()
    }

    pub fn alive(&self) -> bool {
        self.alive.load(Ordering::Relaxed)
    }

    /// Sends without waiting for the answer. Used from the event thread, which must not block.
    pub fn post(&self, session: &str, method: &str, params: J) -> Result<Receiver<J>> {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let mut msg = json!({ "id": id, "method": method, "params": params });
        if !session.is_empty() {
            msg["sessionId"] = json!(session);
        }
        let (tx, rx) = channel();
        if let Ok(mut w) = self.waiting.lock() {
            w.insert(id, tx);
        }
        let mut bytes =
            serde_json::to_vec(&msg).map_err(|e| BrowserError::Protocol(e.to_string()))?;
        bytes.push(0);
        let mut input = self
            .input
            .lock()
            .map_err(|_| BrowserError::Protocol("pipe poisoned".into()))?;
        input
            .write_all(&bytes)
            .and_then(|()| input.flush())
            .map_err(|_| BrowserError::Closed)?;
        Ok(rx)
    }

    /// Sends a command and waits for its result.
    pub fn call(&self, session: &str, method: &str, params: J) -> Result<J> {
        let rx = self.post(session, method, params)?;
        let answer = rx.recv_timeout(ANSWER_WAIT).map_err(|_| {
            if self.alive() {
                BrowserError::Protocol(format!("{method}: no answer"))
            } else {
                BrowserError::Closed
            }
        })?;
        if let Some(e) = answer.get("error") {
            let text = e.get("message").and_then(J::as_str).unwrap_or("error");
            return Err(BrowserError::Protocol(format!("{method}: {text}")));
        }
        Ok(answer.get("result").cloned().unwrap_or(J::Null))
    }

    /// Closes Chrome.
    pub fn close(&self) {
        let _ = self.post("", "Browser.close", json!({}));
        std::thread::sleep(Duration::from_millis(300));
        if let Ok(mut c) = self.child.lock() {
            let _ = c.kill();
            let _ = c.wait();
        }
    }
}
