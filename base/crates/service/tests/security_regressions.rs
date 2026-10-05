use axum::{body::Body, http::Request, Router};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use shufang_native::{backup, workspace::Workspace};
use shufang_service::{
    browser_auth::{Auth, Config, User, UserStore},
    oauth, router, Host,
};
use std::sync::Arc;
use tower::ServiceExt;
async fn send(app: &Router, method: &str, path: &str, body: Value, key: &str) -> (u16, Value) {
    let req = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json")
        .header("origin", "https://library.example")
        .header("x-workspace-id", "w")
        .header("authorization", format!("Bearer {key}"))
        .body(Body::from(body.to_string()))
        .unwrap();
    let r = app.clone().oneshot(req).await.unwrap();
    let status = r.status().as_u16();
    let b = r.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&b).unwrap_or(Value::Null))
}
fn setup() -> (tempfile::TempDir, Arc<Workspace>, Arc<Host>, Router) {
    let d = tempfile::tempdir().unwrap();
    let w = Workspace::open(&d.path().join("live/library.sqlite3"), "w", "n").unwrap();
    let h = Host::new(
        w.clone(),
        "owner-key".into(),
        "https://library.example".into(),
    );
    let r = router(h.clone());
    (d, w, h, r)
}
#[tokio::test]
async fn poisoned_peer_and_local_clocks_are_rejected_without_blocking_writes() {
    let (d, w, h, r) = setup();
    let (s, p) = send(
        &r,
        "POST",
        "/api/v2/peers",
        json!({"id":"peer"}),
        "owner-key",
    )
    .await;
    assert_eq!(s, 201);
    let token = p["token"].as_str().unwrap();
    let(s,b)=send(&r,"POST","/api/v2/sync/push",json!({"operations":[{"workspaceId":"w","replicaId":"peer","operationId":"poison","kind":"notes","entityId":"n1","clock":"9999999999999999:9999999999","patch":{"title":"test"}}]}),token).await;
    assert_eq!(s, 400, "{b}");
    assert_eq!(b["error"], "clock_too_far_ahead");
    let (s,b)=send(&r,"POST","/api/v2/mutations",json!({"kind":"notes","entityId":"n1","clock":"9999999999999999:9999999999","patch":{"title":"poison"}}),"owner-key").await;
    assert_eq!(s, 400, "{b}");
    assert_eq!(
        w.core.lock().unwrap().replication_head().unwrap().sequence,
        "0"
    );

    let (s, b) = send(
        &r,
        "POST",
        "/api/v2/mutations",
        json!({"kind":"notes","entityId":"n2","patch":{"title":"normal"}}),
        "owner-key",
    )
    .await;
    assert_eq!(s, 200, "{b}");
    drop(r);
    drop(h);
    drop(w);
    let w = Workspace::open(&d.path().join("live/library.sqlite3"), "w", "n").unwrap();
    assert!(w.core.lock().unwrap().mutation_clock("new-op").is_ok());
}
#[tokio::test]
async fn anonymous_registration_cannot_exhaust_global_capacity() {
    let (_d, _w, _h, r) = setup();
    let body =
        json!({"client_name":"test","redirect_uris":["https://chatgpt.com/connector/oauth/test"]});
    for _ in 0..200 {
        assert_eq!(
            send(&r, "POST", "/oauth/register", body.clone(), "")
                .await
                .0,
            200
        );
    }
    let (s, b) = send(&r, "POST", "/oauth/register", body, "").await;
    assert_eq!(s, 200, "{b}");
}
fn seed_access(w: &Arc<Workspace>) {
    let token = "public-review-token";
    let hash = URL_SAFE_NO_PAD.encode(Sha256::digest(token.as_bytes()));
    let expires = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
        + 3600;
    let mut access = serde_json::Map::new();
    access.insert(hash,json!({"client":"review","resource":"https://library.example/mcp","scope":"library:read","expires":expires,"grant":"g"}));
    w.core.lock().unwrap().set_local_value("oauth-store",0,&json!({"clients":{},"pending":{},"codes":{},"access":access,"refresh":{},"used_refresh":{}})).unwrap();
}
#[tokio::test]
async fn restore_keeps_revoked_oauth_token_invalid() {
    let (d, w, h, _r) = setup();
    seed_access(&w);
    assert!(oauth::valid_access(&h, "public-review-token"));
    let archive = d.path().join("before.zip");
    backup::create(&d.path().join("live/library.sqlite3"), &archive).unwrap();
    let response = _r
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/oauth/revoke")
                .header("content-type", "application/x-www-form-urlencoded")
                .body(Body::from("token=public-review-token&client_id=review"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert!(!oauth::valid_access(&h, "public-review-token"));
    let target = d.path().join("restored");
    backup::restore(&archive, &target).unwrap();
    let restored = Workspace::open(&target.join("library.sqlite3"), "w", "n").unwrap();
    let h = Host::new(
        restored,
        "owner-key".into(),
        "https://library.example".into(),
    );
    assert!(!oauth::valid_access(&h, "public-review-token"));
}
struct Empty;
impl UserStore for Empty {
    fn get(&self) -> Result<Option<User>, String> {
        Ok(None)
    }
    fn create(&self, _: User) -> Result<bool, String> {
        Ok(false)
    }
    fn update(&self, _: u64, _: User) -> Result<bool, String> {
        Ok(false)
    }
}
#[tokio::test]
async fn reverse_proxy_clients_have_independent_login_limits() {
    let (_d, _w, h, _r) = setup();
    drop(_r);
    let mut h = Arc::try_unwrap(h).ok().unwrap();
    h.browser = Some(
        Auth::new(
            Config {
                app_id: "owner".into(),
                app_secret: "correct-password".into(),
                data_secret: "public-test-data-secret-1234567890".into(),
                session_secret: "public-test-session-secret-1234567890".into(),
                origin: "https://library.example".into(),
                ttl: 43200,
            },
            Arc::new(Empty),
        )
        .unwrap(),
    );
    let r = router(Arc::new(h));
    async fn login(r: &Router, ip: &str, password: &str) -> u16 {
        let req = Request::builder()
            .method("POST")
            .uri("/api/auth/login")
            .header("origin", "https://library.example")
            .header("content-type", "application/json")
            .header("x-real-ip", ip)
            .extension(axum::extract::ConnectInfo(
                "127.0.0.1:40000".parse::<std::net::SocketAddr>().unwrap(),
            ))
            .body(Body::from(
                json!({"appId":"owner","appSecret":password}).to_string(),
            ))
            .unwrap();
        r.clone().oneshot(req).await.unwrap().status().as_u16()
    }
    for _ in 0..5 {
        assert_eq!(login(&r, "192.0.2.1", "bad").await, 401);
    }
    assert_eq!(login(&r, "198.51.100.1", "correct-password").await, 200);
}

#[tokio::test]
async fn snapshot_clock_validation_covers_old_staging_before_publication() {
    use shufang_application::incoming_snapshot::{
        IncomingSnapshot, SnapshotPage, SnapshotRepository,
    };
    let (_d, w, _h, _r) = setup();
    let mut core = w.core.lock().unwrap();
    let snapshot = IncomingSnapshot::new("peer", "test-snapshot", "epoch", "watermark", 1).unwrap();
    core.begin_incoming_snapshot(&snapshot).unwrap();
    let state=shufang_domain::lossless_sync::ReplicaState::parse(r#"{"id":"n","kind":"notes","deleted":false,"fields":{"title":{"version":"9999999999999999:9999999999:peer:poison","value":"bad"}}}"#).unwrap();
    let page = SnapshotPage {
        index: 0,
        after: "".into(),
        next: None,
        states: vec![state],
    };
    assert!(core
        .stage_incoming_snapshot("peer", "test-snapshot", &page)
        .is_err());
    // Model a page already staged by the previous server version.
    SnapshotRepository::stage_snapshot_page(core.repository_mut(), "peer", "test-snapshot", &page)
        .unwrap();
    let checkpoint = shufang_application::LocalCommit {
        key: "sync:receive:peer".into(),
        expected: 0,
        value: json!("watermark"),
    };
    assert!(core
        .finish_incoming_snapshot("peer", "test-snapshot", &checkpoint)
        .is_err());
    assert_eq!(core.replication_head().unwrap().sequence, "0");
    assert!(core.local_value("sync:receive:peer").unwrap().is_none());
}
