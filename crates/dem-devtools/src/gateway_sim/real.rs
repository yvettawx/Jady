//! The real gateway behind the simulator's seam (P0-32 → P3): the same scenarios and the same matrix,
//! now against `dem_core`'s tools on a real throwaway library. Fixed ids in scenarios are translated
//! to the real ones on the way in and back on the way out; everything else is untouched, so a leak
//! shows up exactly as it would to the AI.

use std::collections::BTreeMap;

use dem_core::ai_tools::{Effects, ToolSession};
use dem_core::{AiSession, Core, ItemPatch, MemoryKeychain, NewItem};
use serde_json::Value;
use tempfile::TempDir;

use super::dataset::{Dataset, level_name};
use super::{GatewayUnderTest, Session, ToolResponse};

#[derive(Debug, Default)]
pub struct RealGateway {
    dir: Option<TempDir>,
    core: Option<Core>,
    /// Simulator id to real id.
    ids: BTreeMap<String, String>,
}

impl RealGateway {
    pub fn new() -> Self {
        Self::default()
    }

    fn inward(&self, text: &str) -> String {
        self.ids
            .iter()
            .fold(text.to_owned(), |t, (sim, real)| t.replace(sim, real))
    }

    fn outward(&self, text: &str) -> String {
        self.ids
            .iter()
            .fold(text.to_owned(), |t, (sim, real)| t.replace(real, sim))
    }
}

impl GatewayUnderTest for RealGateway {
    fn name(&self) -> &str {
        "real"
    }

    fn load(&mut self, dataset: &Dataset) -> anyhow::Result<()> {
        let dir = tempfile::tempdir()?;
        std::fs::create_dir_all(dir.path().join("docs"))?;
        let core = Core::new(
            dir.path().join("config"),
            dir.path().join("docs"),
            Box::new(MemoryKeychain::default()),
        );
        core.prepare_library(
            "sim",
            &dir.path().join("docs").display().to_string(),
            "correct horse",
        )
        .map_err(|e| anyhow::anyhow!(e.message))?;
        core.commit_library()
            .map_err(|e| anyhow::anyhow!(e.message))?;
        let mut ids = BTreeMap::new();
        core.with(|s| {
            // All ordinary first, so links resolve; then each is raised to its level.
            for item in &dataset.items {
                let v = s.create_item(NewItem {
                    type_id: "note".into(),
                    title: Some(item.title.clone()),
                    state: None,
                    container: None,
                    privacy: None,
                    fields: None,
                    tags: Some(item.tags.clone()),
                    due: None,
                    markdown: Some(format!("{}\n", item.body)),
                })?;
                ids.insert(item.id.clone(), v.id);
            }
            for item in &dataset.items {
                if item.links.is_empty() {
                    continue;
                }
                let links: Vec<String> = item
                    .links
                    .iter()
                    .filter_map(|l| dataset.items.iter().find(|i| &i.id == l))
                    .map(|i| format!("[[{}]]", i.title))
                    .collect();
                s.body_set_markdown(
                    &ids[&item.id],
                    &format!("{}\n\n{}\n", item.body, links.join(" ")),
                )?;
            }
            for item in &dataset.items {
                s.update_item(
                    &ids[&item.id],
                    ItemPatch {
                        privacy: Some(level_name(item.privacy).to_owned()),
                        ..Default::default()
                    },
                )?;
            }
            Ok(())
        })
        .map_err(|e| anyhow::anyhow!(e.message))?;
        self.dir = Some(dir);
        self.core = Some(core);
        self.ids = ids;
        Ok(())
    }

    fn call(&mut self, session: &Session, tool: &str, args: &Value) -> ToolResponse {
        let Some(core) = &self.core else {
            return ToolResponse::error("not loaded");
        };
        let args: Value =
            serde_json::from_str(&self.inward(&args.to_string())).unwrap_or(Value::Null);
        let tool_session = ToolSession {
            id: session.id.clone(),
            kind: if session.authorized {
                AiSession::Authorized
            } else {
                AiSession::Plain
            },
            learning: false,
        };
        let out = core
            .with(|s| Ok(s.ai_call(&tool_session, tool, &args, &mut Effects::default())))
            .unwrap_or_else(|e| Err(e.message));
        match out {
            Ok(t) => ToolResponse::ok(self.outward(&t)),
            Err(t) => ToolResponse::error(self.outward(&t)),
        }
    }

    fn data_snapshot(&self) -> anyhow::Result<String> {
        let Some(core) = &self.core else {
            return Ok(String::new());
        };
        core.with(|s| {
            let mut out = String::new();
            for id in self.ids.values() {
                let v = s.get_item(id)?;
                out.push_str(&format!(
                    "{id} {:?} {:?} {:?} {}\n",
                    v.title,
                    v.tags,
                    v.privacy,
                    s.body_markdown(id)?
                ));
            }
            Ok(out)
        })
        .map_err(|e| anyhow::anyhow!(e.message))
    }

    fn pending_proposals(&self) -> usize {
        self.core
            .as_ref()
            .and_then(|c| c.with(|s| s.proposal_list()).ok())
            .map_or(0, |list| {
                list.iter().filter(|p| p.state == "pending").count()
            })
    }
}
