use axum::{body::Body, http::Request, Router};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use shufang_native::workspace::Workspace;
use shufang_service::{router, Host};
use tower::ServiceExt;
#[tokio::test]
async fn repeated_delete_events_with_distinct_deliveries_are_idempotent() {
    let dir = tempfile::tempdir().unwrap();
    let w = Workspace::open(&dir.path().join("db"), "w", "r").unwrap();
    let app = router(Host::new(w, "token".into(), "http://localhost".into()));
    assert_eq!(
        request(
            &app,
            "POST",
            "/api/v1/notes",
            json!({"extId":"n","title":"Note","content":"text"})
        )
        .await
        .0,
        201
    );
    for id in ["delete-delivery-01", "delete-delivery-02"] {
        assert_eq!(
            request(
                &app,
                "POST",
                "/api/v1/events",
                json!({"deliveryId":id,"type":"note.deleted","data":{"extId":"n"}})
            )
            .await
            .0,
            200
        );
    }
    assert_eq!(request(&app, "POST", "/api/v1/events", json!({"deliveryId":"create-delivery-01","type":"note.created","data":{"extId":"n","title":"Resurrection","content":"text"}})).await.0, 409);
}
#[tokio::test]
async fn structured_author_and_chapter_limits_match_old_clients() {
    let dir = tempfile::tempdir().unwrap();
    let w = Workspace::open(&dir.path().join("db"), "w", "r").unwrap();
    let app = router(Host::new(w, "token".into(), "http://localhost".into()));
    let book = json!({"extId":"b","title":"结构作者","metadata":{"version":1,"contributors":[{"name":"作者","role":"author"}]},"chapters":[]});
    assert_eq!(request(&app, "POST", "/api/v1/books", book).await.0, 201);
    assert_eq!(
        request(&app, "GET", "/api/v1/books/b", Value::Null).await.1["author"],
        "作者"
    );
    assert_eq!(request(&app,"POST","/api/v1/books",json!({"extId":"bad","title":"Bad","chapters":[{"id":"c","title":"c","paragraphs":["a".repeat(20001)]}]})).await.0,400);
}
#[tokio::test]
async fn association_identity_and_unrelated_filters_match_old_rest() {
    let dir = tempfile::tempdir().unwrap();
    let w = Workspace::open(&dir.path().join("db"), "w", "r").unwrap();
    let app = router(Host::new(w, "token".into(), "http://localhost".into()));
    let b = json!({"extId":"b","title":"书","chapters":[{"id":"c","title":"章","paragraphs":["abcd"]}]});
    assert_eq!(request(&app, "POST", "/api/v1/books", b).await.0, 201);
    request(
        &app,
        "POST",
        "/api/v1/notes",
        json!({"extId":"n","title":"笔记","content":"a"}),
    )
    .await;
    assert_eq!(
        request(&app, "GET", "/api/v1/notes?book=ignored", Value::Null)
            .await
            .1["notes"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let source = json!({"kind":"text","bookId":"b","chapterId":"c","chapterTitle":"章","paraIndex":0,"start":0,"end":1,"text":"a"});
    let target = json!({"kind":"text","bookId":"b","chapterId":"c","chapterTitle":"章","paraIndex":0,"start":1,"end":2,"text":"b"});
    let pair = shufang_domain::associations::pair_key(&source, &target, "bidirectional").unwrap();
    let mut body = json!({"extId":"a","source":source,"target":target,"direction":"bidirectional","pairKey":"wrong","createdAt":123,"updatedAt":124});
    assert_eq!(
        request(&app, "POST", "/api/v1/associations", body.clone())
            .await
            .0,
        400
    );
    body["pairKey"] = pair.clone().into();
    assert_eq!(
        request(&app, "POST", "/api/v1/associations", body.clone())
            .await
            .0,
        201
    );
    let replay = request(&app, "POST", "/api/v1/associations", body.clone()).await;
    assert_eq!(replay.0, 200);
    assert_eq!(replay.1["created"], false);
    assert_eq!(
        request(&app, "GET", "/api/v1/associations/a", Value::Null)
            .await
            .1["createdAt"],
        123
    );
    body["extId"] = "duplicate".into();
    assert_eq!(
        request(&app, "POST", "/api/v1/associations", body).await.0,
        409
    );
    assert_eq!(
        request(&app, "GET", "/api/v1/associations/a", Value::Null)
            .await
            .1["pairKey"],
        pair
    );
}
async fn request(app: &Router, method: &str, path: &str, body: Value) -> (u16, Value) {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("Authorization", "Bearer token")
                .header("Content-Type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status().as_u16();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}
#[tokio::test]
async fn old_rest_shapes_upserts_filters_and_utf16_counts() {
    let dir = tempfile::tempdir().unwrap();
    let w = Workspace::open(&dir.path().join("db"), "w", "r").unwrap();
    let app = router(Host::new(
        w.clone(),
        "token".into(),
        "http://localhost".into(),
    ));
    let book = json!({"extId":"b","title":"书","chapters":[{"id":"c","title":"章","paragraphs":["中文😀"]}],"folder":"阅读"});
    assert_eq!(
        request(&app, "POST", "/api/v1/books", book.clone()).await,
        (201, json!({"ok":true,"extId":"b"}))
    );
    assert_eq!(request(&app, "POST", "/api/v1/books", book).await.0, 201);
    let (_, detail) = request(&app, "GET", "/api/v1/books/b", Value::Null).await;
    assert_eq!(detail["chapterCount"], 1);
    assert!(detail.get("chapters").is_none());
    assert!(detail.get("sourceFile").is_none());
    assert_eq!(
        request(&app, "GET", "/api/v1/books?folder=missing", Value::Null)
            .await
            .1["books"],
        json!([])
    );
    let (_, chapters) = request(&app, "GET", "/api/v1/books/b/chapters", Value::Null).await;
    assert_eq!(chapters["chapters"][0]["chars"], 4);
    assert_eq!(chapters["chapters"][0]["paragraphs"], 1);
    assert_eq!(
        request(&app, "GET", "/api/v1/books/b/chapters/0", Value::Null)
            .await
            .1["index"],
        0
    );
    assert!(request(&app, "GET", "/api/v1/books/b/state", Value::Null)
        .await
        .1["state"]
        .is_object());
    assert_eq!(
        request(
            &app,
            "POST",
            "/api/v1/notes",
            json!({"extId":"n","title":"笔记","content":"😀"})
        )
        .await
        .0,
        201
    );
    let (_, notes) = request(&app, "GET", "/api/v1/notes", Value::Null).await;
    assert_eq!(notes["notes"][0]["chars"], 2);
    assert!(notes["notes"][0].get("content").is_none());
    let h = json!({"extId":"h","bookExtId":"b","text":"全书引用","citationLevel":"book","noteExtId":"n"});
    assert_eq!(request(&app, "POST", "/api/v1/highlights", h).await.0, 201);
    let (_, highlights) = request(&app, "GET", "/api/v1/highlights?book=b", Value::Null).await;
    assert_eq!(highlights["highlights"][0]["bookTitle"], "书");
    assert_eq!(highlights["highlights"][0]["style"]["kind"], "underline");
    assert!(
        w.execute("get", json!({"kind":"notes","id":"n"})).unwrap()["value"]["content"]
            .as_str()
            .unwrap()
            .contains("全书引用")
    );
    assert_eq!(
        request(
            &app,
            "PATCH",
            "/api/v1/highlights/h",
            json!({"noteExtId":null})
        )
        .await
        .1,
        json!({"ok":true})
    );
    assert!(
        !w.execute("get", json!({"kind":"notes","id":"n"})).unwrap()["value"]["content"]
            .as_str()
            .unwrap()
            .contains("全书引用")
    );
    assert_eq!(
        request(&app, "DELETE", "/api/v1/books/b", Value::Null)
            .await
            .0,
        200
    );
    assert_eq!(
        request(
            &app,
            "POST",
            "/api/v1/books",
            json!({"extId":"b","title":"复活","chapters":[]})
        )
        .await
        .0,
        409
    );
}
#[tokio::test]
async fn events_are_idempotent_and_chunk_completion_is_atomic() {
    let dir = tempfile::tempdir().unwrap();
    let w = Workspace::open(&dir.path().join("db"), "w", "r").unwrap();
    let app = router(Host::new(
        w.clone(),
        "token".into(),
        "http://localhost".into(),
    ));
    let event = json!({"deliveryId":"delivery-00000001","type":"note.created","data":{"extId":"n","title":"标题","content":"正文","updatedAt":1}});
    assert_eq!(
        request(&app, "POST", "/api/v1/events", event.clone())
            .await
            .0,
        200
    );
    assert_eq!(
        request(&app, "POST", "/api/v1/events", event.clone())
            .await
            .1["duplicate"],
        true
    );
    let mut conflict = event;
    conflict["data"]["title"] = json!("changed");
    assert_eq!(
        request(&app, "POST", "/api/v1/events", conflict).await.0,
        409
    );
    assert_eq!(
        w.execute("get", json!({"kind":"notes","id":"n"})).unwrap()["revision"],
        1
    );
    let payload = json!([{"id":"c","title":"章","paragraphs":["正文😀"]}]).to_string();
    let bytes = payload.len();
    let start = json!({"deliveryId":"delivery-start-01","type":"book.import.started","data":{"extId":"b","uploadId":"u","chunkCount":1,"encodedBytes":bytes,"title":"大书","author":"","format":"epub","chapterCount":1}});
    assert_eq!(request(&app, "POST", "/api/v1/events", start).await.0, 200);
    let complete = json!({"deliveryId":"delivery-complete1","type":"book.import.completed","data":{"extId":"b","uploadId":"u","chunkCount":1,"encodedBytes":bytes}});
    assert_eq!(
        request(&app, "POST", "/api/v1/events", complete.clone())
            .await
            .0,
        409
    );
    let chunk = json!({"deliveryId":"delivery-chunk-01","type":"book.import.chunk","data":{"extId":"b","uploadId":"u","chunkCount":1,"index":0,"payload":payload}});
    assert_eq!(request(&app, "POST", "/api/v1/events", chunk).await.0, 200);
    assert_eq!(
        request(&app, "POST", "/api/v1/events", complete).await.0,
        200
    );
    assert_eq!(
        w.execute("get", json!({"kind":"books","id":"b"})).unwrap()["value"]["chapters"][0]
            ["paragraphs"][0],
        "正文😀"
    );
}
#[tokio::test]
async fn due_digest_and_ai_routes_have_old_contracts_and_safe_failure() {
    let dir = tempfile::tempdir().unwrap();
    let w = Workspace::open(&dir.path().join("db"), "w", "r").unwrap();
    let app = router(Host::new(w, "token".into(), "http://localhost".into()));
    let (status, due) = request(&app, "GET", "/api/v1/review/due?all=1", Value::Null).await;
    assert_eq!(status, 200);
    assert_eq!(due["count"], 0);
    assert_eq!(due["cards"], json!([]));
    assert_eq!(
        request(&app, "GET", "/api/v1/digest/abc", Value::Null)
            .await
            .0,
        404
    );
    assert_eq!(
        request(
            &app,
            "POST",
            "/api/v1/ask",
            json!({"question":"测试","selection":"合成资料"})
        )
        .await
        .0,
        503
    );
    assert_eq!(
        request(
            &app,
            "POST",
            "/api/v1/translate",
            json!({"text":"测试","bookExtId":"missing"})
        )
        .await
        .0,
        404
    );
}
#[tokio::test]
async fn legacy_webhook_creation_patch_and_test_deliver_signed_payload() {
    let dir = tempfile::tempdir().unwrap();
    let w = Workspace::open(&dir.path().join("db"), "w", "r").unwrap();
    let app = router(Host::new(w, "token".into(), "http://localhost".into()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let (status, created) = request(
        &app,
        "POST",
        "/api/v1/webhooks",
        json!({"url":format!("http://{addr}/hook"),"secret":"synthetic-secret","events":["*"]}),
    )
    .await;
    assert_eq!(status, 201);
    assert!(created["id"].is_number());
    let id = created["id"].as_u64().unwrap();
    assert_eq!(
        request(
            &app,
            "PATCH",
            &format!("/api/v1/webhooks/{id}"),
            json!({"description":"测试","active":true})
        )
        .await
        .1,
        json!({"ok":true})
    );
    let receiver = tokio::spawn(async move {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut data = vec![0; 8192];
        let n = socket.read(&mut data).await.unwrap();
        let request = String::from_utf8_lossy(&data[..n]);
        assert!(request.contains("test.ping"));
        assert!(request
            .to_lowercase()
            .contains("x-shufang-signature: sha256="));
        socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            .await
            .unwrap();
    });
    assert_eq!(
        request(
            &app,
            "POST",
            &format!("/api/v1/webhooks/{id}/test"),
            json!({})
        )
        .await
        .1,
        json!({"ok":true,"status":200})
    );
    receiver.await.unwrap();
    let (_, list) = request(&app, "GET", "/api/v1/webhooks", Value::Null).await;
    assert!(list["webhooks"][0].get("secretRef").is_none());
    assert_eq!(list["webhooks"][0]["description"], "测试");
}
