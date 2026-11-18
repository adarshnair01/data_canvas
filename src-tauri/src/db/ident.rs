//! Identifier validation and quoting. Every identifier that reaches SQL goes through here.

use crate::error::{AppError, AppResult};

/// Quote an identifier for DuckDB, doubling embedded quotes.
pub fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// Quote a string literal. Only used where DuckDB cannot bind a parameter
/// (table function arguments such as `read_csv_auto` paths).
pub fn quote_literal(value: &str) -> AppResult<String> {
    if value.contains('\0') {
        return Err(AppError::query("value contains a NUL character"));
    }
    Ok(format!("'{}'", value.replace('\'', "''")))
}

/// Output aliases come from the frontend and must be plain identifiers.
pub fn validate_alias(alias: &str) -> AppResult<()> {
    let mut chars = alias.chars();
    let ok = alias.len() <= 64
        && matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_');
    if ok {
        Ok(())
    } else {
        Err(AppError::query(format!("invalid alias '{alias}'")))
    }
}

pub fn validate_dataset_id(id: &str) -> AppResult<()> {
    let ok = !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit());
    if ok {
        Ok(())
    } else {
        Err(AppError::UnknownDataset(id.to_string()))
    }
}

/// Physical table holding imported rows.
pub fn table_name(id: &str) -> AppResult<String> {
    validate_dataset_id(id)?;
    Ok(format!("ds_{id}"))
}

/// View with type overrides applied; all queries read from this.
pub fn view_name(id: &str) -> AppResult<String> {
    validate_dataset_id(id)?;
    Ok(format!("dsv_{id}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_identifiers() {
        assert_eq!(quote_ident("a"), "\"a\"");
        assert_eq!(quote_ident("we\"ird"), "\"we\"\"ird\"");
        assert_eq!(quote_literal("it's").unwrap(), "'it''s'");
        assert!(quote_literal("a\0b").is_err());
    }

    #[test]
    fn validates_aliases_and_ids() {
        assert!(validate_alias("m_1").is_ok());
        assert!(validate_alias("1m").is_err());
        assert!(validate_alias("a\"; DROP TABLE x; --").is_err());
        assert!(validate_alias("").is_err());
        assert!(validate_dataset_id("abc123").is_ok());
        assert!(validate_dataset_id("abc; drop").is_err());
        assert!(validate_dataset_id("ABC").is_err());
    }
}
