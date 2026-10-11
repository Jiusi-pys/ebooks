//! Loopback-only macOS acceptance fixture: real Rust HTTP/auth/sync routes,
//! SQLite business storage, and an explicitly in-memory test account store.
use shufang_native::workspace::Workspace;
use shufang_service::{
    browser_auth::{Auth, Config, User, UserStore},
    credentials, router, Host,
};
use std::{path::PathBuf, sync::Arc};
struct Account(User);
impl UserStore for Account {
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
#[tokio::main]
async fn main() {
    let args: Vec<_> = std::env::args().collect();
    assert!(
        (3..=4).contains(&args.len()),
        "requires an isolated fixture root and ready file"
    );
    let root = PathBuf::from(&args[1]);
    assert!(
        root.is_absolute() && !root.exists(),
        "fixture directory must be new"
    );
    let ready = PathBuf::from(&args[2]);
    assert!(!ready.exists(), "ready file must be new");
    let workspace =
        Workspace::open(&root.join("library.sqlite3"), "mac-test", "mac-server").unwrap();
    workspace.execute("save",serde_json::json!({"kind":"notes","id":"server-note","expected":0,"patch":{"title":"服务端资料","content":"真实 Rust HTTP → Mac 😀"}})).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let secret = "synthetic-test-data-secret-1234567890";
    let mut host = Host::new(
        workspace,
        "synthetic-machine-key-only".into(),
        origin.clone(),
    );
    Arc::get_mut(&mut host).unwrap().browser = Some(
        Auth::new(
            Config {
                app_id: String::new(),
                app_secret: String::new(),
                data_secret: secret.into(),
                session_secret: "synthetic-test-session-secret-1234567890".into(),
                origin: origin.clone(),
                ttl: 3600,
            },
            Arc::new(Account(User {
                encrypted: credentials::encrypt_username("mac-test-user", secret).unwrap(),
                hash: credentials::hash_password("synthetic-mac-password-123").unwrap(),
                version: 1,
            })),
        )
        .unwrap(),
    );
    std::fs::write(ready, serde_json::json!({"origin":origin}).to_string()).unwrap();
    let app = if args.get(3).is_some_and(|value| value == "slow") {
        router(host).layer(axum::middleware::from_fn(
            |request: axum::extract::Request, next: axum::middleware::Next| async move {
                tokio::time::sleep(std::time::Duration::from_secs(10)).await;
                next.run(request).await
            },
        ))
    } else {
        router(host)
    };
    axum::serve(listener, app).await.unwrap();
}
