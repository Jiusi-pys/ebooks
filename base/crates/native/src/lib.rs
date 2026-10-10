//! Native filesystem/network adapters. No UI framework or server routing here.
pub mod ai;
mod android_merge;
mod android_search;
pub mod attachments;
pub mod backup;
pub mod books;
pub mod credentials;
mod incoming_snapshot;
mod local_download;
pub mod metadata;
mod offline_sync;
mod pdf;
pub mod replication;
mod replication_files;
pub mod storage;
mod study_backup;
pub mod sync_blobs;
pub mod sync_config;
pub mod transport_host;
pub mod workspace;

fn dependency_path(name: &str, variable: &str) -> Result<std::path::PathBuf, String> {
    if let Some(path) = std::env::var_os(variable) {
        let path = std::path::PathBuf::from(path);
        if path.is_absolute() && path.is_file() {
            return Ok(path);
        }
        return Err(format!("invalid_dependency_path: {variable}"));
    }
    let path = std::env::current_exe()
        .map_err(|e| e.to_string())?
        .parent()
        .ok_or("invalid_executable_path")?
        .join(name);
    if !path.is_file() {
        return Err(format!("missing_dependency: {name}"));
    }
    Ok(path)
}
