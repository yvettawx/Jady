//! Build script: generates the Tauri context and, on Windows MSVC, embeds the
//! application manifest through the linker.
//!
//! tauri-build normally embeds the manifest as a resource of the binary only, so
//! the unit-test executable lacks it and Windows loads the old Common Controls
//! DLL, which fails at startup with STATUS_ENTRYPOINT_NOT_FOUND (0xc0000139).
//! `rustc-link-arg` applies to every target of the crate, tests included.

// A build script reports failure by panicking.
#![allow(clippy::panic)]

fn main() {
    let msvc = std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc");
    let windows = if msvc {
        tauri_build::WindowsAttributes::new_without_app_manifest()
    } else {
        tauri_build::WindowsAttributes::new()
    };
    if let Err(e) =
        tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows))
    {
        panic!("tauri-build failed: {e:#}");
    }
    if msvc {
        let manifest =
            std::path::Path::new(&std::env::var("CARGO_MANIFEST_DIR").unwrap_or_default())
                .join("windows-app-manifest.xml");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    }
}
