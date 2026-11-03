//! 复习 (M7): the review log is the truth; what the scheduler thinks is worked out from it when the
//! library opens and kept current as reviews come in.

use std::collections::HashMap;

use dem_learn::{Memory, Rating, Stage};
use dem_model::Timestamp;
use dem_store::logs::{LogKind, LogRecord};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value as J, json};

use crate::dto::{ItemView, ListQuery};
use crate::error::{CoreError, CoreResult};
use crate::session::{Session, parse_id};

fn rating_of(s: &str) -> CoreResult<Rating> {
    Ok(match s {
        "again" => Rating::Again,
        "hard" => Rating::Hard,
        "good" => Rating::Good,
        "easy" => Rating::Easy,
        _ => return Err(CoreError::invalid("rating")),
    })
}

fn rating_str(r: Rating) -> &'static str {
    match r {
        Rating::Again => "again",
        Rating::Hard => "hard",
        Rating::Good => "good",
        Rating::Easy => "easy",
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct ReviewInput {
    pub item: String,
    /// `again`, `hard`, `good` or `easy`.
    pub rating: String,
    /// 1 to 3, how sure beforehand.
    pub confidence: Option<u8>,
    pub peeked: bool,
    pub duration_ms: u32,
    /// `card`, `chat`, `problem` or `recite`.
    pub context: String,
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct DueCard {
    pub id: String,
    pub front: String,
    pub back: String,
    pub overconfident: bool,
    /// Days until it would come back after each of again, hard, good, easy.
    pub intervals: Vec<f64>,
}

impl std::fmt::Debug for DueCard {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DueCard")
            .field("id", &self.id)
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct MasteryGroup {
    /// A tag, or a domain or project's id.
    pub key: String,
    pub kind: String,
    pub cards: u32,
    /// 0 to 1.
    pub mastery: f64,
    /// `new`, `learning`, `consolidating` or `fluent`.
    pub stage: String,
}

fn now_ms() -> f64 {
    Timestamp::now().as_millisecond() as f64
}

fn stage_str(s: Stage) -> &'static str {
    match s {
        Stage::New => "new",
        Stage::Learning => "learning",
        Stage::Consolidating => "consolidating",
        Stage::Fluent => "fluent",
    }
}

/// What the whole review log adds up to.
pub(crate) fn replay(session: &Session) -> CoreResult<HashMap<String, Memory>> {
    let logs = session.lib.read_logs(LogKind::Review)?;
    let mut records: Vec<_> = logs.records.into_iter().collect();
    records.sort_by_key(|r| r.ts);
    let mut out: HashMap<String, Memory> = HashMap::new();
    for r in records {
        let (Some(item), Some(rating)) = (
            r.fields.get("item").and_then(J::as_str),
            r.fields.get("rating").and_then(J::as_str),
        ) else {
            continue;
        };
        let Ok(rating) = rating_of(rating) else {
            continue;
        };
        let confidence = r
            .fields
            .get("confidence")
            .and_then(J::as_u64)
            .map(|c| c as u8);
        let next = dem_learn::review(
            out.get(item),
            rating,
            r.ts.as_millisecond() as f64,
            dem_learn::is_overconfident(confidence, rating),
        );
        out.insert(item.to_owned(), next);
    }
    Ok(out)
}

fn card_takes_part(fields: &str) -> bool {
    serde_json::from_str::<J>(fields)
        .ok()
        .and_then(|f| f.get("review").and_then(J::as_bool))
        .unwrap_or(false)
}

impl Session {
    pub fn record_review(&mut self, input: &ReviewInput) -> CoreResult<()> {
        // A line of a text recited on its own is `id#n` (M7: each line counts by itself).
        parse_id(input.item.split('#').next().unwrap_or(""))?;
        let mut rating = rating_of(&input.rating)?;
        if input.peeked {
            rating = dem_learn::after_peek(rating);
        }
        let mut fields = Map::new();
        fields.insert("item".into(), json!(input.item));
        fields.insert("rating".into(), json!(rating_str(rating)));
        fields.insert("confidence".into(), json!(input.confidence));
        fields.insert("peeked".into(), json!(input.peeked));
        fields.insert("duration_ms".into(), json!(input.duration_ms));
        fields.insert("context".into(), json!(input.context));
        self.lib
            .append_log(LogKind::Review, &LogRecord::new(LogKind::Review, fields))?;
        let at = now_ms();
        let over = dem_learn::is_overconfident(input.confidence, rating);
        let next = dem_learn::review(self.memories.get(&input.item), rating, at, over);
        self.memories.insert(input.item.clone(), next);
        self.index
            .add_activity(&crate::session::today(), "review", 1)?;
        Ok(())
    }

    /// What is due, those you were sure of and got wrong first (C2).
    pub fn review_queue(&mut self, limit: u32) -> CoreResult<Vec<DueCard>> {
        self.due_of("card", limit)
    }

    /// Problems to do again (C7), by the same schedule.
    pub fn practice_queue(&mut self, limit: u32) -> CoreResult<Vec<DueCard>> {
        self.due_of("problem", limit)
    }

    /// Where one line of a recited text stands: when it is due, or `None` if new.
    pub fn recite_due(&self, item: &str, lines: u32) -> Vec<bool> {
        let now = now_ms();
        (0..lines)
            .map(|n| {
                self.memories
                    .get(&format!("{item}#{n}"))
                    .is_none_or(|m| m.due <= now)
            })
            .collect()
    }

    fn due_of(&mut self, type_id: &str, limit: u32) -> CoreResult<Vec<DueCard>> {
        let cards = self.list_items(&ListQuery {
            type_id: Some(type_id.into()),
            states: Some(vec!["active".into(), "inbox".into()]),
            container: None,
            tag: None,
            order: Some("created".into()),
            limit: None,
        })?;
        let now = now_ms();
        let mut due: Vec<(bool, f64, ItemView)> = Vec::new();
        for c in cards {
            // 机密 stays behind its own gate: never quizzed in the open.
            if c.privacy == "confidential" || !card_takes_part(&c.fields) {
                continue;
            }
            match self.memories.get(&c.id) {
                None => due.push((false, 0.0, c)),
                Some(m) if m.due <= now => due.push((m.overconfident, m.due, c)),
                Some(_) => {}
            }
        }
        due.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.total_cmp(&b.1)));
        Ok(due
            .into_iter()
            .take(limit as usize)
            .map(|(over, _, c)| {
                let f: J = serde_json::from_str(&c.fields).unwrap_or(J::Null);
                let text = |k: &str| f.get(k).and_then(J::as_str).unwrap_or("").to_owned();
                let front = text("front");
                let back = if type_id == "problem" {
                    text("answer")
                } else {
                    text("back")
                };
                DueCard {
                    intervals: dem_learn::preview(self.memories.get(&c.id), now).to_vec(),
                    id: c.id,
                    front: if front.is_empty() {
                        c.title.unwrap_or_default()
                    } else {
                        front
                    },
                    back,
                    overconfident: over,
                }
            })
            .collect())
    }

    /// B2: by tag and by domain or project.
    pub fn mastery_overview(&mut self) -> CoreResult<Vec<MasteryGroup>> {
        let cards = self.list_items(&ListQuery {
            type_id: Some("card".into()),
            states: Some(vec!["active".into(), "inbox".into()]),
            container: None,
            tag: None,
            order: None,
            limit: None,
        })?;
        let now = now_ms();
        let mut groups: HashMap<(String, String), Vec<Memory>> = HashMap::new();
        for c in &cards {
            let Some(m) = self.memories.get(&c.id) else {
                continue;
            };
            for tag in &c.tags {
                groups
                    .entry(("tag".into(), tag.clone()))
                    .or_default()
                    .push(*m);
            }
            if let Some(container) = &c.container {
                groups
                    .entry(("container".into(), container.clone()))
                    .or_default()
                    .push(*m);
            }
        }
        let mut out: Vec<MasteryGroup> = groups
            .into_iter()
            .map(|((kind, key), ms)| MasteryGroup {
                key,
                kind,
                cards: ms.len() as u32,
                mastery: ms.iter().map(|m| dem_learn::mastery(m, now)).sum::<f64>()
                    / ms.len() as f64,
                stage: stage_str(dem_learn::stage(&ms, now)).to_owned(),
            })
            .collect();
        out.sort_by(|a, b| a.key.cmp(&b.key));
        Ok(out)
    }

    /// One tag's mastery, for a key result (E5). `None` until a card there has been reviewed.
    pub fn mastery_of(&mut self, tag: &str) -> CoreResult<Option<f64>> {
        Ok(self
            .mastery_overview()?
            .into_iter()
            .find(|g| g.kind == "tag" && g.key == tag)
            .map(|g| g.mastery))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dto::NewItem;
    use crate::session::tests::open_core;

    fn card(front: &str, review: bool) -> NewItem {
        NewItem {
            type_id: "card".into(),
            title: Some(front.into()),
            state: None,
            container: None,
            privacy: None,
            fields: Some(json!({ "front": front, "back": "答案", "review": review }).to_string()),
            tags: Some(vec!["法语".into()]),
            due: None,
            markdown: None,
        }
    }

    fn input(item: &str, rating: &str, confidence: Option<u8>) -> ReviewInput {
        ReviewInput {
            item: item.into(),
            rating: rating.into(),
            confidence,
            peeked: false,
            duration_ms: 1000,
            context: "card".into(),
        }
    }

    #[test]
    fn only_cards_taking_part_come_up_and_answering_sends_them_away() {
        let dir = tempfile::tempdir().unwrap();
        let core = open_core(dir.path());
        core.with(|s| {
            let a = s.create_item(card("le quai", true))?;
            s.create_item(card("只记不背", false))?;
            let q = s.review_queue(10)?;
            assert_eq!(q.len(), 1);
            assert_eq!(q[0].front, "le quai");
            s.record_review(&input(&a.id, "good", None))?;
            assert!(s.review_queue(10)?.is_empty());
            assert!(s.mastery_of("法语")?.unwrap() > 0.8);
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn sure_and_wrong_comes_first_and_the_log_survives_reopening() {
        let dir = tempfile::tempdir().unwrap();
        let core = open_core(dir.path());
        let sure = core
            .with(|s| {
                let plain = s.create_item(card("普通", true))?;
                let sure = s.create_item(card("以为会", true))?;
                s.record_review(&input(&plain.id, "again", None))?;
                s.record_review(&input(&sure.id, "again", Some(3)))?;
                Ok(sure.id)
            })
            .unwrap();
        // Forgotten cards come back in ten minutes: not due yet right after.
        let path = core.with(|s| Ok(s.library_path())).unwrap();
        core.lock().unwrap();
        assert!(core.unlock_password(&path, "correct horse").unwrap());
        core.with(|s| {
            let m = s.memories.get_mut(&sure).unwrap();
            assert!(m.overconfident, "rebuilt from the log");
            for m in s.memories.values_mut() {
                m.due = 0.0;
            }
            let q = s.review_queue(10)?;
            assert_eq!(q.len(), 2);
            assert_eq!(q[0].id, sure);
            assert!(q[0].overconfident);
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn the_log_holds_no_card_text() {
        let dir = tempfile::tempdir().unwrap();
        let core = open_core(dir.path());
        core.with(|s| {
            let a = s.create_item(card("zzsecretfrontzz", true))?;
            s.record_review(&input(&a.id, "good", Some(2)))?;
            let logs = s.lib.read_logs(LogKind::Review)?;
            let text = format!(
                "{:?}",
                logs.records.iter().map(|r| &r.fields).collect::<Vec<_>>()
            );
            assert!(!text.contains("zzsecretfrontzz"));
            assert!(text.contains(&a.id));
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn a_peek_is_recorded_and_never_counts_as_good() {
        let dir = tempfile::tempdir().unwrap();
        let core = open_core(dir.path());
        core.with(|s| {
            let a = s.create_item(card("偷看", true))?;
            let mut i = input(&a.id, "easy", None);
            i.peeked = true;
            s.record_review(&i)?;
            let logs = s.lib.read_logs(LogKind::Review)?;
            assert_eq!(logs.records[0].fields["rating"], "hard");
            assert_eq!(logs.records[0].fields["peeked"], true);
            Ok(())
        })
        .unwrap();
    }
}
