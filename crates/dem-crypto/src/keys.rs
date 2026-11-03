//! Library key hierarchy (format spec §4).
//!
//! ```text
//! password ──Argon2id──▶ KEK ─┐
//!                             ├─unwraps─▶ master key (32 random bytes)
//! recovery code ──HKDF──▶ KEK ┘                │
//!                                   HKDF-SHA256(salt = library id)
//!                        ┌─────────────────┼─────────────────┐
//!                    files key        blob-name key       index key
//! ```

use std::fmt;
use std::io::Read;

use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

use crate::{CryptoError, Result, random_bytes};

pub const KEY_LEN: usize = 32;
pub const SALT_LEN: usize = 16;
pub const NONCE_LEN: usize = 24;

/// Info strings for HKDF. Changing any of them is a format change.
const INFO_FILES: &[u8] = b"dem/v1/files/";
const INFO_BLOB_NAME: &[u8] = b"dem/v1/blob-name";
const INFO_INDEX: &[u8] = b"dem/v1/index";
const INFO_RECOVERY_KEK: &[u8] = b"dem/v1/recovery-kek";
const AAD_WRAP_PASSWORD: &[u8] = b"dem/v1/wrap/password";
const AAD_WRAP_RECOVERY: &[u8] = b"dem/v1/wrap/recovery";

macro_rules! secret_key_type {
    ($(#[$doc:meta])* $name:ident) => {
        $(#[$doc])*
        #[derive(Clone, Zeroize, ZeroizeOnDrop)]
        pub struct $name([u8; KEY_LEN]);

        impl fmt::Debug for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(concat!(stringify!($name), "([redacted])"))
            }
        }
    };
}

secret_key_type!(
    /// The library master key. Everything else is derived from it.
    MasterKey
);
secret_key_type!(
    /// Key for the SQLCipher index database.
    IndexKey
);
secret_key_type!(
    /// Keyed hash for attachment names: same file → same name within one library,
    /// but outsiders cannot test whether a known file is present.
    BlobNameKey
);

impl MasterKey {
    pub fn generate() -> Self {
        let mut k = [0u8; KEY_LEN];
        random_bytes(&mut k);
        Self(k)
    }

    /// Restores a key previously read from the OS keychain.
    pub fn from_bytes(bytes: [u8; KEY_LEN]) -> Self {
        Self(bytes)
    }

    /// Raw bytes, only for storing the key in the OS keychain.
    pub fn expose_bytes(&self) -> &[u8; KEY_LEN] {
        &self.0
    }
}

impl IndexKey {
    pub fn expose_bytes(&self) -> &[u8; KEY_LEN] {
        &self.0
    }
}

/// A file-encryption key with the id written into every envelope header, so the
/// key can be rotated later without ambiguity.
#[derive(Clone, Zeroize, ZeroizeOnDrop)]
pub struct FileKey {
    #[zeroize(skip)]
    id: u16,
    key: [u8; KEY_LEN],
}

impl fmt::Debug for FileKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "FileKey(id={}, [redacted])", self.id)
    }
}

impl FileKey {
    pub fn id(&self) -> u16 {
        self.id
    }

    pub(crate) fn cipher(&self) -> XChaCha20Poly1305 {
        XChaCha20Poly1305::new((&self.key).into())
    }

    #[cfg(test)]
    pub(crate) fn from_parts(id: u16, key: [u8; KEY_LEN]) -> Self {
        Self { id, key }
    }
}

/// Keys derived from the master key for one library.
#[derive(Debug, Clone)]
pub struct Subkeys {
    pub files: FileKey,
    pub blob_name: BlobNameKey,
    pub index: IndexKey,
}

/// File key generation used for new writes. Older ids stay derivable for reading.
pub const CURRENT_FILE_KEY_ID: u16 = 1;

impl Subkeys {
    pub fn derive(master: &MasterKey, library_id: &[u8; 16]) -> Self {
        Self {
            files: file_key(master, library_id, CURRENT_FILE_KEY_ID),
            blob_name: BlobNameKey(expand(master, library_id, INFO_BLOB_NAME)),
            index: IndexKey(expand(master, library_id, INFO_INDEX)),
        }
    }
}

/// Derives the file key with the given id (`info = "dem/v1/files/<id>"`).
pub fn file_key(master: &MasterKey, library_id: &[u8; 16], id: u16) -> FileKey {
    let mut info = INFO_FILES.to_vec();
    info.extend_from_slice(id.to_string().as_bytes());
    FileKey {
        id,
        key: expand(master, library_id, &info),
    }
}

fn expand(master: &MasterKey, library_id: &[u8; 16], info: &[u8]) -> [u8; KEY_LEN] {
    let hk = Hkdf::<Sha256>::new(Some(library_id), &master.0);
    let mut out = [0u8; KEY_LEN];
    // 32 bytes is far below HKDF-SHA256's 8160-byte limit; this cannot fail.
    let _ = hk.expand(info, &mut out);
    out
}

impl BlobNameKey {
    /// Lowercase hex HMAC-SHA256 of the attachment content.
    pub fn name_for(&self, mut content: impl Read) -> Result<String> {
        let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(&self.0)
            .map_err(|_| CryptoError::Kdf("hmac key".into()))?;
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            let n = content.read(&mut buf)?;
            if n == 0 {
                break;
            }
            mac.update(&buf[..n]);
        }
        Ok(data_encoding::HEXLOWER.encode(&mac.finalize().into_bytes()))
    }
}

/// Argon2id cost parameters, stored in the manifest so they can be raised later.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KdfParams {
    pub m_kib: u32,
    pub t: u32,
    pub p: u32,
}

impl KdfParams {
    /// Default for new libraries: 256 MiB, 5 passes, 4 lanes. Measured 624 ms median on
    /// an Apple M1 with a mostly idle machine (load ~2, 2026-10-18), in the middle of
    /// the 0.5–1 s target of the P0 plan (4 passes: 502 ms, too close to the lower
    /// bound). Far above OWASP's minimum (19 MiB, t=2). Existing libraries keep the
    /// parameters stored in their manifest.
    pub const DEFAULT: KdfParams = KdfParams {
        m_kib: 256 * 1024,
        t: 5,
        p: 4,
    };

    /// Cheapest valid parameters; tests only.
    pub const INSECURE_FOR_TESTS: KdfParams = KdfParams {
        m_kib: 64,
        t: 1,
        p: 1,
    };

    fn derive(&self, password: &[u8], salt: &[u8; SALT_LEN]) -> Result<Zeroizing<[u8; KEY_LEN]>> {
        let params = argon2::Params::new(self.m_kib, self.t, self.p, Some(KEY_LEN))
            .map_err(|e| CryptoError::Kdf(e.to_string()))?;
        let argon =
            argon2::Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, params);
        let mut out = Zeroizing::new([0u8; KEY_LEN]);
        argon
            .hash_password_into(password, salt, out.as_mut())
            .map_err(|e| CryptoError::Kdf(e.to_string()))?;
        Ok(out)
    }
}

/// The master key encrypted under a key-encryption key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WrappedKey {
    pub nonce: [u8; NONCE_LEN],
    pub ciphertext: Vec<u8>,
}

fn wrap(kek: &[u8; KEY_LEN], master: &MasterKey, aad: &[u8]) -> WrappedKey {
    let mut nonce = [0u8; NONCE_LEN];
    random_bytes(&mut nonce);
    wrap_with_nonce(kek, master, aad, nonce)
}

fn wrap_with_nonce(
    kek: &[u8; KEY_LEN],
    master: &MasterKey,
    aad: &[u8],
    nonce: [u8; NONCE_LEN],
) -> WrappedKey {
    let cipher = XChaCha20Poly1305::new(kek.into());
    let ciphertext = cipher
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: &master.0,
                aad,
            },
        )
        // Encryption only fails for plaintexts over ~256 GiB.
        .unwrap_or_default();
    WrappedKey { nonce, ciphertext }
}

fn unwrap(kek: &[u8; KEY_LEN], wrapped: &WrappedKey, aad: &[u8]) -> Result<MasterKey> {
    let cipher = XChaCha20Poly1305::new(kek.into());
    let plain = Zeroizing::new(
        cipher
            .decrypt(
                XNonce::from_slice(&wrapped.nonce),
                Payload {
                    msg: &wrapped.ciphertext,
                    aad,
                },
            )
            .map_err(|_| CryptoError::Decrypt)?,
    );
    let bytes: [u8; KEY_LEN] = plain
        .as_slice()
        .try_into()
        .map_err(|_| CryptoError::Decrypt)?;
    Ok(MasterKey(bytes))
}

fn aad(prefix: &[u8], binding: &[u8]) -> Vec<u8> {
    let mut a = prefix.to_vec();
    a.push(0);
    a.extend_from_slice(binding);
    a
}

/// Wraps the master key under a password. `binding` must contain everything an
/// attacker could alter in the manifest (library id, KDF parameters), so tampering
/// makes unwrapping fail instead of silently weakening the library.
pub fn wrap_with_password(
    master: &MasterKey,
    password: &[u8],
    salt: &[u8; SALT_LEN],
    params: KdfParams,
    binding: &[u8],
) -> Result<WrappedKey> {
    let kek = params.derive(password, salt)?;
    Ok(wrap(&kek, master, &aad(AAD_WRAP_PASSWORD, binding)))
}

pub fn unwrap_with_password(
    wrapped: &WrappedKey,
    password: &[u8],
    salt: &[u8; SALT_LEN],
    params: KdfParams,
    binding: &[u8],
) -> Result<MasterKey> {
    let kek = params.derive(password, salt)?;
    unwrap(&kek, wrapped, &aad(AAD_WRAP_PASSWORD, binding))
}

pub fn new_salt() -> [u8; SALT_LEN] {
    let mut s = [0u8; SALT_LEN];
    random_bytes(&mut s);
    s
}

/// A recovery code: 160 random bits plus a 16-bit checksum, shown to the user as
/// 36 Crockford base32 characters in groups of four. It has enough entropy that
/// no slow KDF is needed, so unlocking with it is instant.
#[derive(Clone, Zeroize, ZeroizeOnDrop)]
pub struct RecoveryCode {
    secret: [u8; RECOVERY_SECRET_LEN],
}

const RECOVERY_SECRET_LEN: usize = 20;

impl fmt::Debug for RecoveryCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("RecoveryCode([redacted])")
    }
}

fn crockford() -> Result<data_encoding::Encoding> {
    let mut spec = data_encoding::Specification::new();
    spec.symbols.push_str("0123456789ABCDEFGHJKMNPQRSTVWXYZ");
    // Accept lowercase and the commonly confused letters.
    spec.translate.from.push_str("abcdefghjkmnpqrstvwxyzILOilo");
    spec.translate.to.push_str("ABCDEFGHJKMNPQRSTVWXYZ110110");
    spec.check_trailing_bits = false;
    spec.encoding()
        .map_err(|_| CryptoError::InvalidRecoveryCode)
}

impl RecoveryCode {
    pub fn generate() -> Self {
        let mut secret = [0u8; RECOVERY_SECRET_LEN];
        random_bytes(&mut secret);
        Self { secret }
    }

    fn checksum(secret: &[u8; RECOVERY_SECRET_LEN]) -> [u8; 2] {
        let h = Sha256::digest(secret);
        [h[0], h[1]]
    }

    /// The text shown to the user, e.g. `7K3M-...` (9 groups of 4).
    pub fn display_text(&self) -> Result<Zeroizing<String>> {
        let mut raw = Zeroizing::new(self.secret.to_vec());
        raw.extend_from_slice(&Self::checksum(&self.secret));
        let encoded = Zeroizing::new(crockford()?.encode(&raw));
        let mut out = Zeroizing::new(String::with_capacity(45));
        for (i, c) in encoded.chars().enumerate() {
            if i > 0 && i % 4 == 0 {
                out.push('-');
            }
            out.push(c);
        }
        Ok(out)
    }

    /// Parses user input; ignores dashes, spaces and case, rejects typos via the checksum.
    pub fn parse(text: &str) -> Result<Self> {
        let compact: Zeroizing<String> = Zeroizing::new(
            text.chars()
                .filter(|c| !c.is_whitespace() && *c != '-')
                .collect(),
        );
        let raw = Zeroizing::new(
            crockford()?
                .decode(compact.as_bytes())
                .map_err(|_| CryptoError::InvalidRecoveryCode)?,
        );
        if raw.len() != RECOVERY_SECRET_LEN + 2 {
            return Err(CryptoError::InvalidRecoveryCode);
        }
        let mut secret = [0u8; RECOVERY_SECRET_LEN];
        secret.copy_from_slice(&raw[..RECOVERY_SECRET_LEN]);
        if Self::checksum(&secret) != raw[RECOVERY_SECRET_LEN..] {
            secret.zeroize();
            return Err(CryptoError::InvalidRecoveryCode);
        }
        Ok(Self { secret })
    }

    fn kek(&self) -> Zeroizing<[u8; KEY_LEN]> {
        let hk = Hkdf::<Sha256>::new(None, &self.secret);
        let mut out = Zeroizing::new([0u8; KEY_LEN]);
        let _ = hk.expand(INFO_RECOVERY_KEK, out.as_mut());
        out
    }
}

pub fn wrap_with_recovery(master: &MasterKey, code: &RecoveryCode, binding: &[u8]) -> WrappedKey {
    wrap(&code.kek(), master, &aad(AAD_WRAP_RECOVERY, binding))
}

pub fn unwrap_with_recovery(
    wrapped: &WrappedKey,
    code: &RecoveryCode,
    binding: &[u8],
) -> Result<MasterKey> {
    unwrap(&code.kek(), wrapped, &aad(AAD_WRAP_RECOVERY, binding))
}

#[cfg(test)]
mod tests {
    use super::*;

    const BINDING: &[u8] = b"library-id-and-params";

    #[test]
    fn password_round_trip_and_wrong_password() {
        let master = MasterKey::generate();
        let salt = new_salt();
        let p = KdfParams::INSECURE_FOR_TESTS;
        let w = wrap_with_password(&master, b"correct horse", &salt, p, BINDING).unwrap();
        let back = unwrap_with_password(&w, b"correct horse", &salt, p, BINDING).unwrap();
        assert_eq!(back.expose_bytes(), master.expose_bytes());
        assert_eq!(
            unwrap_with_password(&w, b"wrong", &salt, p, BINDING).unwrap_err(),
            CryptoError::Decrypt
        );
    }

    #[test]
    fn tampered_binding_or_params_fail() {
        let master = MasterKey::generate();
        let salt = new_salt();
        let p = KdfParams::INSECURE_FOR_TESTS;
        let w = wrap_with_password(&master, b"pw", &salt, p, BINDING).unwrap();
        assert!(unwrap_with_password(&w, b"pw", &salt, p, b"other-library").is_err());
        let weaker = KdfParams { m_kib: 32, ..p };
        assert!(unwrap_with_password(&w, b"pw", &salt, weaker, BINDING).is_err());
    }

    #[test]
    fn recovery_code_round_trip_and_typo_detection() {
        let code = RecoveryCode::generate();
        let text = code.display_text().unwrap();
        assert_eq!(text.len(), 36 + 8);
        assert_eq!(text.split('-').count(), 9);

        let master = MasterKey::generate();
        let w = wrap_with_recovery(&master, &code, BINDING);
        // Lowercase, no dashes, with spaces: still accepted.
        let sloppy = text.replace('-', " ").to_lowercase();
        let parsed = RecoveryCode::parse(&sloppy).unwrap();
        let back = unwrap_with_recovery(&w, &parsed, BINDING).unwrap();
        assert_eq!(back.expose_bytes(), master.expose_bytes());

        // A single changed character is caught by the checksum.
        let mut chars: Vec<char> = text.chars().collect();
        chars[0] = if chars[0] == 'A' { 'B' } else { 'A' };
        let typo: String = chars.into_iter().collect();
        assert!(RecoveryCode::parse(&typo).is_err());
    }

    #[test]
    fn subkeys_are_distinct_and_library_specific() {
        let master = MasterKey::from_bytes([7u8; 32]);
        let a = Subkeys::derive(&master, &[1u8; 16]);
        let b = Subkeys::derive(&master, &[2u8; 16]);
        assert_ne!(a.files.key, b.files.key);
        assert_ne!(a.files.key, a.blob_name.0);
        assert_ne!(a.blob_name.0, a.index.0);
        assert_eq!(a.files.id(), CURRENT_FILE_KEY_ID);
        assert_ne!(file_key(&master, &[1u8; 16], 2).key, a.files.key);
    }

    /// Known-answer test: pins the derivation so an accidental change of info
    /// strings or algorithms is caught. Values were computed independently in
    /// Python (hmac/hashlib) and are listed in the format spec.
    #[test]
    fn subkey_derivation_known_answer() {
        let master = MasterKey::from_bytes([0x11; 32]);
        let k = Subkeys::derive(&master, &[0x22; 16]);
        let hex = |b: &[u8]| data_encoding::HEXLOWER.encode(b);
        assert_eq!(hex(&k.files.key), KAT_FILES);
        assert_eq!(hex(&k.blob_name.0), KAT_BLOB_NAME);
        assert_eq!(hex(&k.index.0), KAT_INDEX);
        assert_eq!(k.blob_name.name_for(&b"hello"[..]).unwrap(), KAT_BLOB_HELLO);
    }

    const KAT_FILES: &str = "21826eb745eb83def52bba9fef2afe724949038947460c4322f5b9de3b7905d8";
    const KAT_BLOB_NAME: &str = "3351d69d4731d79b101244c6bff03d3b074d6fea3c888a236807ff4c11b46c3a";
    const KAT_INDEX: &str = "6895ef572e010b45f5a0fafee481a986bac4a64a9a3ae94c9c16f7951b298814";
    const KAT_BLOB_HELLO: &str = "5fcee2d89d47cdb5c9224f1d5b58c65fba8d477d795db3fe51d1e06b76d20dbe";

    #[test]
    fn debug_never_shows_key_material() {
        let master = MasterKey::from_bytes([0xAB; 32]);
        let s = Subkeys::derive(&master, &[0; 16]);
        let shown = format!("{master:?} {s:?} {:?}", RecoveryCode::generate());
        assert!(!shown.to_lowercase().contains("ab, ab"));
        assert!(!shown.contains("171"));
        assert!(shown.contains("[redacted]"));
    }
}
