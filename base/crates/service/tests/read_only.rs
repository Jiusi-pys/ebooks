use axum::{
    body::Body,
    http::{Request, StatusCode},
    middleware,
};
use serde_json::json;
use shufang_native::workspace::Workspace;
use shufang_service::{
    replication::{tick_peer, Peer},
    router, Host,
};
use std::sync::{Arc, Mutex};
use tower::ServiceExt;

#[tokio::test]
async fn candidate_rejects_every_public_mutation_and_keeps_reads_available() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = Workspace::open(&dir.path().join("library.sqlite3"), "w", "shadow").unwrap();
    let app = router(Host::new_read_only(
        workspace,
        "owner".into(),
        "http://localhost".into(),
    ));
    for (method, path) in [
        ("POST", "/api/native/v1/notes"),
        ("PATCH", "/api/v1/books/b"),
        ("DELETE", "/api/native/v1/versions/v"),
        ("POST", "/api/v2/sync/push"),
        ("PUT", "/api/v2/blobs/uploads/u/0"),
        ("POST", "/api/v1/webhooks"),
        ("POST", "/unknown-mutation"),
        ("GET", "/oauth/authorize"),
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(path)
                    .header("x-api-key", "owner")
                    .header("content-type", "application/json")
                    .body(Body::from("{}"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            StatusCode::SERVICE_UNAVAILABLE,
            "{method} {path}"
        );
    }
    for path in ["/health", "/api/native/v1/notes"] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(path)
                    .header("x-api-key", "owner")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/mcp")
                .header("x-api-key", "owner")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"jsonrpc":"2.0","id":1,"method":"tools/list"}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
}

#[tokio::test]
async fn read_only_replication_receives_data_without_sending_operations_or_files() {
    let local = tempfile::tempdir().unwrap();
    let remote = tempfile::tempdir().unwrap();
    let a = Workspace::open(&local.path().join("library.sqlite3"), "w", "a").unwrap();
    let b = Workspace::open(&remote.path().join("library.sqlite3"), "w", "b").unwrap();
    a.core
        .lock()
        .unwrap()
        .save_note("local-only", "local", &"x".repeat(200_000), 0)
        .unwrap();
    b.core
        .lock()
        .unwrap()
        .save_note("remote", "remote", &"y".repeat(200_000), 0)
        .unwrap();
    let requests = Arc::new(Mutex::new(Vec::<String>::new()));
    let captured = requests.clone();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = router(Host::new(
        b.clone(),
        "remote-token".into(),
        format!("http://{address}"),
    ))
    .layer(middleware::from_fn(
        move |request: Request<Body>, next: middleware::Next| {
            let captured = captured.clone();
            async move {
                captured.lock().unwrap().push(format!(
                    "{} {}",
                    request.method(),
                    request.uri().path()
                ));
                next.run(request).await
            }
        },
    ));
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let host = Host::new_read_only(a.clone(), "local-token".into(), "http://localhost".into());
    let peer = Peer {
        id: "b".into(),
        url: format!("http://{address}"),
        token: "remote-token".into(),
    };
    tick_peer(&host, &peer).await.unwrap();
    tick_peer(&host, &peer).await.unwrap();
    assert_eq!(
        a.core
            .lock()
            .unwrap()
            .entity("notes", "remote")
            .unwrap()
            .value["content"],
        "y".repeat(200_000)
    );
    assert!(b
        .core
        .lock()
        .unwrap()
        .entity("notes", "local-only")
        .is_err());
    let requests = requests.lock().unwrap();
    assert!(!requests
        .iter()
        .any(|p| p.contains("/sync/push") || p.contains("/blobs/uploads")));
    assert!(requests
        .iter()
        .any(|p| p.contains("/blobs/") && p.starts_with("GET ")));
    server.abort();
}
