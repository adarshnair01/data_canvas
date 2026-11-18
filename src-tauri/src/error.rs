use serde::ser::SerializeStruct;
use serde::{Serialize, Serializer};

pub type AppResult<T> = Result<T, AppError>;

/// Typed errors surfaced to the UI as `{ kind, message, position? }`.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("File not found: {0}")]
    FileNotFound(String),
    #[error("Unsupported file type: {0}")]
    UnsupportedFile(String),
    #[error("Unsupported encoding: {0}")]
    UnsupportedEncoding(String),
    #[error("Malformed rows: {0}")]
    MalformedRows(String),
    #[error("The file contains no data")]
    EmptyFile,
    #[error("Sheet '{0}' is empty")]
    EmptySheet(String),
    #[error("Invalid query: {0}")]
    InvalidQuery(String),
    #[error("Invalid expression: {message}")]
    InvalidExpression { message: String, position: usize },
    #[error("Unknown dataset: {0}")]
    UnknownDataset(String),
    #[error("Unknown column: {0}")]
    UnknownColumn(String),
    #[error("Query cancelled")]
    Cancelled,
    #[error("Database error: {0}")]
    Database(String),
    #[error("I/O error: {0}")]
    Io(String),
    #[error("{0}")]
    Internal(String),
}

impl AppError {
    pub fn kind(&self) -> &'static str {
        match self {
            AppError::FileNotFound(_) => "fileNotFound",
            AppError::UnsupportedFile(_) => "unsupportedFile",
            AppError::UnsupportedEncoding(_) => "unsupportedEncoding",
            AppError::MalformedRows(_) => "malformedRows",
            AppError::EmptyFile => "emptyFile",
            AppError::EmptySheet(_) => "emptySheet",
            AppError::InvalidQuery(_) => "invalidQuery",
            AppError::InvalidExpression { .. } => "invalidExpression",
            AppError::UnknownDataset(_) => "unknownDataset",
            AppError::UnknownColumn(_) => "unknownColumn",
            AppError::Cancelled => "cancelled",
            AppError::Database(_) => "database",
            AppError::Io(_) => "io",
            AppError::Internal(_) => "internal",
        }
    }

    pub fn query(msg: impl Into<String>) -> Self {
        AppError::InvalidQuery(msg.into())
    }

    pub fn expr(msg: impl Into<String>, position: usize) -> Self {
        AppError::InvalidExpression {
            message: msg.into(),
            position,
        }
    }
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut s = serializer.serialize_struct("AppError", 3)?;
        s.serialize_field("kind", self.kind())?;
        s.serialize_field("message", &self.to_string())?;
        match self {
            AppError::InvalidExpression { position, .. } => {
                s.serialize_field("position", position)?
            }
            _ => s.skip_field("position")?,
        }
        s.end()
    }
}

impl From<duckdb::Error> for AppError {
    fn from(e: duckdb::Error) -> Self {
        let msg = e.to_string();
        if msg.to_ascii_uppercase().contains("INTERRUPT") {
            AppError::Cancelled
        } else {
            AppError::Database(msg)
        }
    }
}

impl From<rusqlite::Error> for AppError {
    fn from(e: rusqlite::Error) -> Self {
        AppError::Database(e.to_string())
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        if e.kind() == std::io::ErrorKind::NotFound {
            AppError::FileNotFound(e.to_string())
        } else {
            AppError::Io(e.to_string())
        }
    }
}

impl From<tauri::Error> for AppError {
    fn from(e: tauri::Error) -> Self {
        AppError::Internal(e.to_string())
    }
}
