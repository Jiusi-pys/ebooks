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

#[tokio::test]
async fn pkce_consent_rotation_revocation_and_read_only_scope() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = Workspace::open(&dir.path().join("db"), "w", "r").unwrap();
    let host = Host::new(
        workspace,
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
    let (status, body, _) = send(&app, "POST", "/oauth/token", refresh.clone(), true, "").await;
    assert_eq!(status, 200);
    let rotated: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(
        send(&app, "POST", "/oauth/token", refresh, true, "")
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
