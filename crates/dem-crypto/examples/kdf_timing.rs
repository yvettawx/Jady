//! Measures Argon2id unlock time for candidate parameters:
//! `cargo run --release -p dem-crypto --example kdf_timing`.

#![allow(clippy::print_stdout, clippy::unwrap_used)]

use std::time::Instant;

use dem_crypto::MasterKey;
use dem_crypto::keys::{KdfParams, new_salt, unwrap_with_password, wrap_with_password};

fn main() {
    let master = MasterKey::generate();
    let salt = new_salt();
    for (m_mib, t, p) in [
        (256, 2, 4),
        (256, 3, 4),
        (256, 4, 4),
        (256, 5, 4),
        (256, 6, 4),
    ] {
        let params = KdfParams {
            m_kib: m_mib * 1024,
            t,
            p,
        };
        let w = wrap_with_password(&master, b"pw", &salt, params, b"b").unwrap();
        let mut times = Vec::new();
        for _ in 0..5 {
            let start = Instant::now();
            unwrap_with_password(&w, b"pw", &salt, params, b"b").unwrap();
            times.push(start.elapsed().as_millis());
        }
        times.sort();
        println!(
            "m={m_mib}MiB t={t} p={p}: median {} ms (min {}, max {})",
            times[2], times[0], times[4]
        );
    }
}
