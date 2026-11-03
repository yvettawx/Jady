// Hide the console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Claude Code starts this same program as the bridge to the gateway.
    dem_ai_gateway::shim::run_if_asked();
    if let Err(e) = dem_desktop::run() {
        tracing_fallback(&e);
        std::process::exit(1);
    }
}

#[allow(clippy::print_stderr)]
fn tracing_fallback(e: &tauri::Error) {
    // Startup failed before the diagnostic log existed; stderr is all we have.
    eprintln!("dem-desktop failed to start: {e}");
}
