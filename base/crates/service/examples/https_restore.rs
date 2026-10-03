//! Acceptance against an authorized peer into a fresh, independent workspace.
use serde_json::json;
use shufang_native::workspace::Workspace;
use shufang_service::{
    replication::{tick_peer, Peer},
    Host,
};
use std::{path::PathBuf, sync::Arc};

#[tokio::main]
async fn main() -> Result<(), String> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 5 {
        return Err("usage: https_restore new-directory workspace peer-id https-origin".into());
    }
    let root = PathBuf::from(&args[1]);
    if root.exists() {
        return Err("acceptance_destination_exists".into());
    }
    let token =
        std::env::var("SHUFANG_ACCEPTANCE_TOKEN").map_err(|_| "acceptance_token_required")?;
    std::fs::create_dir_all(&root).map_err(|_| "acceptance_directory_failed")?;
    let path = root.join("library.sqlite3");
    let workspace = Workspace::open(&path, &args[2], "https-acceptance")?;
    let host = Host::new(
        Arc::clone(&workspace),
        "local-acceptance-only".into(),
        "http://localhost".into(),
    );
    tick_peer(
        &host,
        &Peer {
            id: args[3].clone(),
            url: args[4].clone(),
            token,
        },
    )
    .await?;
    let (sequence, counts, books) = {
        let core = workspace.core.lock().map_err(|_| "core_lock_failed")?;
        let mut counts = serde_json::Map::new();
        for kind in [
            "books",
            "folders",
            "notes",
            "highlights",
            "associations",
            "translations",
            "mindMaps",
            "studySets",
            "preferences",
        ] {
            let records = core.entities(kind)?;
            if records.iter().any(|r| !r.pending_fields.is_empty()) {
                return Err("acceptance_fields_pending".into());
            }
            counts.insert(kind.into(), records.len().into());
        }
        let books = core
            .entities("books")?
            .into_iter()
            .map(|r| {
                r.value["id"]
                    .as_str()
                    .ok_or("invalid_book_id")
                    .map(str::to_owned)
            })
            .collect::<Result<Vec<_>, _>>()?;
        (core.replication_head()?.sequence, counts, books)
    };
    for id in &books {
        workspace.book_file(id)?;
    }
    drop(host);
    drop(workspace);
    let reopened = Workspace::open(&path, &args[2], "https-acceptance")?;
    let core = reopened.core.lock().map_err(|_| "core_lock_failed")?;
    if core.replication_head()?.sequence != sequence {
        return Err("acceptance_restart_log_changed".into());
    }
    for (kind, count) in &counts {
        if core.entities(kind)?.len() as u64 != count.as_u64().ok_or("acceptance_count_invalid")? {
            return Err("acceptance_restart_count_changed".into());
        }
    }
    drop(core);
    for id in &books {
        reopened.book_file(id)?;
    }
    println!(
        "{}",
        json!({"https":true,"restart":true,"originalOperations":sequence,"originalsOpened":books.len(),"liveRecords":counts,"scope":"native-peer-restore-not-production-cutover"})
    );
    Ok(())
}
