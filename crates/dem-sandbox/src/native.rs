//! Runs a program from this machine's own toolchains inside the operating system's sandbox (C7,
//! M7). On macOS that is Seatbelt through `sandbox-exec`: no network, no reading the user's home
//! (except the toolchain folders the caller names), no writing outside the work folder, no system
//! services such as the clipboard, and, for an answer, no new processes. Other platforms have no
//! implementation yet and say so; the WebAssembly runner in this crate works everywhere.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::{Ending, Limits, RunResult, SandboxError};

/// One program to run.
#[derive(Debug, Clone)]
pub struct NativeJob<'a> {
    pub program: &'a Path,
    pub args: &'a [String],
    /// The only folder it may write to. Also its current folder, home and temporary folder.
    pub dir: &'a Path,
    pub stdin: &'a str,
    /// Folders under the user's home it may read, such as `~/.rustup`.
    pub read: &'a [PathBuf],
    /// Extra environment, on top of a clean one.
    pub env: &'a [(String, String)],
    /// Compilers start linkers and the like; answers do not get to start anything.
    pub fork: bool,
}

#[cfg(target_os = "macos")]
const SANDBOX_EXEC: &str = "/usr/bin/sandbox-exec";

/// Whether this platform has a native sandbox this crate can use.
pub fn native_available() -> bool {
    #[cfg(target_os = "macos")]
    {
        Path::new(SANDBOX_EXEC).is_file()
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

fn quote(p: &Path) -> String {
    let s = p.display().to_string();
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

/// The Seatbelt profile. Later rules win, so each exception comes after what it narrows.
pub fn profile(job: &NativeJob<'_>, home: Option<&Path>) -> String {
    let mut p = String::from(
        "(version 1)\n(deny default)\n(allow process-exec)\n(allow signal (target same-sandbox))\n(allow sysctl-read)\n(allow file-read*)\n",
    );
    if job.fork {
        p.push_str("(allow process-fork)\n");
    }
    if let Some(home) = home {
        p.push_str(&format!("(deny file-read* (subpath {}))\n", quote(home)));
    }
    p.push_str("(deny file-read* (subpath \"/Volumes\"))\n");
    for dir in job.read {
        p.push_str(&format!("(allow file-read* (subpath {}))\n", quote(dir)));
    }
    let dir = quote(job.dir);
    p.push_str(&format!("(allow file-read* file-write* (subpath {dir}))\n"));
    p.push_str("(allow file-write* (literal \"/dev/null\"))\n(deny network*)\n");
    p
}

/// Runs the job and stops it when it uses up its time, memory or output.
pub fn run_native(job: &NativeJob<'_>, limits: Limits) -> Result<RunResult, SandboxError> {
    if !native_available() {
        return Err(SandboxError::Engine(
            "no native sandbox on this platform".into(),
        ));
    }
    #[cfg(target_os = "macos")]
    {
        macos::run(job, limits)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = limits;
        Err(SandboxError::Engine(
            "no native sandbox on this platform".into(),
        ))
    }
}

/// Reads up to `cap` bytes and throws the rest away, so a flood of output cannot fill memory.
fn drain(mut from: impl Read + Send + 'static, cap: usize) -> std::thread::JoinHandle<Vec<u8>> {
    std::thread::spawn(move || {
        let mut kept = Vec::new();
        let mut buf = [0u8; 8192];
        while let Ok(n) = from.read(&mut buf) {
            if n == 0 {
                break;
            }
            let room = cap.saturating_sub(kept.len());
            kept.extend_from_slice(&buf[..n.min(room)]);
        }
        kept
    })
}

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use std::os::unix::process::{CommandExt, ExitStatusExt};

    /// Resident memory of one process, in bytes.
    fn rss(pid: u32) -> Option<usize> {
        let out = Command::new("/bin/ps")
            .args(["-o", "rss=", "-p", &pid.to_string()])
            .output()
            .ok()?;
        let kb: usize = String::from_utf8_lossy(&out.stdout).trim().parse().ok()?;
        Some(kb * 1024)
    }

    fn kill_group(pid: u32) {
        let _ = Command::new("/bin/kill")
            .args(["-KILL", &format!("-{pid}")])
            .stderr(Stdio::null())
            .status();
    }

    pub(super) fn run(job: &NativeJob<'_>, limits: Limits) -> Result<RunResult, SandboxError> {
        let home = std::env::var_os("HOME").map(PathBuf::from);
        let profile = profile(job, home.as_deref());
        let cpu = limits.time.as_secs().max(1) + 1;
        let mut cmd = Command::new("/bin/sh");
        // CPU time and file size are limited before the sandbox starts; the clock below covers
        // waiting, which uses no CPU.
        cmd.args([
            "-c",
            "ulimit -t \"$1\" -f 65536; shift; exec \"$@\"",
            "sh",
            &cpu.to_string(),
            SANDBOX_EXEC,
            "-p",
            &profile,
        ])
        .arg(job.program)
        .args(job.args)
        .current_dir(job.dir)
        .env_clear()
        .env("HOME", job.dir)
        .env("TMPDIR", job.dir)
        .env("PATH", "/usr/bin:/bin")
        .env("LANG", "en_US.UTF-8")
        .envs(job.env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0);
        let mut child = cmd
            .spawn()
            .map_err(|e| SandboxError::Engine(e.to_string()))?;
        let pid = child.id();
        if let Some(mut input) = child.stdin.take() {
            let text = job.stdin.to_owned();
            std::thread::spawn(move || {
                let _ = input.write_all(text.as_bytes());
            });
        }
        let out = child.stdout.take().map(|o| drain(o, limits.output_bytes));
        let err = child.stderr.take().map(|e| drain(e, limits.output_bytes));
        let started = Instant::now();
        let mut checked = Instant::now();
        let mut ending = None;
        let status = loop {
            if let Some(status) = child
                .try_wait()
                .map_err(|e| SandboxError::Engine(e.to_string()))?
            {
                break Some(status);
            }
            if started.elapsed() > limits.time {
                ending = Some(Ending::TimedOut);
            } else if !job.fork && checked.elapsed() > Duration::from_millis(100) {
                checked = Instant::now();
                if rss(pid).is_some_and(|m| m > limits.memory_bytes) {
                    ending = Some(Ending::OutOfMemory);
                }
            }
            if ending.is_some() {
                kill_group(pid);
                let _ = child.wait();
                break None;
            }
            std::thread::sleep(Duration::from_millis(15));
        };
        // Anything it started is gone with it.
        kill_group(pid);
        let text = |h: Option<std::thread::JoinHandle<Vec<u8>>>| {
            h.and_then(|h| h.join().ok())
                .map(|b| String::from_utf8_lossy(&b).into_owned())
                .unwrap_or_default()
        };
        let stdout = text(out);
        let stderr = text(err);
        let ending = ending.unwrap_or_else(|| match status {
            Some(s) => match (s.code(), s.signal()) {
                (Some(code), _) => Ending::Exit(code),
                // SIGXCPU: the CPU limit.
                (None, Some(24)) => Ending::TimedOut,
                (None, Some(sig)) => Ending::Crashed(format!("signal {sig}")),
                (None, None) => Ending::Crashed(String::new()),
            },
            None => Ending::TimedOut,
        });
        Ok(RunResult {
            ending,
            stdout,
            stderr,
        })
    }
}

#[cfg(test)]
#[cfg(target_os = "macos")]
mod tests {
    use super::*;

    fn temp() -> PathBuf {
        // Tests run in parallel: each needs a folder of its own.
        static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let d = std::env::temp_dir().join(format!("dem-native-test-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d.canonicalize().unwrap()
    }

    fn python(dir: &Path, code: &str, stdin: &str) -> RunResult {
        std::fs::write(dir.join("a.py"), code).unwrap();
        let args = vec!["a.py".to_owned()];
        let job = NativeJob {
            program: Path::new("/usr/bin/python3"),
            args: &args,
            dir,
            stdin,
            read: &[],
            env: &[],
            fork: false,
        };
        run_native(&job, Limits::default()).unwrap()
    }

    fn have_python() -> bool {
        Command::new("/usr/bin/xcode-select")
            .arg("-p")
            .output()
            .is_ok_and(|o| o.status.success())
    }

    #[test]
    fn it_runs_and_reads_stdin() {
        if !have_python() {
            return;
        }
        let d = temp();
        let r = python(&d, "print(sum(map(int, input().split())))", "1 2\n");
        assert_eq!(r.ending, Ending::Exit(0), "{}", r.stderr);
        assert_eq!(r.stdout.trim(), "3");
    }

    #[test]
    fn it_cannot_reach_home_network_clipboard_or_start_processes() {
        if !have_python() {
            return;
        }
        let d = temp();
        let home = std::env::var("HOME").unwrap();
        let code = format!(
            r#"
import os, socket, subprocess
def tried(f):
    try:
        f(); return "yes"
    except Exception:
        return "no"
print(tried(lambda: os.listdir({home:?})))
print(tried(lambda: socket.create_connection(("1.1.1.1", 80), timeout=2)))
print(tried(lambda: open("/private/tmp/dem-native-escape", "w")))
print(tried(lambda: subprocess.run(["/usr/bin/pbpaste"])))
"#
        );
        let r = python(&d, &code, "");
        assert_eq!(
            r.stdout.split_whitespace().collect::<Vec<_>>(),
            ["no"; 4],
            "{}",
            r.stderr
        );
        assert!(!Path::new("/private/tmp/dem-native-escape").exists());
    }

    #[test]
    fn it_stops_on_time_and_memory() {
        if !have_python() {
            return;
        }
        let d = temp();
        let limits = Limits {
            time: Duration::from_secs(1),
            ..Limits::default()
        };
        std::fs::write(d.join("a.py"), "while True: pass").unwrap();
        let args = vec!["a.py".to_owned()];
        let job = NativeJob {
            program: Path::new("/usr/bin/python3"),
            args: &args,
            dir: &d,
            stdin: "",
            read: &[],
            env: &[],
            fork: false,
        };
        assert_eq!(run_native(&job, limits).unwrap().ending, Ending::TimedOut);
        let r = python(&d, "x = bytearray(1 << 30); import time; time.sleep(3)", "");
        assert_eq!(r.ending, Ending::OutOfMemory);
    }
}
