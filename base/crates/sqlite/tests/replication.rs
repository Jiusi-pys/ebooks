use serde_json::json;
use shufang_application::{CoreSession, LocalCommit, ReplicationRepository, Repository, Runtime};
use shufang_domain::sync::Operation;
use shufang_sqlite::SqliteRepository;
struct TestRuntime;
impl Runtime for TestRuntime {
    fn now(&self) -> u64 {
        100
    }
    fn new_id(&self) -> String {
        "local-op".into()
    }
}
fn operation(id: &str, clock: &str, patch: serde_json::Value) -> Operation {
    serde_json::from_value(json!({"workspaceId":"w","replicaId":"remote","operationId":id,"kind":"notes","entityId":"n","clock":clock,"patch":patch})).unwrap()
}

#[test]
fn transient_snapshots_expire_but_selected_versions_remain() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let mut repo = SqliteRepository::open(&path, "w", "local").unwrap();
    repo.create_snapshot("network-old", "cursor", 0, 1).unwrap();
    repo.create_snapshot("version-kept", "cursor", 0, 1)
        .unwrap();
    repo.create_snapshot("network-new", "cursor", 0, 86_400_002)
        .unwrap();
    assert!(repo.snapshot_page("network-old", "").is_err());
    assert!(repo.snapshot_page("version-kept", "").is_ok());
    assert!(repo.snapshot_page("network-new", "").is_ok());
}

#[test]
fn mutation_cascade_storage_failure_rolls_back_root_children_clock_and_journal() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let mut core = CoreSession::new(
        SqliteRepository::open(&path, "w", "local").unwrap(),
        TestRuntime,
        "w".into(),
        "local".into(),
    )
    .unwrap();
    let mut book = operation("seed-book", "101:0", json!({"title":"Book"}));
    book.kind = "books".into();
    book.entity_id = "b".into();
    let mut highlight = operation("seed-highlight", "102:0", json!({"bookId":"b"}));
    highlight.kind = "highlights".into();
    highlight.entity_id = "h".into();
    core.receive_operations(&[book, highlight], None).unwrap();
    let connection = rusqlite::Connection::open(&path).unwrap();
    connection.execute_batch("CREATE TRIGGER fail_cascade BEFORE INSERT ON outbox WHEN json_extract(NEW.operation_json,'$.kind')='highlights' BEGIN SELECT RAISE(ABORT,'isolated cascade failure'); END;").unwrap();
    let mut deletion = operation("delete-book", "200:0", json!({}));
    deletion.replica_id = "local".into();
    deletion.kind = "books".into();
    deletion.entity_id = "b".into();
    deletion.deleted = true;
    assert!(core.mutate_replica_entity(deletion.clone()).is_err());
    assert_eq!(core.replication_head().unwrap().clock, "102:0");
    assert_eq!(core.replication_head().unwrap().sequence, "2");
    assert!(core.replication_operation("delete-book").unwrap().is_none());
    assert!(core.entity("books", "b").is_ok());
    assert!(core.entity("highlights", "h").is_ok());
    assert_eq!(core.changes(0, 100).unwrap().len(), 2);
    connection
        .execute_batch("DROP TRIGGER fail_cascade")
        .unwrap();
    assert_eq!(core.mutate_replica_entity(deletion).unwrap(), (false, 3));
    assert_eq!(core.replication_head().unwrap().clock, "200:0");
    assert_eq!(core.replication_head().unwrap().sequence, "4");
    assert!(core.entity("books", "b").is_err());
    assert!(core.entity("highlights", "h").is_err());
    for change in core.changes(2, 100).unwrap() {
        assert_ne!(change.snapshot.unwrap()["replicated"], true);
    }
}
#[test]
fn remote_replay_conflict_and_cursor_are_atomic_after_restart() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("replica.db");
    let mut core = CoreSession::new(
        SqliteRepository::open(&path, "w", "local").unwrap(),
        TestRuntime,
        "w".into(),
        "local".into(),
    )
    .unwrap();
    let op = operation(
        "remote-1",
        "101:0",
        json!({"title":"remote","content":"text","createdAt":100,"updatedAt":101}),
    );
    let checkpoint = LocalCommit {
        key: "sync:receive:peer".into(),
        expected: 0,
        value: json!("cursor-1"),
    };
    assert_eq!(
        core.receive_operations(std::slice::from_ref(&op), Some(checkpoint))
            .unwrap(),
        vec![false]
    );
    assert_eq!(
        core.receive_operations(std::slice::from_ref(&op), None)
            .unwrap(),
        vec![true]
    );
    let mut reused = op.clone();
    reused.patch.insert("title".into(), json!("tampered"));
    assert_eq!(
        core.receive_operations(&[reused], None).unwrap_err(),
        "operation_id_reused"
    );
    let next = operation("remote-2", "102:0", json!({"title":"must roll back"}));
    let bad = LocalCommit {
        key: "sync:receive:peer".into(),
        expected: 0,
        value: json!("invalid"),
    };
    assert!(core.receive_operations(&[next], Some(bad)).is_err());
    drop(core);
    let repo = SqliteRepository::open(&path, "w", "local").unwrap();
    assert_eq!(repo.pending().unwrap().len(), 1);
    assert_eq!(
        repo.get_local("sync:receive:peer").unwrap().unwrap().1,
        json!("cursor-1")
    );
    let core = CoreSession::new(repo, TestRuntime, "w".into(), "local".into()).unwrap();
    assert_eq!(core.entity("notes", "n").unwrap().value["title"], "remote");
}
#[test]
fn receive_old_clock_does_not_rewind_local_clock_or_resurrect_tombstone() {
    let dir = tempfile::tempdir().unwrap();
    let mut core = CoreSession::new(
        SqliteRepository::open(&dir.path().join("r.db"), "w", "local").unwrap(),
        TestRuntime,
        "w".into(),
        "local".into(),
    )
    .unwrap();
    let mut deletion = operation("delete", "500:0", json!({}));
    deletion.deleted = true;
    core.receive_operations(&[deletion], None).unwrap();
    core.receive_operations(&[operation("late", "1:0", json!({"title":"late"}))], None)
        .unwrap();
    assert!(core.entity("notes", "n").is_err());
    assert_eq!(core.replication_head().unwrap().clock, "500:0");
    assert_eq!(core.replication_operations(0, 100).unwrap().len(), 2);
}

#[test]
fn partial_or_reordered_receipt_cannot_advance_send_checkpoint() {
    let dir = tempfile::tempdir().unwrap();
    let mut core = CoreSession::new(
        SqliteRepository::open(&dir.path().join("db"), "w", "local").unwrap(),
        TestRuntime,
        "w".into(),
        "local".into(),
    )
    .unwrap();
    core.receive_operations(
        &[
            operation("a", "100:0", json!({})),
            operation("b", "101:0", json!({})),
        ],
        None,
    )
    .unwrap();
    let rows = core.replication_operations(0, 100).unwrap();
    let partial = json!([{"operationId":"a","persisted":true},{"operationId":"b","persisted":false,"error":"unavailable"}]);
    assert!(core
        .acknowledge_sync("sync:send:b", 0, &rows, &partial)
        .is_err());
    assert_eq!(
        core.sync_checkpoint("sync:send:b").unwrap(),
        (0, serde_json::Value::Null)
    );
    let reversed =
        json!([{"operationId":"b","persisted":true},{"operationId":"a","persisted":true}]);
    assert!(core
        .acknowledge_sync("sync:send:b", 0, &rows, &reversed)
        .is_err());
    core.acknowledge_sync(
        "sync:send:b",
        0,
        &rows,
        &json!([{"operationId":"a","seq":"1"},{"operationId":"b","seq":"2","duplicate":true}]),
    )
    .unwrap();
    assert_eq!(core.sync_checkpoint("sync:send:b").unwrap().1, "2");
}

#[test]
fn javascript_number_echo_is_duplicate_but_changed_number_is_id_reuse() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("replica.db");
    let mut c = CoreSession::new(
        SqliteRepository::open(&path, "w", "local").unwrap(),
        TestRuntime,
        "w".into(),
        "local".into(),
    )
    .unwrap();
    let first = operation(
        "numeric",
        "101:0",
        json!({"nested":{"zero":-0.0,"one":[1.0]},"title":"numbers"}),
    );
    c.receive_operations(&[first], None).unwrap();
    let echoed = operation(
        "numeric",
        "101:0",
        json!({"nested":{"zero":0,"one":[1]},"title":"numbers"}),
    );
    assert_eq!(c.receive_operations(&[echoed], None).unwrap(), vec![true]);
    let changed = operation(
        "numeric",
        "101:0",
        json!({"nested":{"zero":1,"one":[1]},"title":"numbers"}),
    );
    assert_eq!(
        c.receive_operations(&[changed], None).unwrap_err(),
        "operation_id_reused"
    );
    assert_eq!(c.replication_operations(0, 100).unwrap().len(), 1);
}
