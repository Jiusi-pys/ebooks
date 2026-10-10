use axum::{body::Body, http::Request, Router};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use shufang_native::workspace::Workspace;
use shufang_service::{router, Host};
use tower::ServiceExt;
async fn call(app: &Router, method: &str, path: &str, body: Value) -> (u16, Value) {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("authorization", "Bearer owner")
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status().as_u16();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap())
}
#[tokio::test]
async fn conditional_sync_rejects_late_writer_and_preserves_duplicate_receipts() {
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::open(&dir.path().join("library.sqlite"), "w", "server").unwrap();
    let app = router(Host::new(
        ws.clone(),
        "owner".into(),
        "http://127.0.0.1:31417".into(),
    ));
    assert_eq!(
        call(&app, "GET", "/api/v2/capabilities", Value::Null)
            .await
            .1["conditionalPush"],
        1
    );
    let op = json!({"workspaceId":"w","replicaId":"client","operationId":"guarded","kind":"notes","entityId":"n","clock":"101:0","patch":{"title":"Local","content":"offline"},"unset":[],"deleted":false});
    let pre = call(
        &app,
        "POST",
        "/api/v2/sync/preflight",
        json!({"operations":[op.clone()]}),
    )
    .await;
    assert_eq!(pre.0, 200);
    assert!(pre.1["entries"][0]["state"].is_null());
    ws.core
        .lock()
        .unwrap()
        .save_entity(
            "notes",
            "n",
            json!({"title":"Other","content":"late"}),
            vec![],
            0,
        )
        .unwrap();
    let condition = json!({"operations":[op.clone()],"expectedEntities":[{"operationId":"guarded","state":null}]});
    let reply = call(&app, "POST", "/api/v2/sync/push", condition.clone()).await;
    assert_eq!(reply.0, 200);
    assert_eq!(reply.1["receipts"][0]["error"], "sync_precondition_failed");
    assert_eq!(
        ws.core.lock().unwrap().entity("notes", "n").unwrap().value["content"],
        "late"
    );
    // Legacy clients still work. Then an uncertain retry is recognized before its stale guard.
    assert_eq!(
        call(
            &app,
            "POST",
            "/api/v2/sync/push",
            json!({"operations":[op]})
        )
        .await
        .0,
        200
    );
    let retry = call(&app, "POST", "/api/v2/sync/push", condition).await;
    assert_eq!(retry.1["receipts"][0]["duplicate"], true);
    assert_eq!(retry.1["receipts"][0]["persisted"], true);
}
#[tokio::test]
async fn v2_push_retry_changes_and_scoped_cursor_match_contract() {
    let dir = tempfile::tempdir().unwrap();
    let host = Host::new(
        Workspace::open(&dir.path().join("library.sqlite3"), "w", "native").unwrap(),
        "owner".into(),
        "http://127.0.0.1:31417".into(),
    );
    let app = router(host);
    let (status, cap) = call(&app, "GET", "/api/v2/capabilities", Value::Null).await;
    assert_eq!(status, 200);
    assert_eq!(cap["version"], 2);
    assert_eq!(cap["workspaceId"], "w");
    let (status, spec) = call(&app, "GET", "/api/v2/openapi.json", Value::Null).await;
    assert_eq!(status, 200);
    assert_eq!(spec["servers"][0]["url"], "/api/v2");
    assert_eq!(spec["paths"].as_object().unwrap().len(), 19);
    assert!(spec["paths"]["/mutations"]["post"].is_object());
    assert!(
        spec["paths"]["/blobs/uploads/{id}/{index}"]["put"]["requestBody"]["content"]
            ["application/octet-stream"]
            .is_object()
    );
    let op = json!({"workspaceId":"w","replicaId":"old-node","operationId":"old-op","kind":"notes","entityId":"n","clock":"101:0","patch":{"title":"网络笔记","content":"离线修改","createdAt":100,"updatedAt":101},"unset":[],"deleted":false});
    let body = json!({"operations":[op.clone()]});
    assert_eq!(
        call(&app, "POST", "/api/v2/sync/push", body.clone())
            .await
            .1["receipts"][0]["persisted"],
        true
    );
    assert_eq!(
        call(&app, "POST", "/api/v2/sync/push", body).await.1["receipts"][0]["duplicate"],
        true
    );
    let mut later = op.clone();
    later["operationId"] = json!("later-op");
    later["entityId"] = json!("later-entity");
    assert_eq!(
        call(
            &app,
            "POST",
            "/api/v2/sync/push",
            json!({"operations":[later]})
        )
        .await
        .0,
        200
    );
    assert_eq!(
        call(
            &app,
            "POST",
            "/api/v2/sync/push",
            json!({"operations":[op.clone()]})
        )
        .await
        .1["receipts"][0]["seq"],
        "1"
    );
    let (_, page) = call(&app, "GET", "/api/v2/sync/changes", Value::Null).await;
    assert_eq!(page["operations"][0], op.clone());
    assert_eq!(page["hasMore"], false);
    let path = format!(
        "/api/v2/sync/changes?cursor={}",
        page["cursor"].as_str().unwrap()
    );
    assert_eq!(
        call(&app, "GET", &path, Value::Null).await.1["operations"],
        json!([])
    );
    let mut changed = op;
    changed["patch"]["title"] = json!("tampered");
    assert_eq!(
        call(
            &app,
            "POST",
            "/api/v2/sync/push",
            json!({"operations":[changed]})
        )
        .await
        .0,
        409
    );
    let (status, snapshot) = call(&app, "POST", "/api/v2/sync/snapshots", json!({})).await;
    assert_eq!(status, 201);
    let (_, entities) = call(
        &app,
        "GET",
        &format!(
            "/api/v2/sync/snapshots/{}",
            snapshot["id"].as_str().unwrap()
        ),
        Value::Null,
    )
    .await;
    assert_eq!(
        entities["entities"][0]["fields"]["title"]["value"],
        "网络笔记"
    );
    assert_eq!(entities["cursor"], snapshot["cursor"]);
    let (_, other) = call(&app, "GET", "/api/v2/entities?kind=notes", Value::Null).await;
    assert_eq!(other["entities"].as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn node_token_is_workspace_scoped_revocable_and_not_an_owner() {
    let dir = tempfile::tempdir().unwrap();
    let app = router(Host::new(
        Workspace::open(&dir.path().join("db"), "w", "a").unwrap(),
        "owner".into(),
        "http://localhost".into(),
    ));
    let (status, credential) = call(&app, "POST", "/api/v2/peers", json!({"id":"b"})).await;
    assert_eq!(status, 201);
    let token = credential["token"].as_str().unwrap();
    for (path, workspace, expected) in [
        ("/api/v2/capabilities", "w", 200),
        ("/api/v2/capabilities", "other", 401),
        ("/api/v2/peers", "w", 403),
        ("/admin/status", "w", 401),
    ] {
        let r = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(if path.ends_with("peers") {
                        "POST"
                    } else {
                        "GET"
                    })
                    .uri(path)
                    .header("authorization", format!("Bearer {token}"))
                    .header("x-workspace-id", workspace)
                    .header("content-type", "application/json")
                    .body(Body::from("{}"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(r.status().as_u16(), expected);
    }
    assert_eq!(
        call(&app, "DELETE", "/api/v2/peers/b", Value::Null).await.0,
        200
    );
    let r = app
        .oneshot(
            Request::builder()
                .uri("/api/v2/capabilities")
                .header("authorization", format!("Bearer {token}"))
                .header("x-workspace-id", "w")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(r.status(), 401);
}

#[tokio::test]
async fn actual_http_blob_roundtrip_is_hash_verified() {
    use sha2::{Digest, Sha256};
    let dir = tempfile::tempdir().unwrap();
    let app = router(Host::new(
        Workspace::open(&dir.path().join("db"), "w", "a").unwrap(),
        "owner".into(),
        "http://localhost".into(),
    ));
    let bytes = b"native blob HTTP";
    let hash = format!("{:x}", Sha256::digest(bytes));
    let (status, upload) = call(
        &app,
        "POST",
        "/api/v2/blobs/uploads",
        json!({"sha256":hash,"size":bytes.len(),"name":"test.txt","type":"text/plain"}),
    )
    .await;
    assert_eq!(status, 201);
    let id = upload["id"].as_str().unwrap();
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri(format!("/api/v2/blobs/uploads/{id}/0"))
                .header("authorization", "Bearer owner")
                .header("x-chunk-sha256", &hash)
                .body(Body::from(bytes.to_vec()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(
        call(
            &app,
            "POST",
            &format!("/api/v2/blobs/uploads/{id}/commit"),
            json!({})
        )
        .await
        .0,
        200
    );
    let response = app
        .oneshot(
            Request::builder()
                .uri(format!("/api/v2/blobs/{hash}/chunks/0"))
                .header("authorization", "Bearer owner")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(
        &response.into_body().collect().await.unwrap().to_bytes()[..],
        bytes
    );
}

#[tokio::test]
async fn history_and_restore_preserve_tombstones_and_original_retry_content() {
    let dir = tempfile::tempdir().unwrap();
    let app = router(Host::new(
        Workspace::open(&dir.path().join("db"), "w", "a").unwrap(),
        "owner".into(),
        "http://localhost".into(),
    ));
    let op = json!({"workspaceId":"w","replicaId":"b","operationId":"create","kind":"notes","entityId":"n","clock":"101:0","patch":{"title":"original","content":"body"},"unset":[],"deleted":false});
    call(
        &app,
        "POST",
        "/api/v2/sync/push",
        json!({"operations":[op.clone()]}),
    )
    .await;
    let mut deleted = op.clone();
    deleted["operationId"] = json!("delete");
    deleted["clock"] = json!("102:0");
    deleted["deleted"] = json!(true);
    deleted["patch"] = json!({});
    call(
        &app,
        "POST",
        "/api/v2/sync/push",
        json!({"operations":[deleted]}),
    )
    .await;
    let (status, history) =
        call(&app, "GET", "/api/v2/entities/notes/n/history", Value::Null).await;
    assert_eq!(status, 200);
    assert_eq!(history["operations"][0]["operationId"], "delete");
    let body = json!({"operationId":"restore","newEntityId":"restored"});
    let (status, first) = call(
        &app,
        "POST",
        "/api/v2/entities/notes/n/restore",
        body.clone(),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(first["entityId"], "restored");
    assert_eq!(first["receipt"]["duplicate"], false);
    let mut changed = op;
    changed["operationId"] = json!("late");
    changed["clock"] = json!("103:0");
    changed["patch"]["title"] = json!("changed source");
    call(
        &app,
        "POST",
        "/api/v2/sync/push",
        json!({"operations":[changed]}),
    )
    .await;
    let (_, retry) = call(&app, "POST", "/api/v2/entities/notes/n/restore", body).await;
    assert_eq!(retry["receipt"]["duplicate"], true);
    assert_eq!(retry["receipt"]["seq"], first["receipt"]["seq"]);
    let (_, restored) = call(
        &app,
        "GET",
        "/api/v2/entities/notes/restored/history",
        Value::Null,
    )
    .await;
    assert_eq!(restored["operations"][0]["patch"]["title"], "original");
    assert_eq!(
        call(
            &app,
            "POST",
            "/api/v2/entities/notes/n/restore",
            json!({"operationId":"other","newEntityId":"n"})
        )
        .await
        .0,
        400
    );
    assert_eq!(
        call(
            &app,
            "POST",
            "/api/v2/entities/notes/n/restore",
            json!({"operationId":"restore","newEntityId":"different"})
        )
        .await
        .0,
        409
    );
}

#[tokio::test]
async fn owner_can_configure_headless_sync_without_exposing_environment_credentials() {
    let dir = tempfile::tempdir().unwrap();
    let app = router(Host::new(
        Workspace::open(&dir.path().join("db"), "w", "a").unwrap(),
        "owner".into(),
        "http://localhost".into(),
    ));
    assert_eq!(
        call(&app, "GET", "/admin/sync", Value::Null).await.1["config"]["paused"],
        true
    );
    assert_eq!(call(&app,"POST","/admin/sync/peers",json!({"expected":0,"id":"b","url":"https://books.example.test","tokenEnvironment":"SHUFANG_PEER_TOKEN"})).await.0,200);
    assert_eq!(
        call(
            &app,
            "PATCH",
            "/admin/sync",
            json!({"expected":1,"paused":false})
        )
        .await
        .0,
        200
    );
    assert_eq!(
        call(&app, "POST", "/admin/sync/run", json!({})).await.1["requested"],
        1
    );
    let (_, state) = call(&app, "GET", "/admin/sync", Value::Null).await;
    assert!(!state.to_string().contains("SHUFANG_PEER_TOKEN"));
    assert_eq!(state["config"]["revision"], 2);
    assert_eq!(
        call(&app, "DELETE", "/admin/sync/peers/b", json!({"expected":2}))
            .await
            .0,
        200
    );
}

#[tokio::test]
async fn mutations_cascade_atomically_and_replay_the_original_receipt() {
    let dir = tempfile::tempdir().unwrap();
    let app = router(Host::new(
        Workspace::open(&dir.path().join("db"), "w", "native").unwrap(),
        "owner".into(),
        "http://localhost".into(),
    ));
    let seed = [
        ("books", "b", json!({"title":"Book"})),
        ("sources", "b", json!({"name":"book.epub"})),
        ("highlights", "h", json!({"bookId":"b","noteId":"n"})),
        ("translations", "t", json!({"bookId":"b"})),
        ("mindMaps", "m", json!({"bookId":"b"})),
        (
            "associations",
            "a",
            json!({"source":{"bookId":"b"},"target":{"bookId":"other"}}),
        ),
        (
            "studySets",
            "s",
            json!({"name":"Set","@member:b":true,"@member:other":true}),
        ),
        ("notes", "n", json!({"title":"Keep"})),
    ];
    for (kind, id, patch) in seed {
        let operation = json!({"workspaceId":"w","replicaId":"old","operationId":format!("seed-{kind}-{id}"),"kind":kind,"entityId":id,"clock":"100:0","patch":patch,"unset":[],"deleted":false});
        assert_eq!(
            call(
                &app,
                "POST",
                "/api/v2/sync/push",
                json!({"operations":[operation]})
            )
            .await
            .0,
            200
        );
    }
    let input = json!({"operationId":"remove-book","kind":"books","entityId":"b","deleted":true});
    let (status, first) = call(&app, "POST", "/api/v2/mutations", input.clone()).await;
    assert_eq!(status, 200);
    assert_eq!(first["duplicate"], false);
    let (_, entities) = call(&app, "GET", "/api/v2/entities", Value::Null).await;
    let states = entities["entities"].as_array().unwrap();
    for id in ["b", "h", "t", "m", "a"] {
        assert!(states
            .iter()
            .filter(|s| s["id"] == id)
            .all(|s| s["deleted"] == true));
    }
    assert_eq!(
        states.iter().find(|s| s["id"] == "s").unwrap()["fields"]["@member:b"]["removed"],
        true
    );
    assert_eq!(
        states.iter().find(|s| s["id"] == "n").unwrap()["deleted"],
        false
    );
    let before = call(&app, "GET", "/api/v2/status", Value::Null).await.1["sequence"].clone();
    let (_, retry) = call(&app, "POST", "/api/v2/mutations", input).await;
    assert_eq!(retry["duplicate"], true);
    assert_eq!(retry["seq"], first["seq"]);
    assert_eq!(
        call(&app, "GET", "/api/v2/status", Value::Null).await.1["sequence"],
        before
    );
    assert_eq!(call(&app,"POST","/api/v2/mutations",json!({"operationId":"remove-book","kind":"books","entityId":"different","deleted":true})).await.0,409);
    assert_eq!(
        call(
            &app,
            "POST",
            "/api/v2/mutations",
            json!({"operationId":"bad","kind":"books","entityId":"bad id","deleted":true})
        )
        .await
        .0,
        400
    );
    assert_eq!(
        call(&app, "GET", "/api/v2/status", Value::Null).await.1["sequence"],
        before
    );
}

#[tokio::test]
async fn mutation_reference_cleanup_and_immutable_reviews_match_old_v2() {
    let dir = tempfile::tempdir().unwrap();
    let app = router(Host::new(
        Workspace::open(&dir.path().join("db"), "w", "native").unwrap(),
        "owner".into(),
        "http://localhost".into(),
    ));
    for (kind, id, patch) in [
        ("folders", "f", json!({"name":"Folder"})),
        ("books", "b", json!({"folderId":"f"})),
        ("notes", "n", json!({"title":"Note"})),
        ("highlights", "h", json!({"noteId":"n"})),
    ] {
        assert_eq!(call(&app,"POST","/api/v2/mutations",json!({"operationId":format!("create-{id}"),"kind":kind,"entityId":id,"patch":patch})).await.0,200);
    }
    for (kind, id) in [("folders", "f"), ("notes", "n")] {
        assert_eq!(call(&app,"POST","/api/v2/mutations",json!({"operationId":format!("delete-{id}"),"kind":kind,"entityId":id,"deleted":true})).await.0,200);
    }
    let states = call(&app, "GET", "/api/v2/entities", Value::Null).await.1;
    for (id, field) in [("b", "folderId"), ("h", "noteId")] {
        let state = states["entities"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["id"] == id)
            .unwrap();
        assert_eq!(state["deleted"], false);
        assert_eq!(state["fields"][field]["removed"], true);
    }
    let body = json!({"operationId":"review-event","kind":"reviews","entityId":"ignored","patch":{"rating":3}});
    assert_eq!(
        call(&app, "POST", "/api/v2/mutations", body.clone())
            .await
            .0,
        200
    );
    assert_eq!(
        call(&app, "POST", "/api/v2/mutations", body).await.1["duplicate"],
        true
    );
    assert_eq!(
        call(
            &app,
            "POST",
            "/api/v2/mutations",
            json!({"operationId":"review-event","kind":"reviews","patch":{"rating":4}})
        )
        .await
        .0,
        409
    );
    assert_eq!(
        call(
            &app,
            "POST",
            "/api/v2/mutations",
            json!({"operationId":"delete-review","kind":"reviews","deleted":true})
        )
        .await
        .0,
        409
    );
}

#[tokio::test]
async fn mutations_flatten_fields_and_push_rejects_invalid_known_projection_fields() {
    let dir = tempfile::tempdir().unwrap();
    let app = router(Host::new(
        Workspace::open(&dir.path().join("db"), "w", "native").unwrap(),
        "owner".into(),
        "http://localhost".into(),
    ));
    assert_eq!(call(&app,"POST","/api/v2/mutations",json!({"operationId":"set","kind":"studySets","entityId":"s","patch":{"bookIds":["b","c"]}})).await.0,200);
    let (_, history) = call(
        &app,
        "GET",
        "/api/v2/entities/studySets/s/history",
        Value::Null,
    )
    .await;
    assert_eq!(
        history["operations"][0]["patch"],
        json!({"@member:b":true,"@member:c":true})
    );
    let invalid = json!({"workspaceId":"w","replicaId":"old","operationId":"bad-note","kind":"notes","entityId":"n","clock":"101:0","patch":{"title":42}});
    assert_eq!(
        call(
            &app,
            "POST",
            "/api/v2/sync/push",
            json!({"operations":[invalid]})
        )
        .await
        .0,
        400
    );
    assert_eq!(
        call(
            &app,
            "POST",
            "/api/v2/mutations",
            json!({"operationId":"bad-source","kind":"sources","entityId":"b","patch":{"size":-1}})
        )
        .await
        .0,
        400
    );
    assert_eq!(
        call(&app, "GET", "/api/v2/status", Value::Null).await.1["sequence"],
        "1"
    );
}
