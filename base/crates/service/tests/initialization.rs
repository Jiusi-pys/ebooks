#[test]
fn initialization_finishes_without_claiming_listener_or_starting_workers() {
    let dir = tempfile::tempdir().unwrap();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let status = std::process::Command::new(env!("CARGO_BIN_EXE_shufang-service"))
        .args([
            "--workspace",
            dir.path().to_str().unwrap(),
            "--port",
            &listener.local_addr().unwrap().port().to_string(),
            "--initialize-only",
        ])
        .env(
            "SHUFANG_SERVICE_TOKEN",
            "public-initialization-test-owner-key-1234567890",
        )
        .output()
        .unwrap();
    assert!(
        status.status.success(),
        "{}",
        String::from_utf8_lossy(&status.stderr)
    );
}
