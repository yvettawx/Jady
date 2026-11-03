//! 沙盒运行 (C7, M7): an answer is built and run against its test cases with the toolchains this
//! machine already has, inside the system sandbox (`dem_sandbox::native`): no network, no reading
//! the user's files, no writing outside a fresh work folder, no starting other programs. When a
//! language is missing, the result says what to install. Where there is no system sandbox, Rust
//! still runs in WebAssembly.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use dem_sandbox::native::{NativeJob, native_available, run_native};
use dem_sandbox::{Ending, Limits, RunResult};
use serde::{Deserialize, Serialize};

/// One test case: what goes to stdin, and what stdout should be.
#[derive(Debug, Clone, Deserialize, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CodeTest {
    pub input: String,
    pub expected: String,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CodeTestResult {
    pub input: String,
    pub expected: String,
    pub got: String,
    /// `pass`, `fail`, `timeout`, `memory` or `crash`.
    pub verdict: String,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CodeRun {
    /// `ran`, `no-toolchain` (this language is not installed), `unsupported` (no way to run this
    /// language yet) or `compile-error`.
    pub state: String,
    pub output: String,
    pub results: Vec<CodeTestResult>,
    /// The language as people write it, such as `Python`.
    pub language: Option<String>,
    /// For `no-toolchain`: a command that installs it.
    pub install: Option<String>,
}

/// How one language is built and run. `{tool}` is the program found on this machine.
struct Lang {
    name: &'static str,
    file: &'static str,
    tool: &'static str,
    /// Arguments to the tool that build `answer`; `None` when the tool runs the file itself.
    build: Option<&'static [&'static str]>,
    /// Arguments to the tool that run the file, when there is no build step.
    run: &'static [&'static str],
    install: &'static str,
    /// Lives in /usr/bin as a stub until the Command Line Tools are installed.
    command_line_tools: bool,
}

const XCODE_TOOLS: &str = "xcode-select --install";

fn lang(language: &str) -> Option<Lang> {
    let l = |name, file, tool, build, run, install, command_line_tools| Lang {
        name,
        file,
        tool,
        build,
        run,
        install,
        command_line_tools,
    };
    Some(match language.trim().to_lowercase().as_str() {
        "python" | "py" | "python3" => l(
            "Python",
            "answer.py",
            "python3",
            None,
            &["-I", "answer.py"],
            "brew install python",
            true,
        ),
        "javascript" | "js" | "node" => l(
            "JavaScript",
            "answer.js",
            "node",
            None,
            &["answer.js"],
            "brew install node",
            false,
        ),
        "c" => l(
            "C",
            "answer.c",
            "clang",
            Some(&["-O2", "-std=c17", "-o", "answer", "answer.c", "-lm"]),
            &[],
            XCODE_TOOLS,
            true,
        ),
        "cpp" | "c++" | "cc" | "cxx" => l(
            "C++",
            "answer.cpp",
            "clang++",
            Some(&["-O2", "-std=c++17", "-o", "answer", "answer.cpp"]),
            &[],
            XCODE_TOOLS,
            true,
        ),
        // One file, no dependencies: no build script or procedural macro of the answer runs.
        "rust" | "rs" => l(
            "Rust",
            "answer.rs",
            "rustc",
            Some(&["-O", "--edition=2021", "-o", "answer", "answer.rs"]),
            &[],
            "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh",
            false,
        ),
        "go" | "golang" => l(
            "Go",
            "answer.go",
            "go",
            Some(&["build", "-o", "answer", "answer.go"]),
            &[],
            "brew install go",
            false,
        ),
        // Single-file source launch: the first class in the file is the program.
        "java" => l(
            "Java",
            "answer.java",
            "java",
            None,
            &["-Xmx192m", "-Xss64m", "answer.java"],
            "brew install openjdk",
            false,
        ),
        "swift" => l(
            "Swift",
            "answer.swift",
            "swiftc",
            Some(&["-O", "-o", "answer", "answer.swift"]),
            &[],
            XCODE_TOOLS,
            true,
        ),
        "ruby" | "rb" => l(
            "Ruby",
            "answer.rb",
            "ruby",
            None,
            &["--disable-gems", "answer.rb"],
            "brew install ruby",
            false,
        ),
        _ => return None,
    })
}

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

fn command_line_tools() -> bool {
    Command::new("/usr/bin/xcode-select")
        .arg("-p")
        .output()
        .is_ok_and(|o| o.status.success())
}

/// A GUI app starts with a short PATH, so the usual places are searched too. The stubs in
/// /usr/bin only count once the Command Line Tools are there, or calling one opens an installer.
fn find(lang: &Lang) -> Option<PathBuf> {
    let mut dirs: Vec<PathBuf> = vec!["/opt/homebrew/bin".into(), "/usr/local/bin".into()];
    if let Some(h) = home() {
        dirs.push(h.join(".cargo/bin"));
        dirs.push(h.join(".local/bin"));
        dirs.push(h.join("go/bin"));
    }
    if lang.tool == "java" {
        for prefix in ["/opt/homebrew/opt", "/usr/local/opt"] {
            if let Ok(entries) = std::fs::read_dir(prefix) {
                let mut jdks: Vec<_> = entries
                    .flatten()
                    .map(|e| e.path())
                    .filter(|p| {
                        p.file_name()
                            .is_some_and(|n| n.to_string_lossy().starts_with("openjdk"))
                    })
                    .collect();
                jdks.sort();
                dirs.extend(jdks.into_iter().rev().map(|p| p.join("bin")));
            }
        }
        if let Ok(out) = Command::new("/usr/libexec/java_home").output()
            && out.status.success()
        {
            let java_home = String::from_utf8_lossy(&out.stdout).trim().to_owned();
            dirs.push(PathBuf::from(java_home).join("bin"));
        }
    } else if let Some(path) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&path));
    }
    let found = dirs
        .into_iter()
        .filter(|d| !d.starts_with("/usr/bin"))
        .map(|d| d.join(lang.tool))
        .find(|p| p.is_file());
    if found.is_some() {
        return found;
    }
    // /usr/bin/java is always a stub; system Ruby is real.
    let system = Path::new("/usr/bin").join(lang.tool);
    let usable = match lang.tool {
        "java" => false,
        _ if lang.command_line_tools => command_line_tools(),
        _ => true,
    };
    (usable && system.is_file()).then_some(system)
}

/// What a toolchain under the user's home needs to read, and the environment that points at it.
fn toolchain_access(
    lang: &Lang,
    program: &Path,
    dir: &Path,
) -> (Vec<PathBuf>, Vec<(String, String)>) {
    let mut read = Vec::new();
    let mut env = Vec::new();
    let Some(home) = home() else {
        return (read, env);
    };
    if lang.tool == "rustc" {
        let rustup = std::env::var_os("RUSTUP_HOME").map_or(home.join(".rustup"), PathBuf::from);
        let cargo = std::env::var_os("CARGO_HOME").map_or(home.join(".cargo"), PathBuf::from);
        env.push(("RUSTUP_HOME".into(), rustup.display().to_string()));
        env.push(("CARGO_HOME".into(), cargo.display().to_string()));
        read.push(rustup);
        read.push(cargo);
    }
    if lang.tool == "go" {
        env.push(("GOCACHE".into(), dir.join(".gocache").display().to_string()));
        env.push(("GOPATH".into(), dir.join(".gopath").display().to_string()));
        env.push(("GOTOOLCHAIN".into(), "local".into()));
        env.push(("GO111MODULE".into(), "off".into()));
        env.push(("CGO_ENABLED".into(), "0".into()));
    }
    // A toolchain installed under home (nvm, pyenv and the like) keeps its files near the binary.
    if let Ok(real) = program.canonicalize()
        && real.starts_with(&home)
        && let Some(root) = real.ancestors().nth(2)
        && root != home
    {
        read.push(root.to_owned());
    }
    (read, env)
}

/// Compares the way people read output: trailing spaces and blank lines at the end do not matter.
fn same_output(a: &str, b: &str) -> bool {
    let tidy = |s: &str| {
        s.trim_end()
            .lines()
            .map(str::trim_end)
            .collect::<Vec<_>>()
            .join("\n")
    };
    tidy(a) == tidy(b)
}

fn verdict(r: &RunResult, expected: &str) -> &'static str {
    match r.ending {
        Ending::TimedOut => "timeout",
        Ending::OutOfMemory => "memory",
        Ending::Crashed(_) => "crash",
        Ending::Exit(0) if same_output(&r.stdout, expected) => "pass",
        Ending::Exit(0) => "fail",
        Ending::Exit(_) => "crash",
    }
}

pub(crate) fn result(t: &CodeTest, r: RunResult) -> CodeTestResult {
    CodeTestResult {
        input: t.input.clone(),
        expected: t.expected.clone(),
        verdict: verdict(&r, &t.expected).to_owned(),
        got: if r.stdout.is_empty() {
            r.stderr
        } else {
            r.stdout
        },
    }
}

fn state(state: &str, lang: Option<&Lang>, output: String) -> CodeRun {
    CodeRun {
        state: state.to_owned(),
        output: output.chars().take(4000).collect(),
        results: vec![],
        language: lang.map(|l| l.name.to_owned()),
        install: (state == "no-toolchain")
            .then(|| lang.map(|l| l.install.to_owned()))
            .flatten(),
    }
}

const BUILD: Limits = Limits {
    time: Duration::from_secs(60),
    memory_bytes: usize::MAX,
    output_bytes: 64 * 1024,
};
const RUN: Limits = Limits {
    time: Duration::from_secs(5),
    memory_bytes: 256 * 1024 * 1024,
    output_bytes: 256 * 1024,
};

pub fn run_tests(language: &str, code: &str, tests: &[CodeTest]) -> Result<CodeRun, String> {
    let Some(lang) = lang(language) else {
        return Ok(state("unsupported", None, String::new()));
    };
    if !native_available() {
        return if lang.tool == "rustc" {
            crate::compile::run_tests_wasm(code, tests)
        } else {
            Ok(state("unsupported", Some(&lang), String::new()))
        };
    }
    let Some(program) = find(&lang) else {
        return Ok(state("no-toolchain", Some(&lang), String::new()));
    };
    let dir = std::env::temp_dir().join(format!("dem-run-{}", uuid::Uuid::now_v7().simple()));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let out = (|| {
        // The sandbox matches real paths: /var is /private/var.
        let dir = dir.canonicalize().map_err(|e| e.to_string())?;
        std::fs::write(dir.join(lang.file), code).map_err(|e| e.to_string())?;
        let (read, env) = toolchain_access(&lang, &program, &dir);
        let job = |program: &Path, args: Vec<String>, stdin: &str, fork: bool| {
            run_native(
                &NativeJob {
                    program,
                    args: &args,
                    dir: &dir,
                    stdin,
                    read: &read,
                    env: &env,
                    fork,
                },
                if fork { BUILD } else { RUN },
            )
            .map_err(|e| e.to_string())
        };
        let strings = |a: &[&str]| a.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>();
        let (runner, args) = match lang.build {
            Some(build) => {
                let built = job(&program, strings(build), "", true)?;
                if built.ending != Ending::Exit(0) {
                    let output = if built.stderr.is_empty() {
                        built.stdout
                    } else {
                        built.stderr
                    };
                    return Ok(state("compile-error", Some(&lang), output));
                }
                (dir.join("answer"), vec![])
            }
            None => (program.clone(), strings(lang.run)),
        };
        let mut results = Vec::new();
        for t in tests {
            let r = job(&runner, args.clone(), &t.input, false)?;
            results.push(result(t, r));
        }
        Ok(CodeRun {
            state: "ran".to_owned(),
            output: String::new(),
            results,
            language: Some(lang.name.to_owned()),
            install: None,
        })
    })();
    let _ = std::fs::remove_dir_all(&dir);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn case(input: &str, expected: &str) -> CodeTest {
        CodeTest {
            input: input.into(),
            expected: expected.into(),
        }
    }

    /// Each answer adds two numbers from stdin.
    const ANSWERS: &[(&str, &str)] = &[
        ("python", "print(sum(map(int, input().split())))"),
        (
            "javascript",
            "const [a, b] = require('fs').readFileSync(0, 'utf8').split(/\\s+/).map(Number); console.log(a + b);",
        ),
        (
            "c",
            "#include <stdio.h>\nint main(void){int a,b;scanf(\"%d %d\",&a,&b);printf(\"%d\\n\",a+b);}",
        ),
        (
            "cpp",
            "#include <iostream>\nint main(){int a,b;std::cin>>a>>b;std::cout<<a+b<<\"\\n\";}",
        ),
        (
            "rust",
            "use std::io::Read;\nfn main(){let mut s=String::new();std::io::stdin().read_to_string(&mut s).unwrap();let n:i64=s.split_whitespace().map(|x|x.parse::<i64>().unwrap()).sum();println!(\"{n}\");}",
        ),
        (
            "go",
            "package main\nimport \"fmt\"\nfunc main(){var a,b int;fmt.Scan(&a,&b);fmt.Println(a+b)}",
        ),
        (
            "java",
            "import java.util.*;\npublic class Main{public static void main(String[] x){Scanner s=new Scanner(System.in);System.out.println(s.nextInt()+s.nextInt());}}",
        ),
        (
            "swift",
            "let v = readLine()!.split(separator: \" \").map { Int($0)! }\nprint(v[0] + v[1])",
        ),
        ("ruby", "puts gets.split.map(&:to_i).sum"),
    ];

    #[test]
    fn every_installed_language_runs_its_cases() {
        for (language, code) in ANSWERS {
            let r = run_tests(language, code, &[case("1 2", "3\n"), case("2 2", "5")]).unwrap();
            if r.state == "no-toolchain" {
                eprintln!("skipped {language}: {}", r.install.unwrap_or_default());
                assert!(lang(language).is_some());
                continue;
            }
            assert_eq!(r.state, "ran", "{language}: {}", r.output);
            let got: Vec<_> = r.results.iter().map(|x| x.verdict.as_str()).collect();
            assert_eq!(got, ["pass", "fail"], "{language}: {:?}", r.results);
        }
    }

    #[test]
    fn an_answer_cannot_read_home_or_loop_forever() {
        let Some(home) = home() else {
            return;
        };
        let read = format!(
            "import os\ntry:\n    os.listdir({:?}); print('read')\nexcept Exception:\n    print('blocked')",
            home.display().to_string()
        );
        let r = run_tests("python", &read, &[case("", "blocked")]).unwrap();
        if r.state != "ran" {
            return;
        }
        assert_eq!(r.results[0].verdict, "pass", "{:?}", r.results);
        let r = run_tests("python", "while True: pass", &[case("", "")]).unwrap();
        assert_eq!(r.results[0].verdict, "timeout");
    }

    #[test]
    fn a_compile_error_is_reported_and_unknown_languages_say_so() {
        let r = run_tests("c", "int main( {", &[]).unwrap();
        if r.state != "no-toolchain" {
            assert_eq!(r.state, "compile-error");
            assert!(!r.output.is_empty());
        }
        assert_eq!(run_tests("cobol", "", &[]).unwrap().state, "unsupported");
    }

    #[test]
    fn trailing_space_does_not_fail_an_answer() {
        assert!(same_output("3 \n\n", "3"));
        assert!(!same_output("3", "4"));
    }
}
