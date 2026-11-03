//! Operating-system accessibility settings the interface follows (docs/05-design.md B.2).

use serde::Serialize;

/// What the system's display settings ask of the interface.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SystemAppearance {
    /// macOS: 辅助功能 › 显示 › 减少透明度. Windows: 透明效果 turned off.
    pub reduce_transparency: bool,
}

pub fn appearance() -> SystemAppearance {
    SystemAppearance {
        reduce_transparency: reduce_transparency(),
    }
}

/// Read through `defaults`, which keeps us out of unsafe Objective-C calls. The key does not
/// exist until the setting is first changed, which means off.
#[cfg(target_os = "macos")]
fn reduce_transparency() -> bool {
    std::process::Command::new("/usr/bin/defaults")
        .args(["read", "com.apple.universalaccess", "reduceTransparency"])
        .output()
        .map(|o| o.status.success() && String::from_utf8_lossy(&o.stdout).trim() == "1")
        .unwrap_or(false)
}

#[cfg(windows)]
fn reduce_transparency() -> bool {
    use winreg::RegKey;
    use winreg::enums::HKEY_CURRENT_USER;
    RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize")
        .and_then(|k| k.get_value::<u32, _>("EnableTransparency"))
        .map(|v| v == 0)
        .unwrap_or(false)
}

#[cfg(not(any(target_os = "macos", windows)))]
fn reduce_transparency() -> bool {
    false
}
