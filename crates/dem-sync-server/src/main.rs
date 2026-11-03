//! dem-sync-server --dir <folder> [--listen 127.0.0.1:8787]; the token comes from DEM_SYNC_TOKEN, so
//! it stays out of the process list and shell history.

#![allow(clippy::print_stdout, clippy::print_stderr)] // A command-line program: this is its interface.

use std::path::PathBuf;

fn main() {
    let mut args = std::env::args().skip(1);
    let mut dir = None;
    let mut listen = "127.0.0.1:8787".to_owned();
    while let Some(a) = args.next() {
        match a.as_str() {
            "--dir" => dir = args.next().map(PathBuf::from),
            "--listen" => {
                if let Some(v) = args.next() {
                    listen = v;
                }
            }
            _ => {
                eprintln!("usage: dem-sync-server --dir <folder> [--listen host:port]");
                std::process::exit(2);
            }
        }
    }
    let Some(dir) = dir else {
        eprintln!("--dir is required");
        std::process::exit(2);
    };
    let Ok(token) = std::env::var("DEM_SYNC_TOKEN") else {
        eprintln!("set DEM_SYNC_TOKEN first");
        std::process::exit(2);
    };
    if token.len() < 16 {
        eprintln!("DEM_SYNC_TOKEN must be at least 16 characters");
        std::process::exit(2);
    }
    if let Err(e) = dem_sync_server::prepare(&dir) {
        eprintln!("cannot use {}: {e}", dir.display());
        std::process::exit(1);
    }
    let server = match tiny_http::Server::http(&listen) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("cannot listen on {listen}: {e}");
            std::process::exit(1);
        }
    };
    println!("listening on {listen}");
    dem_sync_server::serve(server, &dir, &token);
}
