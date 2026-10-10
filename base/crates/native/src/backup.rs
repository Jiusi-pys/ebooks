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
    let temp = tempfile::tempdir_in(root).map_err(|e| e.to_string())?;
    let snapshot = temp.path().join("library.sqlite3");
    shufang_sqlite::SqliteRepository::snapshot(database, &snapshot)?;
    create_archive(root, destination, &snapshot, "library.sqlite3", 1)
}
fn create_archive(
    root: &Path,
    destination: &Path,
    snapshot: &Path,
    database_name: &str,
    format: u32,
) -> Result<()> {
    let mut paths = vec![(database_name.to_owned(), snapshot.to_path_buf())];
    // Original resources are content addressed and never modified or collected during backup.
    for folder in ["files", "credentials", "auth"] {
        if cfg!(target_os = "android") && ["credentials", "auth"].contains(&folder) {
            continue;
        }
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
        json!({"format":format,"files":manifest,"credentials":if cfg!(windows){"Windows DPAPI; same OS user required"}else{"AES-256-GCM; independent deployment key and environment references required"}})
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
    let staging = extract_verified(archive, parent, 1, "library.sqlite3")?;
    shufang_sqlite::SqliteRepository::prepare_restored_database(
        &staging.path().join("library.sqlite3"),
    )?;
    // No existing workspace is ever replaced. Directory rename is on the same volume.
    std::fs::rename(staging.path(), destination).map_err(|e| e.to_string())?;
    Ok(())
}

fn extract_verified(
    archive: &Path,
    parent: &Path,
    format: u32,
    database_name: &str,
) -> Result<tempfile::TempDir> {
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
            || !(name == database_name
                || name == "manifest.json"
                || ((name.starts_with("files/")
                    || (name.starts_with("credentials/") || name.starts_with("auth/")))
                    && name.split('/').count() == 2)
                || valid_blob_path(&name))
        {
            return Err("invalid_backup_path".into());
        }
        total = total.checked_add(file.size()).ok_or("backup_too_large")?;
        if total > 100 * 1024 * 1024 * 1024
            || (name == "manifest.json" && file.size() > 32 * 1024 * 1024)
            || (name == "mysql.dump.json" && file.size() > 256 * 1024 * 1024)
        {
            return Err("backup_too_large".into());
        }
        let target = staging.path().join(path);
        std::fs::create_dir_all(target.parent().ok_or("invalid_backup_path")?)
            .map_err(|e| e.to_string())?;
        let mut out = std::fs::File::create(&target).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        if name.starts_with("credentials/") || name.starts_with("auth/") {
            use std::os::unix::fs::PermissionsExt;
            out.set_permissions(std::fs::Permissions::from_mode(0o600))
                .map_err(|_| "credential_permissions_failed")?;
            std::fs::set_permissions(
                target.parent().ok_or("invalid_backup_path")?,
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
    if manifest["format"] != format || !names.contains(database_name) {
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
    Ok(staging)
}

fn valid_blob_path(name: &str) -> bool {
    let parts: Vec<_> = name.split('/').collect();
    match parts.as_slice() {
        ["sync-blobs", "objects", hash] => shufang_application::BlobManifest::valid_hash(hash),
        ["sync-blobs", "legacy", book, hash, index] => {
            shufang_application::BlobManifest::valid_hash(book)
                && shufang_application::BlobManifest::valid_hash(hash)
                && index
                    .parse::<u64>()
                    .is_ok_and(|n| n < 1024 && n.to_string() == *index)
        }
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
            if name.split('/').count() > 4 {
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

#[cfg(feature = "server-mysql")]
pub fn create_mysql(
    repository: &shufang_mysql::MysqlRepository,
    root: &Path,
    destination: &Path,
) -> Result<()> {
    if !destination.is_absolute() || destination.exists() {
        return Err("backup_destination_must_be_new".into());
    }
    let blobs = crate::sync_blobs::BlobStore::new(&root.join("sync-blobs"));
    let _lock = blobs.lock()?;
    let temp = tempfile::tempdir().map_err(|e| e.to_string())?;
    let snapshot = temp.path().join("mysql.dump.json");
    let file = std::fs::File::create(&snapshot).map_err(|e| e.to_string())?;
    serde_json::to_writer(file, &repository.dump()?).map_err(|e| e.to_string())?;
    if std::fs::metadata(&snapshot)
        .map_err(|e| e.to_string())?
        .len()
        > 256 * 1024 * 1024
    {
        return Err("backup_too_large".into());
    }
    create_archive(root, destination, &snapshot, "mysql.dump.json", 2)
}
#[cfg(feature = "server-mysql")]
pub fn restore_mysql(archive: &Path, destination: &Path, url: &str) -> Result<String> {
    if !destination.is_absolute() || destination.exists() {
        return Err("restore_destination_must_be_new".into());
    }
    let staging = extract_verified(
        archive,
        destination.parent().ok_or("invalid_destination")?,
        2,
        "mysql.dump.json",
    )?;
    let dump: shufang_mysql::backup::Dump = serde_json::from_reader(
        std::fs::File::open(staging.path().join("mysql.dump.json")).map_err(|e| e.to_string())?,
    )
    .map_err(|_| "invalid_mysql_backup")?;
    // A database commit and filesystem publication cannot share one transaction.
    // Keep verified files and a durable journal until both stages are complete.
    std::fs::write(
        staging.path().join("restore.pending"),
        b"mysql restore in progress\n",
    )
    .map_err(|_| "restore_journal_failed")?;
    let recovery = staging.keep();
    let database = shufang_mysql::backup::restore(url, &dump)
        .map_err(|e| format!("{e}; verified files retained at {}", recovery.display()))?;
    std::fs::write(
        recovery.join("restore.database-committed"),
        database.as_bytes(),
    )
    .map_err(|_| {
        format!(
            "restore_publication_failed; committed database and files retained at {}",
            recovery.display()
        )
    })?;
    std::fs::rename(&recovery, destination).map_err(|_| {
        format!(
            "restore_publication_failed; committed database and files retained at {}",
            recovery.display()
        )
    })?;
    std::fs::remove_file(destination.join("restore.pending"))
        .map_err(|_| "restore_completion_journal_failed")?;
    Ok(database)
}
