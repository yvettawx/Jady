//! Run: cargo run -p dem-desktop --features e2e --example e2e_bridge -- <port> <throwaway dir>

#![allow(clippy::expect_used)]

fn main() {
    dem_ai_gateway::shim::run_if_asked();
    let mut args = std::env::args().skip(1);
    let port = args.next().and_then(|p| p.parse().ok()).unwrap_or(1421);
    let dir = args.next().expect("a throwaway directory");
    dem_desktop::e2e::serve(port, dir.into());
}
