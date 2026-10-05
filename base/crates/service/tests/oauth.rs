use axum::{body::Body, http::Request, Router};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use shufang_native::workspace::Workspace;
use shufang_service::{router, Host};
use tower::ServiceExt;

async fn send(
    app: &Router,
    method: &str,
    uri: &str,
    body: String,
    form: bool,
    bearer: &str,
) -> (u16, String, String) {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(uri)
                .header(
                    "content-type",
                    if form {
                        "application/x-www-form-urlencoded"
                    } else {
                        "application/json"
                    },
                )
                .header("authorization", format!("Bearer {bearer}"))
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status().as_u16();
    let location = response
        .headers()
        .get("location")
        .and_then(|h| h.to_str().ok())
        .unwrap_or("")
        .to_string();
    let text = String::from_utf8(
        response
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes()
            .to_vec(),
    )
    .unwrap();
    (status, text, location)
}
fn form(pairs: &[(&str, &str)]) -> String {
    url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs(pairs.iter().copied())
        .finish()
}

async fn issue_user_grant(app: &Router, scope: Option<&str>) -> Value {
    let (_, body, _) = send(
        app,
        "POST",
        "/oauth/register",
        json!({"client_name":"MCP全功能","redirect_uris":["http://127.0.0.1:5555/callback"]})
            .to_string(),
        false,
        "",
    )
    .await;
    let client: Value = serde_json::from_str(&body).unwrap();
    let id = client["client_id"].as_str().unwrap();
    let verifier = "b".repeat(43);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let mut pairs = vec![
        ("client_id", id),
        ("redirect_uri", "http://127.0.0.1:5555/callback"),
        ("response_type", "code"),
        ("code_challenge_method", "S256"),
        ("code_challenge", &challenge),
        ("resource", "http://127.0.0.1:31417/mcp"),
    ];
    if let Some(scope) = scope {
        pairs.push(("scope", scope));
    }
    let (status, page, _) = send(
        app,
        "GET",
        &format!("/oauth/authorize?{}", form(&pairs)),
        String::new(),
        false,
        "",
    )
    .await;
    assert_eq!(status, 200);
    if scope.is_none() {
        assert!(page.contains("访问和修改"));
        assert!(page.contains("单条恢复"));
        assert!(!page.contains("允许只读访问"));
    } else if scope == Some("library:read") {
        assert!(page.contains("不会授予修改权限"));
    }
    let pending = page
        .split("name='request' value='")
        .nth(1)
        .unwrap()
        .split('\'')
        .next()
        .unwrap();
    let (status, _, redirect) = send(
        app,
        "POST",
        "/oauth/authorize",
        form(&[
            ("request", pending),
            ("token", "admin-key"),
            ("decision", "allow"),
        ]),
        true,
        "",
    )
    .await;
    assert_eq!(status, 303);
    let redirect = url::Url::parse(&redirect).unwrap();
    let code = redirect
        .query_pairs()
        .find(|(k, _)| k == "code")
        .unwrap()
        .1
        .to_string();
    let (status, body, _) = send(
        app,
        "POST",
        "/oauth/token",
        form(&[
            ("grant_type", "authorization_code"),
            ("client_id", id),
            ("redirect_uri", "http://127.0.0.1:5555/callback"),
            ("code", &code),
            ("code_verifier", &verifier),
            ("resource", "http://127.0.0.1:31417/mcp"),
        ]),
        true,
        "",
    )
    .await;
    assert_eq!(status, 200);
    let mut token: Value = serde_json::from_str(&body).unwrap();
    token["client_id"] = json!(id);
    token
}
#[tokio::test]
async fn full_consent_and_refresh_preserve_scope_without_upgrading_old_read_grants() {
    let d = tempfile::tempdir().unwrap();
    let w = Workspace::open(&d.path().join("db"), "w", "n").unwrap();
    let app = router(Host::new(
        w,
        "admin-key".into(),
        "http://127.0.0.1:31417".into(),
    ));
    let full = issue_user_grant(&app, None).await;
    assert_eq!(full["scope"], "library:read library:write");
    let (status, body, _) = send(
        &app,
        "POST",
        "/oauth/token",
        form(&[
            ("grant_type", "refresh_token"),
            ("client_id", full["client_id"].as_str().unwrap()),
            ("refresh_token", full["refresh_token"].as_str().unwrap()),
            ("resource", "http://127.0.0.1:31417/mcp"),
        ]),
        true,
        "",
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(
        serde_json::from_str::<Value>(&body).unwrap()["scope"],
        "library:read library:write"
    );
    let read = issue_user_grant(&app, Some("library:read")).await;
    assert_eq!(read["scope"], "library:read");
    let (status, _, _) = send(
        &app,
        "POST",
        "/oauth/token",
        form(&[
            ("grant_type", "refresh_token"),
            ("client_id", read["client_id"].as_str().unwrap()),
            ("refresh_token", read["refresh_token"].as_str().unwrap()),
            ("resource", "http://127.0.0.1:31417/mcp"),
            ("scope", "library:read library:write"),
        ]),
        true,
        "",
    )
    .await;
    assert_eq!(status, 400);
    let (status, body, _) = send(
        &app,
        "POST",
        "/oauth/token",
        form(&[
            ("grant_type", "refresh_token"),
            ("client_id", read["client_id"].as_str().unwrap()),
            ("refresh_token", read["refresh_token"].as_str().unwrap()),
            ("resource", "http://127.0.0.1:31417/mcp"),
        ]),
        true,
        "",
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(
        serde_json::from_str::<Value>(&body).unwrap()["scope"],
        "library:read"
    );
}

#[tokio::test]
async fn pkce_consent_rotation_revocation_and_read_only_scope() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = Workspace::open(&dir.path().join("db"), "w", "r").unwrap();
    let host = Host::new(
        workspace.clone(),
        "admin-key".into(),
        "http://127.0.0.1:31417".into(),
    );
    let app = router(host);
    let (_, body, _) = send(
        &app,
        "POST",
        "/oauth/register",
        json!({"client_name":"阅读助手","redirect_uris":["http://127.0.0.1:5555/callback"]})
            .to_string(),
        false,
        "",
    )
    .await;
    let client: Value = serde_json::from_str(&body).unwrap();
    let id = client["client_id"].as_str().unwrap();
    let verifier = "a".repeat(43);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let query = form(&[
        ("client_id", id),
        ("redirect_uri", "http://127.0.0.1:5555/callback"),
        ("response_type", "code"),
        ("code_challenge_method", "S256"),
        ("code_challenge", &challenge),
        ("resource", "http://127.0.0.1:31417/mcp"),
        ("scope", "library:read"),
        ("state", "opaque-state"),
    ]);
    let (status, page, _) = send(
        &app,
        "GET",
        &format!("/oauth/authorize?{query}"),
        String::new(),
        false,
        "",
    )
    .await;
    assert_eq!(status, 200);
    assert!(
        page.contains("阅读助手"),
        "consent must identify the requesting client"
    );
    let pending = page
        .split("name='request' value='")
        .nth(1)
        .unwrap()
        .split('\'')
        .next()
        .unwrap();
    assert_eq!(
        send(
            &app,
            "POST",
            "/oauth/authorize",
            form(&[
                ("request", pending),
                ("token", "wrong"),
                ("decision", "approve")
            ]),
            true,
            ""
        )
        .await
        .0,
        401
    );
    let (status, _, location) = send(
        &app,
        "POST",
        "/oauth/authorize",
        form(&[
            ("request", pending),
            ("token", "admin-key"),
            ("decision", "approve"),
        ]),
        true,
        "",
    )
    .await;
    assert_eq!(status, 303);
    let url = url::Url::parse(&location).unwrap();
    let params: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
    assert_eq!(params["state"], "opaque-state");
    let exchange = form(&[
        ("grant_type", "authorization_code"),
        ("code", &params["code"]),
        ("client_id", id),
        ("redirect_uri", "http://127.0.0.1:5555/callback"),
        ("code_verifier", &verifier),
        ("resource", "http://127.0.0.1:31417/mcp"),
    ]);
    let (status, body, _) = send(&app, "POST", "/oauth/token", exchange.clone(), true, "").await;
    assert_eq!(status, 200);
    let tokens: Value = serde_json::from_str(&body).unwrap();
    let access = tokens["access_token"].as_str().unwrap();
    assert_eq!(
        send(&app, "POST", "/oauth/token", exchange, true, "")
            .await
            .0,
        400
    );
    assert_eq!(
        send(&app, "GET", "/api/v1/notes", String::new(), false, access)
            .await
            .0,
        200
    );
    assert_eq!(
        send(
            &app,
            "POST",
            "/api/v1/notes",
            json!({"title":"no","content":"no"}).to_string(),
            false,
            access
        )
        .await
        .0,
        401
    );
    assert_eq!(
        send(
            &app,
            "GET",
            "/api/v1/jobs/private-job",
            String::new(),
            false,
            access
        )
        .await
        .0,
        401
    );
    let refresh = form(&[
        ("grant_type", "refresh_token"),
        ("refresh_token", tokens["refresh_token"].as_str().unwrap()),
        ("client_id", id),
        ("resource", "http://127.0.0.1:31417/mcp"),
    ]);
    let old_refresh_key = URL_SAFE_NO_PAD.encode(Sha256::digest(
        tokens["refresh_token"].as_str().unwrap().as_bytes(),
    ));
    let deadline = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
        + 60;
    {
        let mut core = workspace.core.lock().unwrap();
        let (revision, mut state) = core.local_value("oauth-store").unwrap().unwrap();
        state["refresh"][&old_refresh_key]["expires"] = json!(deadline);
        state["refresh"][&old_refresh_key]["grant_expires"] = json!(deadline);
        // Earlier persisted OAuth stores did not contain replay markers.
        state.as_object_mut().unwrap().remove("used_refresh");
        core.set_local_value("oauth-store", revision, &state)
            .unwrap();
    }
    let (status, body, _) = send(&app, "POST", "/oauth/token", refresh.clone(), true, "").await;
    assert_eq!(status, 200);
    let rotated: Value = serde_json::from_str(&body).unwrap();
    {
        let core = workspace.core.lock().unwrap();
        let (_, state) = core.local_value("oauth-store").unwrap().unwrap();
        let rotated_key = URL_SAFE_NO_PAD.encode(Sha256::digest(
            rotated["refresh_token"].as_str().unwrap().as_bytes(),
        ));
        assert_eq!(state["used_refresh"][&old_refresh_key]["expires"], deadline);
        assert_eq!(state["refresh"][&rotated_key]["expires"], deadline);
    }
    assert_eq!(
        send(&app, "POST", "/oauth/token", refresh, true, "")
            .await
            .0,
        400
    );
    assert_eq!(
        send(
            &app,
            "GET",
            "/api/v1/notes",
            String::new(),
            false,
            rotated["access_token"].as_str().unwrap()
        )
        .await
        .0,
        401,
        "replaying a consumed refresh token must revoke its entire grant"
    );
    assert_eq!(
        send(
            &app,
            "POST",
            "/oauth/token",
            form(&[
                ("grant_type", "refresh_token"),
                ("refresh_token", rotated["refresh_token"].as_str().unwrap()),
                ("client_id", id),
                ("resource", "http://127.0.0.1:31417/mcp"),
            ]),
            true,
            ""
        )
        .await
        .0,
        400
    );
    assert_eq!(
        send(
            &app,
            "POST",
            "/oauth/revoke",
            form(&[
                ("client_id", id),
                ("token", rotated["refresh_token"].as_str().unwrap())
            ]),
            true,
            ""
        )
        .await
        .0,
        200
    );
    for token in [access, rotated["access_token"].as_str().unwrap()] {
        assert_eq!(
            send(&app, "GET", "/api/v1/notes", String::new(), false, token)
                .await
                .0,
            401
        );
    }
}

#[tokio::test]
async fn anonymous_dynamic_registration_never_consumes_persistent_slots() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = Workspace::open(&dir.path().join("db"), "w", "r").unwrap();
    let app = router(Host::new(
        workspace.clone(),
        "admin-key".into(),
        "http://127.0.0.1:31417".into(),
    ));
    for index in 0..250 {
        let (status, body, _) = send(&app,"POST","/oauth/register",json!({"client_name":format!("client-{index}"),"redirect_uris":["http://127.0.0.1:5555/callback"]}).to_string(),false,"").await;
        assert_eq!(status, 200);
        assert!(serde_json::from_str::<Value>(&body).unwrap()["client_id"]
            .as_str()
            .unwrap()
            .starts_with("reg."));
    }
    assert!(workspace
        .core
        .lock()
        .unwrap()
        .local_value("oauth-store")
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn mcp_http_rejects_foreign_and_opaque_origins() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = Workspace::open(&dir.path().join("db"), "w", "r").unwrap();
    let app = router(Host::new(
        workspace,
        "admin-key".into(),
        "http://127.0.0.1:31417".into(),
    ));
    for origin in ["https://untrusted.example", "null", "not-an-origin"] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/mcp")
                    .header("origin", origin)
                    .header("x-api-key", "admin-key")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({"jsonrpc":"2.0","id":1,"method":"ping"}).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status().as_u16(), 403, "origin={origin}");
    }
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/mcp")
                .header("origin", "http://127.0.0.1:31417")
                .header("x-api-key", "admin-key")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"jsonrpc":"2.0","id":1,"method":"ping"}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status().as_u16(), 200);
}

#[tokio::test]
async fn replay_revokes_grant_even_when_access_store_is_full() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = Workspace::open(&dir.path().join("db"), "w", "r").unwrap();
    let resource = "http://127.0.0.1:31417/mcp";
    let expires = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
        + 3600;
    let mut access = serde_json::Map::new();
    let active_key = URL_SAFE_NO_PAD.encode(Sha256::digest(b"active-access"));
    access.insert(active_key, json!({"client":"client","resource":resource,"scope":"library:read","expires":expires,"grant":"target"}));
    for index in 0..4999 {
        access.insert(format!("filler-{index}"), json!({"client":"other","resource":resource,"scope":"library:read","expires":expires,"grant":"other"}));
    }
    let old_key = URL_SAFE_NO_PAD.encode(Sha256::digest(b"old-refresh"));
    let new_key = URL_SAFE_NO_PAD.encode(Sha256::digest(b"new-refresh"));
    let mut used = serde_json::Map::new();
    used.insert(old_key, json!({"grant":"target","expires":expires}));
    let mut refresh = serde_json::Map::new();
    refresh.insert(new_key, json!({"client":"client","resource":resource,"scope":"library:read","expires":expires,"grant":"target"}));
    workspace.core.lock().unwrap().set_local_value("oauth-store", 0, &json!({"clients":{},"pending":{},"codes":{},"access":access,"refresh":refresh,"used_refresh":used})).unwrap();
    let app = router(Host::new(
        workspace,
        "admin-key".into(),
        "http://127.0.0.1:31417".into(),
    ));
    assert_eq!(
        send(
            &app,
            "POST",
            "/oauth/token",
            form(&[
                ("grant_type", "refresh_token"),
                ("refresh_token", "old-refresh"),
                ("client_id", "client"),
                ("resource", resource)
            ]),
            true,
            ""
        )
        .await
        .0,
        400
    );
    assert_eq!(
        send(
            &app,
            "GET",
            "/api/v1/notes",
            String::new(),
            false,
            "active-access"
        )
        .await
        .0,
        401
    );
    assert_eq!(
        send(
            &app,
            "POST",
            "/oauth/token",
            form(&[
                ("grant_type", "refresh_token"),
                ("refresh_token", "new-refresh"),
                ("client_id", "client"),
                ("resource", resource)
            ]),
            true,
            ""
        )
        .await
        .0,
        400
    );
}

#[tokio::test]
async fn registration_and_authorization_envelopes_cannot_pin_or_tamper_with_state() {
    let dir = tempfile::tempdir().unwrap();
    let w = Workspace::open(&dir.path().join("db"), "w", "r").unwrap();
    let app = router(Host::new(
        w.clone(),
        "admin-key".into(),
        "http://127.0.0.1:31417".into(),
    ));
    let (_, body, _) = send(
        &app,
        "POST",
        "/oauth/register",
        json!({"redirect_uris":["http://127.0.0.1:5555/callback"]}).to_string(),
        false,
        "",
    )
    .await;
    let c: Value = serde_json::from_str(&body).unwrap();
    let id = c["client_id"].as_str().unwrap();
    let query = form(&[
        ("client_id", id),
        ("redirect_uri", "http://127.0.0.1:5555/callback"),
        ("response_type", "code"),
        ("code_challenge_method", "S256"),
        ("code_challenge", &"a".repeat(43)),
        ("resource", "http://127.0.0.1:31417/mcp"),
    ]);
    for _ in 0..150 {
        assert_eq!(
            send(
                &app,
                "GET",
                &format!("/oauth/authorize?{query}"),
                String::new(),
                false,
                ""
            )
            .await
            .0,
            200
        );
    }
    assert!(w
        .core
        .lock()
        .unwrap()
        .local_value("oauth-store")
        .unwrap()
        .is_none());
    let forged = format!("{}x", id);
    let bad = query.replace(
        &url::form_urlencoded::byte_serialize(id.as_bytes()).collect::<String>(),
        &url::form_urlencoded::byte_serialize(forged.as_bytes()).collect::<String>(),
    );
    assert_eq!(
        send(
            &app,
            "GET",
            &format!("/oauth/authorize?{bad}"),
            String::new(),
            false,
            ""
        )
        .await
        .0,
        400
    );
    let (_, page, _) = send(
        &app,
        "GET",
        &format!("/oauth/authorize?{query}"),
        String::new(),
        false,
        "",
    )
    .await;
    let request = page
        .split("name='request' value='")
        .nth(1)
        .unwrap()
        .split('\'')
        .next()
        .unwrap();
    assert_eq!(
        send(
            &app,
            "POST",
            "/oauth/authorize",
            form(&[
                ("request", &format!("{request}x")),
                ("decision", "allow"),
                ("token", "admin-key")
            ]),
            true,
            ""
        )
        .await
        .0,
        400
    );
}
