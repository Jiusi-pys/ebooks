use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use shufang_native::workspace::Workspace;
use shufang_service::{router, Host};
use tower::ServiceExt;

#[tokio::test]
async fn review_enrollment_and_due_queue_use_shared_core_and_revision_checks() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = Workspace::open(&dir.path().join("library.db"), "w", "r").unwrap();
    workspace.execute("save", json!({"kind":"books","id":"b","expected":0,"patch":{"title":"Book","author":"","format":"txt","chapters":[{"id":"c","title":"Chapter","paragraphs":["answer"]}]}})).unwrap();
    workspace.execute("save", json!({"kind":"highlights","id":"h","expected":0,"patch":{"bookId":"b","chapterId":"c","text":"answer","paraIndex":0,"start":0,"end":6}})).unwrap();
    let app = router(Host::new(
        workspace.clone(),
        "token".into(),
        "http://127.0.0.1:31417".into(),
    ));
    for (expected, status) in [(1, StatusCode::OK), (1, StatusCode::CONFLICT)] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/highlights/h/review-enrollment")
                    .header("X-API-Key", "token")
                    .header("Content-Type", "application/json")
                    .body(Body::from(
                        json!({"expected":expected,"enabled":true}).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), status);
    }
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/review-queue")
                .header("X-API-Key", "token")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let queue: Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(queue.as_array().unwrap().len(), 1);
    let missing = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/review-queue?studySet=missing")
                .header("X-API-Key", "token")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(missing.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn rest_requires_auth_and_calls_the_same_local_use_cases() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = Workspace::open(&dir.path().join("library.db"), "w", "r").unwrap();
    let app = router(Host::new(
        workspace.clone(),
        "test-token".into(),
        "http://127.0.0.1:31417".into(),
    ));
    let denied = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/notes")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(denied.status(), StatusCode::UNAUTHORIZED);
    let created = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/notes")
                .header("X-API-Key", "test-token")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"extId":"n","title":"API 笔记","content":"native"}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(created.status(), StatusCode::CREATED);
    assert_eq!(
        workspace.execute("list", json!({"kind":"notes"})).unwrap()[0]["value"]["title"],
        "API 笔记"
    );
    let read = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/notes")
                .header("X-API-Key", "test-token")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let body: Value =
        serde_json::from_slice(&read.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(body["notes"][0]["extId"], "n");
}

#[tokio::test]
async fn mcp_initializes_and_rejects_unknown_tools_without_running_commands() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = Workspace::open(&dir.path().join("library.db"), "w", "r").unwrap();
    let host = Host::new(
        workspace,
        "test-token".into(),
        "http://127.0.0.1:31417".into(),
    );
    let result=shufang_service::mcp::dispatch(&host,json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"shell","arguments":{"command":"bad"}}})).unwrap();
    assert!(result.get("error").is_some());
}

#[tokio::test]
async fn multipart_import_preserves_filename_and_commits_before_job_success() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = Workspace::open(&dir.path().join("library.db"), "w", "r").unwrap();
    let app = router(Host::new(
        workspace.clone(),
        "token".into(),
        "http://127.0.0.1:31417".into(),
    ));
    let body = "--boundary\r\nContent-Disposition: form-data; name=\"file\"; filename=\"API Book.txt\"\r\nContent-Type: text/plain\r\n\r\nShared Unicode 😀\r\n--boundary--\r\n";
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/books/import")
                .header("X-API-Key", "token")
                .header("Content-Type", "multipart/form-data; boundary=boundary")
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let start: Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    for _ in 0..100 {
        let job = workspace
            .execute("job", json!({"id":start["job"]}))
            .unwrap();
        if job["status"] == "completed" {
            let books = workspace.execute("list", json!({"kind":"books"})).unwrap();
            assert_eq!(books[0]["value"]["title"], "API Book");
            assert!(books.to_string().contains("Shared Unicode 😀"));
            return;
        }
        assert_ne!(job["status"], "failed", "{job}");
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("import did not complete");
}
