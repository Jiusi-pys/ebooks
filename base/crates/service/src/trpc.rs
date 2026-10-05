//! Existing tRPC HTTP envelopes over Rust use cases; no API key browser fallback.
use crate::Host;
use axum::{
    body::to_bytes,
    extract::{Path, Request, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::any,
    Json, Router,
};
use serde_json::{json, Value};
use std::{collections::HashMap, sync::Arc};
#[derive(Debug)]
pub(crate) struct Failure {
    status: u16,
    code: &'static str,
    message: String,
}
pub(crate) fn fail(code: &'static str, message: impl Into<String>) -> Failure {
    let status = match code {
        "UNAUTHORIZED" => 401,
        "FORBIDDEN" => 403,
        "NOT_FOUND" => 404,
        "METHOD_NOT_SUPPORTED" => 405,
        "PRECONDITION_FAILED" => 412,
        "TOO_MANY_REQUESTS" => 429,
        "TIMEOUT" => 408,
        "INTERNAL_SERVER_ERROR" => 500,
        _ => 400,
    };
    Failure {
        status,
        code,
        message: message.into(),
    }
}
fn envelope(error: Failure, path: &str) -> (u16, Value) {
    let number = match error.code {
        "UNAUTHORIZED" => -32001,
        "FORBIDDEN" => -32003,
        "NOT_FOUND" => -32004,
        "METHOD_NOT_SUPPORTED" => -32005,
        "TIMEOUT" => -32008,
        "PRECONDITION_FAILED" => -32012,
        "TOO_MANY_REQUESTS" => -32029,
        "INTERNAL_SERVER_ERROR" => -32603,
        _ => -32600,
    };
    (
        error.status,
        json!({"error":{"json":{"message":error.message,"code":number,"data":{"code":error.code,"httpStatus":error.status,"path":path}}}}),
    )
}
pub fn router() -> Router<Arc<Host>> {
    Router::new().route("/api/trpc/{procedures}", any(handle))
}
async fn handle(
    State(host): State<Arc<Host>>,
    Path(paths): Path<String>,
    request: Request,
) -> Response {
    let method = request.method().as_str().to_owned();
    let headers = request.headers().clone();
    let query: HashMap<String, String> =
        url::form_urlencoded::parse(request.uri().query().unwrap_or("").as_bytes())
            .into_owned()
            .collect();
    let batch = query.get("batch").is_some_and(|s| s == "1");
    let paths: Vec<&str> = paths.split(',').collect();
    let auth = if let Some(auth) = host.browser.clone() {
        tokio::task::spawn_blocking(move || {
            auth.validate(&headers, true)
                .map_err(|e| match e.as_str() {
                    "unauthorized" => fail("UNAUTHORIZED", "请先登录书房"),
                    "setup_required" => fail("PRECONDITION_FAILED", "请先完成首次账户设置"),
                    _ => fail(
                        "INTERNAL_SERVER_ERROR",
                        "无法读取用户数据，请检查 MySQL 连接与迁移状态",
                    ),
                })?;
            if method != "GET" && method != "HEAD" && !auth.same_origin(&headers) {
                return Err(fail("FORBIDDEN", "请求必须来自书房同源页面"));
            }
            Ok(())
        })
        .await
        .unwrap_or_else(|_| Err(fail("INTERNAL_SERVER_ERROR", "账户服务不可用")))
    } else {
        Err(fail("INTERNAL_SERVER_ERROR", "账户服务未配置"))
    };
    let method = request.method().as_str().to_owned();
    let input = if method == "GET" {
        query
            .get("input")
            .map(|s| serde_json::from_str::<Value>(s))
            .transpose()
            .map(|v| v.unwrap_or(Value::Null))
            .map_err(|_| fail("BAD_REQUEST", "请求 JSON 无效"))
    } else {
        match to_bytes(request.into_body(), 8 * 1024 * 1024).await {
            Ok(bytes) => {
                if bytes.is_empty() {
                    Ok(Value::Null)
                } else {
                    serde_json::from_slice(&bytes)
                        .map_err(|_| fail("BAD_REQUEST", "请求 JSON 无效"))
                }
            }
            Err(_) => Err(fail("BAD_REQUEST", "请求体过大")),
        }
    };
    let mut responses = Vec::new();
    let mut statuses = Vec::new();
    for (index, path) in paths.iter().enumerate() {
        let result = match (&auth, &input) {
            (Err(e), _) => Err(fail(e.code, e.message.clone())),
            (_, Err(e)) => Err(fail(e.code, e.message.clone())),
            _ if paths.len() > 16 || (!batch && paths.len() != 1) => {
                Err(fail("BAD_REQUEST", "批量调用数量无效"))
            }
            (Ok(()), Ok(input)) => {
                let input = if batch {
                    input.get(index.to_string()).unwrap_or(&Value::Null)
                } else {
                    input
                };
                let input = input.get("json").unwrap_or(&Value::Null).clone();
                call(&host, path, &method, input).await
            }
        };
        let (status, value) = match result {
            Ok(value) => {
                let data = if *path == "ai.getDigest" && value.get("createdAt").is_some() {
                    json!({"json":value,"meta":{"values":{"createdAt":["Date"]},"v":1}})
                } else {
                    json!({"json":value})
                };
                (200, json!({"result":{"data":data}}))
            }
            Err(e) => envelope(e, path),
        };
        statuses.push(status);
        responses.push(value);
    }
    let status = if statuses.iter().all(|s| *s == statuses[0]) {
        statuses[0]
    } else {
        207
    };
    (
        StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        [("cache-control", "no-store")],
        Json(if batch {
            Value::Array(responses)
        } else {
            responses.remove(0)
        }),
    )
        .into_response()
}
pub(crate) fn config(
    value: &Value,
    optional: bool,
) -> Result<(shufang_native::ai::Config, Option<String>), Failure> {
    if optional && value.is_null() {
        return Ok((
            shufang_native::ai::Config {
                provider: "deepseek".into(),
                model: String::new(),
                effort: "none".into(),
            },
            None,
        ));
    }
    let provider = value["provider"]
        .as_str()
        .ok_or_else(|| fail("BAD_REQUEST", "无效的 AI 配置"))?;
    let model = value["model"]
        .as_str()
        .filter(|s| !s.is_empty() && s.encode_utf16().count() <= 80)
        .ok_or_else(|| fail("BAD_REQUEST", "无效的模型"))?;
    let effort = value["effort"]
        .as_str()
        .ok_or_else(|| fail("BAD_REQUEST", "无效的思考强度"))?;
    let config = shufang_native::ai::Config {
        provider: provider.into(),
        model: model.into(),
        effort: effort.into(),
    };
    config
        .validate()
        .map_err(|_| fail("BAD_REQUEST", "无效的 AI 配置"))?;
    if (provider == "codex" && effort == "none")
        || (provider == "deepseek" && !["none", "low", "high", "max"].contains(&effort))
    {
        return Err(fail("BAD_REQUEST", "该 Provider 不支持此思考强度"));
    }
    let key = value
        .get("apiKey")
        .map(|v| {
            v.as_str()
                .filter(|s| s.encode_utf16().count() <= 512)
                .map(str::to_owned)
                .ok_or_else(|| fail("BAD_REQUEST", "无效的 API Key"))
        })
        .transpose()?;
    Ok((config, key))
}
pub(crate) fn secret(provider: &str, supplied: Option<String>) -> Option<String> {
    supplied
        .filter(|s| !s.trim().is_empty())
        .or_else(|| {
            let name = match provider {
                "openai" => "OPENAI_API_KEY",
                "deepseek" => "DEEPSEEK_API_KEY",
                "kimi" => "KIMI_API_KEY",
                "minimax" => "MINIMAX_API_KEY",
                _ => return None,
            };
            std::env::var(name).ok().filter(|s| !s.trim().is_empty())
        })
        .map(|s| s.trim().to_owned())
}
async fn call(host: &Arc<Host>, path: &str, method: &str, input: Value) -> Result<Value, Failure> {
    let query = matches!(path, "ping" | "ai.status" | "ai.getDigest");
    if !matches!(
        path,
        "ping"
            | "ai.status"
            | "ai.getDigest"
            | "ai.saveDigest"
            | "ai.models"
            | "ai.testConnection"
            | "ai.chat"
            | "ai.translate"
            | "ai.mindmap"
            | "ai.studyCard"
    ) {
        return Err(fail("NOT_FOUND", "接口不存在"));
    }
    if (query && method != "GET" && method != "HEAD") || (!query && method != "POST") {
        return Err(fail("METHOD_NOT_SUPPORTED", "请求方法无效"));
    }
    match path {
        "ping" => {
            use shufang_application::Runtime;
            Ok(json!({"ok":true,"ts":shufang_native::workspace::SystemRuntime.now()}))
        }
        "ai.status" => {
            let (config, supplied) = config(&input, true)?;
            let auth = if config.provider == "codex" {
                host.codex.status().await
            } else {
                json!({"available":true,"authenticated":secret(&config.provider,supplied).is_some(),"method":"api-key"})
            };
            Ok(
                json!({"provider":config.provider,"model":config.model,"reasoningEffort":config.effort,"auth":auth}),
            )
        }
        _ => crate::ai_rpc::call(host, path, input).await,
    }
}
