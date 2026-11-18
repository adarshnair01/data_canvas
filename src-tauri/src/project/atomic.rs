//! Atomic file replacement: write a sibling temp file, fsync, then rename over the target.

use std::fs::{self, File};
use std::path::{Path, PathBuf};

use crate::error::{AppError, AppResult};

fn temp_path(target: &Path) -> AppResult<PathBuf> {
    let dir = target
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let name = target
        .file_name()
        .ok_or_else(|| AppError::Io(format!("invalid file path: {}", target.display())))?
        .to_string_lossy();
    let suffix = &uuid::Uuid::new_v4().simple().to_string()[..8];
    Ok(dir.join(format!(".{name}.{suffix}.tmp")))
}

/// Run `write` against a temp file next to `target` and rename it into place only on success.
/// Readers never observe a half-written file, and a failed write leaves `target` untouched.
pub fn atomic_write(target: &Path, write: impl FnOnce(&mut File) -> AppResult<()>) -> AppResult<()> {
    let tmp = temp_path(target)?;
    let result = (|| {
        let mut file = File::create(&tmp)?;
        write(&mut file)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&tmp, target)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

pub fn atomic_write_bytes(target: &Path, bytes: &[u8]) -> AppResult<()> {
    use std::io::Write;
    atomic_write(target, |f| Ok(f.write_all(bytes)?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn leftovers(dir: &Path) -> Vec<String> {
        fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .filter(|n| n.ends_with(".tmp"))
            .collect()
    }

    #[test]
    fn replaces_target_and_cleans_up() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.datacanvas");
        fs::write(&p, b"old").unwrap();
        atomic_write_bytes(&p, b"new").unwrap();
        assert_eq!(fs::read(&p).unwrap(), b"new");
        assert!(leftovers(dir.path()).is_empty());
    }

    #[test]
    fn failed_write_keeps_original() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.datacanvas");
        fs::write(&p, b"original").unwrap();
        let r = atomic_write(&p, |f| {
            f.write_all(b"partial")?;
            Err(AppError::Internal("boom".into()))
        });
        assert!(r.is_err());
        assert_eq!(fs::read(&p).unwrap(), b"original");
        assert!(leftovers(dir.path()).is_empty());
    }
}
