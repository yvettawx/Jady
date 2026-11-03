//! Dependency layering rules from `docs/03-modules.md` M0, plus the devtools rule
//! from the P0 plan (Q2). The rules are data so they can be unit-tested against
//! synthetic dependency graphs without invoking cargo.

use std::collections::BTreeMap;

/// One direct dependency edge of a workspace package.
#[derive(Debug, Clone)]
pub struct Edge {
    pub from: String,
    pub to: String,
    /// "normal", "dev" or "build".
    pub kind: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Violation {
    pub from: String,
    pub to: String,
    pub rule: String,
}

impl std::fmt::Display for Violation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} -> {}: {}", self.from, self.to, self.rule)
    }
}

/// Internal crates each workspace member may depend on. A member missing from this
/// table is itself a violation, so new crates must be given an explicit rule.
fn internal_rules() -> BTreeMap<&'static str, &'static [&'static str]> {
    let mut m: BTreeMap<&'static str, &'static [&'static str]> = BTreeMap::new();
    m.insert("dem-model", &[]);
    m.insert("dem-crypto", &[]);
    m.insert("dem-diag", &[]);
    m.insert("dem-store", &["dem-model", "dem-crypto"]);
    m.insert("dem-index", &["dem-model", "dem-crypto", "dem-store"]);
    m.insert("dem-io", &["dem-model"]);
    m.insert("dem-learn", &["dem-model"]);
    m.insert("dem-ai-provider", &["dem-model"]);
    m.insert("dem-sync", &["dem-model", "dem-crypto", "dem-store"]);
    // Stores and hands out ciphertext; has no keys and cannot read any of it.
    m.insert("dem-sync-server", &["dem-crypto", "dem-sync"]);
    // Runs code-exercise answers; knows nothing of the library.
    m.insert("dem-sandbox", &[]);
    // Drives the dedicated browser; knows nothing of the library.
    m.insert("dem-browser", &[]);
    m.insert(
        "dem-core",
        &[
            "dem-model",
            "dem-crypto",
            "dem-store",
            "dem-index",
            "dem-io",
            "dem-learn",
            "dem-ai-provider",
            "dem-sync",
        ],
    );
    // The gateway sees data only through dem-core's restricted view.
    m.insert("dem-ai-gateway", &["dem-core", "dem-model"]);
    // UI and CLI reach data only through dem-core.
    m.insert("dem-cli", &["dem-core", "dem-model", "dem-diag"]);
    m.insert(
        "dem-desktop",
        // The provider crate is where the app says which AI implementations exist; everything else
        // sees only its trait.
        &[
            "dem-core",
            "dem-model",
            "dem-diag",
            "dem-ai-gateway",
            "dem-ai-provider",
            "dem-sandbox",
            "dem-browser",
            "dem-sync",
        ],
    );
    // Devtools may bypass dem-core, but never dem-store/dem-crypto (see EXTERNAL_RULES).
    m.insert(
        "dem-devtools",
        &[
            "dem-model",
            "dem-crypto",
            "dem-store",
            "dem-index",
            "dem-core",
            "dem-io",
            "dem-diag",
            "dem-ai-gateway",
        ],
    );
    m.insert("dem-testkit", &["dem-model", "dem-crypto", "dem-store"]);
    m.insert("xtask", &[]);
    m
}

/// Crates that shipped code may only use as dev-dependencies (devtools never ships).
const TEST_ONLY: &[&str] = &["dem-testkit"];

/// External crates that implement storage formats or cryptography. Only the named
/// owners may depend on them directly; everyone else goes through the owner, so the
/// format and crypto code exists exactly once.
const EXTERNAL_RULES: &[(&str, &[&str], &str)] = &[
    (
        "crypto",
        &["dem-crypto"],
        "cryptography is only used through dem-crypto",
    ),
    (
        "crdt",
        &["dem-store"],
        "CRDT documents are only read and written by dem-store",
    ),
    (
        "sqlite",
        &["dem-index"],
        "SQLite is only used through dem-index",
    ),
];

fn external_family(name: &str) -> Option<&'static str> {
    const CRYPTO: &[&str] = &[
        "chacha20poly1305",
        "chacha20",
        "poly1305",
        "aes-gcm",
        "aead",
        "argon2",
        "scrypt",
        "pbkdf2",
        "hkdf",
        "hmac",
        "blake2",
        "blake3",
        "sha2",
        "ring",
        "aws-lc-rs",
        "openssl",
        "sodiumoxide",
        "libsodium-sys",
        "dryoc",
        "orion",
        "age",
    ];
    const CRDT: &[&str] = &["loro", "loro-internal", "automerge", "yrs"];
    const SQLITE: &[&str] = &["rusqlite", "libsqlite3-sys", "sqlx"];
    if CRYPTO.contains(&name) {
        Some("crypto")
    } else if CRDT.contains(&name) {
        Some("crdt")
    } else if SQLITE.contains(&name) {
        Some("sqlite")
    } else {
        None
    }
}

/// Checks every direct edge (all dependency kinds) of the given workspace members.
pub fn check(members: &[String], edges: &[Edge]) -> Vec<Violation> {
    let rules = internal_rules();
    let mut out = Vec::new();

    for m in members {
        if !rules.contains_key(m.as_str()) {
            out.push(Violation {
                from: m.clone(),
                to: "*".into(),
                rule: "workspace member has no layer rule in xtask/src/layers.rs".into(),
            });
        }
    }

    for e in edges {
        let is_internal = members.iter().any(|m| m == &e.to);
        if TEST_ONLY.contains(&e.to.as_str()) && e.kind != "dev" && e.from != "dem-devtools" {
            out.push(Violation {
                from: e.from.clone(),
                to: e.to.clone(),
                rule: format!("{} is test-only; use it as a dev-dependency", e.to),
            });
            continue;
        }
        if TEST_ONLY.contains(&e.to.as_str()) {
            continue;
        }
        if is_internal {
            let allowed = rules.get(e.from.as_str()).copied().unwrap_or(&[]);
            if !allowed.contains(&e.to.as_str()) {
                out.push(Violation {
                    from: e.from.clone(),
                    to: e.to.clone(),
                    rule: format!(
                        "{} may not depend on {} ({} dependency)",
                        e.from, e.to, e.kind
                    ),
                });
            }
            continue;
        }
        if let Some(family) = external_family(&e.to)
            && let Some((_, owners, why)) = EXTERNAL_RULES.iter().find(|(f, _, _)| *f == family)
            && !owners.contains(&e.from.as_str())
        {
            out.push(Violation {
                from: e.from.clone(),
                to: e.to.clone(),
                rule: format!("{why} ({} dependency)", e.kind),
            });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn members() -> Vec<String> {
        internal_rules().keys().map(|s| s.to_string()).collect()
    }

    fn edge(from: &str, to: &str) -> Edge {
        Edge {
            from: from.into(),
            to: to.into(),
            kind: "normal".into(),
        }
    }

    #[test]
    fn allowed_graph_passes() {
        let edges = vec![
            edge("dem-store", "dem-model"),
            edge("dem-store", "dem-crypto"),
            edge("dem-store", "loro"),
            edge("dem-crypto", "chacha20poly1305"),
            edge("dem-index", "rusqlite"),
            edge("dem-ai-gateway", "dem-core"),
            edge("dem-devtools", "dem-store"),
            edge("dem-devtools", "serde"),
        ];
        assert!(check(&members(), &edges).is_empty());
    }

    #[test]
    fn gateway_cannot_reach_store() {
        let v = check(&members(), &[edge("dem-ai-gateway", "dem-store")]);
        assert_eq!(v.len(), 1);
        assert!(v[0].rule.contains("may not depend on dem-store"));
    }

    #[test]
    fn desktop_cannot_reach_index() {
        let v = check(&members(), &[edge("dem-desktop", "dem-index")]);
        assert_eq!(v.len(), 1);
    }

    #[test]
    fn model_has_no_internal_dependencies() {
        let v = check(&members(), &[edge("dem-model", "dem-crypto")]);
        assert_eq!(v.len(), 1);
    }

    #[test]
    fn nothing_depends_on_devtools() {
        let v = check(&members(), &[edge("dem-core", "dem-devtools")]);
        assert_eq!(v.len(), 1);
    }

    #[test]
    fn devtools_cannot_use_crypto_or_crdt_directly() {
        let v = check(
            &members(),
            &[
                edge("dem-devtools", "chacha20poly1305"),
                edge("dem-devtools", "loro"),
                edge("dem-devtools", "rusqlite"),
            ],
        );
        assert_eq!(v.len(), 3);
        assert!(v[0].rule.contains("dem-crypto"));
        assert!(v[1].rule.contains("dem-store"));
        assert!(v[2].rule.contains("dem-index"));
    }

    #[test]
    fn dev_dependencies_are_checked_too() {
        let e = Edge {
            from: "dem-core".into(),
            to: "argon2".into(),
            kind: "dev".into(),
        };
        assert_eq!(check(&members(), &[e]).len(), 1);
    }

    #[test]
    fn testkit_is_dev_only_except_for_devtools() {
        let dev = Edge {
            from: "dem-store".into(),
            to: "dem-testkit".into(),
            kind: "dev".into(),
        };
        assert!(check(&members(), &[dev]).is_empty());
        assert!(check(&members(), &[edge("dem-devtools", "dem-testkit")]).is_empty());
        let v = check(&members(), &[edge("dem-core", "dem-testkit")]);
        assert_eq!(v.len(), 1);
        assert!(v[0].rule.contains("test-only"));
    }

    #[test]
    fn unknown_member_is_reported() {
        let mut m = members();
        m.push("dem-new".into());
        let v = check(&m, &[]);
        assert_eq!(v.len(), 1);
        assert!(v[0].rule.contains("no layer rule"));
    }
}
