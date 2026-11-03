//! What AI is allowed to see (CLAUDE.md, M6, M9). P3's gateway asks only this, and everything it
//! hands out has been through the same check, so a mistake elsewhere cannot leak: anything not
//! readable in this session looks exactly like something that does not exist.

use dem_model::{AiSession, Privacy};

use crate::dto::{AiSearchPreview, HiddenHit, ItemView, SearchHit};
use crate::error::{CoreError, CoreResult};
use crate::session::{Session, privacy_of};

/// How many results the "what AI can find" page shows; AI itself gets 10 unless it asks for more.
pub const PREVIEW_LIMIT: u32 = 20;

#[derive(Debug)]
pub struct AiView<'a> {
    pub(crate) session: &'a mut Session,
    pub(crate) kind: AiSession,
}

impl Session {
    /// The restricted view for one kind of AI session.
    pub fn ai_view(&mut self, kind: AiSession) -> AiView<'_> {
        AiView {
            session: self,
            kind,
        }
    }

    /// What `search` would hand a session of this kind, and what the user's own search finds that
    /// it would not, with why. For the user's eyes only: no AI tool reaches this and nothing goes
    /// into the AI access log, because no AI is asking.
    pub fn ai_search_preview(
        &mut self,
        kind: AiSession,
        query: &str,
    ) -> CoreResult<AiSearchPreview> {
        let shown = self.ai_view(kind).search(query, PREVIEW_LIMIT)?;
        let mut hidden = Vec::new();
        if !query.trim().is_empty() {
            for hit in self.search(query, PREVIEW_LIMIT)? {
                if shown.iter().any(|h| h.item.id == hit.item.id) {
                    continue;
                }
                if let Some(reason) = self.ai_view(kind).why_hidden(&hit.item)? {
                    hidden.push(HiddenHit { hit, reason });
                }
            }
        }
        Ok(AiSearchPreview { shown, hidden })
    }
}

impl AiView<'_> {
    /// Why this session may not read an item, or `None` when it may (and was only ranked out).
    fn why_hidden(&mut self, item: &ItemView) -> CoreResult<Option<String>> {
        if self.get(&item.id).is_ok() {
            return Ok(None);
        }
        if item.state == "trashed" {
            return Ok(Some("trashed".into()));
        }
        Ok(Some(
            match privacy_of(&item.privacy)? {
                Privacy::Private => "private",
                Privacy::Confidential => "confidential",
                Privacy::Sensitive if self.kind == AiSession::WebAuthorized => "not-web",
                Privacy::Sensitive => "sensitive",
                // Readable by level yet refused: one of the app's own records.
                Privacy::Normal => return Ok(None),
            }
            .into(),
        ))
    }

    pub(crate) fn readable(&self, level: Privacy, ai_web: bool) -> bool {
        level.ai_may_read_in(ai_web, self.kind)
    }

    /// Whether AI may have the web in this session.
    pub fn has_web(&self) -> bool {
        self.kind.has_web()
    }

    /// One item, or "not found" whether it is unreadable or really missing.
    pub fn get(&mut self, id: &str) -> CoreResult<ItemView> {
        let missing = || CoreError::new("not-found", "item");
        let view = self.session.get_item(id).map_err(|_| missing())?;
        let level = privacy_of(&view.privacy)?;
        // The app's own records never reach AI as items: a chat or a proposal can quote what another
        // session was allowed to read. Working agreements are the exception: AI works under them.
        let system = dem_model::is_system_type(&view.type_id) && view.type_id != "agreement";
        if self.readable(level, view.ai_web) && !system && view.state != "trashed" {
            Ok(view)
        } else {
            Err(missing())
        }
    }

    pub fn search(&mut self, query: &str, limit: u32) -> CoreResult<Vec<SearchHit>> {
        // Nothing to look for: what changed most recently.
        if query.trim().is_empty() {
            let rows = self.session.list_items(&crate::dto::ListQuery {
                type_id: None,
                states: Some(vec!["inbox".into(), "active".into()]),
                container: None,
                tag: None,
                order: Some("updated".into()),
                limit: None,
            })?;
            let mut out = Vec::new();
            for item in rows {
                if out.len() as u32 == limit {
                    break;
                }
                if self.get(&item.id).is_ok() {
                    out.push(SearchHit {
                        snippet: item.preview.clone(),
                        item,
                    });
                }
            }
            return Ok(out);
        }
        let hits = self
            .session
            // Wide, so what cannot be read does not push out what can.
            .search(query, limit.saturating_mul(4).max(500))?;
        let mut out = Vec::new();
        for hit in hits {
            // The index does not hold the web mark, so check the item itself.
            if self.get(&hit.item.id).is_ok() {
                out.push(hit);
                if out.len() as u32 == limit {
                    break;
                }
            }
        }
        Ok(out)
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use crate::dto::{ItemPatch, NewItem};
    use crate::session::tests::{new_note, open_core};
    use dem_model::AiSession::*;

    #[test]
    fn each_session_reads_exactly_what_it_may() {
        let d = tempfile::tempdir().unwrap();
        let c = open_core(d.path());
        c.with(|s| {
            let make = |s: &mut crate::session::Session, level: &str, title: &str| {
                s.create_item(NewItem {
                    privacy: Some(level.into()),
                    markdown: Some("共同的词\n".into()),
                    ..new_note(title)
                })
                .map(|i| i.id)
            };
            let normal = make(s, "normal", "普通")?;
            let plain_sensitive = make(s, "sensitive", "敏感")?;
            let marked = make(s, "sensitive", "标过的")?;
            let private = make(s, "private", "私密")?;
            let secret = make(s, "confidential", "机密")?;
            s.update_item(
                &marked,
                ItemPatch {
                    ai_web: Some(true),
                    ..Default::default()
                },
            )?;
            let found = |s: &mut crate::session::Session, k| -> Vec<String> {
                let mut ids: Vec<String> = s
                    .ai_view(k)
                    .search("共同", 50)
                    .unwrap()
                    .into_iter()
                    .map(|h| h.item.id)
                    .collect();
                ids.sort();
                ids
            };
            let sorted = |mut v: Vec<&String>| {
                v.sort();
                v.into_iter().cloned().collect::<Vec<_>>()
            };
            assert_eq!(found(s, Plain), sorted(vec![&normal]));
            assert_eq!(
                found(s, Authorized),
                sorted(vec![&normal, &plain_sensitive, &marked])
            );
            assert_eq!(found(s, WebAuthorized), sorted(vec![&normal, &marked]));

            for k in [Plain, Authorized, WebAuthorized] {
                let mut v = s.ai_view(k);
                assert!(v.get(&normal).is_ok());
                for hidden in [&private, &secret] {
                    let e = v.get(hidden).unwrap_err();
                    assert_eq!(e.code, "not-found");
                    // The same answer as for something that does not exist.
                    let missing = v.get("019a0000-0000-7000-8000-000000000000").unwrap_err();
                    assert_eq!(e, missing);
                }
            }
            assert!(s.ai_view(Plain).get(&marked).is_err());
            assert!(!s.ai_view(Authorized).has_web());
            assert!(s.ai_view(WebAuthorized).has_web());
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn the_preview_shows_what_search_gives_ai_and_says_why_the_rest_is_out() {
        let d = tempfile::tempdir().unwrap();
        let c = open_core(d.path());
        c.with(|s| {
            let make = |s: &mut crate::session::Session, level: &str, title: &str| {
                s.create_item(NewItem {
                    privacy: Some(level.into()),
                    markdown: Some("预览用的词\n".into()),
                    ..new_note(title)
                })
                .map(|i| i.id)
            };
            let normal = make(s, "normal", "普通")?;
            let sensitive = make(s, "sensitive", "敏感")?;
            let private = make(s, "private", "私密")?;
            let gone = make(s, "normal", "扔掉的")?;
            s.update_item(
                &gone,
                ItemPatch {
                    state: Some("trashed".into()),
                    ..Default::default()
                },
            )?;
            let ids = |hits: &[crate::dto::SearchHit]| {
                hits.iter().map(|h| h.item.id.clone()).collect::<Vec<_>>()
            };
            let reasons = |p: &crate::dto::AiSearchPreview| {
                let mut r: Vec<(String, String)> = p
                    .hidden
                    .iter()
                    .map(|h| (h.hit.item.id.clone(), h.reason.clone()))
                    .collect();
                r.sort();
                r
            };
            let sorted = |mut v: Vec<(String, &str)>| {
                v.sort();
                v.into_iter()
                    .map(|(a, b)| (a, b.to_owned()))
                    .collect::<Vec<_>>()
            };

            let plain = s.ai_search_preview(Plain, "预览用的词")?;
            // Exactly what the tool itself hands AI.
            assert_eq!(
                ids(&plain.shown),
                ids(&s
                    .ai_view(Plain)
                    .search("预览用的词", super::PREVIEW_LIMIT)?)
            );
            assert_eq!(ids(&plain.shown), vec![normal.clone()]);
            let user_sees_trash = s
                .search("预览用的词", 50)?
                .iter()
                .any(|h| h.item.id == gone);
            let mut want = vec![
                (sensitive.clone(), "sensitive"),
                (private.clone(), "private"),
            ];
            if user_sees_trash {
                want.push((gone.clone(), "trashed"));
            }
            assert_eq!(reasons(&plain), sorted(want));

            let auth = s.ai_search_preview(Authorized, "预览用的词")?;
            let mut shown = ids(&auth.shown);
            shown.sort();
            let mut want = vec![normal.clone(), sensitive.clone()];
            want.sort();
            assert_eq!(shown, want);

            let web = s.ai_search_preview(WebAuthorized, "预览用的词")?;
            assert!(
                web.hidden
                    .iter()
                    .any(|h| h.hit.item.id == sensitive && h.reason == "not-web")
            );
            // Nothing typed: the recent items AI would get, and nothing to set beside them.
            assert!(s.ai_search_preview(Plain, "")?.hidden.is_empty());
            Ok(())
        })
        .unwrap();
    }
}
