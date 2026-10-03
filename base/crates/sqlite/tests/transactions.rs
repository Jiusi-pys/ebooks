use serde_json::json;
use shufang_application::{Commit, Repository};
use shufang_domain::sync::{apply_operation, Operation};
use shufang_sqlite::SqliteRepository;

fn change(id: &str, operation_id: &str, clock: &str) -> Commit {
    let op: Operation = serde_json::from_value(json!({
        "workspaceId":"w", "replicaId":"r", "operationId":operation_id,
        "kind":"notes", "entityId":id, "clock":clock,
        "patch":{"title":id,"content":"original"}
    }))
    .unwrap();
    Commit {
        expected: 0,
        state: apply_operation(None, &op).unwrap(),
        operation: op,
    }
}

#[test]
fn batch_and_change_journal_commit_together_or_not_at_all() {
    let dir = tempfile::tempdir().unwrap();
    let mut db = SqliteRepository::open(&dir.path().join("library.db"), "w", "r").unwrap();
    db.commit_batch(
        "0:0",
        &[change("a", "op1", "1:0"), change("b", "op2", "1:1")],
    )
    .unwrap();
    assert_eq!(db.changes(0, 100).unwrap().len(), 2);
    // Last operation reuses an outbox ID: earlier writes in this batch must roll back.
    assert!(db
        .commit_batch(
            "1:1",
            &[change("c", "op3", "1:2"), change("d", "op2", "1:3")]
        )
        .is_err());
    assert!(db.load("notes", "c").unwrap().is_none());
    assert_eq!(db.clock().unwrap(), "1:1");
    assert_eq!(db.changes(0, 100).unwrap().len(), 2);
    assert_eq!(db.pending().unwrap().len(), 2);
    assert!(db
        .commit_batch("0:0", &[change("e", "op4", "2:0")])
        .is_err());
}

#[test]
fn local_values_use_optimistic_revisions_and_never_enter_replication_outbox() {
    let dir = tempfile::tempdir().unwrap();
    let mut db = SqliteRepository::open(&dir.path().join("library.db"), "w", "r").unwrap();
    assert_eq!(
        db.set_local("ai-config", 0, &json!({"provider":"openai"}))
            .unwrap(),
        1
    );
    assert!(db
        .set_local("ai-config", 0, &json!({"provider":"stale"}))
        .is_err());
    let (revision, value) = db.get_local("ai-config").unwrap().unwrap();
    assert_eq!(revision, 1);
    assert_eq!(value["provider"], "openai");
    assert!(db.pending().unwrap().is_empty());
}
