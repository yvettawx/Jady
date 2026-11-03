//! Small built-in text corpora. Simplified and Traditional lists contain the same
//! sentences in both scripts, so search tests can check cross-script matching.

use std::ops::Range;

use rand::Rng;

pub const ZH_HANS: &[&str] = &[
    "我们今天复习了数据库的事务隔离级别。",
    "这个操作系统的调度器需要重新设计。",
    "头发长了，后天去理发。",
    "关系代数是查询优化的基础。",
    "他在历史小说里设定了一个架空的王朝。",
    "学习法语的时候要注意动词变位。",
    "这本书的后记写得很好。",
    "面试前一天要把简历再检查一遍。",
    "干净的代码比聪明的代码更重要。",
    "西夏文是一种已经消亡的文字。",
    "记忆规律决定了复习的间隔。",
    "我们讨论了内存管理和虚拟地址。",
];

pub const ZH_HANT: &[&str] = &[
    "我們今天複習了資料庫的事務隔離級別。",
    "這個作業系統的調度器需要重新設計。",
    "頭髮長了，後天去理髮。",
    "關係代數是查詢優化的基礎。",
    "他在歷史小說裡設定了一個架空的王朝。",
    "學習法語的時候要注意動詞變位。",
    "這本書的後記寫得很好。",
    "面試前一天要把簡歷再檢查一遍。",
    "乾淨的程式碼比聰明的程式碼更重要。",
    "西夏文是一種已經消亡的文字。",
];

pub const FRENCH: &[&str] = &[
    "Le café était déjà froid quand elle est arrivée.",
    "Nous avons révisé les verbes irréguliers à l'école.",
    "La fenêtre donne sur un jardin très agréable.",
    "Il préfère étudier le soir, après le dîner.",
    "Où est la bibliothèque la plus proche ?",
    "Ça dépend de la météo de demain.",
];

pub const ENGLISH: &[&str] = &[
    "The scheduler picks the next runnable thread.",
    "Spaced repetition beats cramming for long-term recall.",
    "Write the failing test first, then the fix.",
    "Transactions guarantee atomicity and isolation.",
    "The archive contains letters from the eighteenth century.",
];

pub const TAGS: &[&str] = &[
    "rust",
    "os",
    "database",
    "french",
    "history",
    "writing",
    "job",
    "reading",
    "法语",
    "数据库",
    "算法",
    "小说设定",
];

pub const COMPANIES: &[&str] = &[
    "Acme Robotics",
    "Nordlicht Labs",
    "Société Générale de Calcul",
    "青云科技",
    "Blue Harbor",
];

const TITLE_WORDS: &[&str] = &[
    "复习",
    "笔记",
    "设定",
    "调度",
    "事务",
    "動詞",
    "變位",
    "café",
    "été",
    "kernel",
    "memory",
    "plan",
    "西夏",
    "王朝",
    "面试",
    "reading",
    "Überblick",
    "naïve",
];

pub fn sentences(rng: &mut impl Rng, list: &[&str], count: Range<usize>) -> String {
    let n = rng.random_range(count);
    let mut out = String::new();
    for i in 0..n {
        if i > 0
            && list
                .first()
                .is_some_and(|s| s.is_ascii() || s.contains(' '))
        {
            out.push(' ');
        }
        out.push_str(list[rng.random_range(0..list.len())]);
    }
    out
}

/// Random Tangut ideographs (U+17000–U+187F7) in short space-separated runs.
pub fn tangut(rng: &mut impl Rng, len: Range<usize>) -> String {
    let n = rng.random_range(len);
    let mut out = String::new();
    for i in 0..n {
        if i > 0 && i % 6 == 0 {
            out.push(' ');
        }
        let cp = rng.random_range(0x17000u32..=0x187F7);
        out.push(char::from_u32(cp).unwrap_or('\u{17000}'));
    }
    out
}

pub fn short_title(rng: &mut impl Rng) -> String {
    let n = rng.random_range(1..4);
    (0..n)
        .map(|_| TITLE_WORDS[rng.random_range(0..TITLE_WORDS.len())])
        .collect::<Vec<_>>()
        .join(" ")
}
