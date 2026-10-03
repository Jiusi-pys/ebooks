use rusqlite::{params, Connection};
use sha2::{Digest, Sha256};
use shufang_application::Repository;
use shufang_sqlite::SqliteRepository;

fn version_one(path: &std::path::Path) -> Connection {
    let db = Connection::open(path).unwrap();
    let sql = include_str!("../migrations/0001.sql");
    db.execute_batch(sql).unwrap();
    db.execute(
        "INSERT INTO schema_migrations VALUES(1,?)",
        [format!("{:x}", Sha256::digest(sql.as_bytes()))],
    )
    .unwrap();
    for (k, v) in [("workspace", "w"), ("replica", "r"), ("clock", "0:0")] {
        db.execute("INSERT INTO core_meta VALUES(?,?)", params![k, v])
            .unwrap();
    }
    db.execute(
        "INSERT INTO entities VALUES('notes','retained',1,?)",
        [r#"{"id":"retained","kind":"notes","deleted":false,"fields":{}}"#],
    )
    .unwrap();
    db.execute(
        "INSERT INTO outbox(operation_id,operation_json) VALUES('retained','{}')",
        [],
    )
    .unwrap();
    db.pragma_update(None, "user_version", 1).unwrap();
    db
}

#[test]
fn version_one_upgrades_once_without_losing_old_entities_or_outbox() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("old.db");
    drop(version_one(&path));
    for _ in 0..2 {
        let repo = SqliteRepository::open(&path, "w", "r").unwrap();
        assert!(repo.load("notes", "retained").unwrap().is_some());
    }
    let db = Connection::open(&path).unwrap();
    assert_eq!(
        db.query_row("SELECT COUNT(*) FROM schema_migrations", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        3
    );
    assert_eq!(
        db.query_row(
            "SELECT operation_json FROM outbox WHERE operation_id='retained'",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "{}"
    );
    assert_eq!(
        db.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        3
    );
}

#[test]
fn version_two_upgrade_failure_rolls_back_and_retries_with_stable_epoch() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("v2.db");
    let db = version_one(&path);
    let sql = include_str!("../migrations/0002.sql");
    db.execute_batch(sql).unwrap();
    db.execute(
        "INSERT INTO schema_migrations VALUES(2,?)",
        [format!("{:x}", Sha256::digest(sql.as_bytes()))],
    )
    .unwrap();
    db.pragma_update(None, "user_version", 2).unwrap();
    db.execute(
        "CREATE TABLE sync_snapshot_entities(conflicting INTEGER)",
        [],
    )
    .unwrap();
    assert!(SqliteRepository::open(&path, "w", "r").is_err());
    assert_eq!(
        db.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        2
    );
    assert_eq!(
        db.query_row(
            "SELECT COUNT(*) FROM core_meta WHERE key='sync_epoch'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    db.execute("DROP TABLE sync_snapshot_entities", []).unwrap();
    drop(db);
    use shufang_application::ReplicationRepository;
    let repo = SqliteRepository::open(&path, "w", "r").unwrap();
    let epoch = repo.replication_head().unwrap().epoch;
    assert!(repo.load("notes", "retained").unwrap().is_some());
    drop(repo);
    assert_eq!(
        SqliteRepository::open(&path, "w", "r")
            .unwrap()
            .replication_head()
            .unwrap()
            .epoch,
        epoch
    );
}

#[test]
fn failed_second_step_keeps_version_one_and_can_retry() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("failure.db");
    let db = version_one(&path);
    // A conflicting legacy table deliberately fails the second DDL statement.
    db.execute("CREATE TABLE local_values(conflicting INTEGER)", [])
        .unwrap();
    assert!(SqliteRepository::open(&path, "w", "r").is_err());
    assert_eq!(
        db.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        db.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE name='change_log'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    assert_eq!(
        db.query_row("SELECT COUNT(*) FROM schema_migrations", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
    db.execute("DROP TABLE local_values", []).unwrap();
    assert!(SqliteRepository::open(&path, "w", "r")
        .unwrap()
        .load("notes", "retained")
        .unwrap()
        .is_some());
}

#[test]
fn readonly_version_probe_does_not_migrate_or_create_a_missing_database() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("old.db");
    let db = version_one(&path);
    assert_eq!(SqliteRepository::read_version(&path).unwrap(), 1);
    assert_eq!(
        db.pragma_query_value(None, "user_version", |r| r.get::<_, u32>(0))
            .unwrap(),
        1
    );
    let missing = dir.path().join("missing.db");
    assert!(SqliteRepository::read_version(&missing).is_err());
    assert!(!missing.exists());
}
