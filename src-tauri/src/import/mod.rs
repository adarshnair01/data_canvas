pub mod csv;
pub mod xlsx;

#[cfg(test)]
mod fixture_tests;

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use sha2::{Digest, Sha256};

use crate::error::{AppError, AppResult};
use crate::model::Fingerprint;

const CHUNK: u64 = 1024 * 1024;

/// Fingerprint a source file: path, size, mtime, and SHA-256 of its first and last 1 MB.
pub fn fingerprint(path: &Path) -> AppResult<Fingerprint> {
    let meta = std::fs::metadata(path)
        .map_err(|_| AppError::FileNotFound(path.display().to_string()))?;
    let size = meta.len();
    let modified_ms = meta
        .modified()
        .ok()
        .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);

    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    hasher.update(size.to_le_bytes());
    let head_len = size.min(CHUNK);
    let mut buf = vec![0u8; head_len as usize];
    file.read_exact(&mut buf)?;
    hasher.update(&buf);
    if size > CHUNK {
        let tail_len = (size - CHUNK).min(CHUNK);
        file.seek(SeekFrom::Start(size - tail_len))?;
        let mut tail = vec![0u8; tail_len as usize];
        file.read_exact(&mut tail)?;
        hasher.update(&tail);
    }
    Ok(Fingerprint {
        path: path.display().to_string(),
        size,
        modified_ms,
        partial_sha256: hex::encode(hasher.finalize()),
    })
}

pub fn ensure_file(path: &Path) -> AppResult<()> {
    if !path.is_file() {
        return Err(AppError::FileNotFound(path.display().to_string()));
    }
    Ok(())
}

pub fn default_name(path: &Path) -> String {
    path.file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "Dataset".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn fingerprint_changes_with_content() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.csv");
        std::fs::write(&p, "a,b\n1,2\n").unwrap();
        let f1 = fingerprint(&p).unwrap();
        assert_eq!(f1.size, 8);
        assert_eq!(f1.partial_sha256.len(), 64);
        assert_eq!(fingerprint(&p).unwrap(), f1);
        std::fs::write(&p, "a,b\n1,3\n").unwrap();
        assert_ne!(fingerprint(&p).unwrap().partial_sha256, f1.partial_sha256);
    }

    #[test]
    fn fingerprint_covers_tail_of_large_files() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("big.csv");
        let mut f = File::create(&p).unwrap();
        f.write_all(&vec![b'x'; 3 * 1024 * 1024]).unwrap();
        drop(f);
        let before = fingerprint(&p).unwrap();
        let mut bytes = std::fs::read(&p).unwrap();
        let n = bytes.len();
        bytes[n - 1] = b'y';
        std::fs::write(&p, &bytes).unwrap();
        assert_ne!(fingerprint(&p).unwrap().partial_sha256, before.partial_sha256);
    }

    #[test]
    fn missing_file_is_typed() {
        assert!(matches!(
            fingerprint(Path::new("/definitely/not/here.csv")),
            Err(AppError::FileNotFound(_))
        ));
    }
}
