//! The tiny program Claude Code starts as its MCP server (M6): it turns standard input and output
//! into the local socket and presents the one-time token. It knows nothing else. The app's own
//! executable plays this part when started with `--dem-gw-shim`.

use std::io::{Read, Write};
use std::os::unix::net::UnixStream;

pub const ARG: &str = "--dem-gw-shim";
pub const ENV_SOCKET: &str = "DEM_GW_SOCKET";
pub const ENV_TOKEN: &str = "DEM_GW_TOKEN";

/// Call first thing in `main`. If this run is the shim, it never returns.
pub fn run_if_asked() {
    if std::env::args().nth(1).as_deref() == Some(ARG) {
        std::process::exit(i32::from(run().is_err()));
    }
}

fn run() -> std::io::Result<()> {
    let socket = std::env::var(ENV_SOCKET).map_err(std::io::Error::other)?;
    let token = std::env::var(ENV_TOKEN).map_err(std::io::Error::other)?;
    let mut stream = UnixStream::connect(socket)?;
    writeln!(stream, "{token}")?;
    let mut from_server = stream.try_clone()?;
    let out = std::thread::spawn(move || {
        let mut stdout = std::io::stdout();
        let mut buf = [0u8; 16 * 1024];
        while let Ok(n) = from_server.read(&mut buf) {
            if n == 0 || stdout.write_all(&buf[..n]).is_err() || stdout.flush().is_err() {
                break;
            }
        }
    });
    let mut stdin = std::io::stdin();
    let mut buf = [0u8; 16 * 1024];
    loop {
        let n = stdin.read(&mut buf)?;
        if n == 0 {
            break;
        }
        stream.write_all(&buf[..n])?;
    }
    stream.shutdown(std::net::Shutdown::Write)?;
    let _ = out.join();
    Ok(())
}
