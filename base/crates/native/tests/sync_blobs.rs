use sha2::{Digest, Sha256};
use shufang_application::BlobManifest;
use shufang_native::sync_blobs::BlobStore;
#[test]
fn chunks_resume_after_restart_and_commit_checks_content_not_only_size() {
    let dir = tempfile::tempdir().unwrap();
    let bytes = vec![42u8; 256 * 1024 + 13];
    let manifest = BlobManifest {
        sha256: format!("{:x}", Sha256::digest(&bytes)),
        size: bytes.len() as u64,
        name: "book.txt".into(),
        content_type: "text/plain".into(),
    };
    let store = BlobStore::new(dir.path());
    let id = store.create(&manifest).unwrap().id;
    assert!(store.put(&id, 0, &bytes[..256 * 1024], "invalid").is_err());
    store
        .put(
            &id,
            0,
            &bytes[..256 * 1024],
            &format!("{:x}", Sha256::digest(&bytes[..256 * 1024])),
        )
        .unwrap();
    drop(store);
    let store = BlobStore::new(dir.path());
    assert_eq!(store.status(&id).unwrap().missing, vec![1]);
    assert!(store.commit(&id).is_err());
    let wrong = vec![0u8; 13];
    store
        .put(&id, 1, &wrong, &format!("{:x}", Sha256::digest(&wrong)))
        .unwrap();
    assert_eq!(store.commit(&id).unwrap_err(), "file_checksum_mismatch");
    assert!(!store.has(&manifest.sha256).unwrap());
    store
        .put(
            &id,
            1,
            &bytes[256 * 1024..],
            &format!("{:x}", Sha256::digest(&bytes[256 * 1024..])),
        )
        .unwrap();
    assert_eq!(store.commit(&id).unwrap(), manifest);
    assert_eq!(
        std::fs::read(store.path(&manifest.sha256).unwrap()).unwrap(),
        bytes
    );
    std::fs::write(store.path(&manifest.sha256).unwrap(), b"corrupted").unwrap();
    assert!(
        !store.has(&manifest.sha256).unwrap(),
        "corrupted object reported present"
    );
    assert_eq!(store.commit(&id).unwrap(), manifest);
    assert_eq!(
        std::fs::read(store.path(&manifest.sha256).unwrap()).unwrap(),
        bytes
    );
    assert!(store.path("../escape").is_err());
    assert!(store.status("../escape").is_err());
}
