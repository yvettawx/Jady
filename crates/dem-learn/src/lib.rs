//! Spaced repetition (M7, PRD C1, C2): how sure the memory of a card is and when to see it again.
//! Pure numbers, no AI and no storage: the core replays the review log through this.
//!
//! The scheduler is FSRS-5 with its published default parameters. A review is a pure function of
//! the state before it, so the log alone is the truth and the state can always be rebuilt.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Rating {
    Again,
    Hard,
    Good,
    Easy,
}

impl Rating {
    fn grade(self) -> f64 {
        match self {
            Rating::Again => 1.0,
            Rating::Hard => 2.0,
            Rating::Good => 3.0,
            Rating::Easy => 4.0,
        }
    }
}

/// FSRS-5 defaults.
const W: [f64; 19] = [
    0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046, 1.54575, 0.1192, 1.01925,
    1.9395, 0.11, 0.29605, 2.2698, 0.2315, 2.9898, 0.51655, 0.6621,
];
const DECAY: f64 = -0.5;
const FACTOR: f64 = 19.0 / 81.0;
/// The share of cards you should still remember when they come back.
pub const DESIRED_RETENTION: f64 = 0.9;
const DAY_MS: f64 = 86_400_000.0;

/// What the log says about one card so far.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Memory {
    pub stability: f64,
    pub difficulty: f64,
    /// When it was last reviewed, in milliseconds.
    pub last: f64,
    /// When it comes back, in milliseconds.
    pub due: f64,
    pub reps: u32,
    pub lapses: u32,
    /// Sure of it and got it wrong (C2): comes first until the next right answer.
    pub overconfident: bool,
}

/// The chance of remembering after `elapsed_days`.
pub fn retrievability(stability: f64, elapsed_days: f64) -> f64 {
    (1.0 + FACTOR * elapsed_days.max(0.0) / stability).powf(DECAY)
}

fn interval_days(stability: f64) -> f64 {
    (stability / FACTOR * (DESIRED_RETENTION.powf(1.0 / DECAY) - 1.0)).max(1.0 / 1440.0)
}

fn initial_difficulty(rating: Rating) -> f64 {
    (W[4] - (W[5] * (rating.grade() - 1.0)).exp() + 1.0).clamp(1.0, 10.0)
}

fn next_difficulty(d: f64, rating: Rating) -> f64 {
    let delta = -W[6] * (rating.grade() - 3.0);
    let damped = d + delta * (10.0 - d) / 9.0;
    (W[7] * initial_difficulty(Rating::Easy) + (1.0 - W[7]) * damped).clamp(1.0, 10.0)
}

fn recall_stability(d: f64, s: f64, r: f64, rating: Rating) -> f64 {
    let hard = if rating == Rating::Hard { W[15] } else { 1.0 };
    let easy = if rating == Rating::Easy { W[16] } else { 1.0 };
    s * (1.0
        + W[8].exp() * (11.0 - d) * s.powf(-W[9]) * ((W[10] * (1.0 - r)).exp() - 1.0) * hard * easy)
}

fn forget_stability(d: f64, s: f64, r: f64) -> f64 {
    (W[11] * d.powf(-W[12]) * ((s + 1.0).powf(W[13]) - 1.0) * (W[14] * (1.0 - r)).exp()).min(s)
}

/// The state after one review. Answers on the same day count as short-term repetitions.
pub fn review(before: Option<&Memory>, rating: Rating, at_ms: f64, overconfident: bool) -> Memory {
    let (stability, difficulty, reps, lapses) = match before {
        None => (
            W[(rating.grade() as usize) - 1],
            initial_difficulty(rating),
            1,
            u32::from(rating == Rating::Again),
        ),
        Some(m) => {
            let elapsed = (at_ms - m.last) / DAY_MS;
            let r = retrievability(m.stability, elapsed);
            let d = next_difficulty(m.difficulty, rating);
            let s = if elapsed < 1.0 {
                m.stability * (W[17] * (rating.grade() - 3.0 + W[18])).exp()
            } else if rating == Rating::Again {
                forget_stability(m.difficulty, m.stability, r)
            } else {
                recall_stability(m.difficulty, m.stability, r, rating)
            };
            (
                s.max(0.01),
                d,
                m.reps + 1,
                m.lapses + u32::from(rating == Rating::Again),
            )
        }
    };
    let wait = match rating {
        // Forgotten: again soon, today.
        Rating::Again => 10.0 / 1440.0,
        _ => interval_days(stability),
    };
    Memory {
        stability,
        difficulty,
        last: at_ms,
        due: at_ms + wait * DAY_MS,
        reps,
        lapses,
        overconfident,
    }
}

/// How long until each rating would bring the card back, in days.
pub fn preview(before: Option<&Memory>, at_ms: f64) -> [f64; 4] {
    [Rating::Again, Rating::Hard, Rating::Good, Rating::Easy]
        .map(|r| (review(before, r, at_ms, false).due - at_ms) / DAY_MS)
}

/// A peek counts as 忘了 or 难 at best (M7).
pub fn after_peek(rating: Rating) -> Rating {
    match rating {
        Rating::Again => Rating::Again,
        _ => Rating::Hard,
    }
}

/// C2: sure beforehand (3 of 3) and wrong.
pub fn is_overconfident(confidence: Option<u8>, rating: Rating) -> bool {
    rating == Rating::Again && confidence.is_some_and(|c| c >= 3)
}

/// How well it is remembered right now.
pub fn mastery(m: &Memory, now_ms: f64) -> f64 {
    retrievability(m.stability, (now_ms - m.last) / DAY_MS)
}

/// 熟练程度 (M7), from the review record: decides which methods are offered.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Stage {
    New,
    Learning,
    Consolidating,
    Fluent,
}

pub fn stage(memories: &[Memory], now_ms: f64) -> Stage {
    if memories.is_empty() {
        return Stage::New;
    }
    let avg = memories.iter().map(|m| mastery(m, now_ms)).sum::<f64>() / memories.len() as f64;
    let stable = memories.iter().filter(|m| m.stability >= 21.0).count() as f64;
    if stable / memories.len() as f64 > 0.7 {
        Stage::Fluent
    } else if avg > 0.7 {
        Stage::Consolidating
    } else {
        Stage::Learning
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAY: f64 = DAY_MS;

    #[test]
    fn a_good_answer_waits_longer_each_time() {
        let a = review(None, Rating::Good, 0.0, false);
        assert!((a.stability - W[2]).abs() < 1e-9);
        let due = a.due;
        let b = review(Some(&a), Rating::Good, due, false);
        assert!(b.stability > a.stability);
        assert!(b.due - due > due - 0.0, "{} {}", b.due - due, due);
    }

    #[test]
    fn a_due_card_is_at_the_retention_we_aimed_for() {
        let a = review(None, Rating::Good, 0.0, false);
        let r = mastery(&a, a.due);
        assert!((r - DESIRED_RETENTION).abs() < 0.001, "{r}");
    }

    #[test]
    fn forgetting_brings_it_back_today_and_lowers_stability() {
        let a = review(None, Rating::Easy, 0.0, false);
        let b = review(Some(&a), Rating::Again, a.due, false);
        assert!(b.stability < a.stability);
        assert!(b.due - a.due < DAY);
        assert_eq!(b.lapses, 1);
    }

    #[test]
    fn ratings_are_in_order() {
        let a = review(None, Rating::Good, 0.0, false);
        let [again, hard, good, easy] = preview(Some(&a), a.due);
        assert!(
            again < hard && hard < good && good < easy,
            "{again} {hard} {good} {easy}"
        );
    }

    #[test]
    fn peeking_never_counts_as_knowing_it() {
        assert_eq!(after_peek(Rating::Easy), Rating::Hard);
        assert_eq!(after_peek(Rating::Again), Rating::Again);
    }

    #[test]
    fn sure_and_wrong_is_flagged() {
        assert!(is_overconfident(Some(3), Rating::Again));
        assert!(!is_overconfident(Some(1), Rating::Again));
        assert!(!is_overconfident(Some(3), Rating::Good));
        assert!(!is_overconfident(None, Rating::Again));
    }

    #[test]
    fn stages_follow_the_record() {
        assert_eq!(stage(&[], 0.0), Stage::New);
        let weak = review(None, Rating::Again, 0.0, false);
        assert_eq!(stage(&[weak], 30.0 * DAY), Stage::Learning);
    }
}
