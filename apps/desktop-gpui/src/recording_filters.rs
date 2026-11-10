use chrono::{DateTime, Local, NaiveDate};

fn parse_date(value: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .ok()
        .filter(|date| date.format("%Y-%m-%d").to_string() == value)
}

pub fn date_range_error(from: &str, to: &str) -> Option<&'static str> {
    if (!from.is_empty() && parse_date(from).is_none())
        || (!to.is_empty() && parse_date(to).is_none())
    {
        return Some("Enter dates as YYYY-MM-DD.");
    }
    if !from.is_empty() && !to.is_empty() && from > to {
        return Some("From must be on or before To.");
    }
    None
}

pub fn matches_dates(timestamp: f64, from: &str, to: &str) -> bool {
    if date_range_error(from, to).is_some() {
        return false;
    }
    if from.is_empty() && to.is_empty() {
        return true;
    }
    if !timestamp.is_finite() {
        return false;
    }
    let Some(date) = DateTime::from_timestamp_millis(timestamp as i64)
        .map(|date| date.with_timezone(&Local).date_naive())
    else {
        return false;
    };
    parse_date(from).is_none_or(|from| date >= from) && parse_date(to).is_none_or(|to| date <= to)
}

pub fn calendar_date(timestamp: f64) -> String {
    if !timestamp.is_finite() {
        return "Date unavailable".to_string();
    }
    DateTime::from_timestamp_millis(timestamp as i64)
        .map(|date| {
            date.with_timezone(&Local)
                .format("%b %-d, %Y · %-I:%M %p")
                .to_string()
        })
        .unwrap_or_else(|| "Date unavailable".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn timestamp(day: u32, hour: u32, minute: u32) -> f64 {
        Local
            .with_ymd_and_hms(2026, 11, day, hour, minute, 0)
            .single()
            .expect("valid local date")
            .timestamp_millis() as f64
    }

    #[test]
    fn includes_both_local_date_boundaries() {
        assert!(matches_dates(
            timestamp(9, 0, 0),
            "2026-11-09",
            "2026-11-09"
        ));
        assert!(matches_dates(
            timestamp(9, 23, 59),
            "2026-11-09",
            "2026-11-09"
        ));
        assert!(!matches_dates(
            timestamp(10, 0, 0),
            "2026-11-09",
            "2026-11-09"
        ));
        assert!(!matches_dates(
            timestamp(8, 23, 59),
            "2026-11-09",
            "2026-11-09"
        ));
    }

    #[test]
    fn supports_open_ended_and_cleared_ranges() {
        assert!(matches_dates(timestamp(10, 12, 0), "2026-11-09", ""));
        assert!(matches_dates(timestamp(8, 12, 0), "", "2026-11-09"));
        assert!(matches_dates(f64::NAN, "", ""));
        assert!(!matches_dates(f64::NAN, "2026-11-09", ""));
    }

    #[test]
    fn rejects_invalid_dates_and_reversed_ranges() {
        for (from, to) in [
            ("2026-02-30", ""),
            ("2026-1-1", ""),
            ("", "bad"),
            ("2026-11-10", "2026-11-09"),
        ] {
            assert!(date_range_error(from, to).is_some());
            assert!(!matches_dates(timestamp(9, 12, 0), from, to));
        }
    }

    #[test]
    fn displays_calendar_dates_and_handles_unknown_dates() {
        let label = calendar_date(timestamp(9, 12, 30));
        assert!(label.contains("Nov 9, 2026"));
        assert!(label.contains("12:30 PM"));
        assert_eq!(calendar_date(f64::NAN), "Date unavailable");
    }
}
