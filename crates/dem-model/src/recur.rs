//! The part of RRULE a calendar needs: FREQ, INTERVAL, BYDAY (weekly only), COUNT and UNTIL. Rules
//! it cannot read yield only the first occurrence, so a rule from elsewhere never invents dates.

use jiff::civil::Weekday;
use jiff::tz::TimeZone;
use jiff::{Span, Timestamp, ToSpan, Zoned};

const MAX_STEPS: u32 = 20_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Freq {
    Daily,
    Weekly,
    Monthly,
    Yearly,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Rule {
    freq: Freq,
    interval: i64,
    by_day: Vec<Weekday>,
    count: Option<u32>,
    until: Option<Timestamp>,
}

fn weekday(s: &str) -> Option<Weekday> {
    Some(match s {
        "MO" => Weekday::Monday,
        "TU" => Weekday::Tuesday,
        "WE" => Weekday::Wednesday,
        "TH" => Weekday::Thursday,
        "FR" => Weekday::Friday,
        "SA" => Weekday::Saturday,
        "SU" => Weekday::Sunday,
        _ => return None,
    })
}

fn until(s: &str, tz: &TimeZone) -> Option<Timestamp> {
    if let Ok(at) = s.parse::<Timestamp>() {
        return Some(at);
    }
    let digits = s.trim_end_matches('Z');
    let day = digits.get(..8)?;
    let date = jiff::civil::Date::new(
        day.get(..4)?.parse().ok()?,
        day.get(4..6)?.parse().ok()?,
        day.get(6..8)?.parse().ok()?,
    )
    .ok()?;
    // The whole of that day still counts.
    let end = date.tomorrow().ok()?.to_zoned(tz.clone()).ok()?;
    Some(end.timestamp())
}

fn parse(rule: &str, tz: &TimeZone) -> Option<Rule> {
    let mut out = Rule {
        freq: Freq::Daily,
        interval: 1,
        by_day: vec![],
        count: None,
        until: None,
    };
    let mut has_freq = false;
    for part in rule.trim().trim_start_matches("RRULE:").split(';') {
        let (k, v) = part.split_once('=')?;
        match k {
            "FREQ" => {
                has_freq = true;
                out.freq = match v {
                    "DAILY" => Freq::Daily,
                    "WEEKLY" => Freq::Weekly,
                    "MONTHLY" => Freq::Monthly,
                    "YEARLY" => Freq::Yearly,
                    _ => return None,
                };
            }
            "INTERVAL" => out.interval = v.parse().ok().filter(|n| *n > 0)?,
            "BYDAY" => {
                out.by_day = v.split(',').map(weekday).collect::<Option<_>>()?;
            }
            "COUNT" => out.count = Some(v.parse().ok()?),
            "UNTIL" => out.until = Some(until(v, tz)?),
            _ => return None,
        }
    }
    if !has_freq || (!out.by_day.is_empty() && out.freq != Freq::Weekly) {
        return None;
    }
    Some(out)
}

fn step(freq: Freq, n: i64) -> Span {
    match freq {
        Freq::Daily => n.days(),
        Freq::Weekly => n.weeks(),
        Freq::Monthly => n.months(),
        Freq::Yearly => n.years(),
    }
}

/// When a series starts, in the order they happen, from `from` up to but not including `to`. Each
/// lasts as long as the first, so one still running at `from` is included. Dates keep their local
/// time across a clock change. A month without that day is skipped, like other calendars do.
pub fn occurrences(
    start: Timestamp,
    end: Timestamp,
    tz: &str,
    recurrence: Option<&str>,
    from: Timestamp,
    to: Timestamp,
) -> Vec<Timestamp> {
    let zone = TimeZone::get(tz).unwrap_or_else(|_| TimeZone::system());
    let length = end.as_millisecond().saturating_sub(start.as_millisecond());
    let overlaps = |at: Timestamp| {
        at < to && at.as_millisecond().saturating_add(length) > from.as_millisecond()
    };
    let first = start.to_zoned(zone.clone());
    let rule = recurrence.and_then(|r| parse(r, &zone));
    let Some(rule) = rule else {
        return if overlaps(start) || (length == 0 && start >= from && start < to) {
            vec![start]
        } else {
            vec![]
        };
    };
    let mut out = Vec::new();
    let mut made = 0u32;
    let mut emit = |at: &Zoned, out: &mut Vec<Timestamp>| -> bool {
        let ts = at.timestamp();
        if ts < start {
            return true;
        }
        if rule.until.is_some_and(|u| ts > u) || ts >= to {
            return false;
        }
        if rule.count.is_some_and(|c| made >= c) {
            return false;
        }
        made += 1;
        if overlaps(ts) || (length == 0 && ts >= from) {
            out.push(ts);
        }
        true
    };
    let mut days = rule.by_day.clone();
    days.sort_by_key(|d| d.to_monday_zero_offset());
    for i in 0..MAX_STEPS {
        let Ok(at) = first.checked_add(step(rule.freq, rule.interval * i64::from(i))) else {
            break;
        };
        if rule.freq == Freq::Weekly && !days.is_empty() {
            let Some(monday) = at
                .checked_sub(i64::from(at.weekday().to_monday_zero_offset()).days())
                .ok()
            else {
                break;
            };
            for d in &days {
                let Ok(day) = monday.checked_add(i64::from(d.to_monday_zero_offset()).days())
                else {
                    continue;
                };
                if !emit(&day, &mut out) {
                    return out;
                }
            }
            continue;
        }
        // A month without that day: jiff clamps it, which would move the date, so it is skipped.
        if matches!(rule.freq, Freq::Monthly | Freq::Yearly) && at.day() != first.day() {
            continue;
        }
        if !emit(&at, &mut out) {
            return out;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(s: &str) -> Timestamp {
        s.parse().unwrap()
    }

    fn days(rule: Option<&str>, from: &str, to: &str) -> Vec<String> {
        occurrences(
            at("2026-11-02T09:00:00Z"),
            at("2026-11-02T10:00:00Z"),
            "UTC",
            rule,
            at(from),
            at(to),
        )
        .iter()
        .map(|t| t.to_string()[..10].to_owned())
        .collect()
    }

    const NOV: (&str, &str) = ("2026-11-01T00:00:00Z", "2026-12-01T00:00:00Z");

    #[test]
    fn a_single_event_appears_once_only_in_its_range() {
        assert_eq!(days(None, NOV.0, NOV.1), ["2026-11-02"]);
        assert!(days(None, "2026-12-01T00:00:00Z", "2027-01-01T00:00:00Z").is_empty());
    }

    #[test]
    fn weekly_on_chosen_days() {
        let got = days(
            Some("FREQ=WEEKLY;BYDAY=MO,TH"),
            NOV.0,
            "2026-11-13T00:00:00Z",
        );
        assert_eq!(
            got,
            ["2026-11-02", "2026-11-05", "2026-11-09", "2026-11-12"]
        );
    }

    #[test]
    fn count_and_until_stop_a_series_even_outside_the_range() {
        let got = days(Some("FREQ=DAILY;COUNT=3"), "2026-11-03T00:00:00Z", NOV.1);
        assert_eq!(got, ["2026-11-03", "2026-11-04"]);
        let got = days(Some("FREQ=DAILY;UNTIL=20261104"), NOV.0, NOV.1);
        assert_eq!(got, ["2026-11-02", "2026-11-03", "2026-11-04"]);
    }

    #[test]
    fn a_month_without_the_day_is_skipped() {
        let got: Vec<_> = occurrences(
            at("2026-01-31T09:00:00Z"),
            at("2026-01-31T10:00:00Z"),
            "UTC",
            Some("FREQ=MONTHLY"),
            at("2026-01-01T00:00:00Z"),
            at("2026-04-01T00:00:00Z"),
        )
        .iter()
        .map(|t| t.to_string()[..10].to_owned())
        .collect();
        assert_eq!(got, ["2026-01-31", "2026-03-31"]);
    }

    #[test]
    fn local_time_holds_across_a_clock_change() {
        // New York leaves summer time on 2026-11-01.
        let got = occurrences(
            at("2026-10-31T13:00:00Z"),
            at("2026-10-31T14:00:00Z"),
            "America/New_York",
            Some("FREQ=DAILY;COUNT=2"),
            at("2026-10-31T00:00:00Z"),
            at("2026-11-03T00:00:00Z"),
        );
        assert_eq!(
            got,
            [at("2026-10-31T13:00:00Z"), at("2026-11-01T14:00:00Z")]
        );
    }

    #[test]
    fn an_unreadable_rule_stays_a_single_event() {
        assert_eq!(days(Some("FREQ=SOMETIMES"), NOV.0, NOV.1), ["2026-11-02"]);
        assert_eq!(
            days(Some("FREQ=MONTHLY;BYDAY=2TU"), NOV.0, NOV.1),
            ["2026-11-02"]
        );
    }
}
