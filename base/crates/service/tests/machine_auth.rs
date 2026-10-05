use axum::{body::Body, http::Request};
use shufang_native::workspace::Workspace;
use shufang_service::{router, Host};
use std::sync::Arc;
use tower::ServiceExt;
#[tokio::test]
async fn production_api_key_preserves_clients_without_granting_process_control() {
    let dir = tempfile::tempdir().unwrap();
    let mut host = Host::new(
        Workspace::open(&dir.path().join("db"), "w", "n").unwrap(),
        "owner-key".into(),
        "http://localhost".into(),
    );
    Arc::get_mut(&mut host).unwrap().machine_key = Some("production-key".into());
    let app = router(host);
    for (path, key, status) in [
        ("/api/v1/notes", "production-key", 200),
        ("/admin/status", "production-key", 401),
        ("/admin/status", "owner-key", 200),
        ("/api/v2/capabilities", "production-key", 200),
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(path)
                    .header("x-api-key", key)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status().as_u16(), status, "{path}");
    }
}
