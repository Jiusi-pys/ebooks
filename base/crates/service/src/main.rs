use shufang_native::workspace::Workspace;
use shufang_service::{mcp, router, webhooks, Host};
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
    let root = PathBuf::from(value("--workspace").ok_or("--workspace is required")?);
    if !root.is_absolute() {
        return Err("workspace must be absolute".into());
    }
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let workspace = Workspace::open(
        &root.join("library.sqlite3"),
        &value("--workspace-id").unwrap_or_else(|| "local-preview".into()),
        &value("--node-id").unwrap_or_else(|| "windows-preview".into()),
    )?;
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
    let read_only = args.iter().any(|a| a == "--read-only");
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
    let host = if read_only {
        Host::new_read_only(workspace, token, public_url)
    } else {
        Host::new(workspace, token, public_url)
    };
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
    let result = axum::serve(listener, router(host))
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
            .take(1024 * 1024 + 1)
            .read_until(b'\n', &mut bytes)
            .await
            .map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        if n > 1024 * 1024 {
            return Err("mcp_request_too_large".into());
        }
        let request = serde_json::from_slice(&bytes).map_err(|_| "invalid_json")?;
        let response = mcp::dispatch(&host, request)?;
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
