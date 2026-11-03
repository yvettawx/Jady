//! 本地 Git 仓库 (F6, D10). The folders are this computer's own setting. Only `git log` runs, and it
//! reads commits: dates for the heat map, and subjects and file names when asked for a digest. The
//! code itself stays where it is, so an AI that is handed a digest cannot read files through it.

use std::collections::BTreeMap;
use std::path::Path;
use std::process::{Command, Stdio};

use dem_core::{ActivityDay, Core, CoreResult};

pub const REPOS_KEY: &str = "git-repos";
const DIGEST_LIMIT: usize = 12_000;

pub fn repos(core: &Core) -> CoreResult<Vec<String>> {
    core.with(|s| {
        Ok(s.local_get(REPOS_KEY)?
            .and_then(|j| serde_json::from_str(&j).ok())
            .unwrap_or_default())
    })
}

/// `git log` that no setting in the repository can turn into running something.
fn log(repo: &str, args: &[&str]) -> Option<String> {
    if !Path::new(repo).is_dir() {
        return None;
    }
    let out = Command::new("git")
        .args([
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.hooksPath=/dev/null",
        ])
        .args([
            "-c",
            "log.showSignature=false",
            "--no-pager",
            "-C",
            repo,
            "log",
        ])
        .args(["--no-color", "--no-ext-diff", "--no-textconv"])
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Commits per day since `day`, across all the repositories, for the heat map.
pub fn activity(repos: &[String], day: &str) -> Vec<ActivityDay> {
    let since = format!("--since={day}T00:00:00");
    let mut days: BTreeMap<String, u32> = BTreeMap::new();
    for r in repos {
        let Some(text) = log(r, &[&since, "--date=short", "--format=%ad"]) else {
            continue;
        };
        for d in text.lines().filter(|l| !l.is_empty()) {
            *days.entry(d.to_owned()).or_insert(0) += 1;
        }
    }
    days.into_iter()
        .map(|(date, count)| ActivityDay {
            date,
            type_id: "git".to_owned(),
            count,
        })
        .collect()
}

/// What changed lately: commit subjects and the files they touched. Goes into a chat only when the
/// user asks for a summary, and they can read it there.
pub fn digest(repos: &[String], days: u32) -> String {
    let since = format!("--since={days}.days.ago");
    let mut out = String::new();
    for r in repos {
        let Some(text) = log(
            r,
            &[&since, "--date=short", "--name-only", "--format=%n%ad %s"],
        ) else {
            continue;
        };
        if text.trim().is_empty() {
            continue;
        }
        let name = Path::new(r)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        out.push_str(&format!("## {name}\n{}\n", text.trim()));
    }
    if out.len() > DIGEST_LIMIT {
        let mut cut = DIGEST_LIMIT;
        while !out.is_char_boundary(cut) {
            cut -= 1;
        }
        out.truncate(cut);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git(dir: &Path, args: &[&str], date: &str) {
        let ok = Command::new("git")
            .current_dir(dir)
            .args(["-c", "user.name=t", "-c", "user.email=t@example.com"])
            .args(args)
            .env("GIT_AUTHOR_DATE", date)
            .env("GIT_COMMITTER_DATE", date)
            .output()
            .unwrap();
        assert!(
            ok.status.success(),
            "{}",
            String::from_utf8_lossy(&ok.stderr)
        );
    }

    #[test]
    fn counts_commits_by_day_and_digests_subjects_without_code() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        git(d, &["init", "-q"], "2026-10-01T12:00:00");
        std::fs::write(d.join("secret.rs"), "const KEY: &str = \"zzcodezz\";").unwrap();
        git(d, &["add", "."], "2026-10-01T12:00:00");
        git(d, &["commit", "-qm", "first thing"], "2026-10-01T12:00:00");
        git(
            d,
            &["commit", "-qm", "second", "--allow-empty"],
            "2026-10-01T13:00:00",
        );
        git(
            d,
            &["commit", "-qm", "later", "--allow-empty"],
            "2026-10-03T12:00:00",
        );
        let repo = vec![d.to_string_lossy().into_owned()];
        let a = activity(&repo, "2026-09-01");
        assert_eq!(
            a.iter()
                .map(|x| (x.date.as_str(), x.count))
                .collect::<Vec<_>>(),
            [("2026-10-01", 2), ("2026-10-03", 1)]
        );
        assert!(a.iter().all(|x| x.type_id == "git"));
        let text = digest(&repo, 100_000);
        assert!(text.contains("first thing") && text.contains("secret.rs"));
        assert!(!text.contains("zzcodezz"));
    }

    #[test]
    fn a_folder_that_is_not_a_repository_counts_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let repo = vec![
            dir.path().to_string_lossy().into_owned(),
            "/no/such".to_owned(),
        ];
        assert!(activity(&repo, "2026-01-01").is_empty());
        assert_eq!(digest(&repo, 7), "");
    }
}
