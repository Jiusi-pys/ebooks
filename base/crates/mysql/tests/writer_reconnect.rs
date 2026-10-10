//! Run only against a dedicated migrated database; never kill a production connection.
use mysql::{prelude::Queryable, Conn, Opts};
use serde_json::json;
use sha2::{Digest, Sha256};
use shufang_application::{CoreSession, ReplicationRepository, Runtime};
use shufang_mysql::MysqlRepository;

struct Clock;
impl Runtime for Clock {
    fn now(&self) -> u64 {
        1800000000000
    }
    fn new_id(&self) -> String {
        uuid::Uuid::new_v4().to_string()
    }
}
fn isolated() -> (String, Conn, String, String) {
    let url = std::env::var("SHUFANG_TEST_MYSQL_URL").unwrap();
    let mut admin = Conn::new(Opts::from_url(&url).unwrap()).unwrap();
    let database: String = admin.query_first("SELECT DATABASE()").unwrap().unwrap();
    assert!(
        database.starts_with("shufang_test_"),
        "dedicated test database required"
    );
    let workspace = format!("reconnect-{}", uuid::Uuid::new_v4());
    let lock = format!(
        "shufang:{:x}",
        Sha256::digest(format!("{database}\0{workspace}"))
    )[..64]
        .to_string();
    (url, admin, workspace, lock)
}
fn disconnect(admin: &mut Conn, lock: &str) {
    let owner: Option<u32> = admin
        .exec_first("SELECT IS_USED_LOCK(?)", (lock,))
        .unwrap()
        .flatten();
    admin
        .query_drop(format!("KILL CONNECTION {}", owner.expect("writer lease")))
        .unwrap();
}

#[test]
#[ignore = "requires isolated migrated MySQL"]
fn disconnected_writer_recovers_snapshot_and_mutation_without_duplicate_operations() {
    let (url, mut admin, workspace, lock) = isolated();
    let repo = MysqlRepository::open(&url, &workspace, "node", false).unwrap();
    let mut core = CoreSession::new(repo, Clock, workspace.clone(), "node".into()).unwrap();
    core.save_note("note", "Title", "Before disconnect", 0)
        .unwrap();
    disconnect(&mut admin, &lock);
    let head = core.replication_head().unwrap();
    let snapshot = uuid::Uuid::new_v4().to_string();
    core.create_sync_snapshot(&snapshot, "checkpoint", head.sequence.parse().unwrap())
        .unwrap();
    assert_eq!(core.sync_snapshot_page(&snapshot, "").unwrap().1.len(), 1);
    core.save_note("note", "Title", "After reconnect", 1)
        .unwrap();
    assert_eq!(
        core.entity("notes", "note").unwrap().value["content"],
        json!("After reconnect")
    );
    assert_eq!(core.replication_head().unwrap().sequence, "2");
    assert!(
        matches!(MysqlRepository::open(&url,&workspace,"node",false),Err(e) if e=="writer_already_running")
    );
}

#[test]
#[ignore = "requires isolated migrated MySQL"]
fn reconnect_does_not_steal_another_writer_lease() {
    let (url, mut admin, workspace, lock) = isolated();
    let repo = MysqlRepository::open(&url, &workspace, "node", false).unwrap();
    let mut core = CoreSession::new(repo, Clock, workspace.clone(), "node".into()).unwrap();
    disconnect(&mut admin, &lock);
    let competitor = MysqlRepository::open(&url, &workspace, "node", false).unwrap();
    assert_eq!(
        core.create_sync_snapshot("blocked", "checkpoint", 0)
            .unwrap_err(),
        "writer_lease_lost"
    );
    assert_eq!(competitor.replication_head().unwrap().sequence, "0");
}

#[test]
#[ignore = "requires isolated migrated MySQL"]
fn reconnect_rejects_a_replaced_workspace_epoch() {
    let (url, mut admin, workspace, lock) = isolated();
    let repo = MysqlRepository::open(&url, &workspace, "node", false).unwrap();
    let mut core = CoreSession::new(repo, Clock, workspace.clone(), "node".into()).unwrap();
    disconnect(&mut admin, &lock);
    admin
        .exec_drop(
            "UPDATE sync_heads SET epoch=? WHERE workspace=?",
            (uuid::Uuid::new_v4().to_string(), &workspace),
        )
        .unwrap();
    assert_eq!(
        core.create_sync_snapshot("blocked", "checkpoint", 0)
            .unwrap_err(),
        "writer_identity_changed"
    );
}

#[test]
#[ignore = "requires isolated migrated MySQL"]
fn reconnect_rejects_a_replaced_node() {
    let (url, mut admin, workspace, lock) = isolated();
    let repo = MysqlRepository::open(&url, &workspace, "node", false).unwrap();
    let mut core = CoreSession::new(repo, Clock, workspace.clone(), "node".into()).unwrap();
    disconnect(&mut admin, &lock);
    admin
        .exec_drop(
            "UPDATE sync_heads SET node_id='replacement' WHERE workspace=?",
            (&workspace,),
        )
        .unwrap();
    assert_eq!(
        core.create_sync_snapshot("blocked", "checkpoint", 0)
            .unwrap_err(),
        "writer_identity_changed"
    );
    // A rejected candidate must release its lock so the legitimate new owner can open.
    assert!(MysqlRepository::open(&url, &workspace, "replacement", false).is_ok());
}

#[test]
#[ignore = "requires isolated migrated MySQL"]
fn reconnect_respects_and_releases_the_restore_gate() {
    let (url, mut admin, workspace, lock) = isolated();
    let repo = MysqlRepository::open(&url, &workspace, "node", false).unwrap();
    let mut core = CoreSession::new(repo, Clock, workspace, "node".into()).unwrap();
    disconnect(&mut admin, &lock);
    let database: String = admin.query_first("SELECT DATABASE()").unwrap().unwrap();
    let gate =
        format!("shufang-restore-{:x}", Sha256::digest(database.as_bytes()))[..64].to_owned();
    let acquired: Option<u8> = admin.exec_first("SELECT GET_LOCK(?,0)", (&gate,)).unwrap();
    assert_eq!(acquired, Some(1));
    assert_eq!(
        core.create_sync_snapshot("blocked", "checkpoint", 0)
            .unwrap_err(),
        "database_restore_or_open_running"
    );
    admin.exec_drop("SELECT RELEASE_LOCK(?)", (&gate,)).unwrap();
    core.create_sync_snapshot(&uuid::Uuid::new_v4().to_string(), "checkpoint", 0)
        .unwrap();
    let acquired: Option<u8> = admin.exec_first("SELECT GET_LOCK(?,0)", (&gate,)).unwrap();
    assert_eq!(
        acquired,
        Some(1),
        "recovery must not keep the database restore gate"
    );
}
