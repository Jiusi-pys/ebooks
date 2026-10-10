use serde_json::{json, Value};
use shufang_native::{
    replication::{tick_peer, Peer},
    transport_host::SyncHost,
    workspace::Workspace,
};
use shufang_service::{
    browser_auth::{Auth, Config, User, UserStore},
    router, Host,
};
use std::sync::{Arc, Mutex};

#[derive(Default)]
struct Accounts(Mutex<Option<User>>);
impl UserStore for Accounts {
    fn get(&self) -> Result<Option<User>, String> {
        Ok(self.0.lock().unwrap().clone())
    }
    fn create(&self, user: User) -> Result<bool, String> {
        let mut state = self.0.lock().unwrap();
        if state.is_some() {
            return Ok(false);
        }
        *state = Some(user);
        Ok(true)
    }
    fn update(&self, expected: u64, user: User) -> Result<bool, String> {
        let mut state = self.0.lock().unwrap();
        if state.as_ref().map(|u| u.version) != Some(expected) {
            return Ok(false);
        }
        *state = Some(user);
        Ok(true)
    }
}

#[tokio::test]
async fn android_shared_transport_uses_account_cookie_for_bidirectional_sync_and_rejects_expiry() {
    let local = tempfile::tempdir().unwrap();
    let remote = tempfile::tempdir().unwrap();
    let phone = Workspace::open(
        &local.path().join("library.sqlite"),
        "android-http",
        "phone",
    )
    .unwrap();
    let server = Workspace::open(
        &remote.path().join("library.sqlite"),
        "android-http",
        "server",
    )
    .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let mut host = Host::new(server.clone(), "machine-token-only".into(), origin.clone());
    Arc::get_mut(&mut host).unwrap().browser = Some(
        Auth::new(
            Config {
                app_id: "bootstrap".into(),
                app_secret: "bootstrap-secret".into(),
                data_secret: "public-test-data-secret-1234567890".into(),
                session_secret: "public-test-session-secret-1234567890".into(),
                origin: origin.clone(),
                ttl: 43200,
            },
            Arc::new(Accounts::default()),
        )
        .unwrap(),
    );
    let service = tokio::spawn(async move { axum::serve(listener, router(host)).await.unwrap() });
    let client = reqwest::Client::new();
    let login = client
        .post(format!("{origin}/api/auth/login"))
        .header("Origin", &origin)
        .json(&json!({"appId":"bootstrap","appSecret":"bootstrap-secret"}))
        .send()
        .await
        .unwrap();
    assert!(login.status().is_success());
    let cookie = login.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let setup=client.post(format!("{origin}/api/auth/setup")).header("Origin",&origin).header("Cookie",cookie).json(&json!({"username":"android-test","newPassword":"public-test-password-123","confirmPassword":"public-test-password-123"})).send().await.unwrap();
    assert!(setup.status().is_success());
    let cookie = setup.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let peer = Peer {
        id: "server".into(),
        url: origin.clone(),
        token: String::new(),
        cookie: Some(cookie.clone()),
    };
    let transport = SyncHost::new(phone.clone(), false);
    phone.execute("save",json!({"kind":"notes","id":"phone-note","expected":0,"patch":{"title":"离线修改","content":"Unicode 🚀"}})).unwrap();
    server.execute("save",json!({"kind":"notes","id":"web-note","expected":0,"patch":{"title":"Web 修改","content":"服务端"}})).unwrap();
    tick_peer(&transport, &peer).await.unwrap();
    assert_eq!(
        server
            .execute("get", json!({"kind":"notes","id":"phone-note"}))
            .unwrap()["value"]["content"],
        "Unicode 🚀"
    );
    let web = phone
        .execute("get", json!({"kind":"notes","id":"web-note"}))
        .unwrap();
    phone
        .execute(
            "delete",
            json!({"kind":"notes","id":"web-note","expected":web["revision"]}),
        )
        .unwrap();
    tick_peer(&transport, &peer).await.unwrap();
    assert!(server
        .execute("get", json!({"kind":"notes","id":"web-note"}))
        .is_err());
    let revoked=client.patch(format!("{origin}/api/auth/profile")).header("Origin",&origin).header("Cookie",cookie).json(&json!({"username":"android-test","currentPassword":"public-test-password-123","newPassword":"public-test-password-456","confirmPassword":"public-test-password-456"})).send().await.unwrap();
    assert!(revoked.status().is_success());
    assert!(tick_peer(&transport, &peer).await.is_err());
    assert_eq!(
        phone
            .execute("get", json!({"kind":"notes","id":"phone-note"}))
            .unwrap()["value"]["content"],
        "Unicode 🚀"
    );
    let invalid = Peer {
        token: "invalid-machine-token".into(),
        cookie: None,
        ..peer
    };
    assert!(tick_peer(&transport, &invalid).await.is_err());
    let _: Value = phone.execute("syncStatus", json!({})).unwrap();
    service.abort();
}
