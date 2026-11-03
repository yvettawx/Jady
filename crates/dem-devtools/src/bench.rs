//! `dem-dev bench` (P0-40): whole-library and micro benchmarks against the targets
//! of the P0 plan §5.
//!
//! For each requested size a synthetic library (`dem_testkit::generate`) is written
//! through `dem-store` into a temporary directory, measured and deleted again.
//! Generation uses the insecure test KDF for speed; unlocking with a password is
//! measured separately on a small library with the default parameters, since its
//! cost does not depend on the number of items. Run it in release mode
//! (`cargo run --release -p dem-devtools -- bench`); debug builds are meaningless.
//!
//! Full-text search does not exist before P1 (`dem-index`); the report quotes the
//! search spike instead.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::{Duration, Instant};

use anyhow::Context;
use dem_crypto::keys::{KdfParams, MasterKey, Subkeys};
use dem_crypto::{envelope, stream};
use dem_model::{ChangeOrigin, ItemId};
use dem_store::{Library, Unlock, layout};
use dem_testkit::{GenConfig, GenLibrary, generate};
use serde::Serialize;

use crate::gen_cmd::{batch_id, body_lines};

#[derive(Debug, Clone, clap::Args)]
pub struct Args {
    /// Library sizes (ordinary items; domains and projects come on top).
    #[arg(long, value_delimiter = ',', default_value = "10000,50000,100000")]
    pub items: Vec<usize>,
    /// Write the full report as JSON to this file.
    #[arg(long)]
    pub out: Option<PathBuf>,
    /// Seed for the synthetic data and the random item choice.
    #[arg(long, default_value_t = 1)]
    pub seed: u64,
    /// Samples for the per-item measurements (open, save, compact).
    #[arg(long, default_value_t = 200)]
    pub samples: usize,
    /// Repetitions of the password and recovery-code unlock (default KDF); 0 skips it.
    #[arg(long, default_value_t = 5)]
    pub unlock_runs: usize,
    /// Parent directory for the temporary libraries (default: the system temp dir).
    #[arg(long)]
    pub dir: Option<PathBuf>,
    /// Writer threads used to generate the libraries.
    #[arg(long, default_value_t = 8)]
    pub threads: usize,
    /// Measure unlocking with the insecure test KDF instead of the default
    /// parameters (only for this tool's own tests; the numbers mean nothing).
    #[arg(long, hide = true)]
    pub unlock_kdf_insecure_for_tests: bool,
}

/// Latency distribution in milliseconds.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Stats {
    pub n: usize,
    pub p50_ms: f64,
    pub p95_ms: f64,
    pub max_ms: f64,
}

impl Stats {
    pub fn of(samples: &[Duration]) -> Stats {
        let mut ms: Vec<f64> = samples.iter().map(|d| d.as_secs_f64() * 1e3).collect();
        ms.sort_by(f64::total_cmp);
        Stats {
            n: ms.len(),
            p50_ms: percentile(&ms, 50.0),
            p95_ms: percentile(&ms, 95.0),
            max_ms: ms.last().copied().unwrap_or(0.0),
        }
    }
}

/// Nearest-rank percentile of sorted values (0 for an empty slice).
pub fn percentile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let rank = ((p / 100.0) * sorted.len() as f64).ceil() as usize;
    sorted[rank.clamp(1, sorted.len()) - 1]
}

#[derive(Debug, Clone, Serialize)]
pub struct UnlockReport {
    pub kdf_m_kib: u32,
    pub kdf_t: u32,
    pub kdf_p: u32,
    pub password: Stats,
    pub recovery: Stats,
}

#[derive(Debug, Clone, Serialize)]
pub struct MicroReport {
    /// Seal + open of a 4 KiB small-file envelope, per operation.
    pub envelope_4k_seal_us: f64,
    pub envelope_4k_open_us: f64,
    /// Throughput of the small-file envelope on 1 MiB.
    pub envelope_1m_seal_mib_s: f64,
    pub envelope_1m_open_mib_s: f64,
    /// Chunked attachment encryption on 16 MiB.
    pub stream_16m_seal_mib_s: f64,
    pub stream_16m_open_mib_s: f64,
    /// HKDF subkey derivation (all subkeys of one library).
    pub subkeys_derive_us: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct SizeReport {
    pub items: usize,
    pub containers: usize,
    pub generate_s: f64,
    pub write_s: f64,
    pub files: usize,
    pub bytes: u64,
    /// `Library::open` with the master key (keychain path).
    pub unlock_master_key: Stats,
    /// Unlock with the master key, list item ids, load the structure document.
    pub open_library: Stats,
    /// Load and decode every item document and its metadata.
    pub load_all_s: f64,
    /// Resident set size before / after loading all items (None where `ps` is unavailable).
    pub rss_before_kib: Option<u64>,
    pub rss_all_loaded_kib: Option<u64>,
    pub open_item: Stats,
    pub save_item: Stats,
    pub compact_item: Stats,
    pub scan_files_s: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct Check {
    pub items: Option<usize>,
    pub what: String,
    pub target: String,
    pub measured: String,
    pub pass: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct Report {
    pub profile: &'static str,
    pub load_before: Option<String>,
    pub load_after: Option<String>,
    pub unlock: Option<UnlockReport>,
    pub micro: MicroReport,
    pub sizes: Vec<SizeReport>,
    pub search: &'static str,
    pub checks: Vec<Check>,
}

/// Search numbers come from the P0-11 spike until `dem-index` searches (P1).
pub const SEARCH_NOTE: &str = "P1: no dem-index search yet. docs/spikes/02-search.md \
(machine load 22-30): ranked query p95 9.0 ms at 10k items, 114.6 ms at 100k \
(150 ms at load 80-100); targets 50 / 200 ms.";

/// Small deterministic generator for picking items (no extra dependency).
#[derive(Debug)]
struct SplitMix(u64);

impl SplitMix {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }

    fn below(&mut self, n: usize) -> usize {
        (self.next() % n.max(1) as u64) as usize
    }
}

/// Temporary directory removed on drop (the 100k library is large).
#[derive(Debug)]
struct TempDir(PathBuf);

impl TempDir {
    fn new(parent: Option<&Path>, label: &str) -> anyhow::Result<TempDir> {
        let base = parent.map_or_else(std::env::temp_dir, Path::to_path_buf);
        let path = base.join(format!(
            "dem-bench-{label}-{}-{:08x}",
            std::process::id(),
            dem_crypto::random_u64() as u32
        ));
        fs::create_dir_all(&path).with_context(|| format!("creating {}", path.display()))?;
        Ok(TempDir(path))
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn timed<T>(f: impl FnOnce() -> anyhow::Result<T>) -> anyhow::Result<(T, Duration)> {
    let start = Instant::now();
    let v = f()?;
    Ok((v, start.elapsed()))
}

/// `uptime` output, for recording the machine load next to the numbers.
pub fn machine_load() -> Option<String> {
    let out = std::process::Command::new("uptime").output().ok()?;
    Some(String::from_utf8_lossy(&out.stdout).trim().to_owned())
}

/// Current resident set size of this process in KiB, via `ps` (Unix only).
pub fn rss_kib() -> Option<u64> {
    if cfg!(windows) {
        return None;
    }
    let out = std::process::Command::new("ps")
        .args(["-o", "rss=", "-p", &std::process::id().to_string()])
        .output()
        .ok()?;
    String::from_utf8_lossy(&out.stdout).trim().parse().ok()
}

/// Writes generated data with several threads: each item becomes one snapshot
/// plus one update file, as `dem-dev gen` writes it. No activity logs.
fn populate(library: &Library, data: &GenLibrary, threads: usize) -> anyhow::Result<()> {
    let batch = batch_id(data.seed);
    let mut structure = library.load_structure()?;
    for c in &data.containers {
        let kind = if c.is_project {
            dem_store::NodeKind::Project
        } else {
            dem_store::NodeKind::Domain
        };
        structure.add(c.meta.id, kind, c.parent)?;
        library.create_item(&c.meta)?;
    }
    structure.commit(&format!("import:{batch}"));
    library.save_structure(&mut structure)?;

    let chunk = data.items.len().div_ceil(threads.max(1)).max(1);
    std::thread::scope(|s| {
        let handles: Vec<_> = data
            .items
            .chunks(chunk)
            .map(|items| {
                let batch = &batch;
                s.spawn(move || -> anyhow::Result<()> {
                    for it in items {
                        let mut doc = library.create_item(&it.meta)?;
                        doc.set_body_text(&body_lines(&it.body))?;
                        for (k, v) in &it.fields {
                            doc.set_field(k, v)?;
                        }
                        for to in &it.links {
                            doc.add_link(*to, "reference")?;
                        }
                        doc.commit(ChangeOrigin::Import, Some(batch));
                        library.save_item(&mut doc)?;
                    }
                    Ok(())
                })
            })
            .collect();
        for h in handles {
            h.join()
                .map_err(|_| anyhow::anyhow!("writer thread panicked"))??;
        }
        Ok(())
    })
}

fn bench_unlock(
    parent: Option<&Path>,
    runs: usize,
    params: KdfParams,
) -> anyhow::Result<UnlockReport> {
    let dir = TempDir::new(parent, "unlock")?;
    let root = dir.0.join("library");
    let pw = b"benchmark password";
    let (library, code) = Library::create(&root, pw, params)?;
    drop(library);
    let mut by_pw = Vec::with_capacity(runs);
    let mut by_code = Vec::with_capacity(runs);
    for _ in 0..runs {
        let (v, d) = timed(|| Ok(Library::open(&root, Unlock::Password(pw))?))?;
        drop(v);
        by_pw.push(d);
        let (v, d) = timed(|| Ok(Library::open(&root, Unlock::Recovery(&code))?))?;
        drop(v);
        by_code.push(d);
    }
    Ok(UnlockReport {
        kdf_m_kib: params.m_kib,
        kdf_t: params.t,
        kdf_p: params.p,
        password: Stats::of(&by_pw),
        recovery: Stats::of(&by_code),
    })
}

fn per_op_us(total: Duration, ops: usize) -> f64 {
    total.as_secs_f64() * 1e6 / ops.max(1) as f64
}

fn mib_per_s(bytes: usize, d: Duration) -> f64 {
    bytes as f64 / (1024.0 * 1024.0) / d.as_secs_f64().max(1e-9)
}

fn bench_micro() -> anyhow::Result<MicroReport> {
    let master = MasterKey::from_bytes([0x11; 32]);
    let library_id = [0x22; 16];
    let keys = Subkeys::derive(&master, &library_id);
    let key = &keys.files;
    let path = "items/00/0192f3c4-7a1b-7c3d-9e8f-0123456789ab.dexm";

    let small = vec![0x5au8; 4096];
    let ops = 2000;
    let (sealed, seal_d) = timed(|| {
        let mut last = Vec::new();
        for _ in 0..ops {
            last = envelope::seal(key, path, &small)?;
        }
        Ok(last)
    })?;
    let (_, open_d) = timed(|| {
        for _ in 0..ops {
            envelope::open(key, path, &sealed)?;
        }
        Ok(())
    })?;

    let big = vec![0xa5u8; 1 << 20];
    let reps = 20;
    let (sealed_big, big_seal_d) = timed(|| {
        let mut last = Vec::new();
        for _ in 0..reps {
            last = envelope::seal(key, path, &big)?;
        }
        Ok(last)
    })?;
    let (_, big_open_d) = timed(|| {
        for _ in 0..reps {
            envelope::open(key, path, &sealed_big)?;
        }
        Ok(())
    })?;

    let blob = vec![0x3cu8; 16 << 20];
    let blob_path = "blobs/00/x.dexs";
    let mut sealed_blob = Vec::with_capacity(blob.len() + blob.len() / 4096 + 64);
    let (_, stream_seal_d) =
        timed(|| Ok(stream::seal(key, blob_path, &blob[..], &mut sealed_blob)?))?;
    let mut opened = Vec::with_capacity(blob.len());
    let (_, stream_open_d) =
        timed(|| Ok(stream::open(key, blob_path, &sealed_blob[..], &mut opened)?))?;
    anyhow::ensure!(opened == blob, "stream round trip mismatch");

    let derives = 1000;
    let (_, derive_d) = timed(|| {
        for _ in 0..derives {
            std::hint::black_box(Subkeys::derive(&master, &library_id));
        }
        Ok(())
    })?;

    Ok(MicroReport {
        envelope_4k_seal_us: per_op_us(seal_d, ops),
        envelope_4k_open_us: per_op_us(open_d, ops),
        envelope_1m_seal_mib_s: mib_per_s(big.len() * reps, big_seal_d),
        envelope_1m_open_mib_s: mib_per_s(big.len() * reps, big_open_d),
        stream_16m_seal_mib_s: mib_per_s(blob.len(), stream_seal_d),
        stream_16m_open_mib_s: mib_per_s(blob.len(), stream_open_d),
        subkeys_derive_us: per_op_us(derive_d, derives),
    })
}

fn bench_size(args: &Args, n: usize) -> anyhow::Result<SizeReport> {
    eprintln!("[{n}] generating");
    let (data, gen_d) = timed(|| Ok(generate(&GenConfig::new(args.seed, n))))?;
    let dir = TempDir::new(args.dir.as_deref(), &n.to_string())?;
    let root = dir.0.join("library");

    eprintln!("[{n}] writing library");
    let (master, write_d) = timed(|| {
        let (library, _code) = Library::create(&root, b"bench", KdfParams::INSECURE_FOR_TESTS)?;
        populate(&library, &data, args.threads)?;
        Ok(*library.master_key().expose_bytes())
    })?;
    let containers = data.containers.len();
    drop(data);

    eprintln!("[{n}] scanning files");
    let ((files, bytes), scan_d) = timed(|| {
        let files = layout::scan(&root)?;
        let mut bytes = 0u64;
        for f in &files {
            bytes += fs::metadata(root.join(&f.rel))?.len();
        }
        Ok((files.len(), bytes))
    })?;

    eprintln!("[{n}] unlock and open");
    let mut unlock = Vec::new();
    for _ in 0..10 {
        let (v, d) = timed(|| {
            Ok(Library::open(
                &root,
                Unlock::MasterKey(MasterKey::from_bytes(master)),
            )?)
        })?;
        drop(v);
        unlock.push(d);
    }
    let mut open = Vec::new();
    let mut ids: Vec<ItemId> = Vec::new();
    for _ in 0..3 {
        let (v, d) = timed(|| {
            let v = Library::open(&root, Unlock::MasterKey(MasterKey::from_bytes(master)))?;
            ids = v.item_ids()?;
            v.load_structure()?;
            Ok(v)
        })?;
        drop(v);
        open.push(d);
    }
    let library = Library::open(&root, Unlock::MasterKey(MasterKey::from_bytes(master)))?;
    anyhow::ensure!(ids.len() == n + containers, "item count mismatch");

    eprintln!("[{n}] loading all items");
    let rss_before = rss_kib();
    let (docs, load_d) = timed(|| {
        let mut docs = Vec::with_capacity(ids.len());
        for id in &ids {
            let doc = library.load_item(*id)?;
            std::hint::black_box(doc.meta()?);
            docs.push(doc);
        }
        Ok(docs)
    })?;
    let rss_after = rss_kib();
    drop(docs);

    eprintln!("[{n}] per-item operations");
    let mut rng = SplitMix(args.seed ^ n as u64);
    let picks: Vec<ItemId> = (0..args.samples)
        .map(|_| ids[rng.below(ids.len())])
        .collect();
    let mut open_item = Vec::with_capacity(picks.len());
    for id in &picks {
        let (_, d) = timed(|| {
            let doc = library.load_item(*id)?;
            std::hint::black_box((doc.meta()?, doc.body_text()));
            Ok(())
        })?;
        open_item.push(d);
    }
    let mut save = Vec::with_capacity(picks.len());
    let mut compact = Vec::with_capacity(picks.len());
    for (i, id) in picks.iter().enumerate() {
        let mut doc = library.load_item(*id)?;
        let (_, d) = timed(|| {
            doc.append_paragraph(&format!("基准测试追加的段落 {i}"))?;
            doc.commit(ChangeOrigin::Me, None);
            library.save_item(&mut doc)?;
            Ok(())
        })?;
        save.push(d);
        let (_, d) = timed(|| Ok(library.compact_item(&mut doc)?))?;
        compact.push(d);
    }
    drop(library);

    Ok(SizeReport {
        items: n,
        containers,
        generate_s: gen_d.as_secs_f64(),
        write_s: write_d.as_secs_f64(),
        files,
        bytes,
        unlock_master_key: Stats::of(&unlock),
        open_library: Stats::of(&open),
        load_all_s: load_d.as_secs_f64(),
        rss_before_kib: rss_before,
        rss_all_loaded_kib: rss_after,
        open_item: Stats::of(&open_item),
        save_item: Stats::of(&save),
        compact_item: Stats::of(&compact),
        scan_files_s: scan_d.as_secs_f64(),
    })
}

/// Targets of the P0 plan §5 for a size: 10k targets up to 10k items, relaxed
/// targets from 100k items, none in between (50k is only recorded).
fn size_targets(n: usize) -> Option<(f64, f64, f64)> {
    // (open library s, open item ms, save ms)
    if n <= 10_000 {
        Some((1.5, 30.0, 20.0))
    } else if n >= 100_000 {
        Some((4.0, 50.0, 30.0))
    } else {
        None
    }
}

pub fn checks(unlock: Option<&UnlockReport>, sizes: &[SizeReport]) -> Vec<Check> {
    let mut out = Vec::new();
    let mut push = |items, what: &str, target: String, measured: String, pass| {
        out.push(Check {
            items,
            what: what.to_owned(),
            target,
            measured,
            pass,
        })
    };
    if let Some(u) = unlock {
        let p = u.password.p50_ms;
        push(
            None,
            "unlock with password (p50)",
            "500-1000 ms".into(),
            format!("{p:.0} ms"),
            (500.0..=1000.0).contains(&p),
        );
        let r = u.recovery.p95_ms;
        push(
            None,
            "unlock with recovery code (p95)",
            "<= 1000 ms".into(),
            format!("{r:.1} ms"),
            r <= 1000.0,
        );
    }
    for s in sizes {
        let k = s.unlock_master_key.p95_ms;
        push(
            Some(s.items),
            "unlock with master key (p95)",
            "<= 200 ms".into(),
            format!("{k:.1} ms"),
            k <= 200.0,
        );
        let Some((open_s, item_ms, save_ms)) = size_targets(s.items) else {
            continue;
        };
        let o = s.open_library.p50_ms / 1e3;
        push(
            Some(s.items),
            "open library (p50)",
            format!("<= {open_s} s"),
            format!("{o:.2} s"),
            o <= open_s,
        );
        let i = s.open_item.p95_ms;
        push(
            Some(s.items),
            "open one item (p95)",
            format!("<= {item_ms} ms"),
            format!("{i:.2} ms"),
            i <= item_ms,
        );
        let v = s.save_item.p95_ms;
        push(
            Some(s.items),
            "save one modification (p95)",
            format!("<= {save_ms} ms"),
            format!("{v:.2} ms"),
            v <= save_ms,
        );
    }
    out
}

fn print_report(r: &Report) {
    println!("profile: {}", r.profile);
    if let Some(l) = &r.load_before {
        println!("load before: {l}");
    }
    if let Some(l) = &r.load_after {
        println!("load after:  {l}");
    }
    if let Some(u) = &r.unlock {
        println!(
            "\nunlock (Argon2id m={} KiB t={} p={}): password p50 {:.0} ms max {:.0} ms; recovery p50 {:.1} ms",
            u.kdf_m_kib, u.kdf_t, u.kdf_p, u.password.p50_ms, u.password.max_ms, u.recovery.p50_ms
        );
    }
    let m = &r.micro;
    println!(
        "\nmicro: envelope 4 KiB seal {:.1} us / open {:.1} us; 1 MiB seal {:.0} / open {:.0} MiB/s; \
         stream 16 MiB seal {:.0} / open {:.0} MiB/s; subkeys {:.1} us",
        m.envelope_4k_seal_us,
        m.envelope_4k_open_us,
        m.envelope_1m_seal_mib_s,
        m.envelope_1m_open_mib_s,
        m.stream_16m_seal_mib_s,
        m.stream_16m_open_mib_s,
        m.subkeys_derive_us
    );
    for s in &r.sizes {
        println!(
            "\n== {} items (+{} containers): {} files, {:.1} MiB; generate {:.1} s, write {:.1} s",
            s.items,
            s.containers,
            s.files,
            s.bytes as f64 / 1048576.0,
            s.generate_s,
            s.write_s
        );
        let row = |name: &str, st: &Stats| {
            println!(
                "  {name:<22} p50 {:>9.2} ms  p95 {:>9.2} ms  max {:>9.2} ms  (n={})",
                st.p50_ms, st.p95_ms, st.max_ms, st.n
            );
        };
        row("unlock (master key)", &s.unlock_master_key);
        row("open library", &s.open_library);
        row("open one item", &s.open_item);
        row("save one change", &s.save_item);
        row("compact one item", &s.compact_item);
        let rss = match (s.rss_before_kib, s.rss_all_loaded_kib) {
            (Some(a), Some(b)) => format!(
                "RSS {:.0} -> {:.0} MiB",
                a as f64 / 1024.0,
                b as f64 / 1024.0
            ),
            _ => "RSS N/A".into(),
        };
        println!("  load all items         {:.2} s, {rss}", s.load_all_s);
        println!("  scan files             {:.2} s", s.scan_files_s);
    }
    println!("\nsearch: {}", r.search);
    println!("\nchecks against P0 plan §5:");
    for c in &r.checks {
        let items = c.items.map_or("-".to_owned(), |n| n.to_string());
        println!(
            "  [{}] {:>7} {:<32} target {:<12} measured {}",
            if c.pass { "pass" } else { "FAIL" },
            items,
            c.what,
            c.target,
            c.measured
        );
    }
}

pub fn bench(args: &Args) -> anyhow::Result<Report> {
    let load_before = machine_load();
    let unlock = if args.unlock_runs > 0 {
        let params = if args.unlock_kdf_insecure_for_tests {
            KdfParams::INSECURE_FOR_TESTS
        } else {
            KdfParams::DEFAULT
        };
        eprintln!(
            "unlock (Argon2id m={} KiB t={} p={})",
            params.m_kib, params.t, params.p
        );
        Some(bench_unlock(args.dir.as_deref(), args.unlock_runs, params)?)
    } else {
        None
    };
    eprintln!("micro benchmarks");
    let micro = bench_micro()?;
    let mut sizes = Vec::new();
    for &n in &args.items {
        sizes.push(bench_size(args, n)?);
    }
    let checks = checks(unlock.as_ref(), &sizes);
    Ok(Report {
        profile: if cfg!(debug_assertions) {
            "debug (numbers are not meaningful)"
        } else {
            "release"
        },
        load_before,
        load_after: machine_load(),
        unlock,
        micro,
        sizes,
        search: SEARCH_NOTE,
        checks,
    })
}

pub fn run(args: Args) -> anyhow::Result<ExitCode> {
    if cfg!(debug_assertions) {
        eprintln!("warning: debug build; run with --release for meaningful numbers");
    }
    let report = bench(&args)?;
    print_report(&report);
    if let Some(out) = &args.out {
        let json = serde_json::to_vec_pretty(&report)?;
        fs::write(out, json).with_context(|| format!("writing {}", out.display()))?;
    }
    Ok(if report.checks.iter().all(|c| c.pass) {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(1)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nearest_rank_percentiles() {
        let v: Vec<f64> = (1..=200).map(f64::from).collect();
        assert_eq!(percentile(&v, 50.0), 100.0);
        assert_eq!(percentile(&v, 95.0), 190.0);
        assert_eq!(percentile(&[3.0], 95.0), 3.0);
        assert_eq!(percentile(&[], 50.0), 0.0);
    }

    #[test]
    fn targets_follow_the_plan() {
        assert_eq!(size_targets(10_000), Some((1.5, 30.0, 20.0)));
        assert_eq!(size_targets(50_000), None);
        assert_eq!(size_targets(100_000), Some((4.0, 50.0, 30.0)));
    }

    #[test]
    fn splitmix_is_deterministic() {
        let a: Vec<usize> = {
            let mut r = SplitMix(5);
            (0..5).map(|_| r.below(10)).collect()
        };
        let mut r = SplitMix(5);
        assert_eq!(a, (0..5).map(|_| r.below(10)).collect::<Vec<_>>());
        assert!(a.iter().all(|x| *x < 10));
    }
}
