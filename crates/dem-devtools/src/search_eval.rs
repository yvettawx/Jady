//! Search evaluation set runner (P0-37, framework).
//!
//! An evaluation file (`testdata/search-eval/*.json`) holds documents, queries
//! with the exact set of documents each must find, a category per query, and
//! highlight expectations. The runner indexes the documents into a
//! [`SearchUnderTest`], runs every query, and reports per-category hit rate,
//! recall@k, and the missing and unexpected results of every miss.
//!
//! In P0 the only engine is [`SubstringSearch`], a deliberately naive fake used
//! to prove the runner; P1 adds `dem-index` behind the same trait and runs the
//! full set for real.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use anyhow::{Context, bail};
use serde::{Deserialize, Serialize};

pub const DEFAULT_QUERY_FILE: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../testdata/search-eval/seed.json"
);

const DEFAULT_K: usize = 10;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct EvalSet {
    pub version: u32,
    #[serde(default)]
    pub description: String,
    /// Cut-off for recall@k and hits; default 10.
    #[serde(default)]
    pub k: Option<usize>,
    /// Opening and closing highlight markers used in `highlights[].expected`.
    #[serde(default)]
    pub highlight_markers: Option<(String, String)>,
    pub docs: Vec<EvalDoc>,
    pub queries: Vec<EvalQuery>,
    #[serde(default)]
    pub highlights: Vec<HighlightCase>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct EvalDoc {
    pub id: String,
    #[serde(default)]
    pub lang: String,
    pub title: String,
    pub body: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct EvalQuery {
    pub id: String,
    pub category: String,
    pub query: String,
    /// Every document the query must find, and nothing else. Empty for negative queries.
    pub expected: Vec<String>,
    #[serde(default)]
    pub note: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Field {
    Title,
    Body,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct HighlightCase {
    pub query: String,
    pub doc: String,
    pub field: Field,
    /// The field text with matches wrapped in the highlight markers.
    pub expected: String,
}

impl EvalSet {
    pub fn load(path: &Path) -> anyhow::Result<Self> {
        let text =
            std::fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
        let set: Self =
            serde_json::from_str(&text).with_context(|| format!("parse {}", path.display()))?;
        set.validate()
            .with_context(|| format!("invalid evaluation set {}", path.display()))?;
        Ok(set)
    }

    /// Reject duplicate ids and references to documents that do not exist.
    pub fn validate(&self) -> anyhow::Result<()> {
        if self.version != 1 {
            bail!("unsupported version {}", self.version);
        }
        let mut docs = BTreeSet::new();
        for d in &self.docs {
            if !docs.insert(d.id.as_str()) {
                bail!("duplicate doc id {}", d.id);
            }
        }
        let mut queries = BTreeSet::new();
        for q in &self.queries {
            if !queries.insert(q.id.as_str()) {
                bail!("duplicate query id {}", q.id);
            }
            if let Some(e) = q.expected.iter().find(|e| !docs.contains(e.as_str())) {
                bail!("query {} expects unknown doc {e}", q.id);
            }
        }
        if let Some(h) = self
            .highlights
            .iter()
            .find(|h| !docs.contains(h.doc.as_str()))
        {
            bail!(
                "highlight for query '{}' names unknown doc {}",
                h.query,
                h.doc
            );
        }
        if !self.highlights.is_empty() && self.highlight_markers.is_none() {
            bail!("highlights given without highlight_markers");
        }
        Ok(())
    }

    pub fn k(&self) -> usize {
        self.k.unwrap_or(DEFAULT_K).max(1)
    }
}

/// A search engine the runner can evaluate.
pub trait SearchUnderTest {
    fn name(&self) -> &str;
    /// Replace the indexed content with `docs`.
    fn index(&mut self, docs: &[EvalDoc]) -> anyhow::Result<()>;
    /// Ranked document ids, best first, at most `limit`.
    fn search(&self, query: &str, limit: usize) -> anyhow::Result<Vec<String>>;
    /// The field with matches wrapped in `markers`; `None` if the engine has no
    /// highlighter (the highlight cases are then reported as skipped).
    fn highlight(
        &self,
        _query: &str,
        _doc: &EvalDoc,
        _field: Field,
        _markers: (&str, &str),
    ) -> Option<String> {
        None
    }
}

/// Fake engine: case-sensitive substring match on title and body, documents in
/// file order. No normalization of any kind, so it misses on purpose wherever a
/// real engine has to fold scripts, case or accents.
#[derive(Debug, Default)]
pub struct SubstringSearch {
    docs: Vec<EvalDoc>,
}

impl SearchUnderTest for SubstringSearch {
    fn name(&self) -> &str {
        "substring"
    }

    fn index(&mut self, docs: &[EvalDoc]) -> anyhow::Result<()> {
        self.docs = docs.to_vec();
        Ok(())
    }

    fn search(&self, query: &str, limit: usize) -> anyhow::Result<Vec<String>> {
        Ok(self
            .docs
            .iter()
            .filter(|d| d.title.contains(query) || d.body.contains(query))
            .take(limit)
            .map(|d| d.id.clone())
            .collect())
    }

    fn highlight(
        &self,
        query: &str,
        doc: &EvalDoc,
        field: Field,
        (open, close): (&str, &str),
    ) -> Option<String> {
        let text = match field {
            Field::Title => &doc.title,
            Field::Body => &doc.body,
        };
        if query.is_empty() {
            return Some(text.clone());
        }
        Some(text.replace(query, &format!("{open}{query}{close}")))
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct QueryResult {
    pub id: String,
    pub category: String,
    pub query: String,
    /// All expected documents found within the top k, and nothing else.
    pub hit: bool,
    /// |expected found in top k| / |expected|; `None` for negative queries.
    pub recall: Option<f64>,
    pub missing: Vec<String>,
    pub unexpected: Vec<String>,
    pub returned: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct CategoryStats {
    pub queries: usize,
    pub hits: usize,
    pub hit_rate: f64,
    /// Mean recall@k over the category's queries that expect at least one document.
    pub recall_at_k: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct HighlightResult {
    pub query: String,
    pub doc: String,
    pub field: Field,
    /// `None`: skipped (engine has no highlighter).
    pub passed: Option<bool>,
    pub got: Option<String>,
    pub expected: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Report {
    pub engine: String,
    pub file: String,
    pub k: usize,
    pub categories: BTreeMap<String, CategoryStats>,
    pub overall: CategoryStats,
    pub queries: Vec<QueryResult>,
    pub highlights: Vec<HighlightResult>,
}

fn stats<'a>(results: impl Iterator<Item = &'a QueryResult>) -> CategoryStats {
    let mut s = CategoryStats::default();
    let mut recalls = Vec::new();
    for r in results {
        s.queries += 1;
        s.hits += usize::from(r.hit);
        recalls.extend(r.recall);
    }
    if s.queries > 0 {
        s.hit_rate = s.hits as f64 / s.queries as f64;
    }
    if !recalls.is_empty() {
        s.recall_at_k = Some(recalls.iter().sum::<f64>() / recalls.len() as f64);
    }
    s
}

pub fn evaluate_query(q: &EvalQuery, returned: Vec<String>, k: usize) -> QueryResult {
    let top: BTreeSet<&str> = returned.iter().take(k).map(String::as_str).collect();
    let want: BTreeSet<&str> = q.expected.iter().map(String::as_str).collect();
    let missing: Vec<String> = want.difference(&top).map(|s| s.to_string()).collect();
    let unexpected: Vec<String> = top.difference(&want).map(|s| s.to_string()).collect();
    let recall =
        (!want.is_empty()).then(|| want.intersection(&top).count() as f64 / want.len() as f64);
    QueryResult {
        id: q.id.clone(),
        category: q.category.clone(),
        query: q.query.clone(),
        hit: missing.is_empty() && unexpected.is_empty(),
        recall,
        missing,
        unexpected,
        returned,
    }
}

pub fn run_eval(
    engine: &mut dyn SearchUnderTest,
    set: &EvalSet,
    file: &str,
) -> anyhow::Result<Report> {
    let k = set.k();
    engine.index(&set.docs)?;
    let mut queries = Vec::new();
    for q in &set.queries {
        // Ask for more than k so results beyond the cut-off show up as context.
        let returned = engine
            .search(&q.query, k.saturating_mul(2))
            .with_context(|| format!("query {}", q.id))?;
        queries.push(evaluate_query(q, returned, k));
    }
    let mut categories = BTreeMap::new();
    let names: BTreeSet<&str> = queries.iter().map(|r| r.category.as_str()).collect();
    for c in names {
        categories.insert(
            c.to_string(),
            stats(queries.iter().filter(|r| r.category == c)),
        );
    }
    let overall = stats(queries.iter());
    let highlights = set
        .highlights
        .iter()
        .map(|h| {
            let got = match (
                &set.highlight_markers,
                set.docs.iter().find(|d| d.id == h.doc),
            ) {
                (Some((o, c)), Some(doc)) => engine.highlight(&h.query, doc, h.field, (o, c)),
                _ => None,
            };
            HighlightResult {
                query: h.query.clone(),
                doc: h.doc.clone(),
                field: h.field,
                passed: got.as_ref().map(|g| *g == h.expected),
                got,
                expected: h.expected.clone(),
            }
        })
        .collect();
    Ok(Report {
        engine: engine.name().to_string(),
        file: file.to_string(),
        k,
        categories,
        overall,
        queries,
        highlights,
    })
}

fn pct(v: f64) -> String {
    format!("{:.1}%", v * 100.0)
}

impl Report {
    pub fn render(&self) -> String {
        let mut out = String::new();
        let _ = writeln!(
            out,
            "search-eval: engine '{}', {} queries, k={} ({})\n",
            self.engine,
            self.queries.len(),
            self.k,
            self.file
        );
        let _ = writeln!(
            out,
            "{:<14}{:>8}{:>6}{:>10}{:>11}",
            "category",
            "queries",
            "hits",
            "hit rate",
            format!("recall@{}", self.k)
        );
        let row = |out: &mut String, name: &str, s: &CategoryStats| {
            let _ = writeln!(
                out,
                "{:<14}{:>8}{:>6}{:>10}{:>11}",
                name,
                s.queries,
                s.hits,
                pct(s.hit_rate),
                s.recall_at_k.map(pct).unwrap_or_else(|| "-".into())
            );
        };
        for (name, s) in &self.categories {
            row(&mut out, name, s);
        }
        row(&mut out, "overall", &self.overall);

        let misses: Vec<&QueryResult> = self.queries.iter().filter(|q| !q.hit).collect();
        if !misses.is_empty() {
            let _ = writeln!(out, "\nmisses ({})", misses.len());
            for q in misses {
                let _ = writeln!(
                    out,
                    "  [{}] {:?} ({}): missing {:?}, unexpected {:?}",
                    q.id, q.query, q.category, q.missing, q.unexpected
                );
            }
        }
        let checked: Vec<&HighlightResult> = self
            .highlights
            .iter()
            .filter(|h| h.passed.is_some())
            .collect();
        let skipped = self.highlights.len() - checked.len();
        let passed = checked.iter().filter(|h| h.passed == Some(true)).count();
        let _ = writeln!(
            out,
            "\nhighlights: {passed}/{} passed, {skipped} skipped",
            checked.len()
        );
        for h in checked.iter().filter(|h| h.passed == Some(false)) {
            let _ = writeln!(
                out,
                "  {:?} doc {} {:?}: got {:?}, expected {:?}",
                h.query,
                h.doc,
                h.field,
                h.got.as_deref().unwrap_or(""),
                h.expected
            );
        }
        out
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, clap::ValueEnum)]
pub enum Engine {
    /// Naive substring fake (P0); `dem-index` is added in P1.
    Substring,
}

#[derive(Debug, Clone, clap::Args)]
pub struct Args {
    /// Evaluation file.
    #[arg(long, default_value = DEFAULT_QUERY_FILE)]
    pub queries: PathBuf,
    #[arg(long, value_enum, default_value_t = Engine::Substring)]
    pub engine: Engine,
    /// Override the file's k.
    #[arg(long)]
    pub k: Option<usize>,
    /// Exit with failure if the overall hit rate (0.0 to 1.0) is below this.
    #[arg(long)]
    pub min_hit_rate: Option<f64>,
    /// Print the report as JSON.
    #[arg(long)]
    pub json: bool,
}

pub fn run(args: Args) -> anyhow::Result<ExitCode> {
    if let Some(min) = args.min_hit_rate
        && !(0.0..=1.0).contains(&min)
    {
        bail!("--min-hit-rate must be between 0.0 and 1.0, got {min}");
    }
    let mut set = EvalSet::load(&args.queries)?;
    if args.k.is_some() {
        set.k = args.k;
    }
    let mut engine: Box<dyn SearchUnderTest> = match args.engine {
        Engine::Substring => Box::<SubstringSearch>::default(),
    };
    let file = args
        .queries
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let report = run_eval(engine.as_mut(), &set, &file)?;
    if args.json {
        println!("{}", serde_json::to_string_pretty(&report)?);
    } else {
        print!("{}", report.render());
    }
    let below = args
        .min_hit_rate
        .is_some_and(|min| report.overall.hit_rate < min);
    Ok(if below {
        ExitCode::FAILURE
    } else {
        ExitCode::SUCCESS
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn q(expected: &[&str]) -> EvalQuery {
        EvalQuery {
            id: "q".into(),
            category: "c".into(),
            query: "x".into(),
            expected: expected.iter().map(|s| s.to_string()).collect(),
            note: String::new(),
        }
    }

    fn ids(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn exact_match_is_a_hit() {
        let r = evaluate_query(&q(&["1", "2"]), ids(&["2", "1"]), 10);
        assert!(r.hit);
        assert_eq!(r.recall, Some(1.0));
    }

    #[test]
    fn results_beyond_k_count_as_missing() {
        let r = evaluate_query(&q(&["1", "2"]), ids(&["1", "2"]), 1);
        assert!(!r.hit);
        assert_eq!(r.missing, ids(&["2"]));
        assert_eq!(r.recall, Some(0.5));
    }

    #[test]
    fn negative_query_has_no_recall_and_fails_on_any_result() {
        let r = evaluate_query(&q(&[]), ids(&["3"]), 10);
        assert!(!r.hit);
        assert_eq!(r.recall, None);
        assert_eq!(r.unexpected, ids(&["3"]));
        assert!(evaluate_query(&q(&[]), vec![], 10).hit);
    }
}
