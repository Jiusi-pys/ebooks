//! Browser authentication compatible with Node's singleton MySQL account.
use crate::{browser_session, credentials, same_secret, Host};
use axum::{
    body::to_bytes,
    extract::{Request, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::any,
    Json, Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use hmac::{Hmac, Mac};
use mysql::{prelude::Queryable, Opts, OptsBuilder, Pool, PoolConstraints, PoolOpts};
use serde_json::{json, Value};
use sha2::Sha256;
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Clone)]
pub struct User {
    pub encrypted: String,
    pub hash: String,
    pub version: u64,
}
pub trait UserStore: Send + Sync {
    fn get(&self) -> Result<Option<User>, String>;
    fn create(&self, user: User) -> Result<bool, String>;
    fn update(&self, expected: u64, user: User) -> Result<bool, String>;
}
pub struct MysqlUsers(Pool);
impl MysqlUsers {
    pub fn open(url: &str) -> Result<Self, String> {
        let opts = Opts::from_url(url).map_err(|_| "invalid_database_url")?;
        let opts = OptsBuilder::from_opts(opts).pool_opts(
            PoolOpts::default().with_constraints(PoolConstraints::new(0, 3).ok_or("invalid_pool")?),
        );
        Ok(Self(
            Pool::new(opts).map_err(|_| "account_store_unavailable")?,
        ))
    }
}
impl UserStore for MysqlUsers {
    fn get(&self) -> Result<Option<User>, String> {
        let mut conn = self.0.get_conn().map_err(|_| "account_store_unavailable")?;
        let row:Option<(String,String,u64)>=conn.query_first("SELECT username_encrypted,password_hash,credential_version FROM app_users WHERE id=1").map_err(|_|"account_store_unavailable")?;
        Ok(row.map(|(encrypted, hash, version)| User {
            encrypted,
            hash,
            version,
        }))
    }
    fn create(&self, user: User) -> Result<bool, String> {
        let mut conn = self.0.get_conn().map_err(|_| "account_store_unavailable")?;
        match conn.exec_drop("INSERT INTO app_users(id,username_encrypted,password_hash,credential_version) VALUES (1,?,?,1)",(user.encrypted,user.hash)) {
            Ok(())=>Ok(true),Err(mysql::Error::MySqlError(e)) if e.code==1062=>Ok(false),Err(_)=>Err("account_store_unavailable".into())
        }
    }
    fn update(&self, expected: u64, user: User) -> Result<bool, String> {
        let mut conn = self.0.get_conn().map_err(|_| "account_store_unavailable")?;
        conn.exec_drop("UPDATE app_users SET username_encrypted=?,password_hash=?,credential_version=credential_version+1,updated_at=CURRENT_TIMESTAMP WHERE id=1 AND credential_version=?",(user.encrypted,user.hash,expected)).map_err(|_|"account_store_unavailable")?;
        Ok(conn.affected_rows() == 1)
    }
}
pub struct Config {
    pub app_id: String,
    pub app_secret: String,
    pub data_secret: String,
    pub session_secret: String,
    pub origin: String,
    pub ttl: u64,
}
pub struct Auth {
    pub config: Config,
    pub store: Arc<dyn UserStore>,
    hashes: Arc<tokio::sync::Semaphore>,
    failures: Mutex<BTreeMap<String, (u32, u64, u64)>>,
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
type Reply = (u16, Value, Option<String>);
fn fail(code: &str) -> Reply {
    let status = match code {
        "unauthorized" => 401,
        "csrf_rejected" => 403,
        "setup_required" => 428,
        "setup_completed" | "credential_conflict" => 409,
        "login_throttled" | "password_hash_busy" => 429,
        "account_store_unavailable" | "auth_not_configured" => 503,
        _ => 400,
    };
    (status, json!({"error":code}), None)
}
impl Auth {
    pub fn new(mut config: Config, store: Arc<dyn UserStore>) -> Result<Arc<Self>, String> {
        if config.data_secret.len() < 32 || config.session_secret.len() < 32 {
            return Err("auth_not_configured".into());
        }
        let origin = url::Url::parse(&config.origin).map_err(|_| "invalid_public_origin")?;
        if !["http", "https"].contains(&origin.scheme())
            || origin.path() != "/"
            || !origin.username().is_empty()
            || origin.password().is_some()
            || origin.query().is_some()
            || origin.fragment().is_some()
        {
            return Err("invalid_public_origin".into());
        }
        config.origin = origin.origin().ascii_serialization();
        config.ttl = config.ttl.clamp(300, 604800);
        Ok(Arc::new(Self {
            config,
            store,
            hashes: Arc::new(tokio::sync::Semaphore::new(2)),
            failures: Mutex::new(BTreeMap::new()),
        }))
    }
    fn username(&self, user: &User) -> Result<(String, bool), String> {
        match credentials::decrypt_username(&user.encrypted, &self.config.data_secret) {
            Ok(v) => Ok((v, false)),
            Err(_) => credentials::decrypt_username(&user.encrypted, &self.config.app_secret)
                .map(|v| (v, true))
                .map_err(|_| "account_store_unavailable".into()),
        }
    }
    pub fn same_origin(&self, headers: &HeaderMap) -> bool {
        headers
            .get("origin")
            .and_then(|h| h.to_str().ok())
            .and_then(|v| url::Url::parse(v).ok())
            .is_some_and(|v| v.origin().ascii_serialization() == self.config.origin)
            && headers
                .get("sec-fetch-site")
                .is_none_or(|v| v == "same-origin")
    }
    pub fn signed(&self, headers: &HeaderMap) -> Option<browser_session::Session> {
        let cookie = headers
            .get("cookie")?
            .to_str()
            .ok()?
            .split(';')
            .map(str::trim)
            .find_map(|p| p.strip_prefix("shufang_session="))?;
        browser_session::verify(cookie, &self.config.session_secret, now() as i64)
    }
    pub fn validate(
        &self,
        headers: &HeaderMap,
        normal: bool,
    ) -> Result<browser_session::Session, String> {
        let session = self.signed(headers).ok_or("unauthorized")?;
        let user = self.store.get()?;
        if session.setup_required {
            return if user.is_some() {
                Err("unauthorized".into())
            } else if normal {
                Err("setup_required".into())
            } else {
                Ok(session)
            };
        }
        let user = user.ok_or("unauthorized")?;
        if user.version != session.credential_version
            || !same_secret(&session.user_id, &self.username(&user)?.0)
        {
            return Err("unauthorized".into());
        }
        Ok(session)
    }
    pub fn valid_owner(&self, username: &str, version: u64) -> Result<bool, String> {
        let Some(user) = self.store.get()? else {
            return Ok(false);
        };
        Ok(version != 0
            && user.version == version
            && same_secret(username, &self.username(&user)?.0))
    }
    fn cookie(&self, username: &str, setup: bool, version: u64) -> Result<(String, u64), String> {
        use aes_gcm::aead::Generate;
        let issued = now();
        let expires = issued + self.config.ttl;
        let nonce = aes_gcm::aead::Key::<aes_gcm::Aes256Gcm>::generate();
        let payload = json!({"v":2,"sub":username,"iat":issued,"exp":expires,"nonce":URL_SAFE_NO_PAD.encode(&nonce[..16]),"setup":setup,"cv":version});
        let encoded = URL_SAFE_NO_PAD.encode(payload.to_string());
        let mut mac = Hmac::<Sha256>::new_from_slice(
            format!("{}\0shufang-session-v2", self.config.session_secret).as_bytes(),
        )
        .map_err(|_| "auth_not_configured")?;
        mac.update(encoded.as_bytes());
        let signature = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
        Ok((format!("shufang_session={encoded}.{signature}; Path=/; HttpOnly; SameSite=Lax; Max-Age={}{}",self.config.ttl,if self.config.origin.starts_with("https:"){"; Secure"}else{""}),expires*1000))
    }
    fn invalid(&self, key: &str) -> Reply {
        let time = now();
        let Ok(mut entries) = self.failures.lock() else {
            return fail("account_store_unavailable");
        };
        entries.retain(|_, v| time.saturating_sub(v.2) < 600);
        if entries.len() >= 1024 && !entries.contains_key(key) {
            if let Some(old) = entries
                .iter()
                .min_by_key(|(_, v)| v.2)
                .map(|(k, _)| k.clone())
            {
                entries.remove(&old);
            }
        }
        let entry = entries.entry(key.into()).or_insert((0, 0, time));
        entry.0 = entry.0.saturating_add(1);
        entry.2 = time;
        if entry.0 >= 5 {
            entry.1 = time + (1u64 << entry.0.saturating_sub(5).min(5)).min(30)
        }
        fail("unauthorized")
    }
    fn throttled(&self, key: &str) -> bool {
        self.failures
            .lock()
            .map(|e| e.get(key).is_some_and(|v| v.1 > now()))
            .unwrap_or(true)
    }
    fn clear_failure(&self, key: &str) {
        if let Ok(mut e) = self.failures.lock() {
            e.remove(key);
        }
    }
    fn run(
        &self,
        method: &str,
        path: &str,
        headers: &HeaderMap,
        body: &Value,
        peer: &str,
    ) -> Result<Reply, String> {
        if !["GET", "HEAD"].contains(&method) && !self.same_origin(headers) {
            return Ok(fail("csrf_rejected"));
        }
        let text = |key: &str, max: usize| {
            body[key]
                .as_str()
                .filter(|v| !v.is_empty() && v.encode_utf16().count() <= max)
                .ok_or("invalid_request")
        };
        match (method, path) {
            ("GET", "session") => {
                let user = self.store.get()?;
                let session = match self.validate(headers, false) {
                    Ok(s) => Some(s),
                    Err(e) if e == "unauthorized" || e == "setup_required" => None,
                    Err(e) => return Err(e),
                };
                Ok((
                    200,
                    json!({"configured":user.is_some()||(!self.config.app_id.is_empty()&&!self.config.app_secret.is_empty()),"authenticated":session.is_some(),"user":session.as_ref().map(|s|json!({"id":s.user_id})),"expiresAt":session.as_ref().map(|s|s.expires_at),"setupRequired":session.as_ref().is_some_and(|s|s.setup_required),"accountInitialized":user.is_some()}),
                    None,
                ))
            }
            ("POST", "login") => {
                if self.throttled(peer) {
                    return Ok(fail("login_throttled"));
                }
                let id = text("appId", 256)?;
                let password = text("appSecret", 4096)?;
                let user = self.store.get()?;
                let (username, setup, mut version, legacy) = if let Some(user) = &user {
                    let (name, old) = self.username(user)?;
                    (name, false, user.version, old)
                } else {
                    if self.config.app_id.is_empty() || self.config.app_secret.is_empty() {
                        return Err("auth_not_configured".into());
                    }
                    (self.config.app_id.clone(), true, 0, false)
                };
                let valid = if let Some(user) = &user {
                    let _guard = self
                        .hashes
                        .clone()
                        .try_acquire_owned()
                        .map_err(|_| "password_hash_busy")?;
                    let correct = credentials::verify_password(password, &user.hash);
                    correct && same_secret(&credentials::normalize_username(id), &username)
                } else {
                    same_secret(id, &username) && same_secret(password, &self.config.app_secret)
                };
                if !valid {
                    return Ok(self.invalid(peer));
                }
                if legacy {
                    let user = user.ok_or("account_store_unavailable")?;
                    if !self.store.update(
                        version,
                        User {
                            encrypted: credentials::encrypt_username(
                                &username,
                                &self.config.data_secret,
                            )?,
                            hash: user.hash,
                            version: version + 1,
                        },
                    )? {
                        return Ok(fail("credential_conflict"));
                    }
                    version += 1;
                }
                self.clear_failure(peer);
                let (cookie, expires) = self.cookie(&username, setup, version)?;
                Ok((
                    200,
                    json!({"ok":true,"user":{"id":username},"expiresAt":expires,"setupRequired":setup}),
                    Some(cookie),
                ))
            }
            ("POST", "setup") => {
                let session = self.validate(headers, false)?;
                if !session.setup_required {
                    return Ok(fail("setup_completed"));
                }
                let username = credentials::normalize_username(text("username", 256)?);
                let password = text("newPassword", 1024)?;
                if !credentials::validate_username(&username)
                    || !credentials::validate_password(password)
                {
                    return Ok(fail("invalid_account_details"));
                }
                if !same_secret(password, text("confirmPassword", 1024)?) {
                    return Ok(fail("password_mismatch"));
                }
                let _guard = self
                    .hashes
                    .clone()
                    .try_acquire_owned()
                    .map_err(|_| "password_hash_busy")?;
                let user = User {
                    encrypted: credentials::encrypt_username(&username, &self.config.data_secret)?,
                    hash: credentials::hash_password(password)?,
                    version: 1,
                };
                if !self.store.create(user)? {
                    return Ok(fail("setup_completed"));
                }
                let (cookie, expires) = self.cookie(&username, false, 1)?;
                Ok((
                    200,
                    json!({"ok":true,"user":{"id":username},"expiresAt":expires,"setupRequired":false}),
                    Some(cookie),
                ))
            }
            ("GET", "profile") => {
                let session = self.validate(headers, true)?;
                Ok((
                    200,
                    json!({"user":{"id":session.user_id},"credentialVersion":session.credential_version}),
                    None,
                ))
            }
            ("PATCH", "profile") => {
                let signed = self.signed(headers).ok_or("unauthorized")?;
                let key = format!("{peer}\0{}", signed.user_id);
                if self.throttled(&key) {
                    return Ok(fail("login_throttled"));
                }
                let session = self.validate(headers, true)?;
                let username = credentials::normalize_username(text("username", 256)?);
                if !credentials::validate_username(&username) {
                    return Ok(fail("invalid_account_details"));
                }
                let current = text("currentPassword", 1024)?;
                let new = body
                    .get("newPassword")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty());
                if body.get("newPassword").is_some_and(|s| !s.is_string()) {
                    return Ok(fail("invalid_request"));
                }
                if let Some(new) = new {
                    if !credentials::validate_password(new) {
                        return Ok(fail("invalid_account_details"));
                    }
                    if !same_secret(new, text("confirmPassword", 1024)?) {
                        return Ok(fail("password_mismatch"));
                    }
                }
                let account = self.store.get()?.ok_or("unauthorized")?;
                if account.version != session.credential_version {
                    return Ok(fail("unauthorized"));
                }
                let _guard = self
                    .hashes
                    .clone()
                    .try_acquire_owned()
                    .map_err(|_| "password_hash_busy")?;
                if !credentials::verify_password(current, &account.hash) {
                    return Ok(self.invalid(&key));
                }
                let hash = if let Some(new) = new {
                    credentials::hash_password(new)?
                } else {
                    account.hash
                };
                let version = account
                    .version
                    .checked_add(1)
                    .ok_or("credential_conflict")?;
                if !self.store.update(
                    account.version,
                    User {
                        encrypted: credentials::encrypt_username(
                            &username,
                            &self.config.data_secret,
                        )?,
                        hash,
                        version,
                    },
                )? {
                    return Ok(fail("credential_conflict"));
                }
                self.clear_failure(&key);
                let (cookie, expires) = self.cookie(&username, false, version)?;
                Ok((
                    200,
                    json!({"ok":true,"user":{"id":username},"expiresAt":expires,"setupRequired":false,"credentialVersion":version}),
                    Some(cookie),
                ))
            }
            ("POST", "logout") => Ok((
                200,
                json!({"ok":true}),
                Some(format!(
                    "shufang_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0{}",
                    if self.config.origin.starts_with("https:") {
                        "; Secure"
                    } else {
                        ""
                    }
                )),
            )),
            _ => Ok((404, json!({"error":"not_found"}), None)),
        }
    }
}
pub fn router() -> Router<Arc<Host>> {
    Router::new().route("/api/auth/{path}", any(handle))
}
pub(crate) fn client_ip(request: &Request) -> String {
    let Some(peer) = request
        .extensions()
        .get::<axum::extract::ConnectInfo<std::net::SocketAddr>>()
    else {
        return "local".into();
    };
    let ip = peer.0.ip();
    let loopback = ip.is_loopback()
        || matches!(ip, std::net::IpAddr::V6(v) if v.to_ipv4_mapped().is_some_and(|v|v.is_loopback()));
    if loopback {
        let values = request.headers().get_all("x-real-ip");
        let mut values = values.iter();
        if let Some(value) = values.next().filter(|_| values.next().is_none()) {
            if let Some(real) = value
                .to_str()
                .ok()
                .and_then(|v| v.parse::<std::net::IpAddr>().ok())
            {
                return match real {
                    std::net::IpAddr::V6(v) => v
                        .to_ipv4_mapped()
                        .map(|v| v.to_string())
                        .unwrap_or_else(|| v.to_string()),
                    _ => real.to_string(),
                };
            }
        }
    }
    ip.to_string()
}

async fn handle(State(host): State<Arc<Host>>, request: Request) -> Response {
    let Some(auth) = host.browser.clone() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"error":"auth_not_configured"})),
        )
            .into_response();
    };
    let method = request.method().to_string();
    let path = request
        .uri()
        .path()
        .trim_start_matches("/api/auth/")
        .to_string();
    let peer = client_ip(&request);
    let headers = request.headers().clone();
    let body = match to_bytes(request.into_body(), 32 * 1024).await {
        Ok(b) if b.is_empty() => Value::Null,
        Ok(b) => match serde_json::from_slice(&b) {
            Ok(v) => v,
            Err(_) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(json!({"error":"invalid_request"})),
                )
                    .into_response()
            }
        },
        Err(_) => return StatusCode::PAYLOAD_TOO_LARGE.into_response(),
    };
    let reply =
        tokio::task::spawn_blocking(move || auth.run(&method, &path, &headers, &body, &peer)).await;
    let (status, body, cookie) = match reply {
        Ok(Ok(v)) => v,
        Ok(Err(e)) => fail(&e),
        Err(_) => fail("account_store_unavailable"),
    };
    let mut response = (
        StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        Json(body),
    )
        .into_response();
    response.headers_mut().insert(
        "cache-control",
        axum::http::HeaderValue::from_static("no-store"),
    );
    if status == 429 {
        response
            .headers_mut()
            .insert("retry-after", axum::http::HeaderValue::from_static("30"));
    }
    if let Some(cookie) = cookie {
        if let Ok(value) = cookie.parse() {
            response.headers_mut().insert("set-cookie", value);
        }
    }
    response
}

#[cfg(test)]
mod proxy_tests {
    use super::*;
    #[test]
    fn real_ip_requires_a_single_overwritten_header_from_loopback() {
        for (peer, headers, expected) in [
            (Some("127.0.0.1:1"), vec!["192.0.2.1"], "192.0.2.1"),
            (Some("[::1]:1"), vec!["2001:db8::1"], "2001:db8::1"),
            (
                Some("[::ffff:127.0.0.1]:1"),
                vec!["::ffff:192.0.2.1"],
                "192.0.2.1",
            ),
            (Some("198.51.100.1:1"), vec!["192.0.2.1"], "198.51.100.1"),
            (None, vec!["192.0.2.1"], "local"),
            (
                Some("127.0.0.1:1"),
                vec!["192.0.2.1, 192.0.2.2"],
                "127.0.0.1",
            ),
            (
                Some("127.0.0.1:1"),
                vec!["192.0.2.1", "192.0.2.2"],
                "127.0.0.1",
            ),
            (Some("127.0.0.1:1"), vec!["bad"], "127.0.0.1"),
        ] {
            let mut request = Request::builder().body(axum::body::Body::empty()).unwrap();
            if let Some(peer) = peer {
                request.extensions_mut().insert(axum::extract::ConnectInfo(
                    peer.parse::<std::net::SocketAddr>().unwrap(),
                ));
            }
            for header in headers {
                request
                    .headers_mut()
                    .append("x-real-ip", header.parse().unwrap());
            }
            assert_eq!(client_ip(&request), expected);
        }
    }
}
