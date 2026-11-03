//! Safe tokenizer core. No FFI here: `fts5.rs` adapts this to SQLite.
//!
//! Rules
//! * Ideographic scripts (Han, Tangut, Khitan, Nushu, kana, Hangul):
//!   - document mode: every character is a unigram at its own position; the
//!     bigram of each adjacent pair is emitted *colocated* with the first
//!     character (same position), so a phrase of consecutive bigrams matches;
//!   - query mode: a run of one character yields that unigram; a longer run
//!     yields its bigrams at consecutive positions followed by the unigram of
//!     the last character (FTS5 treats the tokens of one query string as a
//!     phrase). The trailing unigram is needed for highlight()/snippet():
//!     FTS5's highlighter ignores colocated tokens, so a phrase that ended on
//!     a bigram would be highlighted only up to the start of its last bigram.
//!     See `QueryStyle` for the alternatives measured in the spike.
//! * Other letters/digits: words (runs of alphanumerics + combining marks),
//!   folded with NFKD + mark stripping + case folding.
//! * Han characters are folded Traditional -> Simplified before indexing.

use std::sync::atomic::{AtomicU8, Ordering};

use crate::fold::{HanFold, fold_word};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Document,
    Query,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Class {
    Ideo,
    Word,
    Sep,
}

/// Ideographic (and similar syllabic East Asian) code points, tokenized per
/// character. Includes the supplementary planes (Tangut is U+17000..).
pub fn is_ideographic(c: char) -> bool {
    matches!(c as u32,
        0x3005 | 0x3007                     // 々 〇
        | 0x3040..=0x30FF                   // Hiragana, Katakana
        | 0x3400..=0x4DBF                   // CJK Ext A
        | 0x4E00..=0x9FFF                   // CJK Unified
        | 0xAC00..=0xD7AF                   // Hangul syllables
        | 0xF900..=0xFAFF                   // CJK Compatibility Ideographs
        | 0x16FE0..=0x16FFF                 // Ideographic symbols (incl. Tangut iteration mark)
        | 0x17000..=0x187FF                 // Tangut
        | 0x18800..=0x18AFF                 // Tangut Components
        | 0x18B00..=0x18CFF                 // Khitan Small Script
        | 0x18D00..=0x18D7F                 // Tangut Supplement
        | 0x1B170..=0x1B2FF                 // Nushu
        | 0x20000..=0x3FFFF                 // CJK Ext B..J, Compat Supplement
    )
}

fn classify(c: char) -> Class {
    if is_ideographic(c) {
        Class::Ideo
    } else if c.is_alphanumeric() || unicode_normalization::char::is_combining_mark(c) {
        Class::Word
    } else {
        Class::Sep
    }
}

/// A sink for tokens: `(token, byte_start, byte_end, colocated)`.
/// Returning `Err` stops tokenization (SQLite error codes pass through).
pub trait TokenSink {
    fn token(&mut self, tok: &str, start: usize, end: usize, colocated: bool) -> Result<(), i32>;
}

impl<F: FnMut(&str, usize, usize, bool) -> Result<(), i32>> TokenSink for F {
    fn token(&mut self, tok: &str, start: usize, end: usize, colocated: bool) -> Result<(), i32> {
        self(tok, start, end, colocated)
    }
}

/// How a multi-character ideographic run is turned into query tokens.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum QueryStyle {
    /// Bigrams + trailing unigram (default): exact highlight spans.
    BigramsTail = 0,
    /// Bigrams only: highlight() drops the last character of the match.
    BigramsOnly = 1,
    /// Phrase of unigrams: same matches, no bigrams needed at query time.
    Unigrams = 2,
}

#[derive(Debug)]
pub struct Tokenizer {
    fold: HanFold,
    query_style: AtomicU8,
    /// Spike-only: `false` indexes unigrams only (to measure what the
    /// bigrams cost in size and gain in speed). Queries must then use
    /// `QueryStyle::Unigrams`.
    index_bigrams: bool,
}

impl Tokenizer {
    pub fn new(fold: HanFold) -> Self {
        Self {
            fold,
            query_style: AtomicU8::new(QueryStyle::BigramsTail as u8),
            index_bigrams: true,
        }
    }

    pub fn unigram_index_only(fold: HanFold) -> Self {
        Self {
            fold,
            query_style: AtomicU8::new(QueryStyle::Unigrams as u8),
            index_bigrams: false,
        }
    }

    /// Spike-only switch for benchmarking query styles on one index.
    pub fn set_query_style(&self, style: QueryStyle) {
        self.query_style.store(style as u8, Ordering::Relaxed);
    }

    pub fn query_style(&self) -> QueryStyle {
        match self.query_style.load(Ordering::Relaxed) {
            1 => QueryStyle::BigramsOnly,
            2 => QueryStyle::Unigrams,
            _ => QueryStyle::BigramsTail,
        }
    }

    pub fn fold(&self) -> &HanFold {
        &self.fold
    }

    /// Tokenize `text`; offsets are byte offsets into `text`, plus `base`.
    pub fn tokenize(
        &self,
        text: &str,
        base: usize,
        mode: Mode,
        sink: &mut dyn TokenSink,
    ) -> Result<(), i32> {
        let mut word_buf = String::new();
        let mut tok_buf = String::new();
        // Current ideographic run: (folded char, start, end).
        let mut run: Vec<(char, usize, usize)> = Vec::new();
        let mut word_start: Option<usize> = None;

        let mut iter = text.char_indices().peekable();
        while let Some((i, c)) = iter.next() {
            let end = iter.peek().map_or(text.len(), |(j, _)| *j);
            let class = classify(c);
            if class != Class::Word
                && let Some(ws) = word_start.take()
            {
                fold_word(&text[ws..i], &mut word_buf);
                if !word_buf.is_empty() {
                    sink.token(&word_buf, base + ws, base + i, false)?;
                }
            }
            if class != Class::Ideo && !run.is_empty() {
                self.flush_run(&run, base, mode, &mut tok_buf, sink)?;
                run.clear();
            }
            match class {
                Class::Ideo => run.push((self.fold.fold(c), i, end)),
                Class::Word => {
                    if word_start.is_none() {
                        word_start = Some(i);
                    }
                }
                Class::Sep => {}
            }
        }
        if let Some(ws) = word_start {
            fold_word(&text[ws..], &mut word_buf);
            if !word_buf.is_empty() {
                sink.token(&word_buf, base + ws, base + text.len(), false)?;
            }
        }
        if !run.is_empty() {
            self.flush_run(&run, base, mode, &mut tok_buf, sink)?;
        }
        Ok(())
    }

    fn flush_run(
        &self,
        run: &[(char, usize, usize)],
        base: usize,
        mode: Mode,
        buf: &mut String,
        sink: &mut dyn TokenSink,
    ) -> Result<(), i32> {
        match mode {
            Mode::Document => {
                for (k, &(c, s, e)) in run.iter().enumerate() {
                    buf.clear();
                    buf.push(c);
                    sink.token(buf, base + s, base + e, false)?;
                    if !self.index_bigrams {
                        continue;
                    }
                    if let Some(&(c2, _, e2)) = run.get(k + 1) {
                        buf.push(c2);
                        sink.token(buf, base + s, base + e2, true)?;
                    }
                }
            }
            Mode::Query => {
                let style = self.query_style();
                if run.len() == 1 || style == QueryStyle::Unigrams {
                    for &(c, s, e) in run {
                        buf.clear();
                        buf.push(c);
                        sink.token(buf, base + s, base + e, false)?;
                    }
                } else {
                    for w in run.windows(2) {
                        buf.clear();
                        buf.push(w[0].0);
                        buf.push(w[1].0);
                        sink.token(buf, base + w[0].1, base + w[1].2, false)?;
                    }
                    if style == QueryStyle::BigramsTail
                        && let Some(&(c, s, e)) = run.last()
                    {
                        buf.clear();
                        buf.push(c);
                        sink.token(buf, base + s, base + e, false)?;
                    }
                }
            }
        }
        Ok(())
    }

    /// Convenience for tests and tools: collect tokens.
    pub fn collect(&self, text: &str, mode: Mode) -> Vec<(String, usize, usize, bool)> {
        let mut out = Vec::new();
        let mut sink = |t: &str, s: usize, e: usize, col: bool| {
            out.push((t.to_owned(), s, e, col));
            Ok(())
        };
        // The closure never fails.
        let _ = self.tokenize(text, 0, mode, &mut sink);
        out
    }
}

/// Build a safe FTS5 MATCH expression from free user input: each
/// whitespace-separated term becomes a quoted string (implicit AND), so no
/// FTS5 query syntax can be injected.
pub fn user_query_to_match(input: &str) -> Option<String> {
    let terms: Vec<String> = input
        .split_whitespace()
        .map(|t| format!("\"{}\"", t.replace('"', "\"\"")))
        .collect();
    if terms.is_empty() {
        None
    } else {
        Some(terms.join(" "))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tk() -> Tokenizer {
        Tokenizer::new(HanFold::from_opencc())
    }

    #[test]
    fn latin_folding() {
        let t = tk();
        let toks: Vec<String> = t
            .collect("Café ÉCOLE Straße naïve ﬁne", Mode::Document)
            .into_iter()
            .map(|x| x.0)
            .collect();
        assert_eq!(toks, ["cafe", "ecole", "strasse", "naive", "fine"]);
    }

    #[test]
    fn cjk_document_and_query() {
        let t = tk();
        let d = t.collect("頭髮a", Mode::Document);
        assert_eq!(
            d,
            vec![
                ("头".into(), 0, 3, false),
                ("头发".into(), 0, 6, true),
                ("发".into(), 3, 6, false),
                ("a".into(), 6, 7, false),
            ]
        );
        let q = t.collect("中华人民", Mode::Query);
        let q: Vec<_> = q.into_iter().map(|x| x.0).collect();
        assert_eq!(q, ["中华", "华人", "人民", "民"]);
        let q1 = t.collect("髮", Mode::Query);
        assert_eq!(q1, vec![("发".into(), 0, 3, false)]);
    }

    #[test]
    fn tangut_supplementary_plane() {
        let t = tk();
        // U+17000 U+17001 U+17002: 4-byte UTF-8 each.
        let s = "\u{17000}\u{17001}\u{17002}";
        let d = t.collect(s, Mode::Document);
        assert_eq!(d.len(), 5);
        assert_eq!(d[1], ("\u{17000}\u{17001}".into(), 0, 8, true));
        let q = t.collect("\u{17001}\u{17002}", Mode::Query);
        assert_eq!(
            q,
            vec![
                ("\u{17001}\u{17002}".into(), 0, 8, false),
                ("\u{17002}".into(), 4, 8, false)
            ]
        );
    }

    #[test]
    fn one_to_many_fold() {
        let f = HanFold::from_opencc();
        for (t, s) in [
            ("發", '发'),
            ("髮", '发'),
            ("後", '后'),
            ("乾", '干'),
            ("幹", '干'),
            ("衞", '卫'),
            ("裡", '里'),
            ("裏", '里'),
        ] {
            assert_eq!(f.fold(t.chars().next().unwrap_or(' ')), s, "{t}");
        }
        // TW 著 (= simplified 着) folds to 着; 著名 then also indexes as 着名,
        // a harmless over-merge that makes TW 看著 match 看着.
        assert_eq!(f.fold('著'), '着');
        // Simplified characters are fixed points.
        for c in "发后干里面着".chars() {
            assert_eq!(f.fold(c), c);
        }
    }

    #[test]
    fn match_expression_is_quoted() {
        assert_eq!(
            user_query_to_match(r#"a "b OR c*"#).as_deref(),
            Some(r#""a" """b" "OR" "c*""#)
        );
        assert_eq!(user_query_to_match("   "), None);
    }
}
