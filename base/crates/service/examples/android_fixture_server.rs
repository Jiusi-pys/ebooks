//! Isolated, loopback-only acceptance fixture. Credentials here are public test data.
use serde_json::json;
use shufang_native::workspace::Workspace;
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
#[tokio::main]
async fn main() {
    let root = std::env::args()
        .nth(1)
        .expect("Supply an isolated fixture directory");
    let root = std::path::PathBuf::from(root);
    assert!(root.is_absolute());
    std::fs::create_dir_all(&root).unwrap();
    let workspace = Workspace::open(
        &root.join("library.sqlite"),
        "android-fixture",
        "fixture-server",
    )
    .unwrap();
    workspace.execute("save",json!({"kind":"notes","id":"server-seed","expected":0,"patch":{"title":"隔离服务器笔记","content":"服务端原数据 🚀"}})).unwrap();
    let origin = "http://127.0.0.1:31487";
    let mut host = Host::new(
        workspace.clone(),
        "android-public-machine-token".into(),
        origin.into(),
    );
    Arc::get_mut(&mut host).unwrap().browser = Some(
        Auth::new(
            Config {
                app_id: "bootstrap".into(),
                app_secret: "bootstrap-secret".into(),
                data_secret: "public-test-data-secret-1234567890".into(),
                session_secret: "public-test-session-secret-1234567890".into(),
                origin: origin.into(),
                ttl: 43200,
            },
            Arc::new(Accounts::default()),
        )
        .unwrap(),
    );
    let app = router(host).route(
        "/fixture/notes",
        axum::routing::get(move || {
            let workspace = workspace.clone();
            async move { axum::Json(workspace.execute("list", json!({"kind":"notes"})).unwrap()) }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:31487")
        .await
        .unwrap();
    println!("Android acceptance fixture ready on loopback port 31487");
    axum::serve(listener, app).await.unwrap();
}
