use std::collections::HashMap;
use std::ops::Deref;
use std::sync::{Arc, Mutex};

use duckdb::{Connection, InterruptHandle};

use crate::error::{AppError, AppResult};

const MAX_IDLE: usize = 4;

/// Small pool of connections to one in-process DuckDB database.
/// Connections are cheap clones of the root database handle.
pub struct DuckPool {
    root: Mutex<Connection>,
    idle: Mutex<Vec<Connection>>,
    running: Mutex<HashMap<String, Arc<InterruptHandle>>>,
}

impl DuckPool {
    pub fn in_memory() -> AppResult<Self> {
        let conn = Connection::open_in_memory()?;
        // Offline by design: never fetch extensions at runtime.
        conn.execute_batch(
            "SET autoinstall_known_extensions = false;
             SET autoload_known_extensions = false;",
        )?;
        Ok(Self {
            root: Mutex::new(conn),
            idle: Mutex::new(Vec::new()),
            running: Mutex::new(HashMap::new()),
        })
    }

    pub fn get(&self) -> AppResult<PooledConn<'_>> {
        let existing = self.idle.lock().map_err(poisoned)?.pop();
        let conn = match existing {
            Some(c) => c,
            None => self.root.lock().map_err(poisoned)?.try_clone()?,
        };
        Ok(PooledConn {
            conn: Some(conn),
            pool: self,
        })
    }

    /// Run `f` on a pooled connection, registering it under `query_id` so it can be interrupted.
    pub fn run_cancellable<T>(
        &self,
        query_id: Option<&str>,
        f: impl FnOnce(&Connection) -> AppResult<T>,
    ) -> AppResult<T> {
        let conn = self.get()?;
        if let Some(id) = query_id {
            self.running
                .lock()
                .map_err(poisoned)?
                .insert(id.to_string(), conn.interrupt_handle());
        }
        let result = f(&conn);
        if let Some(id) = query_id {
            self.running.lock().map_err(poisoned)?.remove(id);
        }
        result
    }

    pub fn cancel(&self, query_id: &str) -> bool {
        match self.running.lock() {
            Ok(map) => match map.get(query_id) {
                Some(handle) => {
                    handle.interrupt();
                    true
                }
                None => false,
            },
            Err(_) => false,
        }
    }
}

fn poisoned<T>(_: T) -> AppError {
    AppError::Internal("connection pool lock poisoned".into())
}

pub struct PooledConn<'a> {
    conn: Option<Connection>,
    pool: &'a DuckPool,
}

impl Deref for PooledConn<'_> {
    type Target = Connection;
    fn deref(&self) -> &Connection {
        self.conn.as_ref().expect("connection present until drop")
    }
}

impl Drop for PooledConn<'_> {
    fn drop(&mut self) {
        if let Some(conn) = self.conn.take() {
            if let Ok(mut idle) = self.pool.idle.lock() {
                if idle.len() < MAX_IDLE {
                    idle.push(conn);
                }
            }
        }
    }
}
