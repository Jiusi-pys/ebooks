use axum::{body::Body, http::Request};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use hmac::{Hmac, Mac};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use sha2::Sha256;
use shufang_native::workspace::Workspace;
use shufang_service::{
    browser_auth::{Auth, Config, MysqlUsers, UserStore},
    router, Host,
};
use std::sync::Arc;
use tower::ServiceExt;
#[tokio::test]
#[ignore = "requires dedicated isolated account fixture database"]
async fn mysql_node_account_cookie_and_webhook_settings_survive_rust_handoff() {
    let url = std::env::var("SHUFANG_TEST_AUTH_MYSQL_URL").unwrap();
    assert!(url.ends_with("/rust_acceptance_auth_20261005"));
    let fixture: Value =
        serde_json::from_str(include_str!("fixtures/node-credentials.json")).unwrap();
    let users = Arc::new(MysqlUsers::open(&url).unwrap());
    assert_eq!(users.get().unwrap().unwrap().version, 7);
    let dir = tempfile::tempdir().unwrap();
    let w = Workspace::open_mysql(
        &dir.path().join("library.mysql"),
        &url,
        &format!("auth-{}", uuid::Uuid::new_v4()),
        "node",
        false,
    )
    .unwrap();
    let mut h = Host::new(
        w.clone(),
        "private-owner".into(),
        "https://library.example".into(),
    );
    let secret = "public-mysql-session-test-key-123456789";
    Arc::get_mut(&mut h).unwrap().browser = Some(
        Auth::new(
            Config {
                app_id: "old-bootstrap".into(),
                app_secret: "old-bootstrap-secret".into(),
                data_secret: fixture["secret"].as_str().unwrap().into(),
                session_secret: secret.into(),
                origin: "https://library.example".into(),
                ttl: 3600,
            },
            users.clone(),
        )
        .unwrap(),
    );
    shufang_service::webhooks::import_mysql_subscriptions(&h).unwrap();
    shufang_service::webhooks::import_mysql_subscriptions(&h).unwrap();
    let (_, state) = w
        .core
        .lock()
        .unwrap()
        .local_value("webhooks")
        .unwrap()
        .unwrap();
    let sub = state["subscriptions"]
        .as_object()
        .unwrap()
        .values()
        .find(|v| v["legacyId"] == 1)
        .unwrap();
    assert_eq!(sub["legacyId"], 1);
    assert_eq!(sub["failCount"], 3);
    assert_eq!(sub["active"], false);
    assert_eq!(sub["events"], json!(["note.created"]));
    assert!(sub.get("secret").is_none());
    assert_eq!(
        shufang_native::credentials::load(&w.root, sub["secretRef"].as_str().unwrap()).unwrap(),
        "public-test-signing-key"
    );
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let payload=URL_SAFE_NO_PAD.encode(json!({"v":2,"sub":"用户AB","iat":now,"exp":now+3600,"nonce":"public-test-nonce","setup":false,"cv":7}).to_string());
    let mut mac =
        Hmac::<Sha256>::new_from_slice(format!("{secret}\0shufang-session-v2").as_bytes()).unwrap();
    mac.update(payload.as_bytes());
    let cookie = format!(
        "shufang_session={payload}.{}",
        URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
    );
    let app = router(h);
    let req = |method: &str, path: &str, value: Value, cookie: &str| {
        Request::builder()
            .method(method)
            .uri(path)
            .header("content-type", "application/json")
            .header("origin", "https://library.example")
            .header("cookie", cookie)
            .body(Body::from(value.to_string()))
            .unwrap()
    };
    let r = app
        .clone()
        .oneshot(req("GET", "/api/auth/profile", Value::Null, &cookie))
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    let body: Value =
        serde_json::from_slice(&r.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(body["credentialVersion"], 7);
    let r = app
        .clone()
        .oneshot(req(
            "POST",
            "/api/auth/login",
            json!({"appId":"用户AB","appSecret":"public-long-test-password"}),
            "",
        ))
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    let r = app
        .clone()
        .oneshot(req(
            "PATCH",
            "/api/auth/profile",
            json!({"username":"Updated owner","currentPassword":"public-long-test-password"}),
            &cookie,
        ))
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    assert_eq!(users.get().unwrap().unwrap().version, 8);
    assert_eq!(
        app.oneshot(req("GET", "/api/auth/profile", Value::Null, &cookie))
            .await
            .unwrap()
            .status(),
        401
    );
}
