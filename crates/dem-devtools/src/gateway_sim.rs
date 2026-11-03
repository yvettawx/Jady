//! AI gateway simulator (P0-32, framework): checks the privacy rules of the AI
//! gateway without calling any AI and without using any quota.
//!
//! - [`GatewayUnderTest`] is the seam: the [reference fake](reference::ReferenceGateway)
//!   implements it over an in-memory [dataset](dataset::Dataset) today; P3 plugs the
//!   real `dem-ai-gateway` in behind the same trait.
//! - The [runner](runner) executes scenario files from `testdata/gateway/` and an
//!   automatically generated matrix "every tool x every privacy level x
//!   authorized / unauthorized session".
//! - Every response is grepped for canary strings planted in hidden items, so a
//!   leak is caught no matter which tool or code path produced it.
//!
//! The dataset is fake, so responses may be printed in failure messages.

pub mod dataset;
pub mod real;
pub mod reference;
pub mod runner;
pub mod scenario;

use std::path::PathBuf;
use std::process::ExitCode;

use serde::Serialize;
use serde_json::Value;

use dataset::Dataset;

/// Tools every gateway under test must answer (MCP tool names without prefix).
pub const TOOLS: [&str; 4] = ["search", "read_item", "related", "propose_changes"];

/// One AI session as the gateway sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Session {
    pub id: String,
    /// The user authorized this session to read sensitive items.
    pub authorized: bool,
}

impl Session {
    pub fn new(id: impl Into<String>, authorized: bool) -> Self {
        Self {
            id: id.into(),
            authorized,
        }
    }
}

/// What the AI receives for one tool call: the text content and the MCP error flag.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ToolResponse {
    pub is_error: bool,
    pub text: String,
}

impl ToolResponse {
    pub fn ok(text: impl Into<String>) -> Self {
        Self {
            is_error: false,
            text: text.into(),
        }
    }

    pub fn error(text: impl Into<String>) -> Self {
        Self {
            is_error: true,
            text: text.into(),
        }
    }

    /// The response text parsed as JSON (`Null` if it is not JSON).
    pub fn json(&self) -> Value {
        serde_json::from_str(&self.text).unwrap_or(Value::Null)
    }
}

/// A gateway implementation the simulator can drive.
///
/// Calls take the tool name and raw JSON arguments exactly as an MCP client would
/// send them, so malformed arguments can be tested too.
pub trait GatewayUnderTest {
    /// Short name for reports.
    fn name(&self) -> &str;
    /// Replace all data with `dataset` and clear the proposal queue.
    fn load(&mut self, dataset: &Dataset) -> anyhow::Result<()>;
    /// Execute one tool call in `session`.
    fn call(&mut self, session: &Session, tool: &str, args: &Value) -> ToolResponse;
    /// A stable serialization of all item data, compared before and after calls
    /// to prove that tools (including `propose_changes`) never mutate data.
    fn data_snapshot(&self) -> anyhow::Result<String>;
    /// Number of proposals waiting in the queue.
    fn pending_proposals(&self) -> usize;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, clap::ValueEnum)]
pub enum Target {
    /// The reference fake gateway (must pass).
    Reference,
    /// The real gateway on a real throwaway library.
    Real,
    /// A deliberately leaky fake that returns one private item from `search`
    /// (negative control: must fail).
    Leaky,
}

#[derive(Debug, Clone, clap::Args)]
pub struct Args {
    /// Directory of scenario files (`*.json`).
    #[arg(long, default_value = runner::DEFAULT_SCENARIO_DIR)]
    pub scenarios: PathBuf,
    /// Gateway implementation to test.
    #[arg(long, value_enum, default_value_t = Target::Reference)]
    pub target: Target,
    /// Skip the generated tool x privacy level matrix.
    #[arg(long)]
    pub no_matrix: bool,
    /// Print the report as JSON instead of tables.
    #[arg(long)]
    pub json: bool,
}

pub fn run(args: Args) -> anyhow::Result<ExitCode> {
    let mut gateway: Box<dyn GatewayUnderTest> = match args.target {
        Target::Reference => Box::new(reference::ReferenceGateway::new()),
        Target::Real => Box::new(real::RealGateway::new()),
        Target::Leaky => Box::new(reference::LeakyGateway::new()),
    };
    let scenarios = scenario::load_dir(&args.scenarios)?;
    let dataset = Dataset::reference();
    let report = runner::run_all(gateway.as_mut(), &dataset, &scenarios, !args.no_matrix)?;
    if args.json {
        println!("{}", serde_json::to_string_pretty(&report)?);
    } else {
        print!("{}", report.render());
    }
    Ok(if report.passed() {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    })
}
