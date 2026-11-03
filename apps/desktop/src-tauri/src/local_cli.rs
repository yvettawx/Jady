//! The socket `dem` talks to while the app is running (M13). A file only this user can reach; one
//! JSON request per connection. No TCP port. Nothing listens once the app has quit.

use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixListener;

use dem_core::Core;
use dem_core::cli::{Request, handle};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, Runtime};

pub fn serve<R: Runtime>(app: &AppHandle<R>) {
    let core = app.state::<Core>();
    let path = core.config_dir().join("cli.sock");
    let library = core.handle();
    // On a first launch nothing has created the folder yet.
    let _ = std::fs::create_dir_all(core.config_dir());
    let _ = std::fs::remove_file(&path);
    let Ok(listener) = UnixListener::bind(&path) else {
        tracing::warn!("command line socket could not open");
        return;
    };
    if std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).is_err() {
        // Better no command line than one other users can reach.
        let _ = std::fs::remove_file(&path);
        return;
    }
    let handle_ = app.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let library = library.clone();
            let app = handle_.clone();
            std::thread::spawn(move || {
                let Ok(reader) = stream.try_clone() else {
                    return;
                };
                let mut line = String::new();
                if BufReader::new(reader).read_line(&mut line).is_err() {
                    return;
                }
                let answer = match serde_json::from_str::<Request>(&line) {
                    Ok(request) => match library.with(|s| handle(s, request)) {
                        Ok(v) => json!({ "ok": v }),
                        Err(e) => json!({ "error": e.message }),
                    },
                    Err(e) => json!({ "error": e.to_string() }),
                };
                let mut stream = stream;
                let _ = writeln!(stream, "{answer}");
                let _ = app.emit(crate::ITEMS_CHANGED, ());
            });
        }
    });
}
