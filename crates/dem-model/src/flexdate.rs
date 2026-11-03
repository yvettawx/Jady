//! Flexible historical dates: BCE years, unknown month/day, "circa", and spans.
//!
//! Year numbering follows the historians' convention: there is no year 0, and
//! `-1` is 1 BCE (公元前 1 年). Calendar rules are the proleptic Gregorian calendar.

use std::cmp::Ordering;
use std::fmt;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct FlexDate {
    /// Never 0; negative is BCE.
    pub year: i32,
    pub month: Option<u8>,
    pub day: Option<u8>,
    /// "约" (circa).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub approximate: bool,
    /// End of a span; must not be earlier than the start.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub until: Option<Box<FlexDate>>,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum FlexDateError {
    #[error("not a date")]
    Unreadable,
    #[error("year 0 does not exist; use -1 for 1 BCE")]
    YearZero,
    #[error("month must be 1-12, got {0}")]
    Month(u8),
    #[error("a day requires a month")]
    DayWithoutMonth,
    #[error("day {day} does not exist in {year}-{month:02}")]
    Day { year: i32, month: u8, day: u8 },
    #[error("a span cannot end before it starts")]
    SpanReversed,
    #[error("a span end cannot itself be a span")]
    NestedSpan,
}

impl FlexDate {
    pub fn year(year: i32) -> Result<Self, FlexDateError> {
        Self::new(year, None, None)
    }

    pub fn ymd(year: i32, month: u8, day: u8) -> Result<Self, FlexDateError> {
        Self::new(year, Some(month), Some(day))
    }

    pub fn new(year: i32, month: Option<u8>, day: Option<u8>) -> Result<Self, FlexDateError> {
        let d = Self {
            year,
            month,
            day,
            approximate: false,
            until: None,
        };
        d.validate()?;
        Ok(d)
    }

    pub fn approx(mut self) -> Self {
        self.approximate = true;
        self
    }

    /// Turns this date into a span ending at `end`.
    pub fn until(mut self, end: FlexDate) -> Result<Self, FlexDateError> {
        self.until = Some(Box::new(end));
        self.validate()?;
        Ok(self)
    }

    pub fn validate(&self) -> Result<(), FlexDateError> {
        validate_point(self.year, self.month, self.day)?;
        if let Some(end) = &self.until {
            if end.until.is_some() {
                return Err(FlexDateError::NestedSpan);
            }
            validate_point(end.year, end.month, end.day)?;
            if end.last_day() < self.first_day() {
                return Err(FlexDateError::SpanReversed);
            }
        }
        Ok(())
    }

    /// Astronomical year: 1 BCE is 0, 2 BCE is -1. Used for arithmetic only.
    fn astro_year(year: i32) -> i32 {
        if year < 0 { year + 1 } else { year }
    }

    /// Earliest day covered, as (astronomical year, month, day).
    fn first_day(&self) -> (i32, u8, u8) {
        (
            Self::astro_year(self.year),
            self.month.unwrap_or(1),
            self.day.unwrap_or(1),
        )
    }

    /// Latest day covered by the point itself (ignores `until`).
    fn last_day(&self) -> (i32, u8, u8) {
        let y = Self::astro_year(self.year);
        let m = self.month.unwrap_or(12);
        let d = self.day.unwrap_or_else(|| days_in_month(y, m));
        (y, m, d)
    }

    /// Precision rank: year < month < day. Coarser dates sort first on ties.
    fn precision(&self) -> u8 {
        match (self.month, self.day) {
            (None, _) => 0,
            (Some(_), None) => 1,
            (Some(_), Some(_)) => 2,
        }
    }
}

impl FlexDate {
    /// Reads what people type: `公元前221年`, `约1500年3月`, `1200 至 1300`, `1500-03-02`, `44 BC`.
    /// A number that sorts dates by when they start. Coarser dates come first on ties.
    pub fn sort_key(&self) -> i64 {
        i64::from(self.year) * 10_000
            + i64::from(self.month.unwrap_or(0)) * 100
            + i64::from(self.day.unwrap_or(0))
    }

    pub fn parse(text: &str) -> Result<Self, FlexDateError> {
        const SPAN: [&str; 5] = ["至", "到", " to ", "—", "–"];
        let text = text.trim();
        for sep in SPAN {
            if let Some((a, b)) = text.split_once(sep) {
                return Self::parse_point(a)?.until(Self::parse_point(b)?);
            }
        }
        Self::parse_point(text)
    }

    fn parse_point(text: &str) -> Result<Self, FlexDateError> {
        let mut s = text.trim().to_lowercase();
        let mut approximate = false;
        for p in ["约", "circa", "ca.", "c.", "~"] {
            if let Some(rest) = s.strip_prefix(p) {
                approximate = true;
                s = rest.trim().to_owned();
                break;
            }
        }
        let mut bce = false;
        for p in ["公元前", "前"] {
            if let Some(rest) = s.strip_prefix(p) {
                bce = true;
                s = rest.trim().to_owned();
                break;
            }
        }
        for suffix in ["bce", "bc"] {
            if let Some(rest) = s.strip_suffix(suffix) {
                bce = true;
                s = rest.trim().to_owned();
                break;
            }
        }
        let s = s.strip_prefix("公元").unwrap_or(&s);
        let numbers: Vec<&str> = s
            .split(|c: char| !c.is_ascii_digit())
            .filter(|n| !n.is_empty())
            .collect();
        let bad = || FlexDateError::Unreadable;
        // Anything left over means this was not a date after all.
        if numbers.is_empty()
            || numbers.len() > 3
            || s.chars()
                .any(|c| !c.is_ascii_digit() && !"年月日-/. ".contains(c))
        {
            return Err(bad());
        }
        let year: i32 = numbers[0].parse().map_err(|_| bad())?;
        let month: Option<u8> = numbers
            .get(1)
            .map(|m| m.parse().map_err(|_| bad()))
            .transpose()?;
        let day: Option<u8> = numbers
            .get(2)
            .map(|d| d.parse().map_err(|_| bad()))
            .transpose()?;
        let mut date = Self::new(if bce { -year } else { year }, month, day)?;
        date.approximate = approximate;
        Ok(date)
    }
}

fn validate_point(year: i32, month: Option<u8>, day: Option<u8>) -> Result<(), FlexDateError> {
    if year == 0 {
        return Err(FlexDateError::YearZero);
    }
    match (month, day) {
        (None, Some(_)) => Err(FlexDateError::DayWithoutMonth),
        (Some(m), _) if !(1..=12).contains(&m) => Err(FlexDateError::Month(m)),
        (Some(m), Some(d)) if d == 0 || d > days_in_month(FlexDate::astro_year(year), m) => {
            Err(FlexDateError::Day {
                year,
                month: m,
                day: d,
            })
        }
        _ => Ok(()),
    }
}

fn is_leap(astro_year: i32) -> bool {
    (astro_year % 4 == 0 && astro_year % 100 != 0) || astro_year % 400 == 0
}

fn days_in_month(astro_year: i32, month: u8) -> u8 {
    match month {
        2 if is_leap(astro_year) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

/// Chronological order by start; ties go to the coarser date, then exact before
/// approximate, then points before spans, then the earlier span end. Equal start
/// and equal precision imply equal year/month/day, so this is a total order
/// consistent with `Eq`.
impl Ord for FlexDate {
    fn cmp(&self, other: &Self) -> Ordering {
        self.first_day()
            .cmp(&other.first_day())
            .then_with(|| self.precision().cmp(&other.precision()))
            .then_with(|| self.approximate.cmp(&other.approximate))
            .then_with(|| match (&self.until, &other.until) {
                (None, None) => Ordering::Equal,
                (None, Some(_)) => Ordering::Less,
                (Some(_), None) => Ordering::Greater,
                (Some(a), Some(b)) => a.cmp(b),
            })
    }
}

impl PartialOrd for FlexDate {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

/// Chinese display, e.g. `约公元前221年`, `1990年3月5日—1991年`.
impl fmt::Display for FlexDate {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fn point(f: &mut fmt::Formatter<'_>, d: &FlexDate) -> fmt::Result {
            if d.approximate {
                f.write_str("约")?;
            }
            if d.year < 0 {
                write!(f, "公元前{}年", -i64::from(d.year))?;
            } else {
                write!(f, "{}年", d.year)?;
            }
            if let Some(m) = d.month {
                write!(f, "{m}月")?;
            }
            if let Some(day) = d.day {
                write!(f, "{day}日")?;
            }
            Ok(())
        }
        point(f, self)?;
        if let Some(end) = &self.until {
            f.write_str(" 至 ")?;
            point(f, end)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn reads_what_people_type() {
        let p = |t: &str| super::FlexDate::parse(t).map(|d| d.to_string());
        assert_eq!(p("公元前221年").unwrap(), "公元前221年");
        assert_eq!(p("前 221").unwrap(), "公元前221年");
        assert_eq!(p("44 BC").unwrap(), "公元前44年");
        assert_eq!(p("约1500年3月").unwrap(), "约1500年3月");
        assert_eq!(p("1500-03-02").unwrap(), "1500年3月2日");
        assert_eq!(p("1200 至 1300").unwrap(), "1200年 至 1300年");
        // What it writes, it reads again.
        assert_eq!(
            p("约公元前1200年 至 公元前1100年").unwrap(),
            "约公元前1200年 至 公元前1100年"
        );
        assert!(p("明天").is_err());
        assert!(p("").is_err());
        assert!(p("1500年13月").is_err());
    }

    use proptest::prelude::*;

    use super::*;

    #[test]
    fn rejects_invalid_dates() {
        assert_eq!(FlexDate::year(0), Err(FlexDateError::YearZero));
        assert_eq!(
            FlexDate::new(2000, Some(13), None),
            Err(FlexDateError::Month(13))
        );
        assert_eq!(
            FlexDate::new(2000, None, Some(1)),
            Err(FlexDateError::DayWithoutMonth)
        );
        assert!(FlexDate::ymd(2023, 2, 29).is_err());
        assert!(FlexDate::ymd(2024, 2, 29).is_ok());
        assert!(FlexDate::ymd(1900, 2, 29).is_err());
        assert!(FlexDate::ymd(2000, 2, 29).is_ok());
        // 1 BCE is astronomical year 0, a leap year; 5 BCE is astronomical -4, also leap.
        assert!(FlexDate::ymd(-1, 2, 29).is_ok());
        assert!(FlexDate::ymd(-5, 2, 29).is_ok());
        assert!(FlexDate::ymd(-2, 2, 29).is_err());
    }

    #[test]
    fn spans_must_not_run_backwards() {
        let start = FlexDate::year(1990).unwrap();
        assert!(start.clone().until(FlexDate::year(1989).unwrap()).is_err());
        // Same year at different precision is fine.
        assert!(
            start
                .clone()
                .until(FlexDate::ymd(1990, 1, 1).unwrap())
                .is_ok()
        );
        let nested = FlexDate::year(1995)
            .unwrap()
            .until(FlexDate::year(1996).unwrap())
            .unwrap();
        assert_eq!(start.until(nested), Err(FlexDateError::NestedSpan));
    }

    #[test]
    fn chronological_order_across_eras() {
        let mut dates = vec![
            FlexDate::year(1).unwrap(),
            FlexDate::ymd(-221, 6, 1).unwrap(),
            FlexDate::year(-1).unwrap(),
            FlexDate::year(-221).unwrap(),
            FlexDate::year(-1000).unwrap().approx(),
            FlexDate::new(1990, Some(3), None).unwrap(),
            FlexDate::year(1990).unwrap(),
            FlexDate::year(1990)
                .unwrap()
                .until(FlexDate::year(1995).unwrap())
                .unwrap(),
            FlexDate::year(1990).unwrap().approx(),
        ];
        dates.sort();
        let shown: Vec<String> = dates.iter().map(ToString::to_string).collect();
        assert_eq!(
            shown,
            [
                "约公元前1000年",
                "公元前221年",
                "公元前221年6月1日",
                "公元前1年",
                "1年",
                "1990年",
                "1990年 至 1995年",
                "约1990年",
                "1990年3月",
            ]
        );
    }

    #[test]
    fn serde_round_trip_omits_defaults() {
        let d = FlexDate::year(-44).unwrap().approx();
        let json = serde_json::to_string(&d).unwrap();
        assert_eq!(
            json,
            r#"{"year":-44,"month":null,"day":null,"approximate":true}"#
        );
        assert_eq!(serde_json::from_str::<FlexDate>(&json).unwrap(), d);
    }

    fn arb_point() -> impl Strategy<Value = FlexDate> {
        (
            -3000i32..3000,
            proptest::option::of(1u8..=12),
            any::<bool>(),
            1u8..=28,
        )
            .prop_filter_map("valid", |(y, m, approx, d)| {
                let day = m.and(Some(d));
                FlexDate::new(y, m, day)
                    .ok()
                    .map(|f| if approx { f.approx() } else { f })
            })
    }

    fn arb_date() -> impl Strategy<Value = FlexDate> {
        (arb_point(), proptest::option::of(arb_point())).prop_filter_map("valid span", |(a, b)| {
            match b {
                None => Some(a),
                Some(b) => a.until(b).ok(),
            }
        })
    }

    proptest! {
        #[test]
        fn order_is_total_and_consistent_with_eq(a in arb_date(), b in arb_date(), c in arb_date()) {
            prop_assert_eq!(a.cmp(&b), b.cmp(&a).reverse());
            prop_assert_eq!(a.cmp(&b) == Ordering::Equal, a == b);
            if a <= b && b <= c {
                prop_assert!(a <= c);
            }
        }

        #[test]
        fn earlier_start_always_sorts_first(a in arb_date(), b in arb_date()) {
            if a.first_day() < b.first_day() {
                prop_assert!(a < b);
            }
        }

        #[test]
        fn json_round_trip(a in arb_date()) {
            let json = serde_json::to_string(&a).unwrap();
            prop_assert_eq!(serde_json::from_str::<FlexDate>(&json).unwrap(), a);
        }
    }
}
