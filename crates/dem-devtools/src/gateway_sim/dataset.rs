//! The simulator's in-memory dataset: items at all four privacy levels, links
//! between levels, and canary strings planted in every non-normal item.
//!
//! Canaries get a fresh random suffix per run, so a canary in a response can only
//! come from the item it was planted in. They are placed in the title, body and
//! tags, so a leak through any field is caught.

use std::hash::{BuildHasher, RandomState};
use std::time::{SystemTime, UNIX_EPOCH};

use dem_model::Privacy;
use serde::Serialize;

pub const LEVELS: [Privacy; 4] = [
    Privacy::Normal,
    Privacy::Sensitive,
    Privacy::Private,
    Privacy::Confidential,
];

/// Lowercase name of a level, as used in reports and scenario files.
pub fn level_name(level: Privacy) -> &'static str {
    match level {
        Privacy::Normal => "normal",
        Privacy::Sensitive => "sensitive",
        Privacy::Private => "private",
        Privacy::Confidential => "confidential",
    }
}

/// The expected visibility, written out independently of the code under test
/// (`docs/format-spec.md` section 15).
pub fn expected_visible(level: Privacy, authorized: bool) -> bool {
    match level {
        Privacy::Normal => true,
        Privacy::Sensitive => authorized,
        Privacy::Private | Privacy::Confidential => false,
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SimItem {
    pub id: String,
    pub title: String,
    pub body: String,
    pub tags: Vec<String>,
    pub privacy: Privacy,
    /// Outgoing links (item ids).
    pub links: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Canaries {
    /// In private items: must never appear.
    pub private: String,
    /// In confidential items: must never appear.
    pub confidential: String,
    /// In sensitive items: may appear only in authorized sessions.
    pub sensitive: String,
}

impl Canaries {
    pub fn generate() -> Self {
        Self {
            private: format!("CANARY_PRIVATE_{}", random_hex(6)),
            confidential: format!("CANARY_CONFIDENTIAL_{}", random_hex(6)),
            sensitive: format!("MARKER_SENSITIVE_{}", random_hex(6)),
        }
    }

    /// The canary planted at `level`, if any.
    pub fn for_level(&self, level: Privacy) -> Option<&str> {
        match level {
            Privacy::Normal => None,
            Privacy::Sensitive => Some(&self.sensitive),
            Privacy::Private => Some(&self.private),
            Privacy::Confidential => Some(&self.confidential),
        }
    }
}

/// Random hex string of `bytes` bytes, from the standard library's randomly
/// seeded hasher (canaries need uniqueness, not cryptographic strength).
fn random_hex(bytes: usize) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let mut out = String::new();
    let mut round: u128 = 0;
    while out.len() < bytes * 2 {
        let v = RandomState::new().hash_one(nanos ^ round);
        out.push_str(&format!("{v:016x}"));
        round += 1;
    }
    out.truncate(bytes * 2);
    out
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Dataset {
    pub canaries: Canaries,
    pub items: Vec<SimItem>,
}

/// Item id that does not exist in the dataset; hidden items must look exactly like it.
pub const MISSING_ID: &str = "x-404";

/// Item whose links point at one item of every level.
pub const HUB_ID: &str = "n-001";

impl Dataset {
    /// The reference dataset with fresh canaries.
    pub fn reference() -> Self {
        Self::with_canaries(Canaries::generate())
    }

    pub fn with_canaries(c: Canaries) -> Self {
        let item =
            |id: &str, title: String, body: String, tags: &[&str], privacy, links: &[&str]| {
                SimItem {
                    id: id.to_string(),
                    title,
                    body,
                    tags: tags.iter().map(|t| t.to_string()).collect(),
                    privacy,
                    links: links.iter().map(|l| l.to_string()).collect(),
                }
            };
        let (s, p, k) = (&c.sensitive, &c.private, &c.confidential);
        let items = vec![
            item(
                "n-001",
                "Sourdough bread notes".into(),
                "Feed the starter 12 hours before baking. Hydration 75 percent.".into(),
                &["cooking", "bread"],
                Privacy::Normal,
                &["n-002", "s-001", "p-001", "c-001"],
            ),
            item(
                "n-002",
                "Rust ownership summary".into(),
                "Each value has one owner; many shared or one mutable borrow. kwnormal".into(),
                &["rust", "learning"],
                Privacy::Normal,
                &[],
            ),
            item(
                "n-003",
                "Weekly review checklist".into(),
                "Empty the inbox, review projects. Bread baking on Sunday.".into(),
                &["gtd"],
                Privacy::Normal,
                &[],
            ),
            item(
                "s-001",
                format!("Health check results {s}"),
                format!("Blood pressure slightly high; less salt in bread. kwsensitive {s}"),
                &["health", "bread", s],
                Privacy::Sensitive,
                &["n-003"],
            ),
            item(
                "s-002",
                format!("Salary negotiation notes {s}"),
                format!("Target range discussed with manager. {s}"),
                &["career", s],
                Privacy::Sensitive,
                &[],
            ),
            item(
                "p-001",
                format!("Diary {p}"),
                format!("Private diary entry about baking bread with family. kwprivate {p}"),
                &["diary", "bread", p],
                Privacy::Private,
                &["n-002"],
            ),
            item(
                "p-002",
                format!("Private project ideas {p}"),
                format!("A Rust side project I do not want to share. {p}"),
                &["ideas", "rust", p],
                Privacy::Private,
                &[],
            ),
            item(
                "c-001",
                format!("Bank recovery codes {k}"),
                format!("Recovery codes (fake), kept next to the bread recipe. kwconfidential {k}"),
                &["finance", "bread", k],
                Privacy::Confidential,
                &[],
            ),
            item(
                "c-002",
                format!("Passport notes {k}"),
                format!("Passport number placeholder (fake). Rust. {k}"),
                &["identity", k],
                Privacy::Confidential,
                &["n-003"],
            ),
        ];
        Self { canaries: c, items }
    }

    pub fn item(&self, id: &str) -> Option<&SimItem> {
        self.items.iter().find(|i| i.id == id)
    }

    /// The item the matrix probes for `level` (linked from [`HUB_ID`]).
    pub fn target(level: Privacy) -> &'static str {
        match level {
            Privacy::Normal => "n-002",
            Privacy::Sensitive => "s-001",
            Privacy::Private => "p-001",
            Privacy::Confidential => "c-001",
        }
    }

    /// A search keyword matching exactly one item of `level`.
    pub fn keyword(level: Privacy) -> &'static str {
        match level {
            Privacy::Normal => "kwnormal",
            Privacy::Sensitive => "kwsensitive",
            Privacy::Private => "kwprivate",
            Privacy::Confidential => "kwconfidential",
        }
    }

    /// Strings that must not appear in any response of a session with the given
    /// authorization: canaries and ids of every item the session may not see.
    pub fn forbidden_tokens(&self, authorized: bool) -> Vec<String> {
        let mut out = Vec::new();
        for level in LEVELS {
            if expected_visible(level, authorized) {
                continue;
            }
            if let Some(c) = self.canaries.for_level(level) {
                out.push(c.to_string());
            }
            out.extend(
                self.items
                    .iter()
                    .filter(|i| i.privacy == level)
                    .map(|i| i.id.clone()),
            );
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canaries_differ_between_runs() {
        let (a, b) = (Canaries::generate(), Canaries::generate());
        assert_ne!(a.private, b.private);
        assert_eq!(a.private.len(), "CANARY_PRIVATE_".len() + 12);
    }

    #[test]
    fn every_level_has_a_target_linked_from_the_hub() {
        let d = Dataset::reference();
        let hub = d.item(HUB_ID).unwrap();
        for level in LEVELS {
            let t = d.item(Dataset::target(level)).unwrap();
            assert_eq!(t.privacy, level);
            assert!(hub.links.contains(&t.id));
            assert!(t.body.contains(Dataset::keyword(level)));
            if let Some(c) = d.canaries.for_level(level) {
                assert!(t.title.contains(c) && t.body.contains(c));
            }
        }
        assert!(d.item(MISSING_ID).is_none());
    }

    #[test]
    fn forbidden_tokens_follow_authorization() {
        let d = Dataset::reference();
        let unauth = d.forbidden_tokens(false);
        let auth = d.forbidden_tokens(true);
        assert!(unauth.contains(&d.canaries.sensitive) && unauth.contains(&"s-001".into()));
        assert!(!auth.contains(&d.canaries.sensitive) && !auth.contains(&"s-001".into()));
        for t in [&d.canaries.private, &d.canaries.confidential] {
            assert!(unauth.contains(t) && auth.contains(t));
        }
        assert!(!unauth.iter().any(|t| t.starts_with("n-")));
    }
}
