use shufang_native::workspace::Workspace;
use shufang_service::{mcp, router, webhooks, Host, V1Contract};
use std::{path::PathBuf, sync::Arc};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt};

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("shufang-service: {error}");
        std::process::exit(1);
    }
}
async fn run() -> Result<(), String> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    let value = |flag: &str| {
        args.iter()
            .position(|a| a == flag)
            .and_then(|i| args.get(i + 1))
            .cloned()
    };
    if args.iter().any(|a| a == "--migrate") {
        let url = std::env::var("DATABASE_URL").map_err(|_| "database_url_required")?;
        let root = PathBuf::from(value("--migrations").ok_or("--migrations is required")?);
        let count = shufang_mysql::migrations::migrate(&url, &root)?;
        println!("MySQL migrations applied: {count}");
        return Ok(());
    }
    let root = PathBuf::from(value("--workspace").ok_or("--workspace is required")?);
    if !root.is_absolute() {
        return Err("workspace must be absolute".into());
    }
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let read_only = args.iter().any(|a| a == "--read-only");
    let mysql = args.iter().any(|a| a == "--mysql");
    let workspace_id = value("--workspace-id").unwrap_or_else(|| "local-preview".into());
    let node_id = value("--node-id").unwrap_or_else(|| "windows-preview".into());
    let database_url = if mysql {
        Some(std::env::var("DATABASE_URL").map_err(|_| "database_url_required")?)
    } else {
        None
    };
    let workspace = if let Some(url) = &database_url {
        Workspace::open_mysql(
            &root.join("library.mysql"),
            url,
            &workspace_id,
            &node_id,
            read_only,
        )?
    } else {
        Workspace::open(&root.join("library.sqlite3"), &workspace_id, &node_id)?
    };
    let port: u16 = value("--port")
        .unwrap_or_else(|| "31417".into())
        .parse()
        .map_err(|_| "invalid_port")?;
    let token = workspace.service_token()?;
    let public_url = value("--public-url").unwrap_or_else(|| format!("http://127.0.0.1:{port}"));
    if public_url.trim_end_matches('/') != format!("http://127.0.0.1:{port}") {
        let url = url::Url::parse(&public_url).map_err(|_| "invalid_public_url")?;
        if url.scheme() != "https"
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || url.path() != "/"
        {
            return Err("public_url_requires_https_origin".into());
        }
    }
    if let Some(source) = value("--replica-source") {
        if !read_only {
            return Err("replica_source_requires_read_only".into());
        }
        let node = value("--replica-node").ok_or("replica_node_required")?;
        let credential =
            std::env::var("SHUFANG_REPLICA_TOKEN").map_err(|_| "replica_token_required")?;
        if credential.len() < 32 || credential.len() > 4096 {
            return Err("invalid_replica_token".into());
        }
        let config = shufang_native::sync_config::public_config(&workspace)?;
        let updated = shufang_native::sync_config::save_peer(
            &workspace,
            &serde_json::json!({
                "id":node,"url":source,"tokenEnvironment":"SHUFANG_REPLICA_TOKEN","expected":config["revision"]
            }),
        )?;
        shufang_native::sync_config::pause(
            &workspace,
            &serde_json::json!({"paused":false,"expected":updated["revision"]}),
        )?;
    }
    let contract = match value("--v1-contract").as_deref() {
        None | Some("mirror") => V1Contract::Mirror,
        Some("sync-entities") => V1Contract::SyncEntities,
        _ => return Err("invalid_v1_contract".into()),
    };
    let mut host = Host::with_contract(workspace, token, public_url.clone(), read_only, contract);
    if mysql {
        Arc::get_mut(&mut host)
            .ok_or("host_already_shared")?
            .machine_key = std::env::var("OPEN_API_KEY")
            .ok()
            .map(|s| s.trim().to_owned())
            .filter(|s| !s.is_empty());
    }
    if mysql {
        let h = Arc::get_mut(&mut host).ok_or("host_already_shared")?;
        h.oauth_enabled = std::env::var("MCP_OAUTH_ENABLED").ok().as_deref() == Some("true");
        h.oauth_redirects = Some(
            std::env::var("MCP_OAUTH_REDIRECT_URIS")
                .unwrap_or_default()
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .collect(),
        );
    }
    if let Some(url) = database_url {
        use shufang_service::browser_auth::{Auth, Config, MysqlUsers};
        let runtime = value("--auth-runtime").map(PathBuf::from);
        let secret = |env: &str, file: &str| -> Result<String, String> {
            if let Ok(value) = std::env::var(env) {
                if !value.trim().is_empty() {
                    return Ok(value.trim().into());
                }
            }
            let directory = runtime
                .as_ref()
                .ok_or_else(|| format!("{env}_required_or_auth_runtime"))?;
            if !directory.is_absolute() {
                return Err("absolute_auth_runtime_required".into());
            }
            std::fs::read_to_string(directory.join(file))
                .map(|v| v.trim().to_string())
                .map_err(|_| format!("{env}_unavailable"))
        };
        let browser = Auth::new(
            Config {
                app_id: std::env::var("APP_ID").unwrap_or_default(),
                app_secret: std::env::var("APP_SECRET").unwrap_or_default(),
                data_secret: secret("APP_DATA_SECRET", "data-secret")?,
                session_secret: secret("APP_SESSION_SECRET", "session-secret")?,
                origin: public_url,
                ttl: std::env::var("SESSION_TTL_SECONDS")
                    .ok()
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(43200),
            },
            Arc::new(MysqlUsers::open(&url)?),
        )?;
        Arc::get_mut(&mut host)
            .ok_or("host_already_shared")?
            .browser = Some(browser);
    }
    if args.iter().any(|a| a == "--import-mysql-webhooks") {
        webhooks::import_mysql_subscriptions(&host)?;
    }
    if args.iter().any(|a| a == "--import-node-peers") {
        let encoded = std::env::var("SYNC_PEERS_JSON").unwrap_or_else(|_| "[]".into());
        shufang_service::peer_migration::import(&host, &encoded)?;
    }
    if let Some(path) = value("--import-node-oauth") {
        shufang_service::oauth_migration::import(&host, &PathBuf::from(path))?;
    }
    if args.iter().any(|a| a == "--initialize-only") {
        return Ok(());
    }
    if args.iter().any(|a| a == "--stdio") {
        return stdio(host).await;
    }
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(root.join("service.lock"))
        .map_err(|e| e.to_string())?;
    fs2::FileExt::try_lock_exclusive(&lock).map_err(|_| "service_already_running")?;
    let listen: std::net::IpAddr = value("--listen")
        .unwrap_or_else(|| "127.0.0.1".into())
        .parse()
        .map_err(|_| "invalid_listen_address")?;
    let listener = tokio::net::TcpListener::bind((listen, port))
        .await
        .map_err(|e| format!("listen_failed: {e}"))?;
    let worker_host = host.clone();
    let worker = tokio::spawn(async move {
        if worker_host.is_read_only() {
            return;
        }
        loop {
            if let Err(error) = webhooks::tick(&worker_host).await {
                eprintln!("webhook worker: {error}");
            }
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        }
    });
    let shutdown = host.clone();
    let sync_host = host.clone();
    let sync_worker = tokio::spawn(async move {
        shufang_service::replication::run(sync_host).await;
    });
    let result = axum::serve(
        listener,
        router(host).into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(async move {
        shutdown.stop.notified().await;
    })
    .await
    .map_err(|e| e.to_string());
    worker.abort();
    sync_worker.abort();
    result
}
async fn stdio(host: Arc<Host>) -> Result<(), String> {
    let mut reader = tokio::io::BufReader::new(tokio::io::stdin());
    let mut output = tokio::io::stdout();
    loop {
        let mut bytes = Vec::new();
        let n = (&mut reader)
            .take(16 * 1024 * 1024 + 1)
            .read_until(b'\n', &mut bytes)
            .await
            .map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        if n > 16 * 1024 * 1024 {
            return Err("mcp_request_too_large".into());
        }
        let request = serde_json::from_slice(&bytes).map_err(|_| "invalid_json")?;
        let response = mcp::dispatch_async(host.clone(), request, mcp::Access::Write).await?;
        if !response.is_null() {
            output
                .write_all(format!("{response}\n").as_bytes())
                .await
                .map_err(|e| e.to_string())?;
            output.flush().await.map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
