//! Character folding used by the tokenizer.
//!
//! * Han: a context-free, one-to-one Traditional -> Simplified character map,
//!   derived from the OpenCC 1.4.1 dictionaries vendored in `data/`. It is
//!   deliberately *character level*: phrase-level conversion depends on the
//!   surrounding text, so a single-character query could fold differently
//!   from the same character inside a document (see `docs/spikes/02-search.md`).
//! * Latin and other alphabetic scripts: NFKD, drop combining marks, full
//!   Unicode case folding.

use std::collections::{HashMap, HashSet};

use unicode_normalization::UnicodeNormalization;
use unicode_normalization::char::is_combining_mark;

const TS_CHARACTERS: &str = include_str!("../data/opencc-1.4.1/TSCharacters.txt");
const ST_CHARACTERS: &str = include_str!("../data/opencc-1.4.1/STCharacters.txt");
const HK_VARIANTS: &str = include_str!("../data/opencc-1.4.1/HKVariants.txt");
const TW_VARIANTS: &str = include_str!("../data/opencc-1.4.1/TWVariants.txt");

/// Version tag of the fold table. Changing the table changes the index
/// contents, so this would be part of the index's tokenizer version.
pub const FOLD_TABLE_VERSION: &str = "opencc-1.4.1/ts-chars+hk-tw-variants-rev/v1";

/// Parse an OpenCC text dictionary: `key<TAB>value [value...]`.
fn parse_dict(text: &str) -> impl Iterator<Item = (&str, Vec<&str>)> {
    text.lines()
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .filter_map(|l| {
            let (k, v) = l.split_once('\t')?;
            Some((k, v.split(' ').filter(|s| !s.is_empty()).collect()))
        })
}

fn single_char(s: &str) -> Option<char> {
    let mut it = s.chars();
    let c = it.next()?;
    if it.next().is_none() { Some(c) } else { None }
}

#[derive(Debug, Clone)]
pub struct FoldStats {
    pub ts_entries: usize,
    pub variant_entries: usize,
    pub variant_skipped: usize,
}

/// Context-free character fold table.
#[derive(Debug, Clone)]
pub struct HanFold {
    map: HashMap<char, char>,
    pub stats: FoldStats,
}

impl HanFold {
    pub fn from_opencc() -> Self {
        let mut map: HashMap<char, char> = HashMap::new();
        let mut simplified_chars: HashSet<char> = HashSet::new();

        let mut ts_entries = 0;
        for (k, vals) in parse_dict(TS_CHARACTERS) {
            let (Some(k), Some(v)) = (single_char(k), vals.first().and_then(|v| single_char(v)))
            else {
                continue;
            };
            for v in &vals {
                if let Some(c) = single_char(v) {
                    simplified_chars.insert(c);
                }
            }
            if k != v {
                map.insert(k, v);
                ts_entries += 1;
            }
        }
        for (k, _) in parse_dict(ST_CHARACTERS) {
            if let Some(c) = single_char(k) {
                simplified_chars.insert(c);
            }
        }

        // Regional variants (HK/TW) reversed: variant -> OpenCC standard
        // traditional -> simplified. A variant that is itself a valid
        // simplified-script character (e.g. TW 著 for standard 着) is not
        // folded, because that would merge two distinct simplified characters.
        let mut variant_entries = 0;
        let mut variant_skipped = 0;
        for dict in [HK_VARIANTS, TW_VARIANTS] {
            for (std, vars) in parse_dict(dict) {
                let Some(std) = single_char(std) else {
                    continue;
                };
                let target = map.get(&std).copied().unwrap_or(std);
                for v in vars {
                    let Some(v) = single_char(v) else { continue };
                    if v == std || map.contains_key(&v) {
                        continue;
                    }
                    if simplified_chars.contains(&v) {
                        variant_skipped += 1;
                        continue;
                    }
                    map.insert(v, target);
                    variant_entries += 1;
                }
            }
        }

        Self {
            map,
            stats: FoldStats {
                ts_entries,
                variant_entries,
                variant_skipped,
            },
        }
    }

    /// Fold one ideographic character. CJK compatibility ideographs are first
    /// mapped to their unified form via NFKC (single-char result only).
    #[inline]
    pub fn fold(&self, c: char) -> char {
        let c = if is_compat_ideograph(c) {
            let mut it = std::iter::once(c).nfkc();
            match (it.next(), it.next()) {
                (Some(n), None) => n,
                _ => c,
            }
        } else {
            c
        };
        self.map.get(&c).copied().unwrap_or(c)
    }

    pub fn fold_str(&self, s: &str) -> String {
        s.chars().map(|c| self.fold(c)).collect()
    }

    pub fn len(&self) -> usize {
        self.map.len()
    }

    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }
}

fn is_compat_ideograph(c: char) -> bool {
    matches!(c as u32, 0xF900..=0xFAFF | 0x2F800..=0x2FA1F)
}

/// Normalize a Latin/alphabetic word: NFKD, strip combining marks, case fold.
/// Appends to `out` (cleared first) to avoid per-token allocation.
pub fn fold_word(word: &str, out: &mut String) {
    out.clear();
    if word.is_ascii() {
        out.push_str(word);
        out.make_ascii_lowercase();
        return;
    }
    let stripped: String = word.nfkd().filter(|c| !is_combining_mark(*c)).collect();
    if stripped.is_ascii() {
        out.push_str(&stripped);
        out.make_ascii_lowercase();
    } else {
        out.push_str(&caseless::default_case_fold_str(&stripped));
    }
}
