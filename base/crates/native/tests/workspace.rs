use serde_json::json;
use shufang_native::workspace::Workspace;
#[test]
fn received_book_opens_a_verified_original_without_platform_local_path() {
    use sha2::{Digest, Sha256};
    let dir = tempfile::tempdir().unwrap();
    let workspace = Workspace::open(&dir.path().join("library.db"), "w", "r").unwrap();
    let bytes = b"cross-platform original";
    let manifest = shufang_application::BlobManifest {
        sha256: format!("{:x}", Sha256::digest(bytes)),
        size: bytes.len() as u64,
        name: "book.txt".into(),
        content_type: "text/plain".into(),
    };
    let blobs = shufang_native::sync_blobs::BlobStore::new(&dir.path().join("sync-blobs"));
    let upload = blobs.create(&manifest).unwrap();
    blobs.put(&upload.id, 0, bytes, &manifest.sha256).unwrap();
    blobs.commit(&upload.id).unwrap();
    workspace
        .core
        .lock()
        .unwrap()
        .import_book(
            "b",
            json!({"title":"Remote", "author":"", "format":"txt", "chapters":[]}),
            &manifest,
        )
        .unwrap();
    assert_eq!(
        std::fs::read(workspace.book_file("b").unwrap()).unwrap(),
        bytes
    );
    std::fs::write(blobs.path(&manifest.sha256).unwrap(), "corrupt").unwrap();
    assert!(workspace.book_file("b").is_err());
}
#[test]
fn update_lease_blocks_new_sessions_before_database_open() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("library.sqlite3");
    let w = Workspace::open(&path, "w", "r").unwrap();
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(dir.path().join("update.lock"))
        .unwrap();
    assert!(fs2::FileExt::try_lock_exclusive(&lock).is_err());
    drop(w);
    fs2::FileExt::try_lock_exclusive(&lock).unwrap();
    assert!(Workspace::open(&path, "w", "r").is_err());
    fs2::FileExt::unlock(&lock).unwrap();
    assert!(Workspace::open(&path, "w", "r").is_ok());
}

#[test]
fn importing_is_asynchronous_and_persists_an_immutable_original() {
    let dir = tempfile::tempdir().unwrap();
    let input = dir.path().join("original.txt");
    std::fs::write(&input, "正文😀").unwrap();
    let db = dir.path().join("workspace/library.db");
    let workspace = Workspace::open(&db, "w", "r").unwrap();
    let started = workspace.execute("import", json!({"path":input})).unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    let result = loop {
        assert!(std::time::Instant::now() < deadline);
        let job = workspace
            .execute("job", json!({"id":started["job"]}))
            .unwrap();
        if job["status"] != "running" {
            break job;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    };
    assert_eq!(result["status"], "completed", "{result}");
    assert_eq!(
        result["result"]["value"]["chapters"][0]["title"],
        "original"
    );
    let id = result["result"]["value"]["id"].as_str().unwrap();
    {
        let core = workspace.core.lock().unwrap();
        let operations = core.replication_operations(0, 100).unwrap();
        assert_eq!(
            operations.len(),
            2,
            "book and original source share one commit"
        );
        let source = core.replication_entities(Some("sources"), "").unwrap();
        assert_eq!(source.len(), 1);
        assert_eq!(source[0].id, id);
    }
    assert_eq!(
        std::fs::read_to_string(workspace.book_file(id).unwrap()).unwrap(),
        "正文😀"
    );
    std::fs::write(&input, "changed").unwrap();
    assert_eq!(
        std::fs::read_to_string(workspace.book_file(id).unwrap()).unwrap(),
        "正文😀"
    );
    drop(workspace);
    let reopened = Workspace::open(&db, "w", "r").unwrap();
    assert_eq!(
        reopened
            .execute("list", json!({"kind":"books"}))
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn cancellation_cannot_report_a_successful_result() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = Workspace::open(&dir.path().join("library.db"), "w", "r").unwrap();
    let started = workspace
        .start("test", |job| {
            for _ in 0..100 {
                job.check()?;
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            Ok(json!("unexpected"))
        })
        .unwrap();
    workspace
        .execute("cancelJob", json!({"id":started["job"]}))
        .unwrap();
    std::thread::sleep(std::time::Duration::from_millis(50));
    assert_eq!(
        workspace
            .execute("job", json!({"id":started["job"]}))
            .unwrap()["status"],
        "cancelled"
    );
}

#[test]
fn completed_background_job_can_be_read_after_reopening() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("db");
    let w = Workspace::open(&db, "w", "r").unwrap();
    let job = w
        .start("test", |_| Ok(json!({"text":"saved answer"})))
        .unwrap();
    for _ in 0..100 {
        if w.execute("job", json!({"id":job["job"]})).unwrap()["status"] == "completed" {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    drop(w);
    let w = Workspace::open(&db, "w", "r").unwrap();
    assert_eq!(
        w.execute("job", json!({"id":job["job"]})).unwrap()["result"]["text"],
        "saved answer"
    );
}

#[test]
fn invalid_cover_never_mutates_book_metadata() {
    let dir = tempfile::tempdir().unwrap();
    let w = Workspace::open(&dir.path().join("db"), "w", "r").unwrap();
    w.execute("save",json!({"kind":"books","id":"b","expected":0,"patch":{"title":"cover","author":"","format":"txt","chapters":[]}})).unwrap();
    let image = dir.path().join("cover.png");
    std::fs::write(&image, b"not an image").unwrap();
    assert!(w
        .execute("setCover", json!({"id":"b","expected":1,"path":image}))
        .is_err());
    assert_eq!(
        w.execute("get", json!({"kind":"books","id":"b"})).unwrap()["revision"],
        1
    );
    let pixels = image::RgbaImage::new(16, 24);
    pixels.save(&image).unwrap();
    let saved = w
        .execute("setCover", json!({"id":"b","expected":1,"path":image}))
        .unwrap();
    assert!(saved["value"]["customCover"]
        .as_str()
        .unwrap()
        .starts_with("data:image/png;base64,"));
}
