use axum::{body::Body, http::Request};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use shufang_native::workspace::Workspace;
use shufang_service::{router, Host};
use tower::ServiceExt;
#[tokio::test]
#[ignore = "explicit live provider acceptance; consumes authenticated Codex quota"]
async fn live_rest_ask_and_translate_persist_through_shared_core() {
    let dir = tempfile::tempdir().unwrap();
    let w = Workspace::open(&dir.path().join("db"), "live", "windows").unwrap();
    let model = std::env::var("SHUFANG_LIVE_MODEL").expect("choose live model");
    w.execute(
        "saveAiConfig",
        json!({"expected":0,"config":{"provider":"codex","model":model,"effort":"low"}}),
    )
    .unwrap();
    w.execute("save",json!({"kind":"books","id":"b","expected":0,"patch":{"title":"合成AI测试","author":"","format":"txt","chapters":[{"id":"c","title":"测试","paragraphs":["三棵树加两棵树，共五棵树。"]}]}})).unwrap();
    w.execute("save",json!({"kind":"highlights","id":"h","expected":0,"patch":{"bookId":"b","chapterId":"c","text":"三棵树加两棵树，共五棵树。","paraIndex":0,"start":0,"end":"三棵树加两棵树，共五棵树。".encode_utf16().count()}})).unwrap();
    let app = router(Host::new(
        w.clone(),
        "token".into(),
        "http://localhost".into(),
    ));
    for (path, body) in [
        (
            "/api/v1/ask",
            json!({"selection":"三棵树加两棵树，共五棵树。","question":"一共有几棵树？只用中文回答。","highlightExtId":"h"}),
        ),
        (
            "/api/v1/translate",
            json!({"bookExtId":"b","chapterTitle":"测试","text":"The book is on the table.","targetLang":"中文","mode":"passage","extId":"t"}),
        ),
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(path)
                    .header("Authorization", "Bearer token")
                    .header("Content-Type", "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let result: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(status, 200, "{result}");
        if path.ends_with("ask") {
            assert!(
                result["answer"].as_str().unwrap().contains('五')
                    || result["answer"].as_str().unwrap().contains('5')
            );
        } else {
            assert!(!result["translation"].as_str().unwrap().is_empty());
        }
        println!("LIVE {path} {result}");
    }
    assert_eq!(
        w.execute("get", json!({"kind":"highlights","id":"h"}))
            .unwrap()["value"]["aiQa"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    drop(app);
    drop(w);
    let w = Workspace::open(&dir.path().join("db"), "live", "windows").unwrap();
    assert!(w
        .execute("get", json!({"kind":"translations","id":"t"}))
        .unwrap()["value"]["text"]
        .as_str()
        .unwrap()
        .contains('书'));
}
