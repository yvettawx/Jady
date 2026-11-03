//! FTS5 custom tokenizer registration: the *only* module with `unsafe`.
//!
//!
//! What is unsafe here and why:
//! 1. Fetching the `fts5_api*` with `SELECT fts5(?1)` + `sqlite3_bind_pointer`
//!    (the documented way; rusqlite has no wrapper).
//! 2. Calling `xCreateTokenizer` with C callbacks.
//! 3. The three `extern "C"` callbacks: they turn raw pointers back into Rust
//!    references, build a `&[u8]` from `(pText, nText)`, and call `xToken`.
//!
//! Panics never cross the FFI boundary (`catch_unwind` -> `SQLITE_ERROR`).

use std::ffi::{CString, c_char, c_int, c_void};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::ptr;
use std::sync::Arc;

use rusqlite::{Connection, ffi};

use crate::tokenizer::{Mode, Tokenizer};

type XToken = unsafe extern "C" fn(
    ctx: *mut c_void,
    tflags: c_int,
    token: *const c_char,
    n_token: c_int,
    start: c_int,
    end: c_int,
) -> c_int;

/// Register `tokenizer` under `name` on this connection.
pub fn register_tokenizer(
    conn: &Connection,
    name: &str,
    tokenizer: Arc<Tokenizer>,
) -> rusqlite::Result<()> {
    let name_c = CString::new(name).map_err(|_| rusqlite::Error::InvalidQuery)?;
    // SAFETY: `conn.handle()` is a valid open db for the lifetime of `conn`;
    // the statement is finalized before returning; `api` outlives the step.
    unsafe {
        let db = conn.handle();
        let api = fts5_api_from_db(db)?;
        let create = (*api)
            .xCreateTokenizer
            .ok_or(rusqlite::Error::InvalidQuery)?;
        let user_data = Box::into_raw(Box::new(tokenizer)).cast::<c_void>();
        let mut vtab = ffi::fts5_tokenizer {
            xCreate: Some(x_create),
            xDelete: Some(x_delete),
            xTokenize: Some(x_tokenize),
        };
        // SQLite copies the fts5_tokenizer struct; `x_destroy` frees user_data
        // when the connection closes (or on failure, per the API contract).
        let rc = create(api, name_c.as_ptr(), user_data, &mut vtab, Some(x_destroy));
        if rc != ffi::SQLITE_OK {
            return Err(rusqlite::Error::SqliteFailure(ffi::Error::new(rc), None));
        }
    }
    Ok(())
}

/// SAFETY: `db` must be a valid, open connection handle.
unsafe fn fts5_api_from_db(db: *mut ffi::sqlite3) -> rusqlite::Result<*mut ffi::fts5_api> {
    let mut stmt: *mut ffi::sqlite3_stmt = ptr::null_mut();
    let sql = c"SELECT fts5(?1)";
    // SAFETY: valid db, NUL-terminated SQL, out-pointer to a local.
    let rc = unsafe { ffi::sqlite3_prepare_v2(db, sql.as_ptr(), -1, &mut stmt, ptr::null_mut()) };
    if rc != ffi::SQLITE_OK {
        return Err(rusqlite::Error::SqliteFailure(ffi::Error::new(rc), None));
    }
    let mut api: *mut ffi::fts5_api = ptr::null_mut();
    // SAFETY: binds a pointer to our local `api`; FTS5 writes the api pointer
    // into it during step. The type tag must be exactly "fts5_api_ptr".
    let rc = unsafe {
        ffi::sqlite3_bind_pointer(
            stmt,
            1,
            (&mut api as *mut *mut ffi::fts5_api).cast::<c_void>(),
            c"fts5_api_ptr".as_ptr(),
            None,
        )
    };
    // SAFETY: stmt is valid until finalize.
    let step_rc = unsafe { ffi::sqlite3_step(stmt) };
    // SAFETY: finalize exactly once.
    unsafe { ffi::sqlite3_finalize(stmt) };
    if rc != ffi::SQLITE_OK || step_rc != ffi::SQLITE_ROW || api.is_null() {
        return Err(rusqlite::Error::InvalidQuery);
    }
    Ok(api)
}

/// Per-table tokenizer instance: we just share the global tokenizer.
unsafe extern "C" fn x_create(
    user_data: *mut c_void,
    _args: *mut *const c_char,
    _n_args: c_int,
    out: *mut *mut ffi::Fts5Tokenizer,
) -> c_int {
    let r = catch_unwind(AssertUnwindSafe(|| {
        // SAFETY: user_data is the Box<Arc<Tokenizer>> from register_tokenizer
        // and stays alive until x_destroy.
        let shared = unsafe { &*user_data.cast::<Arc<Tokenizer>>() };
        let inst = Box::into_raw(Box::new(Arc::clone(shared)));
        // SAFETY: `out` is a valid out-pointer supplied by FTS5.
        unsafe { *out = inst.cast::<ffi::Fts5Tokenizer>() };
        ffi::SQLITE_OK
    }));
    r.unwrap_or(ffi::SQLITE_ERROR)
}

unsafe extern "C" fn x_delete(p: *mut ffi::Fts5Tokenizer) {
    if !p.is_null() {
        // SAFETY: p was created by Box::into_raw in x_create; freed once.
        drop(unsafe { Box::from_raw(p.cast::<Arc<Tokenizer>>()) });
    }
}

unsafe extern "C" fn x_destroy(user_data: *mut c_void) {
    if !user_data.is_null() {
        // SAFETY: created by Box::into_raw in register_tokenizer; freed once.
        drop(unsafe { Box::from_raw(user_data.cast::<Arc<Tokenizer>>()) });
    }
}

unsafe extern "C" fn x_tokenize(
    p: *mut ffi::Fts5Tokenizer,
    ctx: *mut c_void,
    flags: c_int,
    text: *const c_char,
    n_text: c_int,
    x_token: Option<XToken>,
) -> c_int {
    let Some(x_token) = x_token else {
        return ffi::SQLITE_MISUSE;
    };
    let r = catch_unwind(AssertUnwindSafe(|| {
        // SAFETY: p comes from x_create.
        let tok = unsafe { &*p.cast::<Arc<Tokenizer>>() };
        let bytes: &[u8] = if n_text <= 0 || text.is_null() {
            &[]
        } else {
            // SAFETY: FTS5 guarantees (text, n_text) is readable for this call.
            unsafe { std::slice::from_raw_parts(text.cast::<u8>(), n_text as usize) }
        };
        let mode = if flags & ffi::FTS5_TOKENIZE_QUERY != 0 {
            Mode::Query
        } else {
            Mode::Document
        };
        let mut sink = |t: &str, s: usize, e: usize, colocated: bool| -> Result<(), i32> {
            let tflags = if colocated {
                ffi::FTS5_TOKEN_COLOCATED
            } else {
                0
            };
            // SAFETY: calling back into FTS5 with a buffer valid for the call.
            let rc = unsafe {
                x_token(
                    ctx,
                    tflags,
                    t.as_ptr().cast(),
                    t.len() as c_int,
                    s as c_int,
                    e as c_int,
                )
            };
            if rc == ffi::SQLITE_OK {
                Ok(())
            } else {
                Err(rc)
            }
        };
        // Invalid UTF-8 (should not happen for TEXT columns) is skipped
        // chunk-wise so offsets of valid parts stay exact.
        let mut base = 0;
        for chunk in bytes.utf8_chunks() {
            let valid = chunk.valid();
            if let Err(rc) = tok.tokenize(valid, base, mode, &mut sink) {
                return rc;
            }
            base += valid.len() + chunk.invalid().len();
        }
        ffi::SQLITE_OK
    }));
    r.unwrap_or(ffi::SQLITE_ERROR)
}
