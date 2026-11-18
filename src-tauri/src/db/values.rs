//! Conversion between DuckDB values and JSON.

use chrono::{DateTime, Duration, NaiveDate};
use duckdb::types::Value;
use serde_json::{Number, Value as Json};

pub fn to_json(v: Value) -> Json {
    match v {
        Value::Null => Json::Null,
        Value::Boolean(b) => Json::Bool(b),
        Value::TinyInt(i) => Json::from(i),
        Value::SmallInt(i) => Json::from(i),
        Value::Int(i) => Json::from(i),
        Value::BigInt(i) => Json::from(i),
        Value::UTinyInt(i) => Json::from(i),
        Value::USmallInt(i) => Json::from(i),
        Value::UInt(i) => Json::from(i),
        Value::UBigInt(i) => Json::from(i),
        Value::HugeInt(i) => match i64::try_from(i) {
            Ok(v) => Json::from(v),
            Err(_) => float(i as f64),
        },
        Value::UHugeInt(i) => match u64::try_from(i) {
            Ok(v) => Json::from(v),
            Err(_) => float(i as f64),
        },
        Value::Float(f) => float(f as f64),
        Value::Double(f) => float(f),
        Value::Decimal(d) => d.to_string().parse::<f64>().map(float).unwrap_or(Json::Null),
        Value::Text(s) | Value::Enum(s) => Json::String(s),
        Value::Date32(days) => Json::String(format_date(days)),
        Value::Timestamp(unit, v) => Json::String(format_timestamp(unit.to_micros(v))),
        Value::Time64(unit, v) => Json::String(format_time(unit.to_micros(v))),
        Value::Interval {
            months,
            days,
            nanos,
        } => Json::String(format!("{months} months {days} days {}us", nanos / 1000)),
        Value::Blob(b) | Value::Geometry(b) => Json::String(format!("<{} bytes>", b.len())),
        Value::List(items) | Value::Array(items) => {
            Json::Array(items.into_iter().map(to_json).collect())
        }
        Value::Union(inner) => to_json(*inner),
        other => Json::String(format!("{other:?}")),
    }
}

fn float(f: f64) -> Json {
    Number::from_f64(f).map(Json::Number).unwrap_or(Json::Null)
}

pub fn format_date(days: i32) -> String {
    let epoch = NaiveDate::from_ymd_opt(1970, 1, 1).expect("valid epoch");
    (epoch + Duration::days(days as i64))
        .format("%Y-%m-%d")
        .to_string()
}

/// Matches DuckDB's `CAST(ts AS VARCHAR)` so values round-trip through `IN` filters.
pub fn format_timestamp(micros: i64) -> String {
    match DateTime::from_timestamp_micros(micros) {
        Some(dt) => {
            let naive = dt.naive_utc();
            if micros % 1_000_000 == 0 {
                naive.format("%Y-%m-%d %H:%M:%S").to_string()
            } else {
                naive.format("%Y-%m-%d %H:%M:%S%.6f").to_string()
            }
        }
        None => micros.to_string(),
    }
}

fn format_time(micros: i64) -> String {
    let secs = micros / 1_000_000;
    format!("{:02}:{:02}:{:02}", secs / 3600, (secs / 60) % 60, secs % 60)
}

#[cfg(test)]
mod tests {
    use super::*;
    use duckdb::types::TimeUnit;

    #[test]
    fn formats_temporal_values() {
        assert_eq!(format_date(0), "1970-01-01");
        assert_eq!(format_date(19723), "2024-01-01");
        assert_eq!(format_timestamp(0), "1970-01-01 00:00:00");
        assert_eq!(format_timestamp(1_500_000), "1970-01-01 00:00:01.500000");
        assert_eq!(to_json(Value::Double(f64::NAN)), Json::Null);
        assert_eq!(to_json(Value::Timestamp(TimeUnit::Second, 60)), Json::String("1970-01-01 00:01:00".into()));
    }
}
