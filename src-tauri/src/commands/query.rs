use tauri::State;

use crate::db::expr::{self, ParsedExpression};
use crate::db::query_builder::{build_query, execute, QueryResult};
use crate::db::spec::QuerySpec;
use crate::error::AppResult;
use crate::state::{blocking, AppState};

/// Execute a `QuerySpec`. Pass a `query_id` to make the query cancellable via `cancel_query`.
#[tauri::command]
pub async fn run_query(
    state: State<'_, AppState>,
    spec: QuerySpec,
    query_id: Option<String>,
) -> AppResult<QueryResult> {
    let s = state.0.clone();
    blocking(move || {
        let meta = s.dataset(&spec.dataset_id)?;
        let built = build_query(&spec, &meta.columns)?;
        s.pool
            .run_cancellable(query_id.as_deref(), |conn| execute(conn, &built))
    })
    .await
}

#[tauri::command]
pub async fn cancel_query(state: State<'_, AppState>, query_id: String) -> AppResult<bool> {
    Ok(state.0.pool.cancel(&query_id))
}

/// Validate a calculated-metric expression against a dataset and return its AST.
#[tauri::command]
pub async fn parse_metric_expression(
    state: State<'_, AppState>,
    dataset_id: String,
    expression: String,
) -> AppResult<ParsedExpression> {
    let meta = state.0.dataset(&dataset_id)?;
    expr::parse(&expression, &meta.columns)
}
