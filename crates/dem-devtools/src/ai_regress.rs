//! AI regression scenarios (P0-33, framework). **Uses the Claude subscription
//! quota; manual only, never in CI or tests.**
//!
//! A scenario (`testdata/ai-regress/*.json`, see [`scenario`]) gives a prompt, a
//! session kind, the data the gateway serves, and checks. The runner starts
//! Claude Code with the hardened flag set from [`flags`], parses the
//! `stream-json` transcript ([`transcript`]) and writes a report.
//!
//! Budget guard, checked before anything is started:
//! - `--i-understand-this-uses-quota` is required, otherwise the run is refused;
//! - a CI environment (`CI` or `GITHUB_ACTIONS` set) is always refused;
//! - `--model` is always passed explicitly and `--max-turns` is capped at
//!   [`MAX_TURNS_CEILING`]; a plan with the upper bound of turns is printed first.
//!
//! `--dry-run` prints the plan and the exact commands without starting anything.
//!
//! The gateway: `--mcp-config` is a template of the MCP config whose `{setup}`
//! placeholder is replaced by each scenario's `setup.json`. In P0 it points at a
//! manually provided gateway (for example the P0-14 spike's); in P3 the runner
//! hosts `dem-ai-gateway` itself.

pub mod driver;
pub mod flags;
pub mod scenario;
pub mod transcript;

use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, bail};
use serde::Serialize;

use flags::{SessionKind, claude_args};
use scenario::Scenario;
use transcript::{CheckResult, Outcome, Transcript, evaluate};

pub const DEFAULT_SCENARIO_DIR: &str =
    concat!(env!("CARGO_MANIFEST_DIR"), "/../../testdata/ai-regress");

/// Hard upper limit for `--max-turns`.
pub const MAX_TURNS_CEILING: u32 = 20;

pub const CONFIRM_FLAG: &str = "--i-understand-this-uses-quota";

#[derive(Debug, Clone, clap::Args)]
pub struct Args {
    /// Directory of scenario files (`*.json`).
    #[arg(long, default_value = DEFAULT_SCENARIO_DIR)]
    pub scenarios: PathBuf,
    /// Run only the scenarios with these names (repeatable).
    #[arg(long)]
    pub only: Vec<String>,
    /// MCP config template for the gateway; `{setup}` is replaced by the scenario data path.
    #[arg(long)]
    pub mcp_config: Option<PathBuf>,
    /// Model alias or id, always passed explicitly.
    #[arg(long, default_value = "haiku")]
    pub model: String,
    /// Turn limit per scenario (at most 20; a lower per-scenario limit wins).
    #[arg(long, default_value_t = 6)]
    pub max_turns: u32,
    /// Wall-clock limit per scenario, in seconds.
    #[arg(long, default_value_t = 180)]
    pub timeout_secs: u64,
    /// Report directory (default: a new directory under the system temp dir).
    #[arg(long)]
    pub out: Option<PathBuf>,
    /// Print the plan and the exact commands; start nothing.
    #[arg(long)]
    pub dry_run: bool,
    /// Required to actually run: this uses the Claude subscription quota.
    #[arg(long = "i-understand-this-uses-quota")]
    pub confirm_quota: bool,
}

/// Why a run was refused.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum Refusal {
    #[error("refused: this uses the Claude subscription quota; pass {CONFIRM_FLAG} to run")]
    NotConfirmed,
    #[error("refused: AI regression runs are manual only and never run in CI ({0} is set)")]
    InCi(String),
    #[error("refused: --max-turns must be between 1 and {MAX_TURNS_CEILING}, got {0}")]
    MaxTurns(u32),
    #[error("refused: --model must name a model explicitly")]
    NoModel,
}

/// Environment variables that mark a CI run.
pub const CI_VARS: [&str; 2] = ["CI", "GITHUB_ACTIONS"];

/// The budget guard. `ci_var` is the name of a set CI variable, if any.
pub fn guard(
    confirmed: bool,
    ci_var: Option<&str>,
    model: &str,
    max_turns: u32,
) -> Result<(), Refusal> {
    if let Some(v) = ci_var {
        return Err(Refusal::InCi(v.to_string()));
    }
    if !confirmed {
        return Err(Refusal::NotConfirmed);
    }
    if model.trim().is_empty() {
        return Err(Refusal::NoModel);
    }
    if !(1..=MAX_TURNS_CEILING).contains(&max_turns) {
        return Err(Refusal::MaxTurns(max_turns));
    }
    Ok(())
}

fn ci_var_set() -> Option<&'static str> {
    CI_VARS
        .into_iter()
        .find(|v| std::env::var_os(v).is_some_and(|x| !x.is_empty()))
}

/// Effective turn limit for one scenario.
pub fn turns_for(s: &Scenario, cli_max: u32) -> u32 {
    s.max_turns.map_or(cli_max, |m| m.min(cli_max))
}

/// The arguments one scenario is launched with.
pub fn scenario_args(s: &Scenario, mcp_config: &Path, model: &str, cli_max: u32) -> Vec<String> {
    claude_args(s.session, mcp_config, model, turns_for(s, cli_max))
}

#[derive(Debug, Clone, Serialize)]
pub struct ScenarioReport {
    pub name: String,
    pub session: SessionKind,
    pub max_turns: u32,
    pub checks: Vec<CheckResult>,
    pub transcript: Transcript,
    pub timed_out: bool,
    pub wall_ms: u128,
    pub work_dir: String,
}

impl ScenarioReport {
    pub fn failed(&self) -> bool {
        self.checks
            .iter()
            .any(|c| matches!(c.outcome, Outcome::Fail(_)))
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Report {
    pub model: String,
    pub claude_version: Option<String>,
    pub scenarios: Vec<ScenarioReport>,
}

impl Report {
    pub fn render(&self) -> String {
        let mut out = String::new();
        let _ = writeln!(
            out,
            "ai-regress: model {}, claude {}",
            self.model,
            self.claude_version.as_deref().unwrap_or("?")
        );
        let mut cost = 0.0;
        for s in &self.scenarios {
            cost += s.transcript.total_cost_usd;
            let status = if s.failed() { "FAIL" } else { "ok  " };
            let _ = writeln!(
                out,
                "\n{status} {} ({:?}, {} turns of max {}, {:.1}s, est. ${:.4})",
                s.name,
                s.session,
                s.transcript.num_turns,
                s.max_turns,
                s.wall_ms as f64 / 1000.0,
                s.transcript.total_cost_usd
            );
            for c in &s.checks {
                let line = match &c.outcome {
                    Outcome::Pass => "pass".to_string(),
                    Outcome::Fail(d) => format!("FAIL {d}"),
                    Outcome::Skipped(d) => format!("skipped ({d})"),
                };
                let _ = writeln!(out, "    {:<28} {line}", c.check);
            }
            let _ = writeln!(out, "    work dir: {}", s.work_dir);
        }
        let failed = self.scenarios.iter().filter(|s| s.failed()).count();
        let _ = writeln!(
            out,
            "\n{} scenarios, {failed} failed, estimated cost ${cost:.4} (client estimate; quota indicator only)",
            self.scenarios.len()
        );
        out
    }
}

fn select(all: Vec<Scenario>, only: &[String]) -> anyhow::Result<Vec<Scenario>> {
    if only.is_empty() {
        return Ok(all);
    }
    if let Some(unknown) = only.iter().find(|n| !all.iter().any(|s| &s.name == *n)) {
        bail!("no scenario named '{unknown}'");
    }
    Ok(all.into_iter().filter(|s| only.contains(&s.name)).collect())
}

fn plan(scenarios: &[Scenario], args: &Args) -> String {
    let turns: u32 = scenarios.iter().map(|s| turns_for(s, args.max_turns)).sum();
    format!(
        "plan: {} scenario(s) with model '{}', at most {turns} turns in total, {}s timeout each\n",
        scenarios.len(),
        args.model,
        args.timeout_secs
    )
}

fn claude_version() -> Option<String> {
    let out = std::process::Command::new(driver::claude_bin())
        .arg("--version")
        .output()
        .ok()?;
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

pub fn run(args: Args) -> anyhow::Result<ExitCode> {
    if args.dry_run {
        // A dry run starts nothing, so it needs no confirmation, but it must not
        // print a plan that a real run would refuse.
        guard(true, None, &args.model, args.max_turns)?;
    } else {
        // Before reading anything else: a refused run must not start any process.
        guard(
            args.confirm_quota,
            ci_var_set(),
            &args.model,
            args.max_turns,
        )?;
    }
    let scenarios = select(scenario::load_dir(&args.scenarios)?, &args.only)?;
    print!("{}", plan(&scenarios, &args));

    if args.dry_run {
        let mcp = args
            .mcp_config
            .clone()
            .unwrap_or_else(|| PathBuf::from("<work-dir>/mcp.json"));
        for s in &scenarios {
            let line = driver::describe(&scenario_args(s, &mcp, &args.model, args.max_turns));
            println!("\n[{}] {:?} session\n{line}", s.name, s.session);
        }
        println!("\ndry run: nothing was started");
        return Ok(ExitCode::SUCCESS);
    }

    let template_path = args
        .mcp_config
        .as_ref()
        .context("--mcp-config is required for a real run")?;
    let template = std::fs::read_to_string(template_path)
        .with_context(|| format!("read {}", template_path.display()))?;
    let out_dir = match &args.out {
        Some(d) => d.clone(),
        None => {
            let secs = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            std::env::temp_dir().join(format!("dem-ai-regress-{secs}"))
        }
    };
    std::fs::create_dir_all(&out_dir)?;

    let mut reports = Vec::new();
    for (n, s) in scenarios.iter().enumerate() {
        let dir = out_dir.join(format!("{:02}-{}", n + 1, s.name));
        let mcp = driver::prepare(&dir, s, &template)?;
        let cli = scenario_args(s, &mcp, &args.model, args.max_turns);
        eprintln!("running {} ...", s.name);
        let run = driver::run_claude(&dir, s, &cli, Duration::from_secs(args.timeout_secs))?;
        let t = Transcript::parse(&run.stdout);
        reports.push(ScenarioReport {
            name: s.name.clone(),
            session: s.session,
            max_turns: turns_for(s, args.max_turns),
            checks: evaluate(s, &t, run.exit_ok),
            transcript: t,
            timed_out: run.timed_out,
            wall_ms: run.wall_ms,
            work_dir: dir.display().to_string(),
        });
    }
    let report = Report {
        model: args.model.clone(),
        claude_version: claude_version(),
        scenarios: reports,
    };
    std::fs::write(
        out_dir.join("report.json"),
        serde_json::to_vec_pretty(&report)?,
    )?;
    print!("{}", report.render());
    println!("report: {}", out_dir.join("report.json").display());
    Ok(if report.scenarios.iter().any(ScenarioReport::failed) {
        ExitCode::FAILURE
    } else {
        ExitCode::SUCCESS
    })
}
