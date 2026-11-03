//! `cargo run --release -p dem-testkit --example gen_timing`
#![allow(clippy::print_stdout)]
fn main() {
    for n in [10_000, 100_000] {
        let start = std::time::Instant::now();
        let v = dem_testkit::generate(&dem_testkit::GenConfig::new(1, n));
        println!(
            "{n} items: {:?} ({} containers)",
            start.elapsed(),
            v.containers.len()
        );
    }
}
