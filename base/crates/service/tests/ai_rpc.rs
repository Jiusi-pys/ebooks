use axum::{body::Body, http::Request};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use hmac::{Hmac, Mac};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use sha2::Sha256;
use shufang_native::{ai::Config, workspace::Workspace};
use shufang_service::{
    ai_rpc::Executor,
    browser_auth::{Auth, Config as AuthConfig, User, UserStore},
    router, Host,
};
use std::sync::{Arc, Mutex};
use tower::ServiceExt;
struct Store(User);
impl UserStore for Store {
    fn get(&self) -> Result<Option<User>, String> {
        Ok(Some(self.0.clone()))
    }
    fn create(&self, _: User) -> Result<bool, String> {
        Ok(false)
    }
    fn update(&self, _: u64, _: User) -> Result<bool, String> {
        Ok(false)
    }
}
struct Fake(Arc<Mutex<Vec<Value>>>);
impl Executor for Fake {
    fn start(
        &self,
        workspace: Arc<Workspace>,
        _: Config,
        key: Option<String>,
        request: Value,
    ) -> Result<String, String> {
        assert_eq!(key.as_deref(), Some("public-transient-test-key"));
        self.0.lock().unwrap().push(request.clone());
        let job=workspace.start("ai",move|_|Ok(if request["task"]=="models"{json!({"models":["chat-model"]})}else{json!({"text":"{\"topics\":[{\"title\":\"Topic\",\"children\":[]}],\"title\":\"Card\",\"note\":\"Explanation\",\"cloze\":[\"original\",\"invented\"],\"tags\":[\"tag\"]}"})}))?;
        Ok(job["job"].as_str().unwrap().to_owned())
    }
}
#[tokio::test]
async fn ai_procedures_keep_wire_shapes_and_never_persist_transient_keys() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = Workspace::open(&dir.path().join("db"), "w", "n").unwrap();
    let mut host = Host::new(
        workspace.clone(),
        "owner-key".into(),
        "https://library.example".into(),
    );
    let session_key = "public-ai-rpc-session-test-key-123456";
    let data_key = "public-ai-rpc-data-test-key-123456789";
    let calls = Arc::new(Mutex::new(Vec::new()));
    let host_mut = Arc::get_mut(&mut host).unwrap();
    host_mut.ai_executor = Arc::new(Fake(calls.clone()));
    host_mut.browser = Some(
        Auth::new(
            AuthConfig {
                app_id: "id".into(),
                app_secret: "bootstrap".into(),
                data_secret: data_key.into(),
                session_secret: session_key.into(),
                origin: "https://library.example".into(),
                ttl: 3600,
            },
            Arc::new(Store(User {
                encrypted: shufang_service::credentials::encrypt_username("Owner", data_key)
                    .unwrap(),
                hash: "unused".into(),
                version: 1,
            })),
        )
        .unwrap(),
    );
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let payload=URL_SAFE_NO_PAD.encode(json!({"v":2,"sub":"Owner","iat":now,"exp":now+3600,"nonce":"public-test-nonce","setup":false,"cv":1}).to_string());
    let mut mac =
        Hmac::<Sha256>::new_from_slice(format!("{session_key}\0shufang-session-v2").as_bytes())
            .unwrap();
    mac.update(payload.as_bytes());
    let cookie = format!(
        "shufang_session={payload}.{}",
        URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
    );
    let app = router(host);
    let config = json!({"provider":"deepseek","model":"chat-model","effort":"none","apiKey":"public-transient-test-key"});
    for (path, input) in [
        (
            "ai.models",
            json!({"provider":"deepseek","apiKey":"public-transient-test-key"}),
        ),
        ("ai.testConnection", json!({"config":config})),
        (
            "ai.chat",
            json!({"config":config,"messages":[{"role":"user","content":"Question"}]}),
        ),
        ("ai.translate", json!({"config":config,"text":"original"})),
        (
            "ai.mindmap",
            json!({"config":config,"bookTitle":"Book","chapterTitle":"Chapter","text":"original"}),
        ),
        (
            "ai.studyCard",
            json!({"config":config,"bookTitle":"Book","chapterTitle":"Chapter","text":"original"}),
        ),
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/api/trpc/{path}"))
                    .header("cookie", &cookie)
                    .header("origin", "https://library.example")
                    .header("content-type", "application/json")
                    .body(Body::from(json!({"json":input}).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let body: Value =
            serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        assert_eq!(status, 200, "{path}: {body}");
        let result = &body["result"]["data"]["json"];
        if path == "ai.models" {
            assert_eq!(result["models"], json!(["chat-model"]));
        }
        if path == "ai.translate" {
            assert!(result.is_string());
        }
        if path == "ai.mindmap" {
            assert_eq!(result["topics"][0]["title"], "Topic");
        }
        if path == "ai.studyCard" {
            assert_eq!(result["cloze"], json!(["original"]));
        }
    }
    assert_eq!(calls.lock().unwrap().len(), 6);
    assert!(calls
        .lock()
        .unwrap()
        .iter()
        .all(|v| !v.to_string().contains("public-transient-test-key")));
}
