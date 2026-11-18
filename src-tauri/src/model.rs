//! Serializable data model shared with the frontend (`src/types/*.ts`).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LogicalType {
    String,
    Integer,
    Float,
    Boolean,
    Date,
    Timestamp,
    Other,
}

impl LogicalType {
    pub fn from_duck_type(t: &str) -> Self {
        let t = t.trim().to_ascii_uppercase();
        let base = t.split('(').next().unwrap_or("").trim();
        match base {
            "TINYINT" | "SMALLINT" | "INTEGER" | "INT" | "BIGINT" | "HUGEINT" | "UTINYINT"
            | "USMALLINT" | "UINTEGER" | "UBIGINT" | "UHUGEINT" => LogicalType::Integer,
            "FLOAT" | "REAL" | "DOUBLE" | "DECIMAL" | "NUMERIC" => LogicalType::Float,
            "BOOLEAN" | "BOOL" => LogicalType::Boolean,
            "DATE" => LogicalType::Date,
            "VARCHAR" | "TEXT" | "STRING" | "UUID" => LogicalType::String,
            b if b.starts_with("TIMESTAMP") => LogicalType::Timestamp,
            _ => LogicalType::Other,
        }
    }

    pub fn is_numeric(self) -> bool {
        matches!(self, LogicalType::Integer | LogicalType::Float)
    }

    pub fn is_temporal(self) -> bool {
        matches!(self, LogicalType::Date | LogicalType::Timestamp)
    }

    /// DuckDB type used when the user overrides a column type.
    pub fn cast_target(self) -> Option<&'static str> {
        Some(match self {
            LogicalType::String => "VARCHAR",
            LogicalType::Integer => "BIGINT",
            LogicalType::Float => "DOUBLE",
            LogicalType::Boolean => "BOOLEAN",
            LogicalType::Date => "DATE",
            LogicalType::Timestamp => "TIMESTAMP",
            LogicalType::Other => return None,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnInfo {
    pub name: String,
    pub logical_type: LogicalType,
    pub duck_type: String,
    pub null_count: i64,
    pub distinct_estimate: i64,
    /// Present when the type was overridden; holds the originally detected DuckDB type.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub original_type: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Fingerprint {
    pub path: String,
    pub size: u64,
    pub modified_ms: i64,
    /// SHA-256 over the size, the first 1 MB and the last 1 MB of the file.
    pub partial_sha256: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SourceKind {
    Csv,
    Xlsx,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CsvOptions {
    /// `None` lets DuckDB sniff the delimiter.
    pub delimiter: Option<String>,
    pub header: Option<bool>,
    /// One of `utf-8`, `utf-16`, `latin-1`.
    pub encoding: Option<String>,
    pub skip_malformed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatasetSource {
    pub kind: SourceKind,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sheet: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub csv_options: Option<CsvOptions>,
    #[serde(default = "default_true")]
    pub header: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatasetMeta {
    pub id: String,
    pub name: String,
    pub source: DatasetSource,
    pub columns: Vec<ColumnInfo>,
    pub row_count: i64,
    pub fingerprint: Fingerprint,
    #[serde(default)]
    pub type_overrides: BTreeMap<String, LogicalType>,
    pub imported_at: String,
}

impl DatasetMeta {
    pub fn column(&self, name: &str) -> Option<&ColumnInfo> {
        self.columns.iter().find(|c| c.name == name)
    }
}
