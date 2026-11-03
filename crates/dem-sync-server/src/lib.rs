//! The whole server: list, get, put, delete, behind one bearer token. It stores what it is given. It
//! has no key and no way to read a file, so all it ever knows is names and sizes (format spec §16).
//! No TLS here: put it behind a reverse proxy, or keep it on a private network.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use dem_sync::{Backend, FolderBackend, is_synced};
use tiny_http::{Header, Method, Response, Server};

const MAX_BODY: u64 = 2 * 1024 * 1024 * 1024;

fn path_of(url: &str) -> Option<&str> {
    let p = url.strip_prefix("/v1/files/")?;
    (p == dem_sync::MANIFEST || is_synced(p)).then_some(p)
}

/// Compares fingerprints, so the time taken says nothing about how much of a guess was right.
fn authorized(req: &tiny_http::Request, token_hash: &str) -> bool {
    req.headers()
        .iter()
        .find(|h| h.field.equiv("Authorization"))
        .and_then(|h| h.value.as_str().strip_prefix("Bearer "))
        .is_some_and(|t| dem_crypto::content_hash(t.as_bytes()) == token_hash)
}

fn handle(mut req: tiny_http::Request, store: &FolderBackend, token_hash: &str) {
    let empty = |code: u16| Response::from_data(Vec::new()).with_status_code(code);
    if !authorized(&req, token_hash) {
        let _ = req.respond(empty(401));
        return;
    }
    let url = req.url().to_owned();
    let method = req.method().clone();
    let reply = match (&method, url.as_str()) {
        (Method::Get, "/v1/list") => match store.list() {
            Ok(files) => {
                let body = serde_json::to_vec(&files).unwrap_or_default();
                let json = Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]);
                let mut r = Response::from_data(body);
                if let Ok(h) = json {
                    r = r.with_header(h);
                }
                r
            }
            Err(_) => empty(500),
        },
        _ => match path_of(&url) {
            None => empty(404),
            Some(path) => match method {
                Method::Get => match store.get(path) {
                    Ok(Some(data)) => Response::from_data(data),
                    Ok(None) => empty(404),
                    Err(_) => empty(500),
                },
                Method::Put => {
                    let mut data = Vec::new();
                    let read = req.as_reader().take(MAX_BODY).read_to_end(&mut data);
                    match read.map(|_| store.put(path, &data)) {
                        Ok(Ok(())) => empty(204),
                        _ => empty(500),
                    }
                }
                Method::Delete => match store.delete(path) {
                    Ok(()) => empty(204),
                    Err(_) => empty(500),
                },
                _ => empty(405),
            },
        },
    };
    let _ = req.respond(reply);
}

/// Serves until the process ends. `token` is what clients must send.
pub fn serve(server: Server, dir: &Path, token: &str) {
    let store = FolderBackend::new(dir);
    let hash = dem_crypto::content_hash(token.as_bytes());
    for req in server.incoming_requests() {
        handle(req, &store, &hash);
    }
}

/// Where to keep the files: created if it is not there yet.
pub fn prepare(dir: &Path) -> std::io::Result<PathBuf> {
    fs::create_dir_all(dir)?;
    Ok(dir.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use dem_sync::{HttpBackend, SyncError};

    fn start(dir: &Path, token: &str) -> String {
        let server = Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        let dir = dir.to_owned();
        let token = token.to_owned();
        std::thread::spawn(move || serve(server, &dir, &token));
        format!("http://127.0.0.1:{port}")
    }

    #[test]
    fn stores_and_returns_files_for_the_right_token_only() {
        let dir = tempfile::tempdir().unwrap();
        let url = start(dir.path(), "the-token");
        let good = HttpBackend::new(&url, "the-token").unwrap();
        good.put("items/ab/1.dexm", b"ciphertext").unwrap();
        good.put(dem_sync::MANIFEST, b"{}").unwrap();
        assert_eq!(good.get("items/ab/1.dexm").unwrap().unwrap(), b"ciphertext");
        assert_eq!(good.get("items/ab/none.dexm").unwrap(), None);
        let list = good.list().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].path, "items/ab/1.dexm");
        good.delete("items/ab/1.dexm").unwrap();
        assert!(good.list().unwrap().is_empty());

        let bad = HttpBackend::new(&url, "wrong").unwrap();
        assert!(matches!(bad.list(), Err(SyncError::Unauthorized)));
        assert!(matches!(
            bad.get("items/ab/1.dexm"),
            Err(SyncError::Unauthorized)
        ));
    }

    /// The whole sync round, over HTTP: what the app does with a self-hosted server.
    #[test]
    fn two_folders_settle_through_the_server() {
        let store = tempfile::tempdir().unwrap();
        let url = start(store.path(), "the-token");
        let key =
            dem_crypto::keys::file_key(&dem_crypto::MasterKey::from_bytes([7; 32]), &[1; 16], 1);
        let write = |root: &Path, rel: &str, text: &str| {
            let sealed = dem_crypto::envelope::seal(&key, rel, text.as_bytes()).unwrap();
            let p = root.join(rel);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(p, sealed).unwrap();
        };
        let round = |root: &Path, state: &mut dem_sync::SyncState, device: &str| {
            let backend = HttpBackend::new(&url, "the-token").unwrap();
            let mut n = 0;
            let mut next = || {
                n += 1;
                n
            };
            let mut me = dem_sync::Identity {
                device,
                key: &key,
                next_seq: &mut next,
            };
            dem_sync::run(root, &backend, state, &mut me).unwrap()
        };
        let (a, b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        for d in [&a, &b] {
            fs::write(d.path().join(dem_sync::MANIFEST), "{}").unwrap();
        }
        write(a.path(), "items/x/1.aaaa-1.dexu", "from a zzsecret");
        write(b.path(), "items/x/1.bbbb-1.dexu", "from b");
        let (mut sa, mut sb) = (
            dem_sync::SyncState::default(),
            dem_sync::SyncState::default(),
        );
        round(a.path(), &mut sa, "aaaa");
        round(b.path(), &mut sb, "bbbb");
        round(a.path(), &mut sa, "aaaa");
        assert!(a.path().join("items/x/1.bbbb-1.dexu").exists());
        assert!(b.path().join("items/x/1.aaaa-1.dexu").exists());
        let held = fs::read(store.path().join("items/x/1.aaaa-1.dexu")).unwrap();
        assert!(!String::from_utf8_lossy(&held).contains("zzsecret"));
    }

    #[test]
    fn a_path_cannot_leave_the_folder() {
        assert!(path_of("/v1/files/../secret").is_none());
        assert!(path_of("/v1/files/items/../../secret").is_none());
        assert!(path_of("/v1/files/local/device.json").is_none());
        assert!(path_of("/v1/files/items/ab/1.dexm").is_some());
    }

    #[test]
    fn the_client_will_not_send_a_token_over_plain_http() {
        assert!(HttpBackend::new("http://example.com", "t").is_err());
        assert!(HttpBackend::new("https://example.com", "t").is_ok());
    }
}
