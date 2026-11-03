//! `dem`: the library from the terminal (M13). Reaches the running app over its socket; when the
//! app is not running, asks for the master password and opens the library itself.

#![allow(clippy::print_stdout, clippy::print_stderr)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;

use dem_core::cli::{Request, handle};
use dem_core::{Core, MemoryKeychain};
use serde_json::Value;

const USAGE: &str = "dem: add to and look through your library

  dem add <text>                 put a line in the inbox
  dem add --type todo <text> [--due yyyy-mm-dd]
  dem today                      next steps and what is due
  dem list [--type t] [--tag t] [--limit n]
  dem search <words>
  dem done <id>

  --all   also 私密 and 机密 (机密 without titles); left out by default
  --json  print JSON";

fn config_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("DEM_CONFIG_DIR") {
        return Some(dir.into());
    }
    let home = std::env::var_os("HOME")?;
    Some(PathBuf::from(home).join("Library/Application Support/dev.dem.desktop"))
}

fn take_flag(args: &mut Vec<String>, name: &str) -> bool {
    match args.iter().position(|a| a == name) {
        Some(i) => {
            args.remove(i);
            true
        }
        None => false,
    }
}

fn take_value(args: &mut Vec<String>, name: &str) -> Option<String> {
    let i = args.iter().position(|a| a == name)?;
    args.remove(i);
    (i < args.len()).then(|| args.remove(i))
}

fn parse(mut args: Vec<String>) -> Result<(Request, bool), String> {
    let json = take_flag(&mut args, "--json");
    let all = take_flag(&mut args, "--all");
    let command = if args.is_empty() {
        return Err(USAGE.to_owned());
    } else {
        args.remove(0)
    };
    let request = match command.as_str() {
        "add" => {
            let type_id = take_value(&mut args, "--type");
            let due = take_value(&mut args, "--due");
            if args.is_empty() {
                return Err(USAGE.to_owned());
            }
            Request::Add {
                text: args.join(" "),
                type_id,
                due,
            }
        }
        "today" => Request::Today { all },
        "list" => Request::List {
            type_id: take_value(&mut args, "--type"),
            tag: take_value(&mut args, "--tag"),
            limit: take_value(&mut args, "--limit").and_then(|n| n.parse().ok()),
            all,
        },
        "search" if !args.is_empty() => Request::Search {
            query: args.join(" "),
            all,
        },
        "done" if args.len() == 1 => Request::Done { id: args.remove(0) },
        _ => return Err(USAGE.to_owned()),
    };
    Ok((request, json))
}

fn over_socket(path: &std::path::Path, request: &Request) -> Option<Result<Value, String>> {
    let mut stream = UnixStream::connect(path).ok()?;
    let line = serde_json::to_string(request).ok()?;
    writeln!(stream, "{line}").ok()?;
    let mut answer = String::new();
    BufReader::new(stream).read_line(&mut answer).ok()?;
    let v: Value = serde_json::from_str(&answer).ok()?;
    Some(match v.get("error").and_then(Value::as_str) {
        Some(e) => Err(e.to_owned()),
        None => Ok(v.get("ok").cloned().unwrap_or(Value::Null)),
    })
}

fn opening_it(config: PathBuf, request: Request) -> Result<Value, String> {
    let core = Core::new(
        config,
        std::env::temp_dir(),
        Box::new(MemoryKeychain::default()),
    );
    let start = core.start_state();
    let library = start
        .library
        .ok_or("no library yet: open the app and make one first")?;
    let password =
        rpassword::prompt_password("主密码 / master password: ").map_err(|e| e.to_string())?;
    let opened = core
        .unlock_password(&library.path, &password)
        .map_err(|e| e.message)?;
    if !opened {
        return Err("wrong password".to_owned());
    }
    let out = core.with(|s| handle(s, request)).map_err(|e| e.message);
    core.lock().map_err(|e| e.message)?;
    out
}

fn print(value: &Value, json: bool) {
    if json {
        println!("{value}");
        return;
    }
    let one = |v: &Value| {
        let id = v["id"].as_str().unwrap_or("");
        let title = v["title"].as_str().unwrap_or("🔒");
        let mark = match v["privacy"].as_str() {
            Some("sensitive" | "private" | "confidential") => " 🔒",
            _ => "",
        };
        println!("{id}  {title}{mark}");
    };
    match value {
        Value::Array(items) => items.iter().for_each(one),
        other => one(other),
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (request, json) = match parse(args) {
        Ok(p) => p,
        Err(usage) => {
            eprintln!("{usage}");
            std::process::exit(2);
        }
    };
    let Some(config) = config_dir() else {
        eprintln!("cannot tell where the settings are");
        std::process::exit(1);
    };
    let result = over_socket(&config.join("cli.sock"), &request)
        .unwrap_or_else(|| opening_it(config, request));
    match result {
        Ok(v) => print(&v, json),
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    }
}
