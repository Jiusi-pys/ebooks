use serde_json::json;
use shufang_native::{attachments, workspace::Workspace};

#[test]
fn ios_binary_references_are_collected_without_json_decoding() {
    let hash = "a".repeat(64);
    let value = json!({"pdfDrawing":{"$attachment":{"sha256":hash,"size":4,"name":"drawing.pkdraw","type":"application/octet-stream"}},"nested":[{"$blob":{"sha256":"b".repeat(64),"size":8,"name":"field.json","type":"application/json"}}]});
    assert_eq!(attachments::references(&value).unwrap().len(), 2);
    assert!(
        attachments::references(&json!({"$attachment":{"sha256":"../secret","size":4}})).is_err()
    );
}

#[test]
fn binary_attachment_survives_restart_and_checks_expected_hash() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("ink.bin");
    std::fs::write(&path, [0, 255, 1, 2]).unwrap();
    let workspace = Workspace::open(&dir.path().join("library.sqlite"), "w", "a").unwrap();
    let reference = workspace
        .execute(
            "putAttachment",
            json!({"path":path,"name":"drawing.pkdraw","type":"application/octet-stream"}),
        )
        .unwrap();
    assert!(workspace.execute("putAttachment",json!({"path":path,"name":"x","type":"application/octet-stream","sha256":"a".repeat(64)})).is_err());
    drop(workspace);
    let workspace = Workspace::open(&dir.path().join("library.sqlite"), "w", "a").unwrap();
    let result = workspace
        .execute("attachmentResource", json!({"reference":reference}))
        .unwrap();
    assert_eq!(
        std::fs::read(result["path"].as_str().unwrap()).unwrap(),
        [0, 255, 1, 2]
    );
}

#[test]
fn multi_chunk_binary_attachment_is_exact() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("large.bin");
    let bytes: Vec<u8> = (0..(shufang_application::CHUNK_SIZE as usize * 2 + 17))
        .map(|i| (i % 251) as u8)
        .collect();
    std::fs::write(&path, &bytes).unwrap();
    let workspace = Workspace::open(&dir.path().join("library.sqlite"), "w", "a").unwrap();
    let reference = workspace
        .execute("putAttachment", json!({"path":path}))
        .unwrap();
    let result = workspace
        .execute("attachmentResource", json!({"reference":reference}))
        .unwrap();
    assert_eq!(
        std::fs::read(result["path"].as_str().unwrap()).unwrap(),
        bytes
    );
}

#[test]
fn ios_review_events_can_be_read_by_android_startup() {
    let dir = tempfile::tempdir().unwrap();
    let w = Workspace::open(&dir.path().join("library.sqlite"), "w", "a").unwrap();
    assert_eq!(
        w.execute("listPage", json!({"kind":"reviews","limit":50}))
            .unwrap()["total"],
        0
    );
}
