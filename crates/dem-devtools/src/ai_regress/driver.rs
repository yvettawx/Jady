//! Starts Claude Code for one scenario. Only reached after the budget guard in
//! [`super::run`] has passed; never called from tests.
//!
//! Each scenario runs in its own empty working directory, so no project file
//! (CLAUDE.md, `.mcp.json`, hooks) can be picked up. The prompt goes in as a
//! single `stream-json` user message; stdin is then closed, which ends the
//! session after the first result.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::Context;
use serde::Serialize;
use serde_json::json;

use super::flags::{self, ENV, SessionKind};
use super::scenario::{Scenario, SetupItem};

/// Placeholder in the MCP config template, replaced by the path of `setup.json`.
pub const SETUP_PLACEHOLDER: &str = "{setup}";

/// The `claude` executable (override with `DEM_CLAUDE_BIN`).
pub fn claude_bin() -> String {
    std::env::var("DEM_CLAUDE_BIN").unwrap_or_else(|_| "claude".to_string())
}

#[derive(Debug)]
pub struct RunOutput {
    pub stdout: String,
    pub exit_ok: bool,
    pub timed_out: bool,
    pub wall_ms: u128,
}

/// Write a file readable only by the current user (it may name the gateway's token).
fn write_private(path: &Path, data: &[u8]) -> anyhow::Result<()> {
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts
        .open(path)
        .with_context(|| format!("create {}", path.display()))?;
    f.write_all(data)?;
    Ok(())
}

/// The content of `setup.json`: the data the gateway serves and the session it
/// serves it to. The gateway needs `authorized` to apply the privacy rules
/// (sensitive items are visible only in an authorized session).
#[derive(Debug, Serialize)]
pub struct GatewaySetup<'a> {
    pub session: SessionKind,
    pub authorized: bool,
    pub items: &'a [SetupItem],
}

impl<'a> GatewaySetup<'a> {
    pub fn for_scenario(s: &'a Scenario) -> Self {
        Self {
            session: s.session,
            authorized: s.session == SessionKind::Sensitive,
            items: &s.setup.items,
        }
    }
}

/// Prepare `<dir>/setup.json`, `<dir>/mcp.json` and the empty `<dir>/cwd`.
/// Returns the MCP config path.
pub fn prepare(dir: &Path, scenario: &Scenario, mcp_template: &str) -> anyhow::Result<PathBuf> {
    std::fs::create_dir_all(dir.join("cwd"))?;
    let setup = dir.join("setup.json");
    write_private(
        &setup,
        &serde_json::to_vec_pretty(&GatewaySetup::for_scenario(scenario))?,
    )?;
    // The path is inserted into a JSON string, so escape it as JSON.
    let setup_json = serde_json::to_string(&setup.display().to_string())?;
    let setup_inner = setup_json.trim_matches('"');
    let mcp = dir.join("mcp.json");
    write_private(
        &mcp,
        mcp_template
            .replace(SETUP_PLACEHOLDER, setup_inner)
            .as_bytes(),
    )?;
    Ok(mcp)
}

pub fn run_claude(
    dir: &Path,
    scenario: &Scenario,
    args: &[String],
    timeout: Duration,
) -> anyhow::Result<RunOutput> {
    std::fs::write(dir.join("args.json"), serde_json::to_vec_pretty(args)?)?;
    let bin = claude_bin();
    let mut cmd = Command::new(&bin);
    cmd.args(args)
        .current_dir(dir.join("cwd"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (k, v) in ENV {
        cmd.env(k, v);
    }
    let started = Instant::now();
    let mut child = cmd.spawn().with_context(|| format!("start {bin}"))?;

    let message = json!({"type": "user", "message": {"role": "user", "content": scenario.prompt}});
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(format!("{message}\n").as_bytes())?;
        // Dropping stdin closes it: one turn only.
    }
    let mut stdout = child.stdout.take().context("stdout")?;
    let mut stderr = child.stderr.take().context("stderr")?;
    let out_reader = thread::spawn(move || {
        let mut s = String::new();
        let _ = stdout.read_to_string(&mut s);
        s
    });
    let err_reader = thread::spawn(move || {
        let mut s = String::new();
        let _ = stderr.read_to_string(&mut s);
        s
    });

    let mut timed_out = false;
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break Some(status);
        }
        if started.elapsed() > timeout {
            timed_out = true;
            let _ = child.kill();
            break child.wait().ok();
        }
        thread::sleep(Duration::from_millis(200));
    };
    let stdout = out_reader.join().unwrap_or_default();
    let stderr = err_reader.join().unwrap_or_default();
    std::fs::write(dir.join("stdout.jsonl"), &stdout)?;
    std::fs::write(dir.join("stderr.txt"), &stderr)?;
    Ok(RunOutput {
        stdout,
        exit_ok: !timed_out && status.is_some_and(|s| s.success()),
        timed_out,
        wall_ms: started.elapsed().as_millis(),
    })
}

/// The command a scenario would run, for the dry-run plan.
pub fn describe(args: &[String]) -> String {
    flags::shell_line(&claude_bin(), args)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai_regress::scenario;

    #[test]
    fn setup_tells_the_gateway_whether_the_session_is_authorized() {
        let dir = tempfile::tempdir().unwrap();
        for (kind, authorized) in [("normal", false), ("sensitive", true)] {
            let s = scenario::parse(
                &json!({"name": kind, "session": kind, "prompt": "hi", "setup": {"items": [
                    {"id": "s-1", "title": "t", "body": "b", "privacy": "sensitive"}
                ]}})
                .to_string(),
                Path::new("x.json"),
            )
            .unwrap();
            let d = dir.path().join(kind);
            let mcp = prepare(&d, &s, r#"{"args": ["{setup}"]}"#).unwrap();
            let setup: serde_json::Value =
                serde_json::from_slice(&std::fs::read(d.join("setup.json")).unwrap()).unwrap();
            assert_eq!(setup["authorized"], authorized);
            assert_eq!(setup["session"], kind);
            assert_eq!(setup["items"][0]["id"], "s-1");
            let cfg: serde_json::Value =
                serde_json::from_slice(&std::fs::read(mcp).unwrap()).unwrap();
            assert_eq!(cfg["args"][0], d.join("setup.json").display().to_string());
            assert!(d.join("cwd").is_dir());
        }
    }
}
