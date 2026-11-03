//! Test support shared by crate tests, benchmarks and `dem-dev`.
//!
//! - [`generate`]: deterministic synthetic items (P0-34) covering Simplified and
//!   Traditional Chinese, Tangut, accented Latin, BCE and approximate dates, all
//!   privacy levels, a domain/project tree and links.

pub mod corpus;

use std::collections::BTreeMap;

use dem_model::{
    FlexDate, ItemId, ItemMeta, ItemState, Privacy, SourceInfo, SourceOrigin, TagId, TimeAnchor,
    Timestamp, TypeId,
};
use rand::{Rng, SeedableRng};
use rand_chacha::ChaCha8Rng;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone)]
pub struct GenConfig {
    pub seed: u64,
    pub items: usize,
    /// Domains and projects in the structure tree (not counted in `items`).
    pub containers: usize,
    /// Average outgoing links per item.
    pub links_per_item: f64,
}

impl GenConfig {
    pub fn new(seed: u64, items: usize) -> Self {
        Self {
            seed,
            items,
            containers: (items / 200).clamp(5, 300),
            links_per_item: 1.5,
        }
    }
}

/// A domain or project node; `parent` is None for top-level domains.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GenContainer {
    pub meta: ItemMeta,
    pub parent: Option<ItemId>,
    pub is_project: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GenItem {
    pub meta: ItemMeta,
    pub fields: BTreeMap<String, serde_json::Value>,
    /// Plain-text body; paragraphs separated by blank lines.
    pub body: String,
    pub links: Vec<ItemId>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GenLibrary {
    pub seed: u64,
    pub containers: Vec<GenContainer>,
    pub items: Vec<GenItem>,
}

/// 2020-01-01T00:00:00Z; generated items are created over the following years.
const BASE_MS: i64 = 1_577_836_800_000;

struct Gen {
    rng: ChaCha8Rng,
    clock_ms: i64,
}

impl Gen {
    /// Deterministic UUIDv7: monotonically increasing timestamp, seeded random bits.
    fn id(&mut self) -> ItemId {
        self.clock_ms += self.rng.random_range(1..60_000);
        let mut rand_bytes = [0u8; 10];
        self.rng.fill(&mut rand_bytes);
        let millis = u64::try_from(self.clock_ms).unwrap_or_default();
        ItemId::from_uuid(
            uuid::Builder::from_unix_timestamp_millis(millis, &rand_bytes).into_uuid(),
        )
    }

    fn now(&self) -> Timestamp {
        Timestamp::from_millisecond(self.clock_ms).unwrap_or(Timestamp::UNIX_EPOCH)
    }

    fn pick<'a, T>(&mut self, xs: &'a [T]) -> &'a T {
        &xs[self.rng.random_range(0..xs.len())]
    }

    fn privacy(&mut self) -> Privacy {
        match self.rng.random_range(0..100) {
            0..70 => Privacy::Normal,
            70..85 => Privacy::Sensitive,
            85..95 => Privacy::Private,
            _ => Privacy::Confidential,
        }
    }

    fn state(&mut self) -> ItemState {
        match self.rng.random_range(0..100) {
            0..10 => ItemState::Inbox,
            10..85 => ItemState::Active,
            85..97 => ItemState::Archived,
            _ => ItemState::Trashed,
        }
    }

    fn meta(
        &mut self,
        type_id: &str,
        title: Option<String>,
        container: Option<ItemId>,
    ) -> ItemMeta {
        let id = self.id();
        let created = self.now();
        ItemMeta {
            id,
            type_id: TypeId(type_id.to_owned()),
            title,
            state: self.state(),
            privacy: self.privacy(),
            container,
            tags: Vec::new(),
            created,
            updated: created,
            time: None,
            source: SourceInfo::default(),
            ai_web: false,
        }
    }

    fn flex_date(&mut self) -> FlexDate {
        let year = match self.rng.random_range(0..10) {
            0..3 => -self.rng.random_range(1..3000),
            _ => self.rng.random_range(1..2030),
        };
        let mut d = match self.rng.random_range(0..3) {
            0 => FlexDate::year(year),
            1 => FlexDate::new(year, Some(self.rng.random_range(1..=12)), None),
            _ => FlexDate::ymd(
                year,
                self.rng.random_range(1..=12),
                self.rng.random_range(1..=28),
            ),
        }
        .unwrap_or(FlexDate {
            year: 1,
            month: None,
            day: None,
            approximate: false,
            until: None,
        });
        if self.rng.random_bool(0.2) {
            d = d.approx();
        }
        if self.rng.random_bool(0.15) {
            let end_year = year.saturating_add(self.rng.random_range(1..200));
            let end_year = if end_year == 0 { 1 } else { end_year };
            if let Ok(end) = FlexDate::year(end_year)
                && let Ok(span) = d.clone().until(end)
            {
                d = span;
            }
        }
        d
    }

    fn body(&mut self) -> String {
        let paragraphs = self.rng.random_range(1..6);
        let mut out = Vec::with_capacity(paragraphs);
        for _ in 0..paragraphs {
            let p = match self.rng.random_range(0..10) {
                0..4 => corpus::sentences(&mut self.rng, corpus::ZH_HANS, 1..5),
                4..6 => corpus::sentences(&mut self.rng, corpus::ZH_HANT, 1..4),
                6 => corpus::tangut(&mut self.rng, 4..40),
                7 => corpus::sentences(&mut self.rng, corpus::FRENCH, 1..4),
                _ => corpus::sentences(&mut self.rng, corpus::ENGLISH, 1..4),
            };
            out.push(p);
        }
        out.join("\n\n")
    }
}

const TYPES: &[&str] = &[
    "note",
    "idea",
    "journal",
    "article",
    "todo",
    "card",
    "person",
    "event",
    "job_posting",
];

/// Generates a synthetic library. The same config always yields identical output.
pub fn generate(cfg: &GenConfig) -> GenLibrary {
    let mut g = Gen {
        rng: ChaCha8Rng::seed_from_u64(cfg.seed),
        clock_ms: BASE_MS,
    };

    // Structure: a forest of domains, sub-domains and projects.
    let mut containers: Vec<GenContainer> = Vec::with_capacity(cfg.containers);
    for i in 0..cfg.containers {
        let is_project = i > 2 && g.rng.random_bool(0.4);
        let parent = if i < 3 || containers.is_empty() {
            None
        } else {
            // Only domains can have children.
            let domains: Vec<ItemId> = containers
                .iter()
                .filter(|c| !c.is_project)
                .map(|c| c.meta.id)
                .collect();
            Some(*g.pick(&domains))
        };
        let title = Some(corpus::short_title(&mut g.rng));
        let mut meta = g.meta(if is_project { "project" } else { "domain" }, title, None);
        meta.state = ItemState::Active;
        meta.privacy = Privacy::Normal;
        containers.push(GenContainer {
            meta,
            parent,
            is_project,
        });
    }

    let container_ids: Vec<ItemId> = containers.iter().map(|c| c.meta.id).collect();
    let mut items: Vec<GenItem> = Vec::with_capacity(cfg.items);
    for _ in 0..cfg.items {
        let ty = *g.pick(TYPES);
        let container = if g.rng.random_bool(0.85) {
            Some(*g.pick(&container_ids))
        } else {
            None
        };
        let title = if matches!(ty, "idea" | "card") && g.rng.random_bool(0.5) {
            None
        } else {
            Some(corpus::short_title(&mut g.rng))
        };
        let mut meta = g.meta(ty, title, container);
        for _ in 0..g.rng.random_range(0..4) {
            meta.tags.push(TagId(g.pick(corpus::TAGS).to_string()));
        }
        meta.tags.sort();
        meta.tags.dedup();

        let mut fields = BTreeMap::new();
        match ty {
            "todo" => {
                let due_ms = g.clock_ms + g.rng.random_range(-30..90) * 86_400_000;
                if let Ok(at) = Timestamp::from_millisecond(due_ms) {
                    meta.time = Some(TimeAnchor::Due { at });
                }
                fields.insert("important".into(), g.rng.random_bool(0.3).into());
                fields.insert("urgent".into(), g.rng.random_bool(0.2).into());
                let status = *g.pick(&["next", "waiting", "someday", "done"]);
                fields.insert("gtd".into(), status.into());
            }
            "event" | "journal" | "person" => {
                meta.time = Some(TimeAnchor::Occurred {
                    date: g.flex_date(),
                });
            }
            "card" => {
                fields.insert("front".into(), corpus::short_title(&mut g.rng).into());
                fields.insert("review".into(), g.rng.random_bool(0.6).into());
            }
            "job_posting" => {
                meta.privacy = Privacy::Normal;
                fields.insert(
                    "company".into(),
                    g.pick(corpus::COMPANIES).to_string().into(),
                );
                fields.insert(
                    "status".into(),
                    g.pick(&["saved", "applied", "interview", "offer", "rejected"])
                        .to_string()
                        .into(),
                );
                fields.insert("salary".into(), g.rng.random_range(1500..4500).into());
            }
            "article" => {
                meta.source = SourceInfo {
                    origin: *g.pick(&[
                        SourceOrigin::Me,
                        SourceOrigin::AiSearch,
                        SourceOrigin::Import,
                    ]),
                    needs_check: g.rng.random_bool(0.1),
                    conflict: g.rng.random_bool(0.05),
                    recheck_on: None,
                    refs: vec![format!(
                        "https://example.org/{}",
                        g.rng.random_range(0..100_000)
                    )],
                };
            }
            _ => {}
        }

        let body = g.body();
        items.push(GenItem {
            meta,
            fields,
            body,
            links: Vec::new(),
        });
    }

    // Links point to earlier items only, like real notes referencing older ones.
    for i in 1..items.len() {
        let expected = cfg.links_per_item;
        let mut n = expected.floor() as usize;
        if g.rng.random_bool(expected.fract().clamp(0.0, 1.0)) {
            n += 1;
        }
        for _ in 0..n {
            let target = items[g.rng.random_range(0..i)].meta.id;
            if !items[i].links.contains(&target) {
                items[i].links.push(target);
            }
        }
    }

    GenLibrary {
        seed: cfg.seed,
        containers,
        items,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_seed_same_output() {
        let a = generate(&GenConfig::new(42, 500));
        let b = generate(&GenConfig::new(42, 500));
        assert_eq!(
            serde_json::to_string(&a).unwrap(),
            serde_json::to_string(&b).unwrap()
        );
        let c = generate(&GenConfig::new(43, 500));
        assert_ne!(a.items[0].meta.id, c.items[0].meta.id);
    }

    #[test]
    fn covers_scripts_privacy_levels_and_dates() {
        let v = generate(&GenConfig::new(7, 2000));
        let bodies: String = v.items.iter().map(|i| i.body.as_str()).collect();
        assert!(
            bodies
                .chars()
                .any(|c| ('\u{17000}'..='\u{187F7}').contains(&c)),
            "Tangut"
        );
        assert!(bodies.contains('é') || bodies.contains('è'), "accents");
        assert!(
            bodies.contains('們') || bodies.contains('這'),
            "Traditional Chinese"
        );
        assert!(
            bodies.contains('们') || bodies.contains('这'),
            "Simplified Chinese"
        );
        for p in [
            Privacy::Normal,
            Privacy::Sensitive,
            Privacy::Private,
            Privacy::Confidential,
        ] {
            assert!(v.items.iter().any(|i| i.meta.privacy == p), "{p:?}");
        }
        let dates: Vec<&FlexDate> = v
            .items
            .iter()
            .filter_map(|i| match &i.meta.time {
                Some(TimeAnchor::Occurred { date }) => Some(date),
                _ => None,
            })
            .collect();
        assert!(dates.iter().any(|d| d.year < 0), "BCE");
        assert!(dates.iter().any(|d| d.approximate), "circa");
        assert!(dates.iter().any(|d| d.until.is_some()), "spans");
        assert!(dates.iter().all(|d| d.validate().is_ok()));
    }

    #[test]
    fn ids_are_unique_and_ordered_and_links_valid() {
        let v = generate(&GenConfig::new(1, 3000));
        let ids: Vec<ItemId> = v.items.iter().map(|i| i.meta.id).collect();
        assert!(ids.windows(2).all(|w| w[0] < w[1]));
        let set: std::collections::BTreeSet<_> = ids.iter().collect();
        for item in &v.items {
            assert!(item.links.iter().all(|l| set.contains(l)));
        }
        // Structure is a forest: parents are domains created earlier.
        for (i, c) in v.containers.iter().enumerate() {
            if let Some(p) = c.parent {
                let parent = v.containers[..i].iter().find(|x| x.meta.id == p).unwrap();
                assert!(!parent.is_project);
            }
        }
    }
}
