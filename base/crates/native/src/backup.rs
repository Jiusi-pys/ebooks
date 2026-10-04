//! Online SQLite snapshot plus immutable originals. Restore always creates a new workspace.
use crate::workspace::Result;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    io::{Read, Write},
    path::Path,
};
use zip::{write::SimpleFileOptions, ZipArchive, ZipWriter};
fn digest(path: &Path) -> Result<String> {
    let mut f = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hash = Sha256::new();
    let mut buf = [0; 65536];
    loop {
        let n = f.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hash.update(&buf[..n]);
    }
    Ok(format!("{:x}", hash.finalize()))
}
pub fn create(database: &Path, destination: &Path) -> Result<()> {
    if !destination.is_absolute() || destination.exists() {
        return Err("backup_destination_must_be_new".into());
    }
    let root = database.parent().ok_or("invalid_workspace")?;
    let blobs = crate::sync_blobs::BlobStore::new(&root.join("sync-blobs"));
    let _blob_lock = blobs.lock()?;
    let temp = tempfile::tempdir().map_err(|e| e.to_string())?;
    let snapshot = temp.path().join("library.sqlite3");
    shufang_sqlite::SqliteRepository::snapshot(database, &snapshot)?;
    let mut paths = vec![("library.sqlite3".to_owned(), snapshot)];
    // Original resources are content addressed and never modified or collected during backup.
    for folder in ["files", "credentials"] {
        let directory = root.join(folder);
        if directory.exists() {
            for entry in std::fs::read_dir(directory).map_err(|e| e.to_string())? {
                let entry = entry.map_err(|e| e.to_string())?;
                if !entry.file_type().map_err(|e| e.to_string())?.is_file() {
                    return Err("unsupported_backup_file".into());
                }
                let name = entry
                    .file_name()
                    .into_string()
                    .map_err(|_| "invalid_filename")?;
                paths.push((format!("{folder}/{name}"), entry.path()));
            }
        }
    }
    collect_blobs(root, &root.join("sync-blobs"), &mut paths)?;
    let mut output =
        tempfile::NamedTempFile::new_in(destination.parent().ok_or("invalid_destination")?)
            .map_err(|e| e.to_string())?;
    let mut zip = ZipWriter::new(output.as_file_mut());
    let options = SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Stored)
        .large_file(true);
    let mut manifest = Vec::new();
    for (name, path) in paths {
        zip.start_file(&name, options).map_err(|e| e.to_string())?;
        let mut input = std::fs::File::open(&path).map_err(|e| e.to_string())?;
        // Hash the exact bytes written, even if a credential is rotated concurrently.
        let mut hash = Sha256::new();
        let mut buffer = [0; 65536];
        loop {
            let count = input.read(&mut buffer).map_err(|e| e.to_string())?;
            if count == 0 {
                break;
            }
            zip.write_all(&buffer[..count]).map_err(|e| e.to_string())?;
            hash.update(&buffer[..count]);
        }
        manifest.push(json!({"path":name,"sha256":format!("{:x}", hash.finalize())}));
    }
    zip.start_file("manifest.json", options)
        .map_err(|e| e.to_string())?;
    zip.write_all(
        json!({"format":1,"files":manifest,"credentials":if cfg!(windows){"Windows DPAPI; same OS user required"}else{"AES-256-GCM; independent deployment key and environment references required"}})
            .to_string()
            .as_bytes(),
    )
    .map_err(|e| e.to_string())?;
    zip.finish().map_err(|e| e.to_string())?;
    output.as_file().sync_all().map_err(|e| e.to_string())?;
    output
        .persist_noclobber(destination)
        .map_err(|e| e.to_string())?;
    Ok(())
}
pub fn restore(archive: &Path, destination: &Path) -> Result<()> {
    if !destination.is_absolute() || destination.exists() {
        return Err("restore_destination_must_be_new".into());
    }
    let parent = destination.parent().ok_or("invalid_destination")?;
    let staging = tempfile::tempdir_in(parent).map_err(|e| e.to_string())?;
    let mut zip = ZipArchive::new(std::fs::File::open(archive).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    if zip.len() > 100000 {
        return Err("backup_too_large".into());
    }
    let mut total = 0u64;
    let mut names = BTreeSet::new();
    for i in 0..zip.len() {
        let mut file = zip.by_index(i).map_err(|e| e.to_string())?;
        let name = file.name().to_owned();
        let path = file.enclosed_name().ok_or("invalid_backup_path")?;
        if name.contains(['\\', ':'])
            || !names.insert(name.clone())
            || !(name == "library.sqlite3"
                || name == "manifest.json"
                || ((name.starts_with("files/") || name.starts_with("credentials/"))
                    && name.split('/').count() == 2)
                || valid_blob_path(&name))
        {
            return Err("invalid_backup_path".into());
        }
        total = total.checked_add(file.size()).ok_or("backup_too_large")?;
        if total > 100 * 1024 * 1024 * 1024
            || (name == "manifest.json" && file.size() > 32 * 1024 * 1024)
        {
            return Err("backup_too_large".into());
        }
        let target = staging.path().join(path);
        std::fs::create_dir_all(target.parent().ok_or("invalid_backup_path")?)
            .map_err(|e| e.to_string())?;
        let mut out = std::fs::File::create(target).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        if name.starts_with("credentials/") {
            use std::os::unix::fs::PermissionsExt;
            out.set_permissions(std::fs::Permissions::from_mode(0o600))
                .map_err(|_| "credential_permissions_failed")?;
            std::fs::set_permissions(
                staging.path().join("credentials"),
                std::fs::Permissions::from_mode(0o700),
            )
            .map_err(|_| "credential_permissions_failed")?;
        }
        let copied = std::io::copy(&mut file, &mut out).map_err(|e| e.to_string())?;
        if copied != file.size() {
            return Err("invalid_backup_size".into());
        }
        out.sync_all().map_err(|e| e.to_string())?;
    }
    let manifest: Value = serde_json::from_slice(
        &std::fs::read(staging.path().join("manifest.json")).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    if manifest["format"] != 1 || !names.contains("library.sqlite3") {
        return Err("invalid_backup".into());
    }
    let entries = manifest["files"].as_array().ok_or("invalid_manifest")?;
    let mut verified = BTreeSet::new();
    for entry in entries {
        let name = entry["path"].as_str().ok_or("invalid_manifest")?;
        if !names.contains(name) || name == "manifest.json" || !verified.insert(name) {
            return Err("invalid_manifest".into());
        }
        if entry["sha256"] != digest(&staging.path().join(name))? {
            return Err("backup_checksum_mismatch".into());
        }
    }
    if verified.len() + 1 != names.len() {
        return Err("incomplete_manifest".into());
    }
    shufang_sqlite::SqliteRepository::prepare_restored_database(
        &staging.path().join("library.sqlite3"),
    )?;
    // No existing workspace is ever replaced. Directory rename is on the same volume.
    std::fs::rename(staging.path(), destination).map_err(|e| e.to_string())?;
    Ok(())
}

fn valid_blob_path(name: &str) -> bool {
    let parts: Vec<_> = name.split('/').collect();
    match parts.as_slice() {
        ["sync-blobs", "objects", hash] => shufang_application::BlobManifest::valid_hash(hash),
        ["sync-blobs", "uploads", id, file] => {
            uuid::Uuid::parse_str(id).is_ok_and(|v| v.to_string() == *id)
                && (*file == "manifest.json"
                    || file
                        .parse::<u64>()
                        .is_ok_and(|n| n < 1024 && n.to_string() == *file))
        }
        _ => false,
    }
}
fn collect_blobs(
    root: &Path,
    directory: &Path,
    paths: &mut Vec<(String, std::path::PathBuf)>,
) -> Result<()> {
    for entry in std::fs::read_dir(directory).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let kind = entry.file_type().map_err(|e| e.to_string())?;
        if kind.is_symlink() {
            return Err("unsupported_backup_file".into());
        }
        let path = entry.path();
        let name = path
            .strip_prefix(root)
            .map_err(|_| "invalid_backup_path")?
            .to_str()
            .ok_or("invalid_filename")?
            .replace('\\', "/");
        if kind.is_dir() {
            if name.split('/').count() > 3 {
                return Err("invalid_backup_path".into());
            }
            collect_blobs(root, &path, paths)?;
        } else if kind.is_file() && valid_blob_path(&name) {
            if paths.len() >= 99_999 {
                return Err("backup_too_large".into());
            }
            paths.push((name, path));
        }
    }
    Ok(())
}
