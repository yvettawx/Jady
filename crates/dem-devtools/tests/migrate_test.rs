#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

//! Migration framework (P0-42): the committed v1 sample still reads back exactly,
//! a fake v1 -> v2 no-op migration passes, and lossy or undeclared changes are
//! caught.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use dem_devtools::migrate_test::{
    Difference, Dump, Migration, chain, copy_library, dump, generate_sample, run_on_sample,
};
use dem_model::ChangeOrigin;
use dem_store::Library;
use serde_json::json;

fn sample() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../testdata/migrations/v1")
}

/// Every file under a directory with its bytes.
fn snapshot_dir(root: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
    let mut out = BTreeMap::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for e in std::fs::read_dir(&dir).unwrap() {
            let p = e.unwrap().path();
            if p.is_dir() {
                stack.push(p);
            } else {
                out.insert(p.clone(), std::fs::read(&p).unwrap());
            }
        }
    }
    out
}

struct Step {
    name: &'static str,
    from: u32,
    to: u32,
    action: fn(&Library) -> anyhow::Result<()>,
    declare: fn(&Dump) -> Dump,
}

impl Migration for Step {
    fn name(&self) -> &str {
        self.name
    }
    fn from(&self) -> u32 {
        self.from
    }
    fn to(&self) -> u32 {
        self.to
    }
    fn writes_format_version(&self) -> bool {
        // FORMAT_VERSION is 1: a fake step cannot write version 2.
        false
    }
    fn migrate(&self, _root: &Path, library: &Library) -> anyhow::Result<()> {
        (self.action)(library)
    }
    fn expected(&self, before: &Dump) -> Dump {
        (self.declare)(before)
    }
}

fn nothing(_: &Library) -> anyhow::Result<()> {
    Ok(())
}

fn unchanged(d: &Dump) -> Dump {
    d.clone()
}

/// Rewrites every item file (fold updates into snapshots): new bytes, same data.
fn rewrite_all(v: &Library) -> anyhow::Result<()> {
    for id in v.item_ids()? {
        let mut doc = v.load_item(id)?;
        v.compact_item(&mut doc)?;
    }
    Ok(())
}

fn first_item_with_body(v: &Library) -> anyhow::Result<dem_model::ItemId> {
    for id in v.item_ids()? {
        if v.load_item(id)?.body_text().lines().count() > 1 {
            return Ok(id);
        }
    }
    anyhow::bail!("no item with several paragraphs")
}

/// Drops the last paragraph of one item: a lossy migration.
fn drop_paragraph(v: &Library) -> anyhow::Result<()> {
    let id = first_item_with_body(v)?;
    let mut doc = v.load_item(id)?;
    let text = doc.body_text();
    let kept: Vec<&str> = text.lines().collect();
    doc.set_body_text(&kept[..kept.len() - 1].join("\n"))?;
    doc.commit(ChangeOrigin::Import, Some("migration-2"));
    v.save_item(&mut doc)?;
    Ok(())
}

/// Adds `fields.migrated = true` to every item, committed as one change.
fn mark_migrated(v: &Library) -> anyhow::Result<()> {
    for id in v.item_ids()? {
        let mut doc = v.load_item(id)?;
        doc.set_field("migrated", &json!(true))?;
        doc.commit(ChangeOrigin::Import, Some("migration-2"));
        v.save_item(&mut doc)?;
    }
    Ok(())
}

fn declare_migrated(d: &Dump) -> Dump {
    let mut out = d.clone();
    for (k, v) in out.iter_mut() {
        if k.starts_with("item/") {
            v["doc"]["fields"]["migrated"] = json!(true);
            v["history"]
                .as_array_mut()
                .unwrap()
                .push(json!("import:migration-2"));
        }
    }
    out
}

fn step(
    name: &'static str,
    from: u32,
    to: u32,
    action: fn(&Library) -> anyhow::Result<()>,
    declare: fn(&Dump) -> Dump,
) -> Step {
    Step {
        name,
        from,
        to,
        action,
        declare,
    }
}

fn run_steps(steps: &[&dyn Migration]) -> dem_devtools::migrate_test::Outcome {
    let work = tempfile::tempdir().unwrap();
    run_on_sample(&sample(), "test", steps, work.path()).unwrap()
}

#[test]
fn sample_reads_back_as_recorded_and_is_never_modified() {
    let before = snapshot_dir(&sample());
    let o = run_steps(&[]);
    assert!(o.sample.is_empty(), "{:?}", o.sample);
    assert!(o.passed());
    assert_eq!(snapshot_dir(&sample()), before);

    // The sample covers what migrations must preserve.
    let d: Dump =
        serde_json::from_slice(&std::fs::read(sample().join("dump.json")).unwrap()).unwrap();
    assert_eq!(d.keys().filter(|k| k.starts_with("item/")).count(), 25);
    assert_eq!(d.keys().filter(|k| k.starts_with("blob/")).count(), 2);
    assert_eq!(d["structure"].as_array().unwrap().len(), 5);
    assert_eq!(d["log/activity"]["records"].as_array().unwrap().len(), 25);
    let all = serde_json::to_string(&d).unwrap();
    assert!(all.contains("ai:0192f3c4-0000-7000-8000-000000000001"));
    for p in ["normal", "sensitive", "private", "confidential"] {
        assert!(all.contains(&format!("\"privacy\":\"{p}\"")), "{p}");
    }
    assert!(
        all.chars()
            .any(|c| ('\u{17000}'..='\u{187F7}').contains(&c)),
        "Tangut"
    );
    let times: Vec<&str> = d
        .values()
        .filter_map(|v| v["doc"]["meta"]["time"].as_str())
        .collect();
    assert!(times.iter().any(|t| t.contains("\"year\":-")), "BCE");
    assert!(
        times.iter().any(|t| t.contains("\"approximate\":true")),
        "circa"
    );
}

#[test]
fn no_op_v1_to_v2_migration_passes() {
    let noop = step("noop", 1, 2, nothing, unchanged);
    let o = run_steps(&[&noop]);
    assert!(o.passed(), "{:?}", o.steps);
    assert_eq!(o.steps.len(), 1);
    assert_eq!((o.steps[0].from, o.steps[0].to), (1, 2));
}

#[test]
fn rewriting_every_file_keeps_the_dump() {
    let rewrite = step("rewrite", 1, 2, rewrite_all, unchanged);
    let o = run_steps(&[&rewrite]);
    assert!(o.passed(), "{:?}", o.steps);
}

#[test]
fn lossy_migration_is_detected() {
    let lossy = step("lossy", 1, 2, drop_paragraph, unchanged);
    let o = run_steps(&[&lossy]);
    assert!(!o.passed());
    let diffs: &[Difference] = &o.steps[0].differences;
    assert!(
        diffs
            .iter()
            .any(|d| d.pointer.starts_with("/doc/body/children")),
        "{diffs:?}"
    );
    // Only the one item is affected.
    let records: std::collections::BTreeSet<_> = diffs.iter().map(|d| &d.record).collect();
    assert_eq!(records.len(), 1, "{diffs:?}");
}

#[test]
fn declared_changes_pass_and_undeclared_ones_fail() {
    let declared = step("declared", 1, 2, mark_migrated, declare_migrated);
    assert!(run_steps(&[&declared]).passed());

    let undeclared = step("undeclared", 1, 2, mark_migrated, unchanged);
    let o = run_steps(&[&undeclared]);
    let diffs = &o.steps[0].differences;
    // Every item gets the new field and the new commit, both reported.
    assert_eq!(
        diffs
            .iter()
            .filter(|d| d.pointer == "/doc/fields/migrated")
            .count(),
        25
    );
    assert!(diffs.iter().any(|d| d.pointer == "/history"));
}

#[test]
fn steps_run_in_chain_order_and_gaps_are_refused() {
    let a = step("1to2", 1, 2, nothing, unchanged);
    let b = step("2to3", 2, 3, nothing, unchanged);
    let names: Vec<_> = chain(1, &[&b, &a])
        .unwrap()
        .iter()
        .map(|m| m.name().to_owned())
        .collect();
    assert_eq!(names, ["1to2", "2to3"]);
    let o = run_steps(&[&b, &a]);
    assert!(o.passed());
    assert_eq!(o.steps.len(), 2);

    assert!(chain(1, &[&b]).is_err());
    let a2 = step("1to2-bis", 1, 2, nothing, unchanged);
    assert!(chain(1, &[&a, &a2]).is_err());
    let down = step("2to1", 1, 1, nothing, unchanged);
    assert!(chain(1, &[&down]).is_err());
}

#[test]
fn missing_format_version_bump_is_reported() {
    struct Forgetful;
    impl Migration for Forgetful {
        fn name(&self) -> &str {
            "forgetful"
        }
        fn from(&self) -> u32 {
            1
        }
        fn to(&self) -> u32 {
            2
        }
        fn migrate(&self, _: &Path, _: &Library) -> anyhow::Result<()> {
            Ok(())
        }
    }
    let o = run_steps(&[&Forgetful]);
    assert_eq!(o.steps[0].differences.len(), 1);
    assert_eq!(o.steps[0].differences[0].pointer, "/format_version");
}

#[test]
fn a_freshly_generated_sample_round_trips() {
    let tmp = tempfile::tempdir().unwrap();
    let out = tmp.path().join("v1");
    generate_sample(&out, 7, 6, "pw").unwrap();
    assert!(!out.join("library/.lock").exists());
    let work = tempfile::tempdir().unwrap();
    let o = run_on_sample(&out, "pw", &[], work.path()).unwrap();
    assert!(o.passed(), "{:?}", o.sample);
    assert!(
        generate_sample(&out, 7, 6, "pw").is_err(),
        "never overwrite"
    );

    // Same seed, new keys: identical content apart from the manifest.
    let again = tmp.path().join("again/v1");
    generate_sample(&again, 7, 6, "pw").unwrap();
    let read = |p: &Path| -> Dump {
        let mut d: Dump =
            serde_json::from_slice(&std::fs::read(p.join("dump.json")).unwrap()).unwrap();
        d.remove("manifest");
        d.retain(|k, _| !k.starts_with("blob/"));
        d
    };
    let (d1, d2) = (read(&out), read(&again));
    assert_eq!(d1.keys().collect::<Vec<_>>(), d2.keys().collect::<Vec<_>>());
    let strip_links = |d: &Dump| -> Vec<serde_json::Value> {
        d.values()
            .map(|v| {
                let mut v = v.clone();
                // Relation ids are random UUIDs.
                if let Some(doc) = v.get_mut("doc") {
                    doc["links"] = json!(null);
                }
                v
            })
            .collect()
    };
    assert_eq!(strip_links(&d1), strip_links(&d2));
}

#[test]
fn copy_skips_lock_and_temp() {
    let tmp = tempfile::tempdir().unwrap();
    let src = tmp.path().join("src");
    std::fs::create_dir_all(src.join("tmp")).unwrap();
    std::fs::create_dir_all(src.join("items/ab")).unwrap();
    std::fs::write(src.join(".lock"), b"").unwrap();
    std::fs::write(src.join("tmp/x.tmp"), b"x").unwrap();
    std::fs::write(src.join("items/ab/a.dexm"), b"a").unwrap();
    let dst = tmp.path().join("dst");
    copy_library(&src, &dst).unwrap();
    assert!(dst.join("items/ab/a.dexm").exists());
    assert!(!dst.join(".lock").exists());
    assert!(!dst.join("tmp").exists());
}

#[test]
fn dump_sees_every_record_kind() {
    let tmp = tempfile::tempdir().unwrap();
    let work = tmp.path().join("library");
    copy_library(&sample().join("library"), &work).unwrap();
    let v = Library::open(&work, dem_store::Unlock::Password(b"test")).unwrap();
    let d = dump(&v).unwrap();
    for prefix in ["manifest", "structure", "item/", "log/activity", "blob/"] {
        assert!(d.keys().any(|k| k.starts_with(prefix)), "{prefix}");
    }
}

#[test]
fn binary_attachments_are_dumped_in_full() {
    let tmp = tempfile::tempdir().unwrap();
    let (v, _) = Library::create(
        &tmp.path().join("library"),
        b"pw",
        dem_crypto::keys::KdfParams::INSECURE_FOR_TESTS,
    )
    .unwrap();
    v.put_blob(&[0xff, 0x00, 0x01][..]).unwrap();
    let d = dump(&v).unwrap();
    let (_, rec) = d.iter().find(|(k, _)| k.starts_with("blob/")).unwrap();
    assert_eq!(rec["hex"], "ff0001");
    assert_eq!(rec["utf8"], serde_json::Value::Null);
    assert!(rec.get("name_mismatch").is_none());
}
