use axum::{extract::State, Json};
use serde_json::json;
use shufang_native::workspace::Workspace;
use shufang_service::{webhooks, Host};
#[tokio::test]
async fn replicated_operation_does_not_emit_a_new_business_webhook() {
    let dir = tempfile::tempdir().unwrap();
    let w = Workspace::open(&dir.path().join("db"), "w", "a").unwrap();
    let h = Host::new(w.clone(), "token".into(), "http://localhost".into());
    let _ = webhooks::save(
        State(h.clone()),
        Json(json!({"url":"http://127.0.0.1:1/hook","events":["*"]})),
    )
    .await
    .unwrap();
    let op=serde_json::from_value(json!({"workspaceId":"w","replicaId":"b","operationId":"remote","kind":"notes","entityId":"n","clock":"100:0","patch":{"title":"remote","content":"text","createdAt":100,"updatedAt":100}})).unwrap();
    w.core
        .lock()
        .unwrap()
        .receive_operations(&[op], None)
        .unwrap();
    webhooks::tick(&h).await.unwrap();
    assert!(w
        .core
        .lock()
        .unwrap()
        .local_value("webhooks")
        .unwrap()
        .unwrap()
        .1["deliveries"]
        .as_object()
        .unwrap()
        .is_empty());
}
#[tokio::test]
async fn rapid_edits_and_delete_keep_committed_snapshots_after_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("db");
    let workspace = Workspace::open(&db, "w", "r").unwrap();
    let host = Host::new(workspace.clone(), "token".into(), "http://localhost".into());
    let _ = webhooks::save(
        State(host.clone()),
        Json(json!({"url":"http://127.0.0.1:1/hook","events":["*"]})),
    )
    .await
    .unwrap();
    for (expected, title) in [(0, "First"), (1, "Second")] {
        workspace.execute("save", json!({"kind":"notes","id":"n","expected":expected,"patch":{"title":title,"content":"text"}})).unwrap();
    }
    workspace
        .execute("delete", json!({"kind":"notes","id":"n","expected":2}))
        .unwrap();
    drop(host);
    drop(workspace);
    let workspace = Workspace::open(&db, "w", "r").unwrap();
    let host = Host::new(workspace.clone(), "token".into(), "http://localhost".into());
    webhooks::tick(&host).await.unwrap();
    let (_, state) = workspace
        .core
        .lock()
        .unwrap()
        .local_value("webhooks")
        .unwrap()
        .unwrap();
    let entries = state["deliveries"]
        .as_object()
        .unwrap()
        .values()
        .collect::<Vec<_>>();
    assert_eq!(entries.len(), 3);
    for (event, title) in [
        ("note.created", "First"),
        ("note.updated", "Second"),
        ("note.deleted", "Second"),
    ] {
        assert_eq!(
            entries.iter().find(|d| d["event"] == event).unwrap()["body"]["data"]["title"],
            title
        );
    }
}
#[tokio::test]
async fn queue_survives_restart_and_acknowledges_only_successful_deliveries() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("db");
    let workspace = Workspace::open(&db, "w", "r").unwrap();
    let host = Host::new(
        workspace.clone(),
        "token".into(),
        "http://127.0.0.1:31417".into(),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let _ = webhooks::save(
        State(host.clone()),
        Json(json!({"url":format!("http://{address}/hook"),"events":["note.created"]})),
    )
    .await
    .unwrap();
    workspace
        .execute(
            "save",
            json!({"kind":"notes","id":"n","expected":0,"patch":{"title":"事件","content":"正文"}}),
        )
        .unwrap();
    let receiver = tokio::spawn(async move {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut bytes = vec![0; 8192];
        let n = stream.read(&mut bytes).await.unwrap();
        assert!(String::from_utf8_lossy(&bytes[..n]).contains("note.created"));
        let wire = String::from_utf8_lossy(&bytes[..n]);
        let body: serde_json::Value =
            serde_json::from_str(wire.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(body["data"]["title"], "事件");
        assert!(body["id"].is_string());
        assert!(body["timestamp"].as_str().unwrap().ends_with('Z'));
        stream
            .write_all(b"HTTP/1.1 500 Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            .await
            .unwrap();
    });
    webhooks::tick(&host).await.unwrap();
    receiver.await.unwrap();
    drop(host);
    drop(workspace);
    let workspace = Workspace::open(&db, "w", "r").unwrap();
    let (_, state) = workspace
        .core
        .lock()
        .unwrap()
        .local_value("webhooks")
        .unwrap()
        .unwrap();
    assert_eq!(state["deliveries"].as_object().unwrap().len(), 1);
    assert_eq!(
        state["deliveries"]
            .as_object()
            .unwrap()
            .values()
            .next()
            .unwrap()["attempts"],
        1
    );
    assert_eq!(state["cursor"], 1);
    let host = Host::new(workspace, "token".into(), "http://127.0.0.1:31417".into());
    let Json(list) = webhooks::deliveries(State(host.clone())).await.unwrap();
    let id = list["deliveries"][0]["id"].as_str().unwrap();
    assert_eq!(list["deliveries"][0]["attempts"], 1);
    let _ = webhooks::retry(State(host.clone()), axum::extract::Path(id.into()))
        .await
        .unwrap();
    let Json(list) = webhooks::deliveries(State(host)).await.unwrap();
    assert_eq!(list["deliveries"][0]["attempts"], 0);
}
