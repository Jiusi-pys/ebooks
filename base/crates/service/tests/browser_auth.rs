use axum::{body::Body, http::Request};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use shufang_native::workspace::Workspace;
use shufang_service::{
    browser_auth::{Auth, Config, User, UserStore},
    router, Host,
};
use std::sync::{Arc, Mutex};
use tower::ServiceExt;
#[derive(Default)]
struct Memory(Mutex<Option<User>>);
impl UserStore for Memory {
    fn get(&self) -> Result<Option<User>, String> {
        Ok(self.0.lock().unwrap().clone())
    }
    fn create(&self, user: User) -> Result<bool, String> {
        let mut value = self.0.lock().unwrap();
        if value.is_some() {
            return Ok(false);
        }
        *value = Some(user);
        Ok(true)
    }
    fn update(&self, expected: u64, user: User) -> Result<bool, String> {
        let mut value = self.0.lock().unwrap();
        if value.as_ref().map(|v| v.version) != Some(expected) {
            return Ok(false);
        }
        *value = Some(user);
        Ok(true)
    }
}
#[tokio::test]
async fn bootstrap_setup_login_profile_and_old_cookie_revocation() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = Workspace::open(&dir.path().join("db"), "w", "n").unwrap();
    let mut host = Host::new(
        workspace.clone(),
        "machine-key".into(),
        "https://library.example".into(),
    );
    Arc::get_mut(&mut host).unwrap().browser = Some(
        Auth::new(
            Config {
                app_id: "bootstrap".into(),
                app_secret: "bootstrap-secret".into(),
                data_secret: "public-test-data-secret-1234567890".into(),
                session_secret: "public-test-session-secret-1234567890".into(),
                origin: "https://library.example".into(),
                ttl: 43200,
            },
            Arc::new(Memory::default()),
        )
        .unwrap(),
    );
    let app = router(host.clone());
    let request = |method: &str, path: &str, body: Value, cookie: &str, origin: &str| {
        Request::builder()
            .method(method)
            .uri(path)
            .header("origin", origin)
            .header("cookie", cookie)
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap()
    };
    let r = app
        .clone()
        .oneshot(request(
            "POST",
            "/api/auth/login",
            json!({"appId":"bootstrap","appSecret":"bootstrap-secret"}),
            "",
            "https://evil.example",
        ))
        .await
        .unwrap();
    assert_eq!(r.status(), 403);
    let r = app
        .clone()
        .oneshot(request(
            "POST",
            "/api/auth/login",
            json!({"appId":"bootstrap","appSecret":"bootstrap-secret"}),
            "",
            "https://library.example",
        ))
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    let bootstrap = r.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let r=app.clone().oneshot(request("POST","/api/auth/setup",json!({"username":"用户甲","newPassword":"public-long-password","confirmPassword":"public-long-password"}),&bootstrap,"https://library.example")).await.unwrap();
    assert_eq!(r.status(), 200);
    let cookie = r.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    assert_eq!(
        app.clone()
            .oneshot(request(
                "GET",
                "/api/auth/profile",
                Value::Null,
                &bootstrap,
                "https://library.example"
            ))
            .await
            .unwrap()
            .status(),
        401
    );
    let startup = app
        .clone()
        .oneshot(request(
            "GET",
            "/api/autostart/status",
            Value::Null,
            &cookie,
            "https://library.example",
        ))
        .await
        .unwrap();
    assert_eq!(startup.status(), 200);
    let startup: Value =
        serde_json::from_slice(&startup.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(startup["reason"], "managed_externally");
    assert_eq!(startup["installed"], false);
    assert_eq!(
        app.clone()
            .oneshot(request(
                "POST",
                "/api/autostart/status",
                json!({"enabled":true}),
                &cookie,
                "https://library.example"
            ))
            .await
            .unwrap()
            .status(),
        409
    );
    assert_eq!(
        app.clone()
            .oneshot(request(
                "POST",
                "/api/autostart/status",
                json!({"enabled":true,"unknown":1}),
                &cookie,
                "https://library.example"
            ))
            .await
            .unwrap()
            .status(),
        400
    );
    // Browser consent requires the owner cookie, same origin, and paired CSRF.
    let registered = app.clone().oneshot(request("POST", "/oauth/register", json!({"client_name":"Browser acceptance","redirect_uris":["https://client.example/callback"]}), "", "https://library.example")).await.unwrap();
    assert_eq!(registered.status(), 200);
    let client: Value =
        serde_json::from_slice(&registered.into_body().collect().await.unwrap().to_bytes())
            .unwrap();
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use sha2::Sha256 as OAuthSha;
    let verifier = "a".repeat(43);
    let challenge = URL_SAFE_NO_PAD.encode(OAuthSha::digest(verifier.as_bytes()));
    let authorize = format!("/oauth/authorize?client_id={}&redirect_uri=https%3A%2F%2Fclient.example%2Fcallback&response_type=code&code_challenge_method=S256&code_challenge={challenge}&resource=https%3A%2F%2Flibrary.example%2Fmcp&scope=library%3Aread&state=opaque",client["client_id"].as_str().unwrap());
    let consent = app
        .clone()
        .oneshot(request(
            "GET",
            &authorize,
            Value::Null,
            &cookie,
            "https://library.example",
        ))
        .await
        .unwrap();
    assert_eq!(consent.status(), 200);
    let csrf_cookie = consent.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let html = String::from_utf8(
        consent
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes()
            .to_vec(),
    )
    .unwrap();
    let pending = html
        .split("name='request_id' value='")
        .nth(1)
        .unwrap()
        .split('\'')
        .next()
        .unwrap();
    let csrf = html
        .split("name='csrf' value='")
        .nth(1)
        .unwrap()
        .split('\'')
        .next()
        .unwrap();
    let consent_body = format!("request={pending}&decision=approve&csrf={csrf}");
    let consent_request = |origin: &str, cookies: &str| {
        Request::builder()
            .method("POST")
            .uri("/oauth/authorize")
            .header("origin", origin)
            .header("cookie", cookies)
            .header("content-type", "application/x-www-form-urlencoded")
            .body(Body::from(consent_body.clone()))
            .unwrap()
    };
    assert_eq!(
        app.clone()
            .oneshot(consent_request("https://evil.example", &cookie))
            .await
            .unwrap()
            .status(),
        403
    );
    assert_eq!(
        app.clone()
            .oneshot(consent_request("https://library.example", &cookie))
            .await
            .unwrap()
            .status(),
        403
    );
    let consent = app
        .clone()
        .oneshot(consent_request(
            "https://library.example",
            &format!("{cookie}; {csrf_cookie}"),
        ))
        .await
        .unwrap();
    assert_eq!(consent.status(), 303);
    let redirect = url::Url::parse(consent.headers()["location"].to_str().unwrap()).unwrap();
    let code = redirect
        .query_pairs()
        .find(|(k, _)| k == "code")
        .unwrap()
        .1
        .into_owned();
    let exchange = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("grant_type", "authorization_code")
        .append_pair("code", &code)
        .append_pair("client_id", client["client_id"].as_str().unwrap())
        .append_pair("redirect_uri", "https://client.example/callback")
        .append_pair("code_verifier", &verifier)
        .append_pair("resource", "https://library.example/mcp")
        .finish();
    let token = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/oauth/token")
                .header("content-type", "application/x-www-form-urlencoded")
                .body(Body::from(exchange))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(token.status(), 200);
    let oauth: Value =
        serde_json::from_slice(&token.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert!(shufang_service::oauth::valid_access(
        &host,
        oauth["access_token"].as_str().unwrap()
    ));
    let library = app
        .clone()
        .oneshot(request(
            "GET",
            "/api/library/books",
            Value::Null,
            &cookie,
            "https://library.example",
        ))
        .await
        .unwrap();
    assert_eq!(library.status(), 200);
    let value: Value =
        serde_json::from_slice(&library.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(value, json!({"books":[],"deletedBookIds":[],"folders":[]}));
    let denied = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/library/books")
                .header("x-api-key", "machine-key")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(denied.status(), 401);
    let ping = app
        .clone()
        .oneshot(request(
            "GET",
            "/api/trpc/ping",
            Value::Null,
            &cookie,
            "https://library.example",
        ))
        .await
        .unwrap();
    assert_eq!(ping.status(), 200);
    let ping: Value =
        serde_json::from_slice(&ping.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(ping["result"]["data"]["json"]["ok"], true);
    let batch = app
        .clone()
        .oneshot(request(
            "GET",
            "/api/trpc/ping,ping?batch=1",
            Value::Null,
            &cookie,
            "https://library.example",
        ))
        .await
        .unwrap();
    assert_eq!(batch.status(), 200);
    let batch: Value =
        serde_json::from_slice(&batch.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(batch.as_array().unwrap().len(), 2);

    let created = app
        .clone()
        .oneshot(request(
            "POST",
            "/api/library/books",
            json!({"extId":"book","title":"Book"}),
            &cookie,
            "https://library.example",
        ))
        .await
        .unwrap();
    assert_eq!(created.status(), 200);
    let payload = b"public original source";
    use base64::{engine::general_purpose::STANDARD, Engine};
    use sha2::{Digest, Sha256};
    let hash = format!("{:x}", Sha256::digest(payload));
    let chunk = app
        .clone()
        .oneshot(request(
            "PUT",
            "/api/library/books/book/source/chunks",
            json!({"uploadId":hash,"index":0,"payload":STANDARD.encode(payload)}),
            &cookie,
            "https://library.example",
        ))
        .await
        .unwrap();
    assert_eq!(chunk.status(), 200);
    let completed=app.clone().oneshot(request("POST","/api/library/books/book/source/complete",json!({"uploadId":hash,"sha256":hash,"size":payload.len(),"chunks":1,"name":"original.txt","type":"text/plain"}),&cookie,"https://library.example")).await.unwrap();
    assert_eq!(completed.status(), 200);
    let downloaded = app
        .clone()
        .oneshot(request(
            "GET",
            "/api/library/books/book/source",
            Value::Null,
            &cookie,
            "https://library.example",
        ))
        .await
        .unwrap();
    assert_eq!(downloaded.status(), 200);
    assert_eq!(
        downloaded
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes()
            .as_ref(),
        payload
    );
    let cross_origin = app
        .clone()
        .oneshot(request(
            "PATCH",
            "/api/library/books/book/state",
            json!({"progress":{"chapterId":"","ratio":0.5}}),
            &cookie,
            "https://attacker.example",
        ))
        .await
        .unwrap();
    assert_eq!(cross_origin.status(), 403);

    let oauth_token = "public-oauth-access-token";
    let key = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(Sha256::digest(oauth_token.as_bytes()));
    let expires = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
        + 3600;
    {
        let mut core = workspace.core.lock().unwrap();
        let (revision, mut store) = core.local_value("oauth-store").unwrap().unwrap();
        store["access"][&key] = json!({"expires":expires,"resource":"https://library.example/mcp","scope":"library:read","owner":{"userId":"用户甲","credentialVersion":1}});
        core.set_local_value("oauth-store", revision, &store)
            .unwrap();
    }

    assert!(shufang_service::oauth::valid_access(&host, oauth_token));
    let r = app
        .clone()
        .oneshot(request(
            "PATCH",
            "/api/auth/profile",
            json!({"username":"用户乙","currentPassword":"public-long-password"}),
            &cookie,
            "https://library.example",
        ))
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    assert!(!shufang_service::oauth::valid_access(&host, oauth_token));
    let fresh = r.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    assert_eq!(
        app.clone()
            .oneshot(request(
                "GET",
                "/api/auth/profile",
                Value::Null,
                &cookie,
                "https://library.example"
            ))
            .await
            .unwrap()
            .status(),
        401
    );
    let r = app
        .clone()
        .oneshot(request(
            "GET",
            "/api/auth/profile",
            Value::Null,
            &fresh,
            "https://library.example",
        ))
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    let v: Value =
        serde_json::from_slice(&r.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(v["user"]["id"], "用户乙");
    assert!(!shufang_service::oauth::valid_access(
        &host,
        oauth["access_token"].as_str().unwrap()
    ));
    assert_eq!(
        app.clone()
            .oneshot(request(
                "POST",
                "/api/auth/login",
                json!({"appId":"用户乙","appSecret":"wrong"}),
                "",
                "https://library.example"
            ))
            .await
            .unwrap()
            .status(),
        401
    );
    assert_eq!(
        app.clone()
            .oneshot(request(
                "POST",
                "/api/auth/login",
                json!({"appId":"用户乙","appSecret":"public-long-password"}),
                "",
                "https://library.example"
            ))
            .await
            .unwrap()
            .status(),
        200
    );
    assert_eq!(
        app.oneshot(request(
            "POST",
            "/api/auth/logout",
            json!({}),
            &fresh,
            "https://library.example"
        ))
        .await
        .unwrap()
        .status(),
        200
    );
}
