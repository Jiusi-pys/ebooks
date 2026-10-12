#![cfg(target_os = "macos")]
use shufang_native::{backup, credentials, credentials::macos_host, workspace::Workspace};
use std::sync::{
    atomic::{AtomicIsize, Ordering},
    Mutex,
};
static SECRET: Mutex<Vec<u8>> = Mutex::new(Vec::new());
static RESULT: AtomicIsize = AtomicIsize::new(0);
unsafe extern "C" fn store(
    _: *const u8,
    _: usize,
    _: *const u8,
    _: usize,
    bytes: *const u8,
    length: usize,
) -> i32 {
    if RESULT.load(Ordering::Relaxed) != 0 {
        return -1;
    }
    *SECRET.lock().unwrap() = std::slice::from_raw_parts(bytes, length).to_vec();
    0
}
unsafe extern "C" fn load(
    _: *const u8,
    _: usize,
    _: *const u8,
    _: usize,
    output: *mut u8,
    capacity: usize,
) -> isize {
    let result = RESULT.load(Ordering::Relaxed);
    if result != 0 {
        return result;
    }
    let bytes = SECRET.lock().unwrap();
    assert!(bytes.len() <= capacity);
    std::ptr::copy_nonoverlapping(bytes.as_ptr(), output, bytes.len());
    bytes.len() as isize
}
unsafe extern "C" fn other_store(
    _: *const u8,
    _: usize,
    _: *const u8,
    _: usize,
    _: *const u8,
    _: usize,
) -> i32 {
    0
}
#[test]
fn immutable_host_validates_errors_bounds_and_excludes_credentials_from_backups() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    assert!(macos_host::install(store, load));
    assert!(macos_host::install(store, load));
    assert!(!macos_host::install(other_store, load));
    credentials::store(root, "openai", "test-synthetic").unwrap();
    assert_eq!(credentials::load(root, "openai").unwrap(), "test-synthetic");
    assert!(!root.join("credentials").exists());
    assert!(credentials::store(root, "bad/provider", "synthetic").is_err());
    assert!(credentials::store(root, "openai", &"x".repeat(4097)).is_err());
    RESULT.store(-2, Ordering::Relaxed);
    assert_eq!(
        credentials::load(root, "openai").unwrap_err(),
        "api_key_not_configured"
    );
    RESULT.store(-1, Ordering::Relaxed);
    assert_eq!(
        credentials::store(root, "openai", "synthetic").unwrap_err(),
        "keychain_store_failed"
    );
    assert_eq!(
        credentials::load(root, "openai").unwrap_err(),
        "keychain_load_failed"
    );
    RESULT.store(4097, Ordering::Relaxed);
    assert_eq!(
        credentials::load(root, "openai").unwrap_err(),
        "keychain_load_failed"
    );
    RESULT.store(0, Ordering::Relaxed);
    *SECRET.lock().unwrap() = vec![0xff];
    assert_eq!(
        credentials::load(root, "openai").unwrap_err(),
        "invalid_stored_secret"
    );
    let db = root.join("library.sqlite3");
    let _workspace = Workspace::open(&db, "test", "replica").unwrap();
    for folder in ["credentials", "auth"] {
        std::fs::create_dir(root.join(folder)).unwrap();
        std::fs::write(
            root.join(folder).join("owned-test-secret"),
            b"synthetic-old-secret",
        )
        .unwrap();
    }
    let archive = root.join("backup.zip");
    backup::create(&db, &archive).unwrap();
    let mut zip = zip::ZipArchive::new(std::fs::File::open(archive).unwrap()).unwrap();
    for index in 0..zip.len() {
        let file = zip.by_index(index).unwrap();
        assert!(!file.name().starts_with("credentials/"));
        assert!(!file.name().starts_with("auth/"));
    }
}
