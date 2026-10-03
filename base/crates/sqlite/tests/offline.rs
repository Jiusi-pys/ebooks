use shufang_application::{CoreSession, Runtime};
use shufang_sqlite::SqliteRepository;
use std::cell::Cell;

struct Clock(Cell<u64>);
impl Runtime for Clock {
    fn now(&self) -> u64 {
        1000
    }
    fn new_id(&self) -> String {
        let n = self.0.get() + 1;
        self.0.set(n);
        format!("op-{n}")
    }
}

#[test]
fn offline_save_survives_restart_with_its_outbox() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("library.sqlite3");
    {
        let repository = SqliteRepository::open(&path, "workspace", "replica").unwrap();
        let mut core = CoreSession::new(
            repository,
            Clock(Cell::new(0)),
            "workspace".into(),
            "replica".into(),
        )
        .unwrap();
        core.save_note("note", "书籍笔记", "离线内容", 0).unwrap();
        assert_eq!(core.pending().unwrap().len(), 1);
        assert_eq!(
            core.save_note("note", "stale", "bad", 0).unwrap_err(),
            "revision_conflict"
        );
    }
    let repository = SqliteRepository::open(&path, "workspace", "replica").unwrap();
    let core = CoreSession::new(
        repository,
        Clock(Cell::new(1)),
        "workspace".into(),
        "replica".into(),
    )
    .unwrap();
    let notes = core.notes().unwrap();
    assert_eq!(notes[0]["note"]["content"], "离线内容");
    assert_eq!(notes[0]["revision"], 1);
    assert_eq!(core.pending().unwrap().len(), 1);
    assert!(SqliteRepository::open(&path, "wrong-workspace", "replica").is_err());
}

#[test]
fn duplicate_operation_failure_rolls_back_entity_and_clock() {
    let dir = tempfile::tempdir().unwrap();
    let repository = SqliteRepository::open(&dir.path().join("library.db"), "w", "r").unwrap();
    let mut core =
        CoreSession::new(repository, Clock(Cell::new(0)), "w".into(), "r".into()).unwrap();
    core.save_note("n", "first", "original", 0).unwrap();
    // Reopening with a repeated ID simulates a failed outbox insert after the entity write.
    drop(core);
    let repository = SqliteRepository::open(&dir.path().join("library.db"), "w", "r").unwrap();
    let mut core =
        CoreSession::new(repository, Clock(Cell::new(0)), "w".into(), "r".into()).unwrap();
    assert!(core
        .save_note("n", "second", "should roll back", 1)
        .is_err());
    assert_eq!(core.notes().unwrap()[0]["note"]["title"], "first");
    assert_eq!(core.pending().unwrap().len(), 1);
}

#[test]
fn rejects_future_versions_and_migration_checksum_drift() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("library.db");
    drop(SqliteRepository::open(&path, "w", "r").unwrap());
    let db = rusqlite::Connection::open(&path).unwrap();
    db.pragma_update(None, "user_version", 4).unwrap();
    assert!(
        matches!(SqliteRepository::open(&path,"w","r"), Err(e) if e == "unsupported_database_version")
    );
    assert_eq!(
        db.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        4
    );
    db.pragma_update(None, "user_version", 3).unwrap();
    db.execute("UPDATE schema_migrations SET sha256='tampered'", [])
        .unwrap();
    assert!(
        matches!(SqliteRepository::open(&path,"w","r"), Err(e) if e == "migration_checksum_mismatch")
    );
}

#[test]
fn interrupted_initialization_rolls_back_and_reopen_succeeds() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("library.db");
    {
        let mut db = rusqlite::Connection::open(&path).unwrap();
        let tx = db.transaction().unwrap();
        tx.execute_batch(include_str!("../migrations/0001.sql"))
            .unwrap();
        tx.pragma_update(None, "user_version", 1).unwrap();
        // Drop before commit simulates a failed initializer. No success receipt survives.
    }
    drop(SqliteRepository::open(&path, "w", "r").unwrap());
    drop(SqliteRepository::open(&path, "w", "r").unwrap());
}
