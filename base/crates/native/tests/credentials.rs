#[test]
#[cfg(not(windows))]
fn portable_credentials_are_authenticated_and_require_independent_deployment_key() {
    use shufang_native::credentials;
    let dir = tempfile::tempdir().unwrap();
    credentials::store(dir.path(), "service", "private-linux-service-token").unwrap();
    assert_eq!(
        credentials::load(dir.path(), "service").unwrap(),
        "private-linux-service-token"
    );
    let db = dir.path().join("library.sqlite3");
    let _w = shufang_native::workspace::Workspace::open(&db, "w", "r").unwrap();
    let archive = dir.path().join("backup.zip");
    shufang_native::backup::create(&db, &archive).unwrap();
    let restored = dir.path().join("restored");
    shufang_native::backup::restore(&archive, &restored).unwrap();
    assert_eq!(
        credentials::load(&restored, "service").unwrap(),
        "private-linux-service-token"
    );
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(
        std::fs::metadata(restored.join("credentials/service"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    let path = dir.path().join("credentials/service");
    let mut encrypted = std::fs::read(&path).unwrap();
    assert!(!String::from_utf8_lossy(&encrypted).contains("private-linux-service-token"));
    let last = encrypted.len() - 1;
    encrypted[last] ^= 1;
    std::fs::write(&path, &encrypted).unwrap();
    assert!(credentials::load(dir.path(), "service").is_err());
    assert_eq!(
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
        0o600
    );
}
