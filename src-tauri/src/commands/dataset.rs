use std::collections::BTreeMap;
use std::path::PathBuf;

use tauri::State;

use crate::db::ident::{quote_ident, table_name, view_name};
use crate::db::schema::{self, ColumnStats, PreviewPage, PreviewSort, ValueCount};
use crate::error::{AppError, AppResult};
use crate::import::{self, csv, xlsx};
use crate::model::{CsvOptions, DatasetMeta, DatasetSource, Fingerprint, LogicalType, SourceKind};
use crate::state::{blocking, AppState, Inner};

fn new_dataset_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()[..16].to_string()
}

/// Build the view and metadata after rows have been loaded into `ds_<id>`.
fn finish_import(
    inner: &Inner,
    id: String,
    name: String,
    source: DatasetSource,
    fingerprint: Fingerprint,
) -> AppResult<DatasetMeta> {
    let conn = inner.pool.get()?;
    let overrides = BTreeMap::new();
    schema::create_view(&conn, &id, &overrides)?;
    let (columns, row_count) = schema::detect_schema(&conn, &id, &overrides)?;
    let meta = DatasetMeta {
        id,
        name,
        source,
        columns,
        row_count,
        fingerprint,
        type_overrides: overrides,
        imported_at: chrono::Utc::now().to_rfc3339(),
    };
    inner.put_dataset(meta.clone())?;
    Ok(meta)
}

pub fn import_csv_blocking(
    inner: &Inner,
    path: PathBuf,
    name: Option<String>,
    options: CsvOptions,
) -> AppResult<DatasetMeta> {
    let fingerprint = import::fingerprint(&path)?;
    let id = new_dataset_id();
    {
        let conn = inner.pool.get()?;
        csv::import(&conn, &id, &path, &options)?;
    }
    let name = name.unwrap_or_else(|| import::default_name(&path));
    let header = options.header.unwrap_or(true);
    let source = DatasetSource {
        kind: SourceKind::Csv,
        path: path.display().to_string(),
        sheet: None,
        csv_options: Some(options),
        header,
    };
    finish_import(inner, id, name, source, fingerprint)
}

pub fn import_xlsx_blocking(
    inner: &Inner,
    path: PathBuf,
    sheet: String,
    header: bool,
    name: Option<String>,
) -> AppResult<DatasetMeta> {
    let fingerprint = import::fingerprint(&path)?;
    let id = new_dataset_id();
    {
        let conn = inner.pool.get()?;
        xlsx::import(&conn, &id, &path, &sheet, header)?;
    }
    let name = name.unwrap_or_else(|| format!("{} – {sheet}", import::default_name(&path)));
    let source = DatasetSource {
        kind: SourceKind::Xlsx,
        path: path.display().to_string(),
        sheet: Some(sheet),
        csv_options: None,
        header,
    };
    finish_import(inner, id, name, source, fingerprint)
}

#[tauri::command]
pub async fn import_csv(
    state: State<'_, AppState>,
    path: String,
    name: Option<String>,
    options: Option<CsvOptions>,
) -> AppResult<DatasetMeta> {
    let s = state.0.clone();
    blocking(move || import_csv_blocking(&s, PathBuf::from(path), name, options.unwrap_or_default())).await
}

#[tauri::command]
pub async fn list_xlsx_sheets(path: String) -> AppResult<Vec<String>> {
    blocking(move || xlsx::list_sheets(&PathBuf::from(path))).await
}

#[tauri::command]
pub async fn import_xlsx(
    state: State<'_, AppState>,
    path: String,
    sheet: String,
    header: Option<bool>,
    name: Option<String>,
) -> AppResult<DatasetMeta> {
    let s = state.0.clone();
    blocking(move || {
        import_xlsx_blocking(&s, PathBuf::from(path), sheet, header.unwrap_or(true), name)
    })
    .await
}

#[tauri::command]
pub async fn list_datasets(state: State<'_, AppState>) -> AppResult<Vec<DatasetMeta>> {
    let map = state
        .0
        .datasets
        .read()
        .map_err(|_| AppError::Internal("dataset registry poisoned".into()))?;
    let mut list: Vec<DatasetMeta> = map.values().cloned().collect();
    list.sort_by(|a, b| a.imported_at.cmp(&b.imported_at));
    Ok(list)
}

#[tauri::command]
pub async fn get_dataset(state: State<'_, AppState>, id: String) -> AppResult<DatasetMeta> {
    state.0.dataset(&id)
}

#[tauri::command]
pub async fn rename_dataset(
    state: State<'_, AppState>,
    id: String,
    name: String,
) -> AppResult<DatasetMeta> {
    let mut meta = state.0.dataset(&id)?;
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::query("dataset name cannot be empty"));
    }
    meta.name = name.to_string();
    state.0.put_dataset(meta.clone())?;
    Ok(meta)
}

#[tauri::command]
pub async fn remove_dataset(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let s = state.0.clone();
    blocking(move || {
        s.dataset(&id)?;
        let conn = s.pool.get()?;
        conn.execute_batch(&format!(
            "DROP VIEW IF EXISTS {}; DROP TABLE IF EXISTS {};",
            quote_ident(&view_name(&id)?),
            quote_ident(&table_name(&id)?)
        ))?;
        s.datasets
            .write()
            .map_err(|_| AppError::Internal("dataset registry poisoned".into()))?
            .remove(&id);
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn preview_dataset(
    state: State<'_, AppState>,
    id: String,
    offset: u32,
    limit: u32,
    sort: Option<PreviewSort>,
) -> AppResult<PreviewPage> {
    let s = state.0.clone();
    blocking(move || {
        let meta = s.dataset(&id)?;
        let conn = s.pool.get()?;
        schema::preview(&conn, &id, &meta.columns, meta.row_count, offset, limit, sort.as_ref())
    })
    .await
}

#[tauri::command]
pub async fn column_stats(
    state: State<'_, AppState>,
    id: String,
    column: String,
) -> AppResult<ColumnStats> {
    let s = state.0.clone();
    blocking(move || {
        let meta = s.dataset(&id)?;
        let col = meta
            .column(&column)
            .ok_or_else(|| AppError::UnknownColumn(column.clone()))?;
        let conn = s.pool.get()?;
        schema::column_stats(&conn, &id, col)
    })
    .await
}

#[tauri::command]
pub async fn distinct_values(
    state: State<'_, AppState>,
    id: String,
    column: String,
    search: Option<String>,
    limit: Option<u32>,
) -> AppResult<Vec<ValueCount>> {
    let s = state.0.clone();
    blocking(move || {
        let meta = s.dataset(&id)?;
        let col = meta
            .column(&column)
            .ok_or_else(|| AppError::UnknownColumn(column.clone()))?;
        let conn = s.pool.get()?;
        schema::distinct_values(&conn, &id, col, search.as_deref(), limit.unwrap_or(200))
    })
    .await
}

/// Replace the dataset's type overrides (empty map restores detected types).
#[tauri::command]
pub async fn set_column_types(
    state: State<'_, AppState>,
    id: String,
    overrides: BTreeMap<String, LogicalType>,
) -> AppResult<DatasetMeta> {
    let s = state.0.clone();
    blocking(move || {
        let mut meta = s.dataset(&id)?;
        let overrides: BTreeMap<String, LogicalType> = overrides
            .into_iter()
            .filter(|(_, t)| *t != LogicalType::Other)
            .collect();
        let conn = s.pool.get()?;
        schema::create_view(&conn, &id, &overrides)?;
        let (columns, row_count) = schema::detect_schema(&conn, &id, &overrides)?;
        meta.columns = columns;
        meta.row_count = row_count;
        meta.type_overrides = overrides;
        s.put_dataset(meta.clone())?;
        Ok(meta)
    })
    .await
}

#[tauri::command]
pub async fn fingerprint_file(path: String) -> AppResult<Fingerprint> {
    blocking(move || import::fingerprint(&PathBuf::from(path))).await
}
