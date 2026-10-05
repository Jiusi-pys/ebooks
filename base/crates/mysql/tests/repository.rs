use serde_json::json;
use sha2::Digest;
use shufang_application::{CoreSession, Repository, Runtime};
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
#[test]
#[ignore = "requires isolated MySQL with migrations 0000-0015"]
fn existing_schema_atomic_commands_and_snapshot_lifecycle() {
    let url = std::env::var("SHUFANG_TEST_MYSQL_URL").expect("isolated test database required");
    let workspace = format!("test-{}", uuid::Uuid::new_v4());
    let repo = MysqlRepository::open(&url, &workspace, "test-node", false).unwrap();
    assert!(
        matches!(MysqlRepository::open(&url,&workspace,"test-node",false),Err(e) if e=="writer_already_running")
    );
    assert_eq!(repo.clock().unwrap(), "0:0");
    let mut core = CoreSession::new(repo, Clock, workspace.clone(), "test-node".into()).unwrap();
    let record = core.save_note("note", "Title", "Original", 0).unwrap();
    assert_eq!(record["revision"], 1);
    assert!(core.save_note("note", "Changed", "bad", 0).is_err());
    assert_eq!(
        core.entity("notes", "note").unwrap().value["content"],
        "Original"
    );
    let head = core.replication_head().unwrap();
    let version = format!("version-{}", uuid::Uuid::new_v4());
    core.create_sync_snapshot(&version, "checkpoint", head.sequence.parse().unwrap())
        .unwrap();
    assert_eq!(core.sync_snapshot_page(&version, "").unwrap().1.len(), 1);
    assert_eq!(core.local_value("state").unwrap(), None);
    core.set_local_value("state", 0, &json!({"value":1}))
        .unwrap();
    assert!(core
        .set_local_value("state", 0, &json!({"value":2}))
        .is_err());
    drop(core);
    let repo = MysqlRepository::open(&url, &workspace, "test-node", true).unwrap();
    assert_eq!(repo.load("notes", "note").unwrap().unwrap().revision, 1);
    assert_eq!(repo.list_versions().unwrap().len(), 1);
}

#[test]
#[ignore = "requires a second fully migrated, empty isolated MySQL database"]
fn restore_retains_operations_and_changes_epoch_then_transfers_writer() {
    let url = std::env::var("SHUFANG_TEST_MYSQL_URL").unwrap();
    let target = std::env::var("SHUFANG_TEST_RESTORE_MYSQL_URL").unwrap();
    let workspace = format!("restore-{}", uuid::Uuid::new_v4());
    let repo = MysqlRepository::open(&url, &workspace, "restore-node", false).unwrap();
    let mut core = CoreSession::new(repo, Clock, workspace.clone(), "restore-node".into()).unwrap();
    core.save_note("n", "Title", "Retained", 0).unwrap();
    let head = core.replication_head().unwrap();
    core.set_local_value("sync:receive:old-peer", 0, &json!({"cursor":"123"}))
        .unwrap();
    let dump = core.repository().dump().unwrap();
    assert!(shufang_mysql::backup::restore(&url, &dump).is_err());
    shufang_mysql::backup::restore(&target, &dump).unwrap();
    let restored = MysqlRepository::open(&target, &workspace, "restore-node", false).unwrap();
    assert_ne!(
        shufang_application::ReplicationRepository::replication_head(&restored)
            .unwrap()
            .epoch,
        head.epoch
    );
    assert_eq!(restored.pending().unwrap().len(), 1);
    assert!(restored
        .get_local("sync:receive:old-peer")
        .unwrap()
        .is_none());
    assert_eq!(restored.load("notes", "n").unwrap().unwrap().state.id, "n");
    assert!(
        matches!(MysqlRepository::open(&target,&workspace,"restore-node",false),Err(e) if e=="writer_already_running")
    );
    drop(restored);
    let mut switched = CoreSession::new(
        MysqlRepository::open(&target, &workspace, "restore-node", false).unwrap(),
        Clock,
        workspace,
        "restore-node".into(),
    )
    .unwrap();
    switched
        .save_note("n", "Title", "After handoff", 1)
        .unwrap();
    assert_eq!(
        switched.entity("notes", "n").unwrap().value["content"],
        "After handoff"
    );
}

#[test]
#[ignore = "requires isolated migrated MySQL"]
fn existing_peer_credentials_remain_authoritative_and_revocable() {
    use mysql::prelude::Queryable;
    let url = std::env::var("SHUFANG_TEST_MYSQL_URL").unwrap();
    let workspace = format!("credentials-{}", uuid::Uuid::new_v4());
    let mut repo = MysqlRepository::open(&url, &workspace, "node", false).unwrap();
    let mut database = mysql::Conn::new(mysql::Opts::from_url(&url).unwrap()).unwrap();
    database
        .exec_drop(
            "INSERT INTO sync_credentials(workspace,credential_id,digest,revoked) VALUES(?,?,?,0)",
            (&workspace, "legacy-peer", "a".repeat(64)),
        )
        .unwrap();
    let (revision, value) = repo.get_local("sync:credentials").unwrap().unwrap();
    assert_eq!(value["legacy-peer"], "a".repeat(64));
    repo.set_local(
        "sync:credentials",
        revision,
        &json!({"new-peer":"b".repeat(64)}),
    )
    .unwrap();
    let revoked:bool=database.exec_first("SELECT revoked FROM sync_credentials WHERE workspace=? AND credential_id='legacy-peer'",(&workspace,)).unwrap().unwrap();
    assert!(revoked);
    let token: String = database
        .exec_first(
            "SELECT digest FROM sync_credentials WHERE workspace=? AND credential_id='new-peer'",
            (&workspace,),
        )
        .unwrap()
        .unwrap();
    assert_eq!(token, "b".repeat(64));
    database
        .exec_drop(
            "UPDATE sync_credentials SET revoked=1 WHERE workspace=? AND credential_id='new-peer'",
            (&workspace,),
        )
        .unwrap();
    assert!(repo
        .get_local("sync:credentials")
        .unwrap()
        .unwrap()
        .1
        .as_object()
        .unwrap()
        .is_empty());
}
#[test]
#[ignore = "requires isolated migrated MySQL"]
fn digest_preserves_shared_owner_and_rejects_stale_save() {
    use serde_json::Value;
    use shufang_application::ReplicationRepository;
    let url = std::env::var("SHUFANG_TEST_MYSQL_URL").unwrap();
    let workspace = format!("digest-{}", uuid::Uuid::new_v4());
    let node = "node";
    let mut repo = MysqlRepository::open(&url, &workspace, node, false).unwrap();
    let hash = format!(
        "{:x}",
        sha2::Sha256::digest(uuid::Uuid::new_v4().as_bytes())
    );
    let mut add = |id: &str, clock: &str, deleted: bool| {
        let op = shufang_domain::sync::Operation {
            workspace_id: workspace.clone(),
            operation_id: uuid::Uuid::new_v4().to_string(),
            replica_id: node.into(),
            kind: "books".into(),
            entity_id: id.into(),
            clock: clock.into(),
            patch: if deleted {
                serde_json::Map::new()
            } else {
                json!({"contentHash":hash}).as_object().unwrap().clone()
            },
            unset: vec![],
            deleted,
        };
        let prior = repo.load("books", id).unwrap();
        let state =
            shufang_domain::sync::apply_operation(prior.as_ref().map(|v| &v.state), &op).unwrap();
        let head = repo.clock().unwrap();
        repo.mutation_batch(
            &head,
            &[shufang_application::Commit {
                expected: prior.map_or(0, |v| v.revision),
                state,
                operation: op,
            }],
        )
        .unwrap();
    };
    add("a", "1:0", false);
    add("b", "2:0", false);
    let key = format!("digest:{hash}");
    let digest = json!({"title":"Title","author":"","structure":"Outline","overview":Value::Null});
    repo.set_local(&key, 0, &digest).unwrap();
    assert_eq!(
        repo.get_local(&key).unwrap().unwrap().1["structure"],
        "Outline"
    );
    fn remove(repo: &mut MysqlRepository, w: &str, id: &str, clock: &str) {
        let prior = repo.load("books", id).unwrap().unwrap();
        let op = shufang_domain::sync::Operation {
            workspace_id: w.into(),
            operation_id: uuid::Uuid::new_v4().to_string(),
            replica_id: "node".into(),
            kind: "books".into(),
            entity_id: id.into(),
            clock: clock.into(),
            patch: serde_json::Map::new(),
            unset: vec![],
            deleted: true,
        };
        let state = shufang_domain::sync::apply_operation(Some(&prior.state), &op).unwrap();
        repo.mutation_batch(
            &repo.clock().unwrap(),
            &[shufang_application::Commit {
                expected: prior.revision,
                state,
                operation: op,
            }],
        )
        .unwrap();
    }
    remove(&mut repo, &workspace, "a", "3:0");
    assert!(repo.get_local(&key).unwrap().is_some());
    remove(&mut repo, &workspace, "b", "4:0");
    assert!(repo.get_local(&key).unwrap().is_none());
    assert_eq!(
        repo.set_local(&key, 0, &digest).unwrap_err(),
        "digest_unreferenced"
    );
}
