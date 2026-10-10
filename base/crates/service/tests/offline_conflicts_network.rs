use serde_json::{json, Value};
use shufang_native::{
    replication::{tick_peer, Peer},
    transport_host::SyncHost,
    workspace::Workspace,
};
use shufang_service::{router, Host};
use std::sync::Arc;
async fn sync(client: &Arc<Workspace>, peer: &Peer) -> Result<(), String> {
    tick_peer(&SyncHost::new(client.clone(), false), peer).await
}
async fn start(server: Arc<Workspace>) -> (Peer, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let h = Host::new(server, "test-owner".into(), url.clone());
    let task = tokio::spawn(async move { axum::serve(listener, router(h)).await.unwrap() });
    (
        Peer {
            id: "server".into(),
            url,
            token: "test-owner".into(),
            cookie: None,
        },
        task,
    )
}
fn note(w: &Arc<Workspace>, content: &str) {
    let mut core = w.core.lock().unwrap();
    let revision = core.entity("notes", "n").map_or(0, |r| r.revision);
    core.save_entity(
        "notes",
        "n",
        json!({"title":"Conflict fixture","content":content}),
        vec![],
        revision,
    )
    .unwrap();
}
#[tokio::test]
async fn real_two_offline_clients_preserve_conflict_across_restart_and_copy_without_publishing_rejected_operation(
) {
    let s = tempfile::tempdir().unwrap();
    let a = tempfile::tempdir().unwrap();
    let b = tempfile::tempdir().unwrap();
    let server = Workspace::open(&s.path().join("library.sqlite"), "w", "server").unwrap();
    note(&server, "base");
    let (peer, task) = start(server.clone()).await;
    let path = a.path().join("library.sqlite");
    let mut local = Workspace::open(&path, "w", "a").unwrap();
    let other = Workspace::open(&b.path().join("library.sqlite"), "w", "b").unwrap();
    local.execute("enableSyncConflicts", json!({})).unwrap();
    other.execute("enableSyncConflicts", json!({})).unwrap();
    sync(&local, &peer).await.unwrap();
    sync(&other, &peer).await.unwrap();
    note(&local, "my offline 😀");
    note(&other, "other offline");
    sync(&other, &peer).await.unwrap();
    let original = local
        .core
        .lock()
        .unwrap()
        .replication_operations(0, 100)
        .unwrap()
        .into_iter()
        .find(|r| r.operation.replica_id == "a")
        .unwrap()
        .operation;
    assert_eq!(
        sync(&local, &peer).await.unwrap_err(),
        "sync_conflicts_pending"
    );
    assert_eq!(
        local
            .core
            .lock()
            .unwrap()
            .entity("notes", "n")
            .unwrap()
            .value["content"],
        "my offline 😀"
    );
    assert!(server
        .core
        .lock()
        .unwrap()
        .replication_operation(&original.operation_id)
        .unwrap()
        .is_none());
    drop(local);
    local = Workspace::open(&path, "w", "a").unwrap();
    let preview = local
        .core
        .lock()
        .unwrap()
        .sync_conflicts()
        .unwrap()
        .remove(0);
    let copied = local
        .execute(
            "resolveSyncConflict",
            json!({"id":preview["id"],"fingerprint":preview["fingerprint"],"choice":"copy"}),
        )
        .unwrap();
    sync(&local, &peer).await.unwrap();
    sync(&other, &peer).await.unwrap();
    for w in [&server, &local, &other] {
        assert_eq!(
            w.core.lock().unwrap().entity("notes", "n").unwrap().value["content"],
            "other offline"
        );
        assert_eq!(
            w.core
                .lock()
                .unwrap()
                .entity("notes", copied["copyId"].as_str().unwrap())
                .unwrap()
                .value["content"],
            "my offline 😀"
        );
    }
    assert!(server
        .core
        .lock()
        .unwrap()
        .replication_operation(&original.operation_id)
        .unwrap()
        .is_none());
    sync(&local, &peer).await.unwrap();
    assert!(local
        .execute("syncConflicts", json!({}))
        .unwrap()
        .as_array()
        .unwrap()
        .is_empty());
    task.abort();
}
#[tokio::test]
async fn independent_fields_merge_and_deleted_local_note_can_keep_server_identity() {
    let s = tempfile::tempdir().unwrap();
    let a = tempfile::tempdir().unwrap();
    let server = Workspace::open(&s.path().join("library.sqlite"), "w", "server").unwrap();
    note(&server, "base");
    let (peer, task) = start(server.clone()).await;
    let local = Workspace::open(&a.path().join("library.sqlite"), "w", "a").unwrap();
    local.execute("enableSyncConflicts", json!({})).unwrap();
    sync(&local, &peer).await.unwrap();
    let row = local.core.lock().unwrap().entity("notes", "n").unwrap();
    local.execute("save",json!({"kind":"notes","id":"n","expected":row.revision,"patch":{"content":"local body"}})).unwrap();
    let row = server.core.lock().unwrap().entity("notes", "n").unwrap();
    server.execute("save",json!({"kind":"notes","id":"n","expected":row.revision,"patch":{"title":"Independent title"}})).unwrap();
    sync(&local, &peer).await.unwrap();
    let row = local.core.lock().unwrap().entity("notes", "n").unwrap();
    assert_eq!(row.value["title"], "Independent title");
    assert_eq!(row.value["content"], "local body");
    local
        .execute(
            "delete",
            json!({"kind":"notes","id":"n","expected":row.revision}),
        )
        .unwrap();
    note(&server, "server edited after offline delete");
    assert_eq!(
        sync(&local, &peer).await.unwrap_err(),
        "sync_conflicts_pending"
    );
    let p = local
        .core
        .lock()
        .unwrap()
        .sync_conflicts()
        .unwrap()
        .remove(0);
    local
        .execute(
            "resolveSyncConflict",
            json!({"id":p["id"],"fingerprint":p["fingerprint"],"choice":"remote"}),
        )
        .unwrap();
    sync(&local, &peer).await.unwrap();
    assert_eq!(
        local
            .core
            .lock()
            .unwrap()
            .entity("notes", "n")
            .unwrap()
            .value["content"],
        "server edited after offline delete"
    );
    task.abort();
}
#[tokio::test]
async fn large_remote_body_is_hash_checked_before_preview_and_local_choice_still_synchronizes() {
    let s = tempfile::tempdir().unwrap();
    let a = tempfile::tempdir().unwrap();
    let server = Workspace::open(&s.path().join("library.sqlite"), "w", "server").unwrap();
    note(&server, "base");
    let (peer, task) = start(server.clone()).await;
    let local = Workspace::open(&a.path().join("library.sqlite"), "w", "a").unwrap();
    local.execute("enableSyncConflicts", json!({})).unwrap();
    sync(&local, &peer).await.unwrap();
    let ours = "离线正文😀".repeat(40000);
    let theirs = "另一正文😀".repeat(40000);
    note(&local, &ours);
    note(&server, &theirs);
    assert_eq!(
        sync(&local, &peer).await.unwrap_err(),
        "sync_conflicts_pending"
    );
    let row = local.execute("syncConflicts", json!({})).unwrap()[0].clone();
    let preview = local
        .execute("syncConflictPreview", json!({"id":row["id"]}))
        .unwrap();
    let path = std::path::PathBuf::from(preview["path"].as_str().unwrap());
    let data: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    assert_eq!(data["local"]["content"], ours);
    assert_eq!(data["remote"]["content"], theirs);
    local
        .execute(
            "resolveSyncConflict",
            json!({"id":data["id"],"fingerprint":data["fingerprint"],"choice":"local"}),
        )
        .unwrap();
    sync(&local, &peer).await.unwrap();
    assert_eq!(
        server
            .core
            .lock()
            .unwrap()
            .entity("notes", "n")
            .unwrap()
            .value["content"],
        ours
    );
    task.abort();
}

#[tokio::test]
async fn server_deletion_keeps_offline_body_as_new_copy_and_late_edit_requires_another_choice() {
    let s = tempfile::tempdir().unwrap();
    let a = tempfile::tempdir().unwrap();
    let server = Workspace::open(&s.path().join("library.sqlite"), "w", "server").unwrap();
    note(&server, "base");
    let (peer, task) = start(server.clone()).await;
    let local = Workspace::open(&a.path().join("library.sqlite"), "w", "a").unwrap();
    local.execute("enableSyncConflicts", json!({})).unwrap();
    sync(&local, &peer).await.unwrap();
    note(&local, "offline preserved");
    let revision = server
        .core
        .lock()
        .unwrap()
        .entity("notes", "n")
        .unwrap()
        .revision;
    server
        .execute(
            "delete",
            json!({"kind":"notes","id":"n","expected":revision}),
        )
        .unwrap();
    assert_eq!(
        sync(&local, &peer).await.unwrap_err(),
        "sync_conflicts_pending"
    );
    let p = local
        .core
        .lock()
        .unwrap()
        .sync_conflicts()
        .unwrap()
        .remove(0);
    let decision = local
        .execute(
            "resolveSyncConflict",
            json!({"id":p["id"],"fingerprint":p["fingerprint"],"choice":"local"}),
        )
        .unwrap();
    sync(&local, &peer).await.unwrap();
    assert!(local.core.lock().unwrap().entity("notes", "n").is_err());
    let copy = decision["copyId"].as_str().unwrap();
    assert_eq!(
        server
            .core
            .lock()
            .unwrap()
            .entity("notes", copy)
            .unwrap()
            .value["content"],
        "offline preserved"
    );
    task.abort();
}
#[tokio::test]
async fn failed_transport_never_acknowledges_edits_and_late_remote_change_reopens_conflict() {
    let s = tempfile::tempdir().unwrap();
    let a = tempfile::tempdir().unwrap();
    let server = Workspace::open(&s.path().join("library.sqlite"), "w", "server").unwrap();
    note(&server, "base");
    let (peer, task) = start(server.clone()).await;
    let local = Workspace::open(&a.path().join("library.sqlite"), "w", "a").unwrap();
    local.execute("enableSyncConflicts", json!({})).unwrap();
    sync(&local, &peer).await.unwrap();
    note(&local, "offline body");
    let mut unreachable = peer.clone();
    unreachable.url = "http://127.0.0.1:1".into();
    assert!(sync(&local, &unreachable).await.is_err());
    assert!(local
        .core
        .lock()
        .unwrap()
        .sync_edit("notes", "n")
        .unwrap()
        .is_some());
    note(&server, "remote first");
    assert_eq!(
        sync(&local, &peer).await.unwrap_err(),
        "sync_conflicts_pending"
    );
    let p = local
        .core
        .lock()
        .unwrap()
        .sync_conflicts()
        .unwrap()
        .remove(0);
    local
        .execute(
            "resolveSyncConflict",
            json!({"id":p["id"],"fingerprint":p["fingerprint"],"choice":"local"}),
        )
        .unwrap();
    note(&server, "remote late");
    assert_eq!(
        sync(&local, &peer).await.unwrap_err(),
        "sync_conflicts_pending"
    );
    assert_eq!(
        server
            .core
            .lock()
            .unwrap()
            .entity("notes", "n")
            .unwrap()
            .value["content"],
        "remote late"
    );
    assert_eq!(
        local
            .core
            .lock()
            .unwrap()
            .entity("notes", "n")
            .unwrap()
            .value["content"],
        "offline body"
    );
    task.abort();
}

#[tokio::test]
async fn matching_manual_edit_removes_obsolete_conflict_instead_of_leaving_stale_preview() {
    let s = tempfile::tempdir().unwrap();
    let a = tempfile::tempdir().unwrap();
    let server = Workspace::open(&s.path().join("library.sqlite"), "w", "server").unwrap();
    note(&server, "base");
    let (peer, task) = start(server.clone()).await;
    let local = Workspace::open(&a.path().join("library.sqlite"), "w", "a").unwrap();
    local.execute("enableSyncConflicts", json!({})).unwrap();
    sync(&local, &peer).await.unwrap();
    note(&local, "first local");
    note(&server, "remote value");
    assert_eq!(
        sync(&local, &peer).await.unwrap_err(),
        "sync_conflicts_pending"
    );
    note(&local, "remote value");
    sync(&local, &peer).await.unwrap();
    assert!(local
        .core
        .lock()
        .unwrap()
        .sync_conflicts()
        .unwrap()
        .is_empty());
    task.abort();
}

#[tokio::test]
async fn committed_write_with_503_receipt_loss_is_recognized_without_duplicate_or_false_conflict() {
    use axum::{
        extract::Request,
        http::StatusCode,
        middleware::{self, Next},
        response::IntoResponse,
    };
    use std::sync::atomic::{AtomicBool, Ordering};
    let s = tempfile::tempdir().unwrap();
    let a = tempfile::tempdir().unwrap();
    let server = Workspace::open(&s.path().join("library.sqlite"), "w", "server").unwrap();
    note(&server, "base");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let flag = Arc::new(AtomicBool::new(true));
    let observed = server.clone();
    let toggle = flag.clone();
    let app = router(Host::new(server.clone(), "test-owner".into(), url.clone())).layer(
        middleware::from_fn(move |request: Request, next: Next| {
            let observed = observed.clone();
            let toggle = toggle.clone();
            async move {
                let push = request.uri().path() == "/api/v2/sync/push";
                let response = next.run(request).await;
                if push
                    && observed
                        .core
                        .lock()
                        .unwrap()
                        .entity("notes", "n")
                        .unwrap()
                        .value["content"]
                        == "accepted offline"
                    && toggle.swap(false, Ordering::SeqCst)
                {
                    StatusCode::SERVICE_UNAVAILABLE.into_response()
                } else {
                    response
                }
            }
        }),
    );
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let peer = Peer {
        id: "server".into(),
        url,
        token: "test-owner".into(),
        cookie: None,
    };
    let local = Workspace::open(&a.path().join("library.sqlite"), "w", "a").unwrap();
    local.execute("enableSyncConflicts", json!({})).unwrap();
    sync(&local, &peer).await.unwrap();
    note(&local, "accepted offline");
    assert!(sync(&local, &peer).await.is_err());
    assert!(!flag.load(Ordering::SeqCst));
    assert!(local
        .core
        .lock()
        .unwrap()
        .sync_edit("notes", "n")
        .unwrap()
        .is_some());
    assert_eq!(
        server
            .core
            .lock()
            .unwrap()
            .entity("notes", "n")
            .unwrap()
            .value["content"],
        "accepted offline"
    );
    note(&server, "later confirmed remote edit");
    sync(&local, &peer).await.unwrap();
    assert!(local
        .core
        .lock()
        .unwrap()
        .sync_conflicts()
        .unwrap()
        .is_empty());
    assert!(local
        .core
        .lock()
        .unwrap()
        .sync_edit("notes", "n")
        .unwrap()
        .is_none());
    assert_eq!(
        local
            .core
            .lock()
            .unwrap()
            .entity("notes", "n")
            .unwrap()
            .value["content"],
        "later confirmed remote edit"
    );
    assert_eq!(
        server
            .core
            .lock()
            .unwrap()
            .replication_operations(0, 100)
            .unwrap()
            .iter()
            .filter(|r| r.operation.replica_id == "a")
            .count(),
        1
    );
    task.abort();
}

#[tokio::test]
async fn concurrent_opaque_ink_attachments_are_verified_and_both_copies_remain_binary() {
    let s = tempfile::tempdir().unwrap();
    let a = tempfile::tempdir().unwrap();
    let server = Workspace::open(&s.path().join("library.sqlite"), "w", "server").unwrap();
    note(&server, "base");
    let (peer, task) = start(server.clone()).await;
    let local = Workspace::open(&a.path().join("library.sqlite"), "w", "a").unwrap();
    local.execute("enableSyncConflicts", json!({})).unwrap();
    sync(&local, &peer).await.unwrap();
    let ours = b"\x00\xffPencilKit-local\x80";
    let theirs = b"\x00\xfePencilKit-remote\x81";
    let file = a.path().join("local.ink");
    std::fs::write(&file, ours).unwrap();
    let first = local
        .execute(
            "putAttachment",
            json!({"path":file,"name":"drawing.bin","type":"application/octet-stream"}),
        )
        .unwrap();
    let file = s.path().join("remote.ink");
    std::fs::write(&file, theirs).unwrap();
    let second = server
        .execute(
            "putAttachment",
            json!({"path":file,"name":"drawing.bin","type":"application/octet-stream"}),
        )
        .unwrap();
    for (w, reference) in [(&local, &first), (&server, &second)] {
        let revision = w
            .core
            .lock()
            .unwrap()
            .entity("notes", "n")
            .unwrap()
            .revision;
        w.execute(
            "save",
            json!({"kind":"notes","id":"n","expected":revision,"patch":{"pdfDrawing":reference}}),
        )
        .unwrap();
    }
    assert_eq!(
        sync(&local, &peer).await.unwrap_err(),
        "sync_conflicts_pending"
    );
    let p = local
        .core
        .lock()
        .unwrap()
        .sync_conflicts()
        .unwrap()
        .remove(0);
    let downloaded = local
        .execute("attachmentResource", json!({"reference":second}))
        .unwrap();
    assert_eq!(
        std::fs::read(downloaded["path"].as_str().unwrap()).unwrap(),
        theirs
    );
    let copied = local
        .execute(
            "resolveSyncConflict",
            json!({"id":p["id"],"fingerprint":p["fingerprint"],"choice":"copy"}),
        )
        .unwrap();
    sync(&local, &peer).await.unwrap();
    for (id, reference, bytes) in [
        ("n", &second, theirs.as_slice()),
        (copied["copyId"].as_str().unwrap(), &first, ours.as_slice()),
    ] {
        assert_eq!(
            &server
                .core
                .lock()
                .unwrap()
                .entity("notes", id)
                .unwrap()
                .value["pdfDrawing"],
            reference
        );
        let resource = server
            .execute("attachmentResource", json!({"reference":reference}))
            .unwrap();
        assert_eq!(
            std::fs::read(resource["path"].as_str().unwrap()).unwrap(),
            bytes
        );
    }
    task.abort();
}

#[tokio::test]
async fn deleted_book_local_choice_copies_learning_graph_and_synchronizes_new_references() {
    let s = tempfile::tempdir().unwrap();
    let a = tempfile::tempdir().unwrap();
    let server = Workspace::open(&s.path().join("library.sqlite"), "w", "server").unwrap();
    for (kind, id, patch) in [
        (
            "books",
            "book",
            json!({"title":"Book","author":"A","format":"txt","chapters":[{"id":"chapter","title":"One","paragraphs":["body"]}],"progress":{"chapterId":"chapter","ratio":0}}),
        ),
        (
            "notes",
            "note",
            json!({"title":"Note","content":"Local analysis"}),
        ),
        (
            "highlights",
            "card",
            json!({"bookId":"book","chapterId":"chapter","chapterTitle":"One","text":"body","noteId":"note"}),
        ),
        (
            "studySets",
            "set",
            json!({"name":"Study","bookIds":["book"]}),
        ),
    ] {
        server
            .execute(
                "save",
                json!({"kind":kind,"id":id,"expected":0,"patch":patch}),
            )
            .unwrap();
    }
    let original = s.path().join("original.txt");
    std::fs::write(&original, b"original body").unwrap();
    let reference = server
        .execute(
            "putAttachment",
            json!({"path":original,"name":"original.txt","type":"text/plain"}),
        )
        .unwrap();
    let source: shufang_application::BlobManifest =
        serde_json::from_value(reference["$attachment"].clone()).unwrap();
    server
        .core
        .lock()
        .unwrap()
        .attach_book_source("book", &source)
        .unwrap();
    let (peer, task) = start(server.clone()).await;
    let local = Workspace::open(&a.path().join("library.sqlite"), "w", "a").unwrap();
    local.execute("enableSyncConflicts", json!({})).unwrap();
    sync(&local, &peer).await.unwrap();
    let revision = local
        .core
        .lock()
        .unwrap()
        .entity("books", "book")
        .unwrap()
        .revision;
    local.execute("save",json!({"kind":"books","id":"book","expected":revision,"patch":{"title":"Offline book"}})).unwrap();
    let revision = server
        .core
        .lock()
        .unwrap()
        .entity("books", "book")
        .unwrap()
        .revision;
    server
        .execute(
            "delete",
            json!({"kind":"books","id":"book","expected":revision}),
        )
        .unwrap();
    assert_eq!(
        sync(&local, &peer).await.unwrap_err(),
        "sync_conflicts_pending"
    );
    let preview = local
        .core
        .lock()
        .unwrap()
        .sync_conflicts()
        .unwrap()
        .into_iter()
        .find(|p| p["kind"] == "books")
        .unwrap();
    let result = local
        .execute(
            "resolveSyncConflict",
            json!({"id":preview["id"],"fingerprint":preview["fingerprint"],"choice":"local"}),
        )
        .unwrap();
    let remaining = local.core.lock().unwrap().sync_conflicts().unwrap();
    for p in remaining {
        local
            .execute(
                "resolveSyncConflict",
                json!({"id":p["id"],"fingerprint":p["fingerprint"],"choice":"remote"}),
            )
            .unwrap();
    }
    sync(&local, &peer).await.unwrap();
    let book = result["copyId"].as_str().unwrap();
    let core = server.core.lock().unwrap();
    assert_eq!(
        core.entity("books", book).unwrap().value["title"],
        "Offline book"
    );
    assert_eq!(core.book_source(book).unwrap(), source);
    let card = core
        .entities("highlights")
        .unwrap()
        .into_iter()
        .find(|r| r.value["bookId"] == book)
        .unwrap();
    let note = core
        .entity("notes", card.value["noteId"].as_str().unwrap())
        .unwrap();
    assert!(note.value["content"]
        .as_str()
        .unwrap()
        .contains("Local analysis"));
    assert!(core
        .entities("studySets")
        .unwrap()
        .iter()
        .any(|r| r.value["bookIds"][0] == book));
    drop(core);
    assert_eq!(
        std::fs::read(local.book_file(book).unwrap()).unwrap(),
        b"original body"
    );
    assert_eq!(
        std::fs::read(server.book_file(book).unwrap()).unwrap(),
        b"original body"
    );
    task.abort();
}
