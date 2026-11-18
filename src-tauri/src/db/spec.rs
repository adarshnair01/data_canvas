//! `QuerySpec`: the only query shape the frontend can send. Mirrors `src/types/query.ts`.

use serde::{Deserialize, Serialize};

use crate::db::schema::SortDir;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuerySpec {
    pub dataset_id: String,
    #[serde(default)]
    pub mode: QueryMode,
    #[serde(default)]
    pub dimensions: Vec<Dimension>,
    #[serde(default)]
    pub measures: Vec<Measure>,
    #[serde(default)]
    pub filters: Vec<Filter>,
    #[serde(default)]
    pub sort: Vec<SortSpec>,
    #[serde(default)]
    pub limit: Option<u32>,
    #[serde(default)]
    pub offset: Option<u32>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum QueryMode {
    /// GROUP BY dimensions, aggregate measures.
    #[default]
    Aggregate,
    /// Row-level values (scatter, raw tables); no GROUP BY.
    Raw,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DateBucket {
    Day,
    Week,
    Month,
    Quarter,
    Year,
}

impl DateBucket {
    pub fn sql_part(self) -> &'static str {
        match self {
            DateBucket::Day => "day",
            DateBucket::Week => "week",
            DateBucket::Month => "month",
            DateBucket::Quarter => "quarter",
            DateBucket::Year => "year",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Dimension {
    pub id: String,
    pub field: String,
    #[serde(default)]
    pub bucket: Option<DateBucket>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Aggregation {
    Sum,
    Avg,
    Count,
    CountDistinct,
    Min,
    Max,
    None,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum MeasureSource {
    Column { column: String },
    /// `count(*)`
    Rows,
    /// Calculated metric, parsed by `db::expr` (never raw SQL).
    Expression { expression: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Measure {
    pub id: String,
    pub source: MeasureSource,
    pub agg: Aggregation,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Filter {
    In {
        field: String,
        values: Vec<serde_json::Value>,
        #[serde(default)]
        exclude: bool,
    },
    Range {
        field: String,
        #[serde(default)]
        min: Option<f64>,
        #[serde(default)]
        max: Option<f64>,
    },
    DateRange {
        field: String,
        #[serde(default)]
        from: Option<String>,
        #[serde(default)]
        to: Option<String>,
    },
    Contains {
        field: String,
        text: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SortSpec {
    /// Id of a dimension or measure in this spec.
    pub by: String,
    pub dir: SortDir,
}
