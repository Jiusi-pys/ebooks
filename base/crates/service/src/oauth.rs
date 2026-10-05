use crate::{error, same_secret, ApiResult, Host};
use axum::{
    extract::{Query, State},
    http::{HeaderMap, HeaderValue, StatusCode},
    response::{Html, IntoResponse, Redirect, Response},
    routing::{get, post},
    Form, Json, Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};
use url::Url;

pub fn router(host: Arc<Host>) -> Router<Arc<Host>> {
    Router::new()
        .route("/.well-known/oauth-protected-resource", get(resource))
        .route("/.well-known/oauth-protected-resource/mcp", get(resource))
        .route("/.well-known/oauth-authorization-server", get(metadata))
        .route("/oauth/register", post(register))
        .route("/oauth/authorize", get(authorize).post(consent))
        .route("/oauth/token", post(token))
        .route("/oauth/revoke", post(revoke))
        .layer(axum::middleware::from_fn_with_state(host, enabled))
}
async fn enabled(
    State(h): State<Arc<Host>>,
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    if !h.oauth_enabled {
        return (StatusCode::NOT_FOUND, Json(json!({"error":"not_found"}))).into_response();
    }
    next.run(request).await
}
fn configured_redirect(host: &Host, value: &str) -> bool {
    let Some(allowed) = &host.oauth_redirects else {
        return redirect_valid(value);
    };
    Url::parse(value).is_ok_and(|u| {
        u.scheme() == "https"
            && u.username().is_empty()
            && u.password().is_none()
            && u.fragment().is_none()
            && u.query().is_none()
            && (allowed.iter().any(|s| s == value)
                || u.origin().ascii_serialization() == "https://chatgpt.com"
                    && (u.path() == "/connector_platform_oauth_redirect"
                        || u.path().strip_prefix("/connector/oauth/").is_some_and(|s| {
                            !s.is_empty()
                                && s.bytes()
                                    .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
                        })))
    })
}
fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn random() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}
fn hash(token: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(token.as_bytes()))
}
fn empty() -> Value {
    json!({"clients":{},"pending":{},"codes":{},"access":{},"refresh":{},"used_refresh":{}})
}
fn mutate<F, T>(host: &Host, action: F) -> Result<T, String>
where
    F: FnOnce(&mut Value) -> Result<T, String>,
{
    let mut core = host.workspace.core.lock().map_err(|_| "core_lock_failed")?;
    let (revision, mut value) = core.local_value("oauth-store")?.unwrap_or((0, empty()));
    for key in ["pending", "codes", "access", "refresh", "used_refresh"] {
        if let Some(values) = value[key].as_object_mut() {
            values.retain(|_, v| v["expires"].as_u64().unwrap_or(0) > now());
        }
    }
    let result = action(&mut value)?;
    core.set_local_value("oauth-store", revision, &value)?;
    Ok(result)
}
fn valid_owner(host: &Host, record: &Value) -> Result<bool, String> {
    match &host.browser {
        None => Ok(true),
        Some(auth) => match (
            record["owner"]["userId"].as_str(),
            record["owner"]["credentialVersion"].as_u64(),
        ) {
            (Some(user), Some(version)) => auth.valid_owner(user, version),
            _ => Ok(false),
        },
    }
}
fn stored_key(records: &Value, token: &str) -> String {
    let current = hash(token);
    if records.get(&current).is_some() {
        current
    } else {
        format!("{:x}", Sha256::digest(token.as_bytes()))
    }
}
pub fn valid_access(host: &Host, token: &str) -> bool {
    valid_access_result(host, token).unwrap_or(false)
}
pub fn valid_access_result(host: &Host, token: &str) -> Result<bool, String> {
    if !host.oauth_enabled {
        return Ok(false);
    }
    if token.len() > 1024 {
        return Ok(false);
    }
    let core = host.workspace.core.lock().map_err(|_| "core_lock_failed")?;
    let Some((_, value)) = core.local_value("oauth-store")? else {
        return Ok(false);
    };
    let item = &value["access"][stored_key(&value["access"], token)];
    Ok(item["expires"].as_u64().unwrap_or(0) > now()
        && item["resource"] == format!("{}/mcp", host.base_url)
        && item["scope"] == "library:read"
        && valid_owner(host, item)?)
}
async fn resource(State(h): State<Arc<Host>>) -> Json<Value> {
    Json(
        json!({"resource":format!("{}/mcp",h.base_url),"authorization_servers":[h.base_url],"scopes_supported":["library:read"],"bearer_methods_supported":["header"]}),
    )
}
async fn metadata(State(h): State<Arc<Host>>) -> Json<Value> {
    Json(
        json!({"issuer":h.base_url,"authorization_endpoint":format!("{}/oauth/authorize",h.base_url),"token_endpoint":format!("{}/oauth/token",h.base_url),"registration_endpoint":format!("{}/oauth/register",h.base_url),"revocation_endpoint":format!("{}/oauth/revoke",h.base_url),"response_types_supported":["code"],"grant_types_supported":["authorization_code","refresh_token"],"code_challenge_methods_supported":["S256"],"token_endpoint_auth_methods_supported":["none"],"scopes_supported":["library:read"]}),
    )
}
fn redirect_valid(value: &str) -> bool {
    Url::parse(value).is_ok_and(|u| {
        u.username().is_empty()
            && u.password().is_none()
            && u.fragment().is_none()
            && (u.scheme() == "https"
                || (u.scheme() == "http"
                    && matches!(u.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))))
    })
}
async fn register(State(h): State<Arc<Host>>, Json(request): Json<Value>) -> ApiResult {
    let redirects = request["redirect_uris"]
        .as_array()
        .ok_or_else(|| error("invalid_redirect_uris".into()))?;
    if redirects.is_empty()
        || redirects.len() > 10
        || redirects
            .iter()
            .any(|r| !r.as_str().is_some_and(|s| configured_redirect(&h, s)))
    {
        return Err(error("invalid_redirect_uri".into()));
    }
    let id = random();
    let client = json!({"client_id":id,"client_id_issued_at":now(),"client_name":request["client_name"].as_str().unwrap_or("MCP client").chars().take(100).collect::<String>(),"redirect_uris":redirects,"token_endpoint_auth_method":"none","grant_types":["authorization_code","refresh_token"],"response_types":["code"]});
    mutate(&h, |store| {
        let active: HashSet<String> = ["pending", "codes", "access", "refresh"]
            .iter()
            .filter_map(|key| store[*key].as_object())
            .flat_map(|records| records.values())
            .filter_map(|record| record["client"].as_str().map(str::to_owned))
            .collect();
        let clients = store["clients"]
            .as_object_mut()
            .ok_or("invalid_oauth_store")?;
        // Older registrations have no timestamp. Give them a full grace period on
        // first registration attempt instead of dropping potentially live clients.
        for old in clients.values_mut() {
            if old["client_id_issued_at"].as_u64().is_none() {
                old["client_id_issued_at"] = now().into();
            }
        }
        clients.retain(|id, record| {
            active.contains(id)
                || record["client_id_issued_at"].as_u64().unwrap_or(0) + 86400 > now()
        });
        if clients.len() >= 200 {
            return Ok(Err("client_limit".to_owned()));
        }
        clients.insert(id.clone(), client.clone());
        Ok(Ok(()))
    })
    .map_err(error)?
    .map_err(error)?;
    Ok(Json(client))
}
async fn authorize(
    State(h): State<Arc<Host>>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let result = mutate(&h, |store| {
        let client = q.get("client_id").ok_or("invalid_client")?;
        let redirect = q.get("redirect_uri").ok_or("invalid_redirect_uri")?;
        if !store["clients"][client]["redirect_uris"]
            .as_array()
            .is_some_and(|rs| rs.iter().any(|r| r == redirect))
        {
            return Err("invalid_redirect_uri".into());
        }
        if q.get("response_type").map(String::as_str) != Some("code")
            || q.get("code_challenge_method").map(String::as_str) != Some("S256")
            || q.get("code_challenge").is_none_or(|s| s.len() != 43)
        {
            return Err("invalid_pkce".into());
        }
        if q.get("scope").is_some_and(|s| s != "library:read")
            || q.get("resource")
                .is_none_or(|s| s != &format!("{}/mcp", h.base_url))
        {
            return Err("invalid_scope_or_resource".into());
        }
        if store["pending"]
            .as_object()
            .ok_or("invalid_oauth_store")?
            .len()
            >= 100
        {
            return Err("authorization_limit".into());
        }
        let id = random();
        let csrf = random();
        store["pending"][&id] = json!({"client":client,"redirect":redirect,"challenge":q["code_challenge"],"state":q.get("state"),"resource":format!("{}/mcp",h.base_url),"expires":now()+600,"csrfHash":format!("{:x}",Sha256::digest(csrf.as_bytes()))});
        Ok((
            id,
            store["clients"][client]["client_name"]
                .as_str()
                .unwrap_or("MCP client")
                .to_owned(),
            redirect.to_owned(),
            csrf,
        ))
    });
    match result {
        Ok((id, name, redirect, csrf)) => {
            let request_name = if h.browser.is_some() {
                "request_id"
            } else {
                "request"
            };
            let credential = if h.browser.is_some() {
                format!("<input type='hidden' name='csrf' value='{csrf}'>")
            } else {
                "<label>管理员访问令牌 <input type='password' name='token' autocomplete='off' required></label>".into()
            };
            let mut response=Html(format!("<!doctype html><html lang='zh-CN'><meta charset='utf-8'><title>书房授权</title><body><h1>允许 {} 读取书库？</h1><p>回调地址：{}</p><p>授权范围：书目、阅读进度、书摘、复习队列和笔记。不会授予修改权限。</p><form method='post'><input type='hidden' name='{request_name}' value='{id}'>{credential}<button name='decision' value='allow'>允许只读访问</button><button name='decision' value='deny'>拒绝</button></form></body></html>",html(&name),html(&redirect))).into_response();
            let cookie = format!(
                "mcp_oauth_csrf={csrf}; Path=/oauth; HttpOnly; SameSite=Lax; Max-Age=600{}",
                if h.base_url.starts_with("https:") {
                    "; Secure"
                } else {
                    ""
                }
            );
            response.headers_mut().insert(
                "set-cookie",
                HeaderValue::from_str(&cookie).expect("generated cookie is ASCII"),
            );
            response
                .headers_mut()
                .insert("cache-control", HeaderValue::from_static("no-store"));
            response
                .headers_mut()
                .insert("x-frame-options", HeaderValue::from_static("DENY"));
            if let Ok(uri) = Url::parse(&redirect) {
                let policy=format!("default-src 'none'; form-action 'self' {}; base-uri 'none'; frame-ancestors 'none'",uri.origin().ascii_serialization());
                if let Ok(header) = HeaderValue::from_str(&policy) {
                    response
                        .headers_mut()
                        .insert("content-security-policy", header);
                }
            }
            response
        }
        Err(e) => error(e).into_response(),
    }
}
fn html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}
async fn consent(
    State(h): State<Arc<Host>>,
    headers: HeaderMap,
    Form(form): Form<HashMap<String, String>>,
) -> Response {
    let owner = if let Some(auth) = &h.browser {
        if !auth.same_origin(&headers) {
            return (
                StatusCode::FORBIDDEN,
                Json(json!({"error":"access_denied"})),
            )
                .into_response();
        }
        match auth.validate(&headers, true) {
            Ok(session) => Some(
                json!({"userId":session.user_id,"credentialVersion":session.credential_version}),
            ),
            Err(e) => {
                return (
                    if e == "unauthorized" {
                        StatusCode::UNAUTHORIZED
                    } else {
                        StatusCode::SERVICE_UNAVAILABLE
                    },
                    Json(json!({"error":e})),
                )
                    .into_response()
            }
        }
    } else {
        None
    };
    let authenticated = owner.is_some()
        || form
            .get("token")
            .is_some_and(|token| same_secret(token, &h.token));
    if !authenticated {
        return (
            StatusCode::UNAUTHORIZED,
            Html("管理员访问令牌无效".to_owned()),
        )
            .into_response();
    }
    let result = mutate(&h, |store| {
        let id = form
            .get("request_id")
            .or_else(|| form.get("request"))
            .ok_or("invalid_request")?;
        let pending = store["pending"]
            .as_object_mut()
            .ok_or("invalid_oauth_store")?
            .remove(id)
            .ok_or("expired_authorization")?;
        if owner.is_some() {
            let csrf = form.get("csrf").ok_or("csrf_rejected")?;
            let cookie = headers
                .get("cookie")
                .and_then(|h| h.to_str().ok())
                .and_then(|s| {
                    s.split(';')
                        .map(str::trim)
                        .find_map(|v| v.strip_prefix("mcp_oauth_csrf="))
                });
            if cookie != Some(csrf.as_str())
                || !same_secret(
                    pending["csrfHash"].as_str().unwrap_or(""),
                    &format!("{:x}", Sha256::digest(csrf.as_bytes())),
                )
            {
                return Err("csrf_rejected".into());
            }
        }
        let mut redirect = Url::parse(pending["redirect"].as_str().ok_or("invalid_redirect_uri")?)
            .map_err(|_| "invalid_redirect_uri")?;
        if form
            .get("decision")
            .is_some_and(|d| d == "approve" || d == "allow")
        {
            let code = random();
            store["codes"][hash(&code)] = pending.clone();
            store["codes"][hash(&code)]["expires"] = (now() + 300).into();
            store["codes"][hash(&code)]["owner"] = owner.clone().unwrap_or(Value::Null);
            redirect.query_pairs_mut().append_pair("code", &code);
        } else {
            redirect
                .query_pairs_mut()
                .append_pair("error", "access_denied");
        }
        if let Some(state) = pending["state"].as_str() {
            redirect.query_pairs_mut().append_pair("state", state);
        }
        Ok(redirect.to_string())
    });
    match result {
        Ok(url) => Redirect::to(&url).into_response(),
        Err(e) => error(e).into_response(),
    }
}
async fn token(State(h): State<Arc<Host>>, Form(form): Form<HashMap<String, String>>) -> Response {
    let result = mutate(&h, |store| {
        let client = form.get("client_id").ok_or("invalid_client")?;
        let resource = form.get("resource").ok_or("invalid_target")?;
        if resource != &format!("{}/mcp", h.base_url) {
            return Err("invalid_target".into());
        }
        if form.get("grant_type").map(String::as_str) == Some("refresh_token") {
            let key = stored_key(
                &store["used_refresh"],
                form.get("refresh_token").ok_or("invalid_grant")?,
            );
            if let Some(used) = store["used_refresh"].get(&key) {
                let grant = used["grant"].clone();
                for kind in ["access", "refresh"] {
                    store[kind]
                        .as_object_mut()
                        .ok_or("invalid_oauth_store")?
                        .retain(|_, v| v["grant"] != grant);
                }
                // A replay must be committed even if normal issuance is at capacity.
                return Ok(json!({"error":"invalid_grant"}));
            }
        }
        // Check capacity before consuming a code or a refresh token. mutate() does not
        // persist changes when its action returns Err.
        if store["access"]
            .as_object()
            .ok_or("invalid_oauth_store")?
            .len()
            >= 5000
        {
            return Err("token_limit".into());
        }
        let identity = match form.get("grant_type").map(String::as_str) {
            Some("authorization_code") => {
                let key = stored_key(&store["codes"], form.get("code").ok_or("invalid_grant")?);
                let record = store["codes"][&key].clone();
                let verifier = form.get("code_verifier").ok_or("invalid_grant")?;
                if !(43..=128).contains(&verifier.len())
                    || record["client"] != *client
                    || record["redirect"]
                        != form.get("redirect_uri").map(String::as_str).unwrap_or("")
                    || record["challenge"] != hash(verifier)
                    || record["resource"] != *resource
                    || record["expires"].as_u64().unwrap_or(0) <= now()
                {
                    return Err("invalid_grant".into());
                }
                store["codes"]
                    .as_object_mut()
                    .ok_or("invalid_oauth_store")?
                    .remove(&key);
                record
            }
            Some("refresh_token") => {
                let key = stored_key(
                    &store["refresh"],
                    form.get("refresh_token").ok_or("invalid_grant")?,
                );
                let record = store["refresh"][&key].clone();
                if record["client"] != *client
                    || record["resource"] != *resource
                    || record["expires"].as_u64().unwrap_or(0) <= now()
                {
                    return Err("invalid_grant".into());
                }
                store["refresh"]
                    .as_object_mut()
                    .ok_or("invalid_oauth_store")?
                    .remove(&key);
                let lifetime = record["grant_expires"]
                    .as_u64()
                    .unwrap_or_else(|| record["expires"].as_u64().unwrap_or(0));
                store["used_refresh"][&key] = json!({"grant":record["grant"],"expires":lifetime});
                record
            }
            _ => return Err("unsupported_grant_type".into()),
        };
        if !valid_owner(&h, &identity)? {
            return Err("invalid_grant".into());
        }
        let access = random();
        let refresh = random();
        let grant = identity["grant"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(random);
        let grant_expires = if form.get("grant_type").map(String::as_str) == Some("refresh_token") {
            identity["grant_expires"]
                .as_u64()
                .unwrap_or_else(|| identity["expires"].as_u64().unwrap_or(0))
        } else {
            now() + 30 * 86400
        };
        store["access"][hash(&access)] = json!({"client":client,"resource":resource,"scope":"library:read","expires":(now()+3600).min(grant_expires),"grant":grant,"owner":identity["owner"]});
        store["refresh"][hash(&refresh)] = json!({"client":client,"resource":resource,"scope":"library:read","expires":grant_expires,"grant_expires":grant_expires,"grant":grant,"owner":identity["owner"]});
        Ok(
            json!({"access_token":access,"token_type":"Bearer","expires_in":3600u64.min(grant_expires.saturating_sub(now())),"refresh_token":refresh,"scope":"library:read"}),
        )
    });
    match result {
        Ok(value) if value.get("error").is_some() => {
            (StatusCode::BAD_REQUEST, Json(value)).into_response()
        }
        Ok(value) => (
            [("Cache-Control", "no-store"), ("Pragma", "no-cache")],
            Json(value),
        )
            .into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, Json(json!({"error":e}))).into_response(),
    }
}
async fn revoke(
    State(h): State<Arc<Host>>,
    Form(form): Form<HashMap<String, String>>,
) -> ApiResult {
    mutate(&h, |store| {
        let raw = form.get("token").ok_or("invalid_request")?;
        let key = if store["access"]
            .get(stored_key(&store["access"], raw))
            .is_some()
        {
            stored_key(&store["access"], raw)
        } else {
            stored_key(&store["refresh"], raw)
        };
        let client = form.get("client_id").ok_or("invalid_client")?;
        let record = if store["access"].get(&key).is_some() {
            store["access"][&key].clone()
        } else {
            store["refresh"][&key].clone()
        };
        if record["client"] == *client {
            let grant = record["grant"].clone();
            for kind in ["access", "refresh"] {
                store[kind]
                    .as_object_mut()
                    .ok_or("invalid_oauth_store")?
                    .retain(|_, v| v["grant"] != grant);
            }
        }
        Ok(())
    })
    .map_err(error)?;
    Ok(Json(json!({})))
}
