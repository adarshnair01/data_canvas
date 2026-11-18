//! App settings and recent projects, persisted in SQLite under the app data directory.

use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use crate::error::AppResult;

const MAX_RECENT: i64 = 20;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RecentProject {
    pub path: String,
    pub name: String,
    pub last_opened_ms: i64,
}

pub struct SettingsDb {
    conn: Connection,
}

impl SettingsDb {
    pub fn open(path: &Path) -> AppResult<Self> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        Self::init(Connection::open(path)?)
    }

    pub fn open_in_memory() -> AppResult<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> AppResult<Self> {
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             CREATE TABLE IF NOT EXISTS recent_projects (
               path TEXT PRIMARY KEY,
               name TEXT NOT NULL,
               last_opened_ms INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS settings (
               key TEXT PRIMARY KEY,
               value TEXT NOT NULL
             );",
        )?;
        Ok(Self { conn })
    }

    pub fn list_recent(&self) -> AppResult<Vec<RecentProject>> {
        let mut stmt = self.conn.prepare(
            "SELECT path, name, last_opened_ms FROM recent_projects ORDER BY last_opened_ms DESC LIMIT ?1",
        )?;
        let rows = stmt
            .query_map(params![MAX_RECENT], |r| {
                Ok(RecentProject {
                    path: r.get(0)?,
                    name: r.get(1)?,
                    last_opened_ms: r.get(2)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn add_recent(&self, path: &str, name: &str, now_ms: i64) -> AppResult<()> {
        self.conn.execute(
            "INSERT INTO recent_projects (path, name, last_opened_ms) VALUES (?1, ?2, ?3)
             ON CONFLICT(path) DO UPDATE SET name = excluded.name, last_opened_ms = excluded.last_opened_ms",
            params![path, name, now_ms],
        )?;
        self.conn.execute(
            "DELETE FROM recent_projects WHERE path NOT IN
               (SELECT path FROM recent_projects ORDER BY last_opened_ms DESC LIMIT ?1)",
            params![MAX_RECENT],
        )?;
        Ok(())
    }

    pub fn remove_recent(&self, path: &str) -> AppResult<()> {
        self.conn
            .execute("DELETE FROM recent_projects WHERE path = ?1", params![path])?;
        Ok(())
    }

    pub fn clear_recent(&self) -> AppResult<()> {
        self.conn.execute("DELETE FROM recent_projects", [])?;
        Ok(())
    }

    pub fn get(&self, key: &str) -> AppResult<Option<String>> {
        Ok(self
            .conn
            .query_row(
                "SELECT value FROM settings WHERE key = ?1",
                params![key],
                |r| r.get(0),
            )
            .optional()?)
    }

    pub fn set(&self, key: &str, value: &str) -> AppResult<()> {
        self.conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recent_projects_are_ordered_and_deduplicated() {
        let db = SettingsDb::open_in_memory().unwrap();
        db.add_recent("/a.datacanvas", "A", 1).unwrap();
        db.add_recent("/b.datacanvas", "B", 2).unwrap();
        db.add_recent("/a.datacanvas", "A2", 3).unwrap();
        let list = db.list_recent().unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].name, "A2");
        db.remove_recent("/a.datacanvas").unwrap();
        assert_eq!(db.list_recent().unwrap().len(), 1);
        db.clear_recent().unwrap();
        assert!(db.list_recent().unwrap().is_empty());
    }

    #[test]
    fn recent_projects_are_capped() {
        let db = SettingsDb::open_in_memory().unwrap();
        for i in 0..30 {
            db.add_recent(&format!("/p{i}"), "p", i).unwrap();
        }
        assert_eq!(db.list_recent().unwrap().len(), MAX_RECENT as usize);
    }

    #[test]
    fn settings_round_trip() {
        let db = SettingsDb::open_in_memory().unwrap();
        assert_eq!(db.get("theme").unwrap(), None);
        db.set("theme", "dark").unwrap();
        db.set("theme", "light").unwrap();
        assert_eq!(db.get("theme").unwrap().as_deref(), Some("light"));
    }
}
