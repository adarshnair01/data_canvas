//! Excel import with calamine (no DuckDB extension download). Rows go in through the Appender.

use std::collections::HashSet;
use std::path::Path;

use calamine::{open_workbook_auto, Data, Reader};
use chrono::{NaiveDate, NaiveDateTime, Timelike};
use duckdb::appender_params_from_iter;
use duckdb::types::{TimeUnit, Value};
use duckdb::Connection;

use crate::db::ident::{quote_ident, table_name};
use crate::error::{AppError, AppResult};

pub fn list_sheets(path: &Path) -> AppResult<Vec<String>> {
    super::ensure_file(path)?;
    let wb = open_workbook_auto(path).map_err(|e| AppError::UnsupportedFile(e.to_string()))?;
    Ok(wb.sheet_names().to_vec())
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum ColType {
    Empty,
    Int,
    Float,
    Bool,
    Date,
    Timestamp,
    Text,
}

impl ColType {
    fn sql(self) -> &'static str {
        match self {
            ColType::Int => "BIGINT",
            ColType::Float => "DOUBLE",
            ColType::Bool => "BOOLEAN",
            ColType::Date => "DATE",
            ColType::Timestamp => "TIMESTAMP",
            ColType::Empty | ColType::Text => "VARCHAR",
        }
    }

    fn merge(self, other: ColType) -> ColType {
        use ColType::*;
        match (self, other) {
            (a, Empty) => a,
            (Empty, b) => b,
            (a, b) if a == b => a,
            (Int, Float) | (Float, Int) => Float,
            (Date, Timestamp) | (Timestamp, Date) => Timestamp,
            _ => Text,
        }
    }
}

fn cell_datetime(cell: &Data) -> Option<NaiveDateTime> {
    match cell {
        Data::DateTime(dt) => dt.as_datetime(),
        Data::DateTimeIso(s) => NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S%.f")
            .ok()
            .or_else(|| {
                NaiveDate::parse_from_str(s, "%Y-%m-%d")
                    .ok()
                    .and_then(|d| d.and_hms_opt(0, 0, 0))
            }),
        _ => None,
    }
}

fn cell_type(cell: &Data) -> ColType {
    match cell {
        Data::Empty | Data::Error(_) => ColType::Empty,
        Data::Int(_) => ColType::Int,
        Data::Float(f) => {
            if f.fract() == 0.0 && f.abs() < 9.0e15 {
                ColType::Int
            } else {
                ColType::Float
            }
        }
        Data::Bool(_) => ColType::Bool,
        Data::DateTime(_) | Data::DateTimeIso(_) => match cell_datetime(cell) {
            Some(dt) if dt.time().num_seconds_from_midnight() == 0 && dt.nanosecond() == 0 => {
                ColType::Date
            }
            Some(_) => ColType::Timestamp,
            None => ColType::Text,
        },
        Data::String(s) if s.trim().is_empty() => ColType::Empty,
        Data::String(_) | Data::DurationIso(_) => ColType::Text,
    }
}

fn cell_text(cell: &Data) -> Option<String> {
    match cell {
        Data::Empty | Data::Error(_) => None,
        Data::String(s) if s.trim().is_empty() => None,
        Data::Float(f) if f.fract() == 0.0 && f.abs() < 9.0e15 => Some(format!("{}", *f as i64)),
        Data::DateTime(_) | Data::DateTimeIso(_) => match cell_datetime(cell) {
            Some(dt) => Some(dt.format("%Y-%m-%d %H:%M:%S").to_string()),
            None => Some(cell.to_string()),
        },
        other => Some(other.to_string()),
    }
}

fn to_value(cell: &Data, t: ColType) -> Value {
    let epoch = NaiveDate::from_ymd_opt(1970, 1, 1).expect("epoch");
    match (t, cell) {
        (_, Data::Empty | Data::Error(_)) => Value::Null,
        (ColType::Int, Data::Int(i)) => Value::BigInt(*i),
        (ColType::Int, Data::Float(f)) => Value::BigInt(*f as i64),
        (ColType::Float, Data::Int(i)) => Value::Double(*i as f64),
        (ColType::Float, Data::Float(f)) => Value::Double(*f),
        (ColType::Bool, Data::Bool(b)) => Value::Boolean(*b),
        (ColType::Date, c) => match cell_datetime(c) {
            Some(dt) => Value::Date32((dt.date() - epoch).num_days() as i32),
            None => Value::Null,
        },
        (ColType::Timestamp, c) => match cell_datetime(c) {
            Some(dt) => Value::Timestamp(TimeUnit::Microsecond, dt.and_utc().timestamp_micros()),
            None => Value::Null,
        },
        (_, c) => cell_text(c).map(Value::Text).unwrap_or(Value::Null),
    }
}

/// Unique, non-empty column names from the header row.
fn column_names(header: Option<&[Data]>, width: usize) -> Vec<String> {
    let mut seen = HashSet::new();
    (0..width)
        .map(|i| {
            let raw = header
                .and_then(|h| h.get(i))
                .and_then(cell_text)
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| format!("column_{}", i + 1));
            let mut name = raw.clone();
            let mut n = 2;
            while !seen.insert(name.to_lowercase()) {
                name = format!("{raw}_{n}");
                n += 1;
            }
            name
        })
        .collect()
}

pub fn import(
    conn: &Connection,
    dataset_id: &str,
    path: &Path,
    sheet: &str,
    header: bool,
) -> AppResult<()> {
    super::ensure_file(path)?;
    let mut wb = open_workbook_auto(path).map_err(|e| AppError::UnsupportedFile(e.to_string()))?;
    if !wb.sheet_names().iter().any(|s| s == sheet) {
        return Err(AppError::EmptySheet(format!("{sheet} (not found)")));
    }
    let range = wb
        .worksheet_range(sheet)
        .map_err(|e| AppError::MalformedRows(e.to_string()))?;
    let (height, width) = range.get_size();
    if height == 0 || width == 0 {
        return Err(AppError::EmptySheet(sheet.to_string()));
    }
    let mut rows = range.rows();
    let header_row = if header { rows.next() } else { None };
    let data: Vec<&[Data]> = rows
        .filter(|r| r.iter().any(|c| cell_type(c) != ColType::Empty))
        .collect();
    if data.is_empty() {
        return Err(AppError::EmptySheet(sheet.to_string()));
    }

    let names = column_names(header_row, width);
    let mut types = vec![ColType::Empty; width];
    for row in &data {
        for (i, cell) in row.iter().enumerate().take(width) {
            types[i] = types[i].merge(cell_type(cell));
        }
    }

    let table = table_name(dataset_id)?;
    let defs = names
        .iter()
        .zip(&types)
        .map(|(n, t)| format!("{} {}", quote_ident(n), t.sql()))
        .collect::<Vec<_>>()
        .join(", ");
    conn.execute_batch(&format!(
        "CREATE OR REPLACE TABLE {} ({defs})",
        quote_ident(&table)
    ))?;
    let result = (|| -> AppResult<()> {
        let mut app = conn.appender(&table)?;
        for row in &data {
            let values = (0..width).map(|i| {
                row.get(i)
                    .map(|c| to_value(c, types[i]))
                    .unwrap_or(Value::Null)
            });
            app.append_row(appender_params_from_iter(values))?;
        }
        app.flush()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = conn.execute_batch(&format!("DROP TABLE IF EXISTS {}", quote_ident(&table)));
    }
    result
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    /// Minimal multi-sheet .xlsx writer for fixtures. Each cell is either a number, `=b:true`,
    /// `=d:<serial>` (date-formatted number), or an inline string.
    pub fn write_xlsx(path: &Path, sheets: &[(&str, Vec<Vec<&str>>)]) {
        let f = std::fs::File::create(path).unwrap();
        let mut z = zip::ZipWriter::new(f);
        let o = SimpleFileOptions::default();
        let overrides: String = (1..=sheets.len())
            .map(|i| format!(r#"<Override PartName="/xl/worksheets/sheet{i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>"#))
            .collect();
        z.start_file("[Content_Types].xml", o).unwrap();
        write!(z, r#"<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>{overrides}</Types>"#).unwrap();
        z.start_file("_rels/.rels", o).unwrap();
        write!(z, r#"<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>"#).unwrap();
        let sheet_entries: String = sheets
            .iter()
            .enumerate()
            .map(|(i, (n, _))| format!(r#"<sheet name="{n}" sheetId="{}" r:id="rId{}"/>"#, i + 1, i + 1))
            .collect();
        z.start_file("xl/workbook.xml", o).unwrap();
        write!(z, r#"<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>{sheet_entries}</sheets></workbook>"#).unwrap();
        let rels: String = (1..=sheets.len())
            .map(|i| format!(r#"<Relationship Id="rId{i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet{i}.xml"/>"#))
            .collect();
        z.start_file("xl/_rels/workbook.xml.rels", o).unwrap();
        write!(z, r#"<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">{rels}<Relationship Id="rIdS" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>"#).unwrap();
        z.start_file("xl/styles.xml", o).unwrap();
        write!(z, r#"<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/></cellXfs></styleSheet>"#).unwrap();
        for (i, (_, rows)) in sheets.iter().enumerate() {
            let mut xml = String::new();
            for (r, row) in rows.iter().enumerate() {
                xml.push_str(&format!(r#"<row r="{}">"#, r + 1));
                for (c, v) in row.iter().enumerate() {
                    let cref = format!("{}{}", (b'A' + c as u8) as char, r + 1);
                    if v.is_empty() {
                        continue;
                    } else if let Some(b) = v.strip_prefix("=b:") {
                        xml.push_str(&format!(r#"<c r="{cref}" t="b"><v>{}</v></c>"#, if b == "true" { 1 } else { 0 }));
                    } else if let Some(d) = v.strip_prefix("=d:") {
                        xml.push_str(&format!(r#"<c r="{cref}" s="1"><v>{d}</v></c>"#));
                    } else if v.parse::<f64>().is_ok() {
                        xml.push_str(&format!(r#"<c r="{cref}"><v>{v}</v></c>"#));
                    } else {
                        xml.push_str(&format!(r#"<c r="{cref}" t="inlineStr"><is><t>{v}</t></is></c>"#));
                    }
                }
                xml.push_str("</row>");
            }
            z.start_file(format!("xl/worksheets/sheet{}.xml", i + 1), o).unwrap();
            write!(z, r#"<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>{xml}</sheetData></worksheet>"#).unwrap();
        }
        z.finish().unwrap();
    }

    #[test]
    fn imports_sheet_with_inferred_types() {
        use crate::db::schema::{create_view, detect_schema};
        use crate::model::LogicalType;
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("book.xlsx");
        write_xlsx(
            &p,
            &[
                (
                    "Sales",
                    vec![
                        vec!["Region", "Amount", "Units", "When", "Paid", "Region"],
                        vec!["North", "1.5", "2", "=d:45292", "=b:true", "x"],
                        vec!["South", "2", "3", "=d:45293", "=b:false", "y"],
                        vec!["", "", "", "", "", ""],
                        vec!["East", "4.25", "", "=d:45294", "=b:true", "z"],
                    ],
                ),
                ("Empty", vec![]),
            ],
        );
        assert_eq!(list_sheets(&p).unwrap(), vec!["Sales", "Empty"]);
        let c = Connection::open_in_memory().unwrap();
        import(&c, "x1", &p, "Sales", true).unwrap();
        create_view(&c, "x1", &Default::default()).unwrap();
        let (cols, rows) = detect_schema(&c, "x1", &Default::default()).unwrap();
        assert_eq!(rows, 3);
        let names: Vec<_> = cols.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["Region", "Amount", "Units", "When", "Paid", "Region_2"]);
        let types: Vec<_> = cols.iter().map(|c| c.logical_type).collect();
        assert_eq!(
            types,
            vec![
                LogicalType::String,
                LogicalType::Float,
                LogicalType::Integer,
                LogicalType::Date,
                LogicalType::Boolean,
                LogicalType::String
            ]
        );
        let d: String = c
            .query_row("SELECT CAST(min(\"When\") AS VARCHAR) FROM ds_x1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(d, "2024-01-01");
        assert!(matches!(import(&c, "x2", &p, "Empty", true), Err(AppError::EmptySheet(_))));
        assert!(matches!(import(&c, "x3", &p, "Nope", true), Err(AppError::EmptySheet(_))));
    }

    #[test]
    fn rejects_non_excel_files() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("fake.xlsx");
        std::fs::write(&p, "not a zip").unwrap();
        assert!(matches!(list_sheets(&p), Err(AppError::UnsupportedFile(_))));
    }
}
