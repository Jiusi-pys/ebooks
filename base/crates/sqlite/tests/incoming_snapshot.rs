use shufang_application::{
    incoming_snapshot::{IncomingSnapshot, SnapshotPage, SnapshotRepository},
    replica::{ReplicaRepository, ReplicaSession},
    LocalCommit, Runtime,
};
use shufang_domain::lossless_sync::{ReplicaOperation, ReplicaState};
use shufang_sqlite::SqliteRepository;
struct Clock;
impl Runtime for Clock {
    fn now(&self) -> u64 {
        100
    }
    fn new_id(&self) -> String {
        "local".into()
    }
}
fn state(id: &str, clock: u64, title: &str) -> ReplicaState {
    let op = ReplicaOperation::parse(&format!(r#"{{"workspaceId":"w","replicaId":"remote","operationId":"remote-{id}","kind":"notes","entityId":"{id}","clock":"{clock}:0","patch":{{"title":{title}}}}}"#)).unwrap();
    ReplicaState::apply(None, &op).unwrap()
}
#[test]
fn staging_restart_and_atomic_finish_preserve_local_changes_without_inventing_operations() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("library.sqlite");
    let mut repo = SqliteRepository::open(&path, "w", "native").unwrap();
    let snapshot =
        IncomingSnapshot::new("remote", "snapshot-one", "epoch-one", "watermark", 100).unwrap();
    repo.begin_snapshot(&snapshot).unwrap();
    let page = SnapshotPage {
        index: 0,
        after: "".into(),
        next: Some("page-two".into()),
        states: vec![state("n", 5, r#""\ud800""#)],
    };
    repo.stage_snapshot_page("remote", "snapshot-one", &page)
        .unwrap();
    repo.stage_snapshot_page("remote", "snapshot-one", &page)
        .unwrap();
    assert!(repo.load_replica("notes", "n").unwrap().is_none());
    drop(repo);
    let repo = SqliteRepository::open(&path, "w", "native").unwrap();
    assert_eq!(
        repo.incoming_snapshot("remote")
            .unwrap()
            .unwrap()
            .next
            .as_deref(),
        Some("page-two")
    );
    let mut session = ReplicaSession::new(repo, Clock, "w".into()).unwrap();
    let local=ReplicaOperation::parse(r#"{"workspaceId":"w","replicaId":"native","operationId":"local-one","kind":"notes","entityId":"n","clock":"10:0","patch":{"title":"local"}}"#).unwrap();
    session.receive(std::slice::from_ref(&local), None).unwrap();
    let repo = &mut session.repository;
    let page = SnapshotPage {
        index: 1,
        after: "page-two".into(),
        next: None,
        states: vec![state("another", 20, r#""\udfff""#)],
    };
    repo.stage_snapshot_page("remote", "snapshot-one", &page)
        .unwrap();
    let bad_checkpoint = LocalCommit {
        key: "sync:remote-cursor".into(),
        expected: 1,
        value: serde_json::json!("watermark"),
    };
    assert!(repo
        .finish_snapshot("remote", "snapshot-one", &bad_checkpoint)
        .is_err());
    assert!(repo.load_replica("notes", "another").unwrap().is_none());
    assert!(repo.incoming_snapshot("remote").unwrap().is_some());
    let checkpoint = LocalCommit {
        expected: 0,
        ..bad_checkpoint
    };
    repo.finish_snapshot("remote", "snapshot-one", &checkpoint)
        .unwrap();
    assert!(repo
        .load_replica("notes", "n")
        .unwrap()
        .unwrap()
        .state
        .stringify()
        .contains("local"));
    assert!(repo
        .load_replica("notes", "another")
        .unwrap()
        .unwrap()
        .state
        .stringify()
        .contains("\\udfff"));
    assert_eq!(repo.replica_clock().unwrap(), "0000000000000020:0000000000");
    assert_eq!(repo.replica_operation("local-one").unwrap(), Some(local));
    assert!(repo.replica_operation("remote-another").unwrap().is_none());
    assert!(repo.incoming_snapshot("remote").unwrap().is_none());
    let connection = rusqlite::Connection::open(path).unwrap();
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM outbox", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
}

#[test]
fn invalid_pages_and_late_merge_conflicts_roll_back_every_entity_and_watermark() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("library.sqlite");
    let repo = SqliteRepository::open(&path, "w", "native").unwrap();
    let mut session = ReplicaSession::new(repo, Clock, "w".into()).unwrap();
    let local = ReplicaOperation::parse(r#"{"workspaceId":"w","replicaId":"remote","operationId":"remote-z","kind":"notes","entityId":"z","clock":"5:0","patch":{"title":"original"},"deleted":true}"#).unwrap();
    session.receive(std::slice::from_ref(&local), None).unwrap();
    let repo = &mut session.repository;
    repo.begin_snapshot(&IncomingSnapshot::new("remote", "failed", "epoch", "cursor", 1).unwrap())
        .unwrap();
    let wrong = SnapshotPage {
        index: 1,
        after: "missing".into(),
        next: None,
        states: vec![],
    };
    assert!(repo
        .stage_snapshot_page("remote", "failed", &wrong)
        .is_err());
    let page = SnapshotPage {
        index: 0,
        after: "".into(),
        next: Some("next".into()),
        states: vec![state("a", 10, r#""first""#)],
    };
    repo.stage_snapshot_page("remote", "failed", &page).unwrap();
    let conflicting_page = SnapshotPage {
        states: vec![state("b", 11, r#""wrong""#)],
        ..page.clone()
    };
    assert!(repo
        .stage_snapshot_page("remote", "failed", &conflicting_page)
        .is_err());
    let checkpoint = LocalCommit {
        key: "sync:cursor".into(),
        expected: 0,
        value: serde_json::json!("cursor"),
    };
    assert!(repo
        .finish_snapshot("remote", "failed", &checkpoint)
        .is_err());
    let page = SnapshotPage {
        index: 1,
        after: "next".into(),
        next: None,
        states: vec![state("z", 5, r#""changed-under-same-version""#)],
    };
    repo.stage_snapshot_page("remote", "failed", &page).unwrap();
    assert_eq!(
        repo.finish_snapshot("remote", "failed", &checkpoint)
            .unwrap_err(),
        "field_version_reused"
    );
    assert!(repo.load_replica("notes", "a").unwrap().is_none());
    assert!(
        repo.load_replica("notes", "z")
            .unwrap()
            .unwrap()
            .state
            .deleted
    );
    assert_eq!(repo.replica_clock().unwrap(), "5:0");
    assert_eq!(repo.replica_operation("remote-z").unwrap(), Some(local));
    assert!(repo.incoming_snapshot("remote").unwrap().is_some());
    let connection = rusqlite::Connection::open(path).unwrap();
    assert_eq!(
        connection
            .query_row(
                "SELECT COUNT(*) FROM local_values WHERE key='sync:cursor'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
}

#[test]
fn storage_failure_at_final_watermark_rolls_back_then_retries_and_abandon_is_scoped() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("library.sqlite");
    let mut repo = SqliteRepository::open(&path, "w", "native").unwrap();
    repo.begin_snapshot(&IncomingSnapshot::new("remote", "retry", "epoch", "cursor", 1).unwrap())
        .unwrap();
    repo.stage_snapshot_page(
        "remote",
        "retry",
        &SnapshotPage {
            index: 0,
            after: "".into(),
            next: None,
            states: vec![state("n", 5, r#""\ud800""#)],
        },
    )
    .unwrap();
    let connection = rusqlite::Connection::open(&path).unwrap();
    connection.execute_batch("CREATE TRIGGER reject_watermark BEFORE INSERT ON local_values WHEN NEW.key='sync:cursor' BEGIN SELECT RAISE(ABORT,'injected failure'); END;").unwrap();
    let checkpoint = LocalCommit {
        key: "sync:cursor".into(),
        expected: 0,
        value: serde_json::json!("cursor"),
    };
    assert!(repo
        .finish_snapshot("remote", "retry", &checkpoint)
        .is_err());
    assert!(repo.load_replica("notes", "n").unwrap().is_none());
    assert_eq!(repo.replica_clock().unwrap(), "0:0");
    assert!(repo.incoming_snapshot("remote").unwrap().is_some());
    connection
        .execute_batch("DROP TRIGGER reject_watermark;")
        .unwrap();
    repo.finish_snapshot("remote", "retry", &checkpoint)
        .unwrap();
    repo.begin_snapshot(
        &IncomingSnapshot::new("remote", "abandon", "new-epoch", "new-cursor", 2).unwrap(),
    )
    .unwrap();
    repo.stage_snapshot_page(
        "remote",
        "abandon",
        &SnapshotPage {
            index: 0,
            after: "".into(),
            next: Some("more".into()),
            states: vec![state("other", 20, r#""pending""#)],
        },
    )
    .unwrap();
    assert!(repo.abandon_snapshot("remote", "wrong").is_err());
    repo.abandon_snapshot("remote", "abandon").unwrap();
    repo.abandon_snapshot("remote", "abandon").unwrap();
    assert!(repo.incoming_snapshot("remote").unwrap().is_none());
    assert!(repo.load_replica("notes", "n").unwrap().is_some());
    assert!(repo.load_replica("notes", "other").unwrap().is_none());
    assert_eq!(
        connection
            .query_row(
                "SELECT value_json FROM local_values WHERE key='sync:cursor'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
        "\"cursor\""
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT COUNT(*) FROM local_values WHERE key LIKE 'sync:incoming-page:%'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
}
