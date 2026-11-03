//! The macOS keychain for the library's master key (format spec §4.1). A read can sit waiting on a
//! system prompt, so it runs on its own thread with a time limit: if it takes too long the caller
//! falls back to asking for the password, and the interface never hangs (M9).

use std::sync::mpsc;
use std::time::Duration;

use dem_core::{Keychain, KeychainError};

const READ_TIMEOUT: Duration = Duration::from_secs(60);

#[cfg(debug_assertions)]
const SERVICE: &str = "dev.dem.desktop.dev";
#[cfg(not(debug_assertions))]
const SERVICE: &str = "dev.dem.desktop";

#[derive(Debug, Default)]
pub struct SystemKeychain;

impl SystemKeychain {
    pub fn new() -> Self {
        Self
    }
}

fn entry(account: &str) -> Result<keyring::Entry, KeychainError> {
    keyring::Entry::new(SERVICE, account).map_err(|e| KeychainError::Other(e.to_string()))
}

fn convert(e: keyring::Error) -> KeychainError {
    match e {
        keyring::Error::NoEntry => KeychainError::NotFound,
        other => KeychainError::Other(other.to_string()),
    }
}

impl Keychain for SystemKeychain {
    fn read(&self, account: &str) -> Result<Vec<u8>, KeychainError> {
        let account = account.to_owned();
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let result = entry(&account).and_then(|e| e.get_secret().map_err(convert));
            // Nobody listening any more means the caller gave up waiting.
            let _ = tx.send(result);
        });
        rx.recv_timeout(READ_TIMEOUT)
            .map_err(|_| KeychainError::Other("timed out".into()))?
    }

    fn write(&self, account: &str, secret: &[u8]) -> Result<(), KeychainError> {
        entry(account)?.set_secret(secret).map_err(convert)
    }

    fn delete(&self, account: &str) -> Result<(), KeychainError> {
        match entry(account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(convert(e)),
        }
    }
}
