//! Canonical library-relative paths. The path is authenticated as part of every
//! envelope so a file cannot be swapped into another location undetected; both
//! platforms must therefore compute byte-identical paths.

use crate::{CryptoError, Result};

/// Validates and canonicalizes a library-relative path: `/` separators (a `\` from
/// Windows is converted), no leading `/` or `./`, no empty, `.` or `..` segments,
/// and only lowercase ASCII letters, digits, `.`, `_` and `-`. Library file names are
/// ids and hashes, so this never rejects a legitimate path, and lowercase-only
/// keeps case-insensitive file systems from aliasing two files.
pub fn canonical(path: &str) -> Result<String> {
    let path = path.replace('\\', "/");
    if path.is_empty() {
        return Err(CryptoError::InvalidPath("empty"));
    }
    if path.starts_with('/') {
        return Err(CryptoError::InvalidPath("absolute"));
    }
    for seg in path.split('/') {
        match seg {
            "" => return Err(CryptoError::InvalidPath("empty segment")),
            "." | ".." => return Err(CryptoError::InvalidPath("dot segment")),
            _ => {}
        }
        if !seg.bytes().all(|b| {
            b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'.' | b'_' | b'-')
        }) {
            return Err(CryptoError::InvalidPath("character outside [a-z0-9._-]"));
        }
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonicalizes_windows_separators() {
        assert_eq!(
            canonical(r"items\ab\cd\x.dexm").unwrap(),
            "items/ab/cd/x.dexm"
        );
    }

    #[test]
    fn rejects_unsafe_paths() {
        for bad in [
            "",
            "/items/x",
            "items//x",
            "items/../x",
            "./x",
            "Items/x",
            "items/x y",
            "日记",
        ] {
            assert!(canonical(bad).is_err(), "{bad:?} must be rejected");
        }
    }
}
