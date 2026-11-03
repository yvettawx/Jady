//! Opening a library from command-line options.

use anyhow::{Context, bail};
use dem_crypto::RecoveryCode;
use dem_store::{Library, Unlock};

use crate::LibraryArgs;

pub fn open(args: &LibraryArgs) -> anyhow::Result<Library> {
    if let Some(code) = &args.recovery {
        let code = RecoveryCode::parse(code).context("invalid recovery code")?;
        return Ok(Library::open(&args.library, Unlock::Recovery(&code))?);
    }
    let pw = match &args.password {
        Some(p) => p.clone(),
        None => match std::env::var("DEM_PASSWORD") {
            Ok(p) => p,
            Err(_) => bail!("give --password, --recovery or set DEM_PASSWORD"),
        },
    };
    Ok(Library::open(
        &args.library,
        Unlock::Password(pw.as_bytes()),
    )?)
}
