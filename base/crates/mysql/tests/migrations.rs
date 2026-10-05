use mysql::{prelude::Queryable, Conn, Opts};
use shufang_mysql::migrations::{apply, read_chain};
use std::path::PathBuf;
#[test]
#[ignore = "requires isolated MySQL with create/drop access to rust_acceptance namespaces"]
fn rust_runner_initializes_upgrades_repeats_and_recovers_partial_ddl() {
    let url = std::env::var("SHUFANG_TEST_MYSQL_URL").unwrap();
    assert!(url.ends_with("/rust_acceptance_20261005"));
    let source = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../app/db/migrations");
    let chain = read_chain(&source).unwrap();
    assert_eq!(chain.len(), 16);
    for start in [0, 12, 15] {
        let name = format!("rust_acceptance_runner_{}", uuid::Uuid::new_v4().simple());
        assert!(name.starts_with("rust_acceptance_runner_"));
        assert_eq!(name.len(), 55);
        let mut admin = Conn::new(Opts::from_url(&url).unwrap()).unwrap();
        admin
            .query_drop(format!(
                "CREATE DATABASE `{name}` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin"
            ))
            .unwrap();
        let base = url.rsplit_once('/').unwrap().0;
        let target = format!("{base}/{name}");
        let result = std::panic::catch_unwind(|| {
            let mut db = Conn::new(Opts::from_url(&target).unwrap()).unwrap();
            let mut historical = chain[..start].to_vec();
            if start == 15 {
                historical[14].hash =
                    "0d33a43b95cc793c398193ac609bb0db2c88118a27db925c2be820884f6438d1".into();
            }
            apply(&mut db, &historical).unwrap();
            if start > 0 {
                db.query_drop("INSERT INTO app_users(id,username_encrypted,password_hash) VALUES(1,'public-encrypted','public-hash')").unwrap();
            }
            if start == 15 {
                let mut broken = chain.clone();
                broken[15]
                    .statements
                    .insert(1, "SELECT * FROM deliberately_missing_test_table".into());
                assert!(apply(&mut db, &broken).is_err());
                let count: u64 = db
                    .query_first("SELECT COUNT(*) FROM __drizzle_migrations")
                    .unwrap()
                    .unwrap();
                assert_eq!(count, 15);
            }
            assert_eq!(apply(&mut db, &chain).unwrap(), 16 - start);
            assert_eq!(apply(&mut db, &chain).unwrap(), 0);
            if start == 15 {
                let recorded: String = db
                    .exec_first(
                        "SELECT hash FROM __drizzle_migrations WHERE created_at=?",
                        (chain[14].when,),
                    )
                    .unwrap()
                    .unwrap();
                assert_eq!(
                    recorded,
                    "0d33a43b95cc793c398193ac609bb0db2c88118a27db925c2be820884f6438d1"
                );
            }
            if start > 0 {
                let value: String = db
                    .query_first("SELECT username_encrypted FROM app_users WHERE id=1")
                    .unwrap()
                    .unwrap();
                assert_eq!(value, "public-encrypted");
            }
        });
        admin.query_drop(format!("DROP DATABASE `{name}`")).unwrap();
        if let Err(e) = result {
            std::panic::resume_unwind(e);
        }
    }
}
