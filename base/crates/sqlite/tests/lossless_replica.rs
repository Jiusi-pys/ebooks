use shufang_application::{
    replica::{ReplicaRepository, ReplicaSession},
    LocalCommit, Runtime,
};
use shufang_domain::lossless_sync::ReplicaOperation;
use shufang_sqlite::SqliteRepository;
struct Clock;
impl Runtime for Clock {
    fn now(&self) -> u64 {
        100
    }
    fn new_id(&self) -> String {
        "id".into()
    }
}
#[test]
fn lossless_remote_receive_and_checkpoint_survive_restart_and_failed_transaction() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let mut session = ReplicaSession::new(
        SqliteRepository::open(&path, "w", "native").unwrap(),
        Clock,
        "w".into(),
    )
    .unwrap();
    let op=ReplicaOperation::parse(r#"{"workspaceId":"w","replicaId":"other","operationId":"one","kind":"notes","entityId":"n","clock":"101:0","patch":{"title":"\ud800","\udfff":["\ud800",null]}}"#).unwrap();
    let checkpoint = LocalCommit {
        key: "sync:lossless-test".into(),
        expected: 0,
        value: serde_json::json!("cursor-one"),
    };
    assert_eq!(
        session
            .receive(std::slice::from_ref(&op), Some(checkpoint))
            .unwrap(),
        vec![false]
    );
    assert_eq!(
        session.receive(std::slice::from_ref(&op), None).unwrap(),
        vec![true]
    );
    let mut failed = op.clone();
    failed.operation_id = "two".into();
    failed.clock = "102:0".into();
    failed.deleted = true;
    assert!(session
        .receive(
            &[failed],
            Some(LocalCommit {
                key: "sync:lossless-test".into(),
                expected: 0,
                value: serde_json::json!("bad")
            })
        )
        .is_err());
    drop(session);
    let repo = SqliteRepository::open(&path, "w", "native").unwrap();
    assert_eq!(repo.replica_operation("one").unwrap().unwrap(), op);
    assert!(repo.replica_operation("two").unwrap().is_none());
    let state = repo.load_replica("notes", "n").unwrap().unwrap();
    assert_eq!(state.revision, 1);
    assert!(!state.state.deleted);
    assert!(state.state.stringify().contains(r#""value":"\ud800""#));
    assert_eq!(repo.replica_clock().unwrap(), "101:0");
    let c = rusqlite::Connection::open(&path).unwrap();
    assert_eq!(
        c.query_row(
            "SELECT value_json FROM local_values WHERE key='sync:lossless-test'",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "\"cursor-one\""
    );
    assert_eq!(
        c.query_row("SELECT COUNT(*) FROM outbox", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
}
