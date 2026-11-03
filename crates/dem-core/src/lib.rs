//! Service facade: the only entry point for the UI and the AI gateway to reach data
//! (docs/02-architecture.md, CLAUDE.md). Everything above this crate speaks in the types here.

mod ai_view;
mod core;
mod dto;
mod error;
mod export;
mod import;
mod session;

use serde::{Deserialize, Serialize};

pub mod ai_tools;
pub mod cli;
pub mod learn;
pub mod plugin_api;
pub mod proposal;
pub mod vault;
pub use dem_io::fetch_page;

pub use ai_view::AiView;
pub use core::{Core, CoreHandle, Keychain, KeychainError, MemoryKeychain, keychain_account};
pub use dem_model::{AiSession, FieldDef, FieldKind, PrivacyDto, SelectOption, TypeDef, ViewKind};
pub use dto::*;
pub use error::{CoreError, CoreResult};
pub use session::{Session, privacy_of};

/// Basic facts about the running build, shown by the UI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub name: String,
    pub version: String,
    pub format_version: u32,
}

pub fn app_info() -> AppInfo {
    AppInfo {
        name: "Jady".to_owned(),
        version: env!("CARGO_PKG_VERSION").to_owned(),
        format_version: dem_store::FORMAT_VERSION,
    }
}

/// A token nobody can guess: 256 bits from the crypto library's generator, as hex.
pub fn random_token() -> String {
    (0..4)
        .map(|_| format!("{:016x}", dem_crypto::random_u64()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_info_reports_current_format_version() {
        assert_eq!(app_info().format_version, dem_store::FORMAT_VERSION);
    }
}
