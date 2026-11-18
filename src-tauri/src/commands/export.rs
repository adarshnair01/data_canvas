use tauri::ipc::{InvokeBody, Request};
use tauri::State;

use crate::db::export::{self, ColumnLabel, ExportResult};
use crate::db::spec::QuerySpec;
use crate::error::{AppError, AppResult};
use crate::state::{blocking, AppState};

/// Header carrying the percent-encoded destination for [`write_export_file`].
const PATH_HEADER: &str = "x-export-path";

/// Write every row of a dataset to `path` as CSV via DuckDB `COPY`.
#[tauri::command]
pub async fn export_dataset_csv(
    state: State<'_, AppState>,
    dataset_id: String,
    path: String,
) -> AppResult<ExportResult> {
    let s = state.0.clone();
    blocking(move || {
        s.dataset(&dataset_id)?;
        let dest = export::validate_destination(&path)?;
        let conn = s.pool.get()?;
        let rows = export::export_dataset_csv(&conn, &dataset_id, &dest)?;
        Ok(ExportResult { path, rows })
    })
    .await
}

/// Write a widget's `QuerySpec` result (without the chart row cap) to `path` as CSV.
/// Pass a `query_id` to make the export cancellable via `cancel_query`.
#[tauri::command]
pub async fn export_query_csv(
    state: State<'_, AppState>,
    spec: QuerySpec,
    path: String,
    labels: Option<Vec<ColumnLabel>>,
    query_id: Option<String>,
) -> AppResult<ExportResult> {
    let s = state.0.clone();
    blocking(move || {
        let meta = s.dataset(&spec.dataset_id)?;
        let dest = export::validate_destination(&path)?;
        let labels = labels.unwrap_or_default();
        let rows = s.pool.run_cancellable(query_id.as_deref(), |conn| {
            export::export_query_csv(conn, &spec, &meta.columns, &labels, &dest)
        })?;
        Ok(ExportResult { path, rows })
    })
    .await
}

/// Write PNG/PDF bytes rendered in the WebView. The body is the raw file contents and the
/// destination arrives in the `x-export-path` header.
#[tauri::command]
pub async fn write_export_file(request: Request<'_>) -> AppResult<()> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err(AppError::Io("expected raw file bytes".into()));
    };
    let encoded = request
        .headers()
        .get(PATH_HEADER)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| AppError::Io("missing export path".into()))?;
    let dest = export::validate_destination(&export::percent_decode(encoded)?)?;
    let bytes = bytes.clone();
    blocking(move || export::write_bytes(&dest, &bytes)).await
}
