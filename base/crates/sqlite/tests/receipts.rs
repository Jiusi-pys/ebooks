use serde_json::json;
use shufang_application::{CoreSession, Runtime};
use shufang_sqlite::SqliteRepository;
struct Clock;
impl Runtime for Clock {
    fn now(&self) -> u64 {
        1000
    }
    fn new_id(&self) -> String {
        "op-test".into()
    }
}
#[test]
fn event_receipt_commits_with_business_data_and_failed_actions_remain_retryable() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let mut c = CoreSession::new(
        SqliteRepository::open(&path, "w", "r").unwrap(),
        Clock,
        "w".into(),
        "r".into(),
    )
    .unwrap();
    assert!(c
        .with_receipt("event:a", "hash", vec![], |c| c
            .save_entity("notes", "n", json!({"title":"","content":"bad"}), vec![], 0)
            .map(|_| ()))
        .is_err());
    assert!(c.local_value("event:a").unwrap().is_none());
    assert!(c.changes(0, 100).unwrap().is_empty());
    assert!(c.local_value("journal:1").unwrap().is_none());
    assert!(!c
        .with_receipt("event:a", "hash", vec![], |c| c
            .save_entity(
                "notes",
                "n",
                json!({"title":"标题","content":"正文"}),
                vec![],
                0
            )
            .map(|_| ()))
        .unwrap());
    assert!(c
        .with_receipt("event:a", "hash", vec![], |_| panic!(
            "duplicate action executed"
        ))
        .unwrap());
    assert!(c
        .with_receipt("event:a", "changed", vec![], |_| Ok(()))
        .is_err());
    drop(c);
    let c = CoreSession::new(
        SqliteRepository::open(&path, "w", "r").unwrap(),
        Clock,
        "w".into(),
        "r".into(),
    )
    .unwrap();
    assert_eq!(c.entity("notes", "n").unwrap().revision, 1);
    assert!(c.local_value("event:a").unwrap().is_some());
    assert_eq!(
        c.changes(0, 100).unwrap()[0].snapshot.as_ref().unwrap()["record"]["value"]["title"],
        "标题"
    );
}
#[test]
fn expiry_cleanup_preserves_business_and_unknown_historical_caches() {
    use shufang_application::Repository;
    let dir = tempfile::tempdir().unwrap();
    let mut repo =
        shufang_sqlite::SqliteRepository::open(&dir.path().join("db"), "w", "r").unwrap();
    repo.set_local(
        "upload:expired",
        0,
        &serde_json::json!({"version":1,"expires":1,"chunks":{"0":"large"}}),
    )
    .unwrap();
    repo.set_local(
        "upload:future",
        0,
        &serde_json::json!({"version":1,"expires":100}),
    )
    .unwrap();
    repo.set_local(
        "event:historical",
        0,
        &serde_json::json!({"version":1,"fingerprint":"kept"}),
    )
    .unwrap();
    repo.set_local("job:expired", 0, &serde_json::json!({"expires":1}))
        .unwrap();
    assert_eq!(repo.local_usage("upload:").unwrap().0, 2);
    assert_eq!(repo.delete_expired_local("upload:", 50, 1000).unwrap(), 1);
    assert!(repo.get_local("upload:expired").unwrap().is_none());
    assert!(repo.get_local("upload:future").unwrap().is_some());
    assert!(repo.get_local("event:historical").unwrap().is_some());
    assert!(repo.get_local("job:expired").unwrap().is_some());
}
