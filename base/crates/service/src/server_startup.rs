use crate::Host;
use axum::{
    http::StatusCode,
    middleware,
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;

pub(crate) fn router(host: Arc<Host>) -> Router<Arc<Host>> {
    Router::new()
        .route("/api/autostart/status", get(status).post(set))
        .layer(middleware::from_fn_with_state(
            host,
            crate::library::authorize,
        ))
}
async fn status() -> Response {
    ([("cache-control", "no-store")], Json(json!({"supported":false,"installed":false,"enabled":false,"platform":"linux","reason":"managed_externally"}))).into_response()
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Setting {
    enabled: bool,
}
async fn set(body: axum::body::Bytes) -> Response {
    let valid = serde_json::from_slice::<Setting>(&body).map(|setting| setting.enabled);
    let (status, message) = if valid.is_ok() {
        (
            StatusCode::CONFLICT,
            "Automatic startup is unsupported on this platform",
        )
    } else {
        (StatusCode::BAD_REQUEST, "无效的启动项设置")
    };
    (
        status,
        [("cache-control", "no-store")],
        Json(json!({"error":message})),
    )
        .into_response()
}
