//! 编译检查 (C7, M7): one file, no dependencies, with whatever the machine already has. Only tools
//! that check without running: no macro expansion that can run code, no execution of the answer.

use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::ai::CodeCheck;
use crate::coderun::{CodeRun, CodeTest};

const LIMIT: Duration = Duration::from_secs(20);

fn tool_for(language: &str) -> Option<(&'static str, &'static str, Vec<&'static str>)> {
    Some(match language.to_lowercase().as_str() {
        "python" | "py" => (
            "python3",
            "answer.py",
            vec!["-m", "py_compile", "answer.py"],
        ),
        "c" => ("clang", "answer.c", vec!["-fsyntax-only", "answer.c"]),
        "cpp" | "c++" | "cc" => ("clang++", "answer.cpp", vec!["-fsyntax-only", "answer.cpp"]),
        "javascript" | "js" => ("node", "answer.js", vec!["--check", "answer.js"]),
        // No dependencies, so no procedural macros and no build script: nothing of the answer runs.
        "rust" | "rs" => (
            "rustc",
            "answer.rs",
            vec![
                "--edition=2021",
                "--crate-type=lib",
                "--emit=metadata",
                "answer.rs",
            ],
        ),
        _ => return None,
    })
}

/// Rust compiled to WebAssembly and run with `dem_sandbox`, for platforms without a system sandbox
/// (`crate::coderun`). Needs `rustup target add wasm32-wasip1`.
pub fn run_tests_wasm(code: &str, tests: &[CodeTest]) -> Result<CodeRun, String> {
    let none = |state: &str, output: String| CodeRun {
        state: state.to_owned(),
        output,
        results: vec![],
        language: Some("Rust".to_owned()),
        install: (state == "no-toolchain").then(|| "rustup target add wasm32-wasip1".to_owned()),
    };
    // The answer is one file with no dependencies, so no build script or procedural macro.
    let args = [
        "--edition=2021",
        "--target=wasm32-wasip1",
        "-Copt-level=1",
        "-o",
        "answer.wasm",
        "answer.rs",
    ];
    let dir = std::env::temp_dir().join(format!("dem-run-{}", uuid::Uuid::now_v7().simple()));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let out = (|| {
        let built = run("rustc", "answer.rs", &args, code, &dir)?;
        if !built.ran {
            return Ok(none("no-toolchain", String::new()));
        }
        if !built.ok {
            // A missing target looks like a compile error; say what it really is.
            let state = if built.output.contains("target may not be installed")
                || built.output.contains("can't find crate for `std`")
            {
                "no-toolchain"
            } else {
                "compile-error"
            };
            return Ok(none(state, built.output));
        }
        let module = std::fs::read(dir.join("answer.wasm")).map_err(|e| e.to_string())?;
        let mut results = Vec::new();
        for t in tests {
            let r = dem_sandbox::run(&module, &t.input, dem_sandbox::Limits::default())
                .map_err(|e| e.to_string())?;
            results.push(crate::coderun::result(t, r));
        }
        Ok(CodeRun {
            state: "ran".to_owned(),
            output: String::new(),
            results,
            language: Some("Rust".to_owned()),
            install: None,
        })
    })();
    let _ = std::fs::remove_dir_all(&dir);
    out
}

pub fn check(language: &str, code: &str) -> Result<CodeCheck, String> {
    let Some((tool, file, args)) = tool_for(language) else {
        return Ok(CodeCheck {
            ran: false,
            ok: false,
            output: String::new(),
        });
    };
    let dir = std::env::temp_dir().join(format!("dem-check-{}", uuid::Uuid::now_v7().simple()));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let out = run(tool, file, &args, code, &dir);
    let _ = std::fs::remove_dir_all(&dir);
    out
}

fn run(
    tool: &str,
    file: &str,
    args: &[&str],
    code: &str,
    dir: &std::path::Path,
) -> Result<CodeCheck, String> {
    std::fs::write(dir.join(file), code).map_err(|e| e.to_string())?;
    let spawned = Command::new(tool)
        .args(args)
        .current_dir(dir)
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();
    let Ok(mut child) = spawned else {
        return Ok(CodeCheck {
            ran: false,
            ok: false,
            output: String::new(),
        });
    };
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            break status;
        }
        if started.elapsed() > LIMIT {
            let _ = child.kill();
            let _ = child.wait();
            return Err("took too long".to_owned());
        }
        std::thread::sleep(Duration::from_millis(30));
    };
    let mut output = String::new();
    if let Some(mut err) = child.stderr.take() {
        let _ = err.read_to_string(&mut output);
    }
    Ok(CodeCheck {
        ran: true,
        ok: status.success(),
        output: output.chars().take(4000).collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_language_without_a_checker_says_it_did_not_run() {
        let r = check("cobol", "x").unwrap();
        assert!(!r.ran);
    }

    #[test]
    fn python_is_checked_and_not_run() {
        let marker = std::env::temp_dir().join(format!("dem-ran-{}", std::process::id()));
        let code = format!("open(r'{}', 'w').write('x')\n", marker.display());
        let r = check("python", &code).unwrap();
        if !r.ran {
            return;
        }
        assert!(r.ok);
        assert!(!marker.exists(), "the answer must not run");
        assert!(!check("python", "def (:\n").unwrap().ok);
    }

    #[test]
    fn rust_macros_do_not_run_and_a_broken_file_fails() {
        let r = check("rust", "fn main() { println!(\"x\"); }").unwrap();
        if !r.ran {
            return;
        }
        assert!(r.ok, "{}", r.output);
        assert!(!check("rust", "fn main( {").unwrap().ok);
    }
}
