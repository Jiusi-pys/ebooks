//! Owner-authenticated Codex lifecycle, with one login process per service.
use crate::{error, Host};
use axum::{
    extract::State,
    http::StatusCode,
    middleware,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use futures_util::future::BoxFuture;
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
pub struct Process {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}
pub trait Runner: Send + Sync {
    fn run(&self, args: Vec<String>, seconds: u64) -> BoxFuture<'static, Result<Process, String>>;
}
struct Real;
async fn tail(mut stream: impl tokio::io::AsyncRead + Unpin) -> Result<String, String> {
    use tokio::io::AsyncReadExt;
    let mut bytes = Vec::new();
    let mut buffer = [0u8; 4096];
    loop {
        let count = stream
            .read(&mut buffer)
            .await
            .map_err(|_| "codex_output_failed")?;
        if count == 0 {
            break;
        }
        bytes.extend_from_slice(&buffer[..count]);
        if bytes.len() > 16384 {
            bytes.drain(..bytes.len() - 16384);
        }
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}
impl Runner for Real {
    fn run(&self, args: Vec<String>, seconds: u64) -> BoxFuture<'static, Result<Process, String>> {
        Box::pin(async move {
            let mut command = shufang_native::ai::codex_command();
            command
                .args(args)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped());
            let mut child = command.spawn().map_err(|_| "codex_unavailable")?;
            let stdout = child.stdout.take().ok_or("codex_output_failed")?;
            let stderr = child.stderr.take().ok_or("codex_output_failed")?;
            tokio::time::timeout(std::time::Duration::from_secs(seconds), async {
                let (stdout, stderr, status) =
                    tokio::join!(tail(stdout), tail(stderr), child.wait());
                Ok(Process {
                    code: status
                        .map_err(|_| "codex_process_failed")?
                        .code()
                        .unwrap_or(-1),
                    stdout: stdout?,
                    stderr: stderr?,
                })
            })
            .await
            .map_err(|_| "codex_timeout")?
        })
    }
}
pub struct Controller {
    runner: Arc<dyn Runner>,
    operations: tokio::sync::Mutex<()>,
    running: AtomicBool,
    last_error: Mutex<Option<String>>,
}
impl Controller {
    pub fn new() -> Arc<Self> {
        Self::with_runner(Arc::new(Real))
    }
    pub fn with_runner(runner: Arc<dyn Runner>) -> Arc<Self> {
        Arc::new(Self {
            runner,
            operations: tokio::sync::Mutex::new(()),
            running: AtomicBool::new(false),
            last_error: Mutex::new(None),
        })
    }
    pub async fn status(&self) -> Value {
        let result = self
            .runner
            .run(vec!["login".into(), "status".into()], 10)
            .await;
        let (available, authenticated, method) = match result {
            Ok(p) => {
                let detail = format!("{} {}", p.stdout, p.stderr).to_lowercase();
                let method = if detail.contains("chatgpt") {
                    "chatgpt"
                } else if detail.contains("access token") || detail.contains("access-token") {
                    "access-token"
                } else if detail.contains("api key") || detail.contains("api-key") {
                    "api-key"
                } else {
                    "unknown"
                };
                (true, p.code == 0, method)
            }
            Err(_) => (false, false, "unknown"),
        };
        json!({"available":available,"authenticated":authenticated,"method":method,"loginRunning":self.running.load(Ordering::Acquire),"lastLoginError":self.last_error.lock().ok().and_then(|v|v.clone())})
    }
    pub async fn login(self: &Arc<Self>) -> Result<Value, String> {
        let _operation = self.operations.lock().await;
        let mut status = self.status().await;
        if status["available"] != true {
            return Err("codex_unavailable".into());
        }
        if self.running.load(Ordering::Acquire) || status["authenticated"] == true {
            status["started"] = false.into();
            return Ok(status);
        }
        self.running.store(true, Ordering::Release);
        *self.last_error.lock().map_err(|_| "codex_state_failed")? = None;
        let owner = self.clone();
        tokio::spawn(async move {
            let result = owner.runner.run(vec!["login".into()], 900).await;
            let error = match result {
                Ok(p) if p.code == 0 => None,
                _ => Some("Codex 登录未完成，请重试".to_owned()),
            };
            if let Ok(mut value) = owner.last_error.lock() {
                *value = error;
            }
            owner.running.store(false, Ordering::Release);
        });
        status["started"] = true.into();
        status["loginRunning"] = true.into();
        Ok(status)
    }
    pub async fn logout(&self) -> Result<Value, String> {
        let _operation = self.operations.lock().await;
        if self.running.load(Ordering::Acquire) {
            return Err("codex_login_running".into());
        }
        let process = self.runner.run(vec!["logout".into()], 15).await?;
        if process.code != 0 {
            return Err("codex_logout_failed".into());
        }
        *self.last_error.lock().map_err(|_| "codex_state_failed")? = None;
        Ok(self.status().await)
    }
}
pub fn router(host: Arc<Host>) -> Router<Arc<Host>> {
    Router::new()
        .route("/api/auth/codex/status", get(status))
        .route("/api/auth/codex/login", post(login))
        .route("/api/auth/codex/logout", post(logout))
        .layer(middleware::from_fn_with_state(
            host,
            crate::library::authorize,
        ))
}
async fn status(State(h): State<Arc<Host>>) -> Json<Value> {
    Json(h.codex.status().await)
}
async fn login(State(h): State<Arc<Host>>) -> Response {
    match h.codex.login().await {
        Ok(mut value) => {
            value["ok"] = true.into();
            (
                if value["started"] == true {
                    StatusCode::ACCEPTED
                } else {
                    StatusCode::OK
                },
                Json(value),
            )
                .into_response()
        }
        Err(e) => error(e).into_response(),
    }
}
async fn logout(State(h): State<Arc<Host>>) -> Response {
    match h.codex.logout().await {
        Ok(mut value) => {
            value["ok"] = true.into();
            Json(value).into_response()
        }
        Err(e) => (StatusCode::CONFLICT, Json(json!({"error":e}))).into_response(),
    }
}
