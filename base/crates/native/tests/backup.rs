use serde_json::json;
use shufang_native::{backup, workspace::Workspace};
#[test]
fn backup_restores_committed_wal_and_files_without_overwriting_a_workspace() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("live/library.sqlite3");
    let workspace = Workspace::open(&db, "w", "r").unwrap();
    workspace.execute("save",json!({"kind":"notes","id":"n","expected":0,"patch":{"title":"备份","content":"正文😀"}})).unwrap();
    std::fs::create_dir(workspace.root.join("files")).unwrap();
    std::fs::write(workspace.root.join("files/book.txt"), "original").unwrap();
    std::fs::create_dir(workspace.root.join("auth")).unwrap();
    std::fs::write(
        workspace.root.join("auth/session-secret"),
        "public-backup-test-key",
    )
    .unwrap();
    let archive = dir.path().join("backup.zip");
    let original_epoch = workspace
        .core
        .lock()
        .unwrap()
        .replication_head()
        .unwrap()
        .epoch;
    backup::create(&db, &archive).unwrap();
    let target = dir.path().join("restored");
    backup::restore(&archive, &target).unwrap();
    assert!(backup::restore(&archive, &target).is_err());
    assert_eq!(
        std::fs::read_to_string(target.join("auth/session-secret")).unwrap(),
        "public-backup-test-key"
    );
    let restored = Workspace::open(&target.join("library.sqlite3"), "w", "r").unwrap();
    assert_ne!(
        restored
            .core
            .lock()
            .unwrap()
            .replication_head()
            .unwrap()
            .epoch,
        original_epoch,
        "restored workspace must start a new replication generation"
    );
    assert_eq!(
        restored
            .execute("get", json!({"kind":"notes","id":"n"}))
            .unwrap()["value"]["content"],
        "正文😀"
    );
    assert_eq!(
        std::fs::read_to_string(target.join("files/book.txt")).unwrap(),
        "original"
    );
}

#[test]
fn backup_preserves_verified_blobs_and_incomplete_chunks_for_restart_resume() {
    use sha2::{Digest, Sha256};
    use shufang_application::BlobManifest;
    use shufang_native::sync_blobs::BlobStore;
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("live/library.sqlite3");
    let w = Workspace::open(&db, "w", "r").unwrap();
    let store = BlobStore::new(&w.root.join("sync-blobs"));
    let bytes = vec![19u8; 256 * 1024 + 7];
    let manifest = BlobManifest {
        sha256: format!("{:x}", Sha256::digest(&bytes)),
        size: bytes.len() as u64,
        name: "book.txt".into(),
        content_type: "text/plain".into(),
    };
    let upload = store.create(&manifest).unwrap();
    store
        .put(
            &upload.id,
            0,
            &bytes[..256 * 1024],
            &format!("{:x}", Sha256::digest(&bytes[..256 * 1024])),
        )
        .unwrap();
    let archive = dir.path().join("backup.zip");
    backup::create(&db, &archive).unwrap();
    let restored = dir.path().join("restored");
    backup::restore(&archive, &restored).unwrap();
    let store = BlobStore::new(&restored.join("sync-blobs"));
    assert_eq!(store.status(&upload.id).unwrap().missing, vec![1]);
    store
        .put(
            &upload.id,
            1,
            &bytes[256 * 1024..],
            &format!("{:x}", Sha256::digest(&bytes[256 * 1024..])),
        )
        .unwrap();
    store.commit(&upload.id).unwrap();
    let _reopened = Workspace::open(&restored.join("library.sqlite3"), "w", "r").unwrap();
    let second = dir.path().join("second.zip");
    backup::create(&restored.join("library.sqlite3"), &second).unwrap();
    let target = dir.path().join("second");
    backup::restore(&second, &target).unwrap();
    assert!(BlobStore::new(&target.join("sync-blobs"))
        .has(&manifest.sha256)
        .unwrap());
}
