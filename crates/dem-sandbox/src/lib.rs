//! Runs a WebAssembly module with nothing around it (C7, M7): no files, no network, no clock worth
//! the name, no environment. It gets stdin, gives stdout and stderr, and is stopped when it uses up
//! its time or memory. What is in the module cannot change any of that.

pub mod native;

use std::time::Duration;

use wasmtime::{Config, Engine, Linker, Module, ResourceLimiter, Store, Trap};
use wasmtime_wasi::p1::{self, WasiP1Ctx};
use wasmtime_wasi::p2::pipe::{MemoryInputPipe, MemoryOutputPipe};
use wasmtime_wasi::{I32Exit, WasiCtxBuilder};

#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub time: Duration,
    pub memory_bytes: usize,
    pub output_bytes: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Limits {
            time: Duration::from_secs(5),
            memory_bytes: 128 * 1024 * 1024,
            output_bytes: 256 * 1024,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Ending {
    /// It finished by itself, with this exit code.
    Exit(i32),
    TimedOut,
    OutOfMemory,
    /// It crashed: a trap, such as dividing by zero or a Rust panic.
    Crashed(String),
}

#[derive(Debug, Clone)]
pub struct RunResult {
    pub ending: Ending,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Debug, thiserror::Error)]
pub enum SandboxError {
    #[error("not a module the sandbox can run: {0}")]
    BadModule(String),
    #[error("sandbox failed: {0}")]
    Engine(String),
}

struct State {
    wasi: WasiP1Ctx,
    limits: MemoryLimit,
}

struct MemoryLimit {
    max: usize,
    hit: bool,
}

impl ResourceLimiter for MemoryLimit {
    fn memory_growing(
        &mut self,
        _current: usize,
        desired: usize,
        _maximum: Option<usize>,
    ) -> wasmtime::Result<bool> {
        let ok = desired <= self.max;
        self.hit |= !ok;
        Ok(ok)
    }

    fn table_growing(
        &mut self,
        _current: usize,
        desired: usize,
        _maximum: Option<usize>,
    ) -> wasmtime::Result<bool> {
        Ok(desired <= 1_000_000)
    }
}

/// `module` is Wasm bytes or the text format. Runs its `_start` on this thread.
pub fn run(module: &[u8], stdin: &str, limits: Limits) -> Result<RunResult, SandboxError> {
    let mut config = Config::new();
    config.epoch_interruption(true);
    let engine = Engine::new(&config).map_err(|e| SandboxError::Engine(e.to_string()))?;
    let module =
        Module::new(&engine, module).map_err(|e| SandboxError::BadModule(e.to_string()))?;

    let stdout = MemoryOutputPipe::new(limits.output_bytes);
    let stderr = MemoryOutputPipe::new(limits.output_bytes);
    // Deliberately nothing else: no preopened folders, no arguments, no environment, no sockets.
    let wasi = WasiCtxBuilder::new()
        .stdin(MemoryInputPipe::new(stdin.to_owned()))
        .stdout(stdout.clone())
        .stderr(stderr.clone())
        .build_p1();

    let mut linker: Linker<State> = Linker::new(&engine);
    p1::add_to_linker_sync(&mut linker, |s: &mut State| &mut s.wasi)
        .map_err(|e| SandboxError::Engine(e.to_string()))?;

    let mut store = Store::new(
        &engine,
        State {
            wasi,
            limits: MemoryLimit {
                max: limits.memory_bytes,
                hit: false,
            },
        },
    );
    store.limiter(|s| &mut s.limits);
    store.set_epoch_deadline(1);
    store.epoch_deadline_trap();

    let ticker = engine.clone();
    let time = limits.time;
    let (done, stop) = std::sync::mpsc::channel::<()>();
    let timer = std::thread::spawn(move || {
        if stop.recv_timeout(time).is_err() {
            ticker.increment_epoch();
        }
    });

    let outcome = linker
        .instantiate(&mut store, &module)
        .and_then(|i| i.get_typed_func::<(), ()>(&mut store, "_start"))
        .and_then(|f| f.call(&mut store, ()));
    let _ = done.send(());
    let _ = timer.join();

    let ending = match outcome {
        Ok(()) => Ending::Exit(0),
        Err(e) => {
            if let Some(code) = e.downcast_ref::<I32Exit>() {
                Ending::Exit(code.0)
            } else if matches!(e.downcast_ref::<Trap>(), Some(Trap::Interrupt)) {
                Ending::TimedOut
            } else if store.data().limits.hit {
                Ending::OutOfMemory
            } else {
                Ending::Crashed(format!("{e:#}"))
            }
        }
    };
    let text = |p: &MemoryOutputPipe| String::from_utf8_lossy(&p.contents()).into_owned();
    Ok(RunResult {
        ending,
        stdout: text(&stdout),
        stderr: text(&stderr),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const FAST: Limits = Limits {
        time: Duration::from_millis(400),
        memory_bytes: 2 * 1024 * 1024,
        output_bytes: 4096,
    };

    /// Reads up to 64 bytes from stdin and writes them to stdout.
    const ECHO: &str = r#"(module
      (import "wasi_snapshot_preview1" "fd_read" (func $read (param i32 i32 i32 i32) (result i32)))
      (import "wasi_snapshot_preview1" "fd_write" (func $write (param i32 i32 i32 i32) (result i32)))
      (memory (export "memory") 1)
      (func (export "_start")
        (i32.store (i32.const 0) (i32.const 100))
        (i32.store (i32.const 4) (i32.const 64))
        (drop (call $read (i32.const 0) (i32.const 0) (i32.const 1) (i32.const 8)))
        (i32.store (i32.const 4) (i32.load (i32.const 8)))
        (drop (call $write (i32.const 1) (i32.const 0) (i32.const 1) (i32.const 8)))))"#;

    #[test]
    fn stdin_goes_in_and_stdout_comes_out() {
        let r = run(ECHO.as_bytes(), "hello", FAST).unwrap();
        assert_eq!(r.ending, Ending::Exit(0));
        assert_eq!(r.stdout, "hello");
    }

    #[test]
    fn an_endless_loop_is_stopped() {
        let m = r#"(module (func (export "_start") (loop $l (br $l))))"#;
        let r = run(m.as_bytes(), "", FAST).unwrap();
        assert_eq!(r.ending, Ending::TimedOut);
    }

    #[test]
    fn asking_for_too_much_memory_is_refused() {
        let m = r#"(module (memory 1)
          (func (export "_start")
            (if (i32.eq (memory.grow (i32.const 1000)) (i32.const -1)) (then unreachable))))"#;
        let r = run(m.as_bytes(), "", FAST).unwrap();
        assert_eq!(r.ending, Ending::OutOfMemory);
    }

    #[test]
    fn a_crash_is_reported_as_a_crash() {
        let m = r#"(module (func (export "_start") unreachable))"#;
        let r = run(m.as_bytes(), "", FAST).unwrap();
        assert!(matches!(r.ending, Ending::Crashed(_)));
    }

    #[test]
    fn no_file_can_be_opened_because_no_folder_was_given() {
        // path_open on fd 3, the first folder there would be, must fail with EBADF (8). Exits with
        // whatever errno it got.
        let m = r#"(module
          (import "wasi_snapshot_preview1" "path_open"
            (func $open (param i32 i32 i32 i32 i32 i64 i64 i32 i32) (result i32)))
          (import "wasi_snapshot_preview1" "proc_exit" (func $exit (param i32)))
          (memory (export "memory") 1)
          (data (i32.const 0) "etc/passwd")
          (func (export "_start")
            (call $exit (call $open (i32.const 3) (i32.const 0) (i32.const 0) (i32.const 10)
              (i32.const 0) (i64.const 2) (i64.const 2) (i32.const 0) (i32.const 100)))))"#;
        let r = run(m.as_bytes(), "", FAST).unwrap();
        assert_eq!(r.ending, Ending::Exit(8));
    }

    #[test]
    fn no_network_call_exists() {
        // sock_open is not part of what is linked: such a module does not even start.
        let m = r#"(module
          (import "wasi_snapshot_preview1" "sock_open" (func (param i32 i32 i32) (result i32)))
          (func (export "_start")))"#;
        let r = run(m.as_bytes(), "", FAST).unwrap();
        assert!(matches!(r.ending, Ending::Crashed(_)));
    }

    #[test]
    fn output_is_capped() {
        // Writes 64 KB of zeros, 100 times.
        let m = r#"(module
          (import "wasi_snapshot_preview1" "fd_write" (func $write (param i32 i32 i32 i32) (result i32)))
          (memory (export "memory") 2)
          (func (export "_start") (local $i i32)
            (i32.store (i32.const 0) (i32.const 1024))
            (i32.store (i32.const 4) (i32.const 65536))
            (loop $l
              (drop (call $write (i32.const 1) (i32.const 0) (i32.const 1) (i32.const 8)))
              (local.set $i (i32.add (local.get $i) (i32.const 1)))
              (br_if $l (i32.lt_u (local.get $i) (i32.const 100))))))"#;
        let r = run(m.as_bytes(), "", FAST).unwrap();
        assert!(r.stdout.len() <= FAST.output_bytes);
    }
}
