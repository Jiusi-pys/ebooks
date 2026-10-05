use axum::{body::Body, http::Request};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use shufang_native::workspace::Workspace;
use shufang_service::{router, Host, V1Contract};
use tower::ServiceExt;

#[tokio::test]
async fn incomplete_blob_fields_are_unavailable_instead_of_leaking_storage_references() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = Workspace::open(&dir.path().join("db"), "w", "n").unwrap();
    let op = serde_json::from_value(json!({
        "workspaceId":"w","operationId":"remote-note","replicaId":"other",
        "kind":"notes","entityId":"note","clock":"1800000000000:0000",
        "patch":{"title":"Remote","content":{"$blob":{"sha256":"a".repeat(64),"size":200000,"encoding":"json"}}},
        "unset":[],"deleted":false
    })).unwrap();
    workspace
        .core
        .lock()
        .unwrap()
        .receive_operations(&[op], None)
        .unwrap();
    let app = router(Host::with_contract(
        workspace,
        "token".into(),
        "http://localhost".into(),
        true,
        V1Contract::SyncEntities,
    ));
    for path in ["/api/v1/notes", "/api/v1/notes/note"] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(path)
                    .header("x-api-key", "token")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), 503);
        let actual: Value =
            serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        assert_eq!(actual, json!({"error":"sync_field_pending"}));
    }
}

#[tokio::test]
async fn production_contract_preserves_materialized_fields_and_filters() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = Workspace::open(&dir.path().join("db"), "w", "n").unwrap();
    workspace
        .core
        .lock()
        .unwrap()
        .save_entity("folders", "f", json!({"name":"Folder"}), vec![], 0)
        .unwrap();
    let book = json!({"title":"Book","author":"Author","format":"txt",
        "folderId":"f","chapters":[{"id":"c","title":"Chapter","paragraphs":["text"]}],
        "coverTone":12,"progress":{"chapterId":"c","ratio":0.5},
        "readingSessions":[],"outline":[{"id":"chapter:c","title":"Chapter","chapterId":"c","depth":0}]});
    let expected = workspace
        .core
        .lock()
        .unwrap()
        .save_entity("books", "b", book, vec![], 0)
        .unwrap()
        .value;
    let app = router(Host::with_contract(
        workspace,
        "token".into(),
        "http://localhost".into(),
        true,
        V1Contract::SyncEntities,
    ));
    let get = |path: &str| {
        Request::builder()
            .uri(path)
            .header("x-api-key", "token")
            .body(Body::empty())
            .unwrap()
    };
    let response = app.clone().oneshot(get("/api/v1/books/b")).await.unwrap();
    assert_eq!(response.status(), 200);
    let mut value: Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(value["extId"], "b");
    value.as_object_mut().unwrap().remove("extId");
    assert_eq!(value, expected);
    for (path, value) in [
        (
            "/api/v1/books/b/chapters",
            json!({"chapters":expected["chapters"]}),
        ),
        (
            "/api/v1/books/b/chapters/0",
            expected["chapters"][0].clone(),
        ),
        ("/api/v1/books/b/state", {
            let mut v = expected.clone();
            v["extId"] = json!("b");
            v
        }),
    ] {
        let response = app.clone().oneshot(get(path)).await.unwrap();
        assert_eq!(response.status(), 200);
        let actual: Value =
            serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        assert_eq!(actual, value);
    }
    assert_eq!(
        app.clone()
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri("/api/v1/books/b")
                    .header("x-api-key", "token")
                    .header("content-type", "application/json")
                    .body(Body::from("{\"title\":\"unsafe\"}"))
                    .unwrap()
            )
            .await
            .unwrap()
            .status(),
        503
    );
    for (path, count) in [
        ("/api/v1/books?folder=f", 1),
        ("/api/v1/books?folder=other", 0),
    ] {
        let response = app.clone().oneshot(get(path)).await.unwrap();
        assert_eq!(response.status(), 200);
        let value: Value =
            serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        assert_eq!(value["books"].as_array().unwrap().len(), count);
    }
    assert_eq!(
        app.oneshot(get("/api/v1/books/missing"))
            .await
            .unwrap()
            .status(),
        404
    );
}

#[tokio::test]
async fn production_mutation_defaults_aliases_and_retry_are_preserved() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = Workspace::open(&dir.path().join("db"), "w", "n").unwrap();
    let host = Host::with_contract(
        workspace.clone(),
        "token".into(),
        "http://localhost".into(),
        true,
        V1Contract::SyncEntities,
    );
    let input = json!({"extId":"book","title":"Book","folder":"folder"});
    let (_, axum::Json(result)) = shufang_service::legacy::create(
        axum::extract::State(host.clone()),
        axum::extract::Path("books".into()),
        axum::http::HeaderMap::new(),
        axum::Json(input.clone()),
    )
    .await
    .unwrap();
    assert_eq!(result, json!({"ok":true,"extId":"book"}));
    let record = workspace
        .execute("get", json!({"kind":"books","id":"book"}))
        .unwrap();
    assert_eq!(record["value"]["folderId"], "folder");
    assert_eq!(record["value"]["chapters"], json!([]));
    assert_eq!(record["value"]["format"], "txt");
    let axum::Json(updated) = shufang_service::legacy::update(
        axum::extract::State(host),
        axum::extract::Path(("books".into(), "book".into())),
        axum::http::HeaderMap::new(),
        axum::Json(json!({"progress":{"chapterId":"","ratio":0.5}})),
    )
    .await
    .unwrap();
    assert_eq!(updated, json!({"ok":true,"extId":"book"}));
}
#[tokio::test]
async fn production_events_preserve_metadata_and_delivery_identity() {
    let dir = tempfile::tempdir().unwrap();
    let w = Workspace::open(&dir.path().join("db"), "w", "n").unwrap();
    let h = Host::with_contract(
        w.clone(),
        "token".into(),
        "http://localhost".into(),
        true,
        V1Contract::SyncEntities,
    );
    let event = json!({"deliveryId":"public-delivery-0001","type":"note.created","data":{"extId":"note","title":"Title","content":"Content","updatedAt":42}});
    for _ in 0..2 {
        let _ = shufang_service::legacy::events(
            axum::extract::State(h.clone()),
            axum::Json(event.clone()),
        )
        .await
        .unwrap();
    }
    let r = w
        .execute("getReplica", json!({"kind":"notes","id":"note"}))
        .unwrap();
    assert_eq!(r["value"]["updatedAt"], 42);
    assert_eq!(r["revision"], 1);
    let mut changed = event.clone();
    changed["data"]["content"] = json!("different");
    assert!(
        shufang_service::legacy::events(axum::extract::State(h.clone()), axum::Json(changed))
            .await
            .is_err()
    );
    let invalid = json!({"type":"note.created","data":{"extId":"bad","title":"Title","content":"Content","updatedAt":1,"unrecognized":true}});
    assert!(
        shufang_service::legacy::events(axum::extract::State(h), axum::Json(invalid))
            .await
            .is_err()
    );
}
#[tokio::test]
async fn production_chunk_import_retains_sync_fields_and_upload_operation_id() {
    let dir = tempfile::tempdir().unwrap();
    let w = Workspace::open(&dir.path().join("db"), "w", "n").unwrap();
    let h = Host::with_contract(
        w.clone(),
        "token".into(),
        "http://localhost".into(),
        true,
        V1Contract::SyncEntities,
    );
    let chapters = json!([{"id":"c","title":"Chapter","paragraphs":["Content"]}]).to_string();
    let bytes = chapters.len();
    let started = json!({"extId":"b","uploadId":"u","chunkCount":1,"encodedBytes":bytes,"title":"Book","author":"Author","format":"txt","folder":"f","contentHash":"hash","chapterCount":1});
    for (typ, data) in [
        ("book.import.started", started),
        (
            "book.import.chunk",
            json!({"extId":"b","uploadId":"u","chunkCount":1,"index":0,"payload":chapters}),
        ),
        (
            "book.import.completed",
            json!({"extId":"b","uploadId":"u","chunkCount":1,"encodedBytes":bytes}),
        ),
    ] {
        let _ = shufang_service::legacy::events(
            axum::extract::State(h.clone()),
            axum::Json(json!({"type":typ,"data":data})),
        )
        .await
        .unwrap();
    }
    let _=shufang_service::legacy::events(axum::extract::State(h.clone()),axum::Json(json!({"type":"book.import.completed","data":{"extId":"b","uploadId":"u","chunkCount":1,"encodedBytes":bytes}}))).await.unwrap();
    let record = w
        .execute("getReplica", json!({"kind":"books","id":"b"}))
        .unwrap();
    assert_eq!(record["value"]["folderId"], "f");
    assert_eq!(record["value"]["progress"]["chapterId"], "c");
}
#[tokio::test]
async fn production_http_writes_deduplicate_keys_and_conflict_on_reuse() {
    let dir = tempfile::tempdir().unwrap();
    let w = Workspace::open(&dir.path().join("db"), "w", "n").unwrap();
    let app = router(Host::with_contract(
        w.clone(),
        "token".into(),
        "http://localhost".into(),
        false,
        V1Contract::SyncEntities,
    ));
    for title in ["Title", "Title", "Changed"] {
        let r = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/notes")
                    .header("x-api-key", "token")
                    .header("idempotency-key", "public-command-id")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({"extId":"n","title":title,"content":"Content"}).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(r.status(), if title == "Changed" { 409 } else { 200 });
    }
    assert_eq!(
        w.execute("getReplica", json!({"kind":"notes","id":"n"}))
            .unwrap()["revision"],
        1
    );
}

#[tokio::test]
async fn production_rest_webhook_is_atomic_and_keeps_api_event() {
    let dir = tempfile::tempdir().unwrap();
    let w = Workspace::open(&dir.path().join("db"), "w", "n").unwrap();
    let app = router(Host::with_contract(
        w.clone(),
        "token".into(),
        "http://localhost".into(),
        false,
        V1Contract::SyncEntities,
    ));
    let input = json!({"extId":"b","title":"Book","author":"Author","format":"txt"});
    for _ in 0..2 {
        let r = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/books")
                    .header("x-api-key", "token")
                    .header("idempotency-key", "api-book-command")
                    .header("content-type", "application/json")
                    .body(Body::from(input.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(r.status(), 200);
    }
    let core = w.core.lock().unwrap();
    let (_, state) = core
        .local_value("webhooks")
        .unwrap()
        .expect("webhook commits with entity");
    let entry = &state["overrides"]["books:b:1"];
    assert_eq!(entry["type"], "book.created");
    assert_eq!(entry["source"], "api");
    assert_eq!(entry["data"], input);
    assert_eq!(state["overrides"].as_object().unwrap().len(), 1);
}
