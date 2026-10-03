use serde_json::{json, Value};
use shufang_application::{CoreSession, Runtime};
use shufang_sqlite::SqliteRepository;
use std::cell::Cell;
struct Clock(Cell<u64>);
impl Runtime for Clock {
    fn now(&self) -> u64 {
        1_000_000
    }
    fn new_id(&self) -> String {
        let v = self.0.get() + 1;
        self.0.set(v);
        format!("op-{v}")
    }
}
fn book() -> Value {
    json!({"title":"测试书","author":"作者","format":"txt","chapters":[{"id":"ch1","title":"第一章","paragraphs":["共同的文段"]}],"progress":{"chapterId":"ch1","ratio":0}})
}
#[test]
fn imported_book_and_original_manifest_roll_back_together_on_storage_failure() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let repo = SqliteRepository::open(&path, "w", "r").unwrap();
    let mut core = CoreSession::new(repo, Clock(Cell::new(0)), "w".into(), "r".into()).unwrap();
    let source = shufang_application::BlobManifest {
        sha256: "a".repeat(64),
        size: 3,
        name: "book.txt".into(),
        content_type: "text/plain".into(),
    };
    let connection = rusqlite::Connection::open(&path).unwrap();
    connection.execute_batch("CREATE TRIGGER reject_source BEFORE INSERT ON entities WHEN NEW.kind='sources' BEGIN SELECT RAISE(ABORT,'injected'); END;").unwrap();
    assert!(core.import_book("b", book(), &source).is_err());
    assert!(core.entity("books", "b").is_err());
    assert!(core.pending().unwrap().is_empty());
    connection
        .execute_batch("DROP TRIGGER reject_source;")
        .unwrap();
    core.import_book("b", book(), &source).unwrap();
    assert_eq!(core.pending().unwrap().len(), 2);
    assert_eq!(core.book_source("b").unwrap(), source);
}
#[test]
fn review_enrollment_queue_and_study_set_filter_survive_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let repo = SqliteRepository::open(&path, "w", "r").unwrap();
    let mut core = CoreSession::new(repo, Clock(Cell::new(0)), "w".into(), "r".into()).unwrap();
    core.save_entity("books", "b", book(), vec![], 0).unwrap();
    core.save_entity(
        "highlights",
        "h",
        json!({"bookId":"b","chapterId":"ch1","text":"共同","paraIndex":0,"start":0,"end":2}),
        vec![],
        0,
    )
    .unwrap();
    core.save_entity(
        "studySets",
        "s",
        json!({"name":"学习","bookIds":["b"]}),
        vec![],
        0,
    )
    .unwrap();
    core.save_entity(
        "studySets",
        "empty",
        json!({"name":"空","bookIds":[]}),
        vec![],
        0,
    )
    .unwrap();
    assert!(core.review_queue(None).unwrap().is_empty());
    let enrolled = core.set_review("h", true, 1).unwrap();
    assert_eq!(core.review_queue(Some("s")).unwrap().len(), 1);
    assert!(core.review_queue(Some("empty")).unwrap().is_empty());
    assert!(core.review_queue(Some("missing")).is_err());
    assert!(core.set_review("h", false, 1).is_err());
    let reviewed = core.review("h", 3, enrolled.revision).unwrap();
    assert!(core.review_queue(None).unwrap().is_empty());
    let again = core.set_review("h", true, reviewed.revision).unwrap();
    assert_eq!(again.value["review"], reviewed.value["review"]);
    drop(core);
    let repo = SqliteRepository::open(&path, "w", "r").unwrap();
    let mut core = CoreSession::new(repo, Clock(Cell::new(100)), "w".into(), "r".into()).unwrap();
    assert!(core.review_queue(None).unwrap().is_empty());
    let disabled = core.set_review("h", false, again.revision).unwrap();
    assert!(disabled.value.get("review").is_none());
    core.set_review("h", true, disabled.revision).unwrap();
    assert_eq!(core.review_queue(None).unwrap().len(), 1);
}
#[test]
fn associations_deduplicate_opposite_directions_and_keep_stable_keys() {
    let dir = tempfile::tempdir().unwrap();
    let repo = SqliteRepository::open(&dir.path().join("db"), "w", "r").unwrap();
    let mut core = CoreSession::new(repo, Clock(Cell::new(0)), "w".into(), "r".into()).unwrap();
    core.save_entity("books", "a", book(), vec![], 0).unwrap();
    core.save_entity("books", "b", book(), vec![], 0).unwrap();
    let a = json!({"kind":"text","bookId":"a","chapterId":"ch1","text":"共同","paraIndex":0,"start":0,"end":2});
    let b = json!({"kind":"text","bookId":"b","chapterId":"ch1","text":"共同","paraIndex":0,"start":0,"end":2});
    let record = core
        .save_entity(
            "associations",
            "ab",
            json!({"source":a,"target":b,"direction":"bidirectional"}),
            vec![],
            0,
        )
        .unwrap();
    assert!(record.value["pairKey"].is_string());
    assert!(core
        .save_entity(
            "associations",
            "ba",
            json!({"source":b,"target":a,"direction":"bidirectional"}),
            vec![],
            0
        )
        .is_err());
}

#[test]
fn reading_checkpoint_is_idempotent_and_utf16_anchors_are_exact() {
    let dir = tempfile::tempdir().unwrap();
    let repo = SqliteRepository::open(&dir.path().join("db"), "w", "r").unwrap();
    let mut core = CoreSession::new(repo, Clock(Cell::new(0)), "w".into(), "r".into()).unwrap();
    let mut value = book();
    value["chapters"][0]["paragraphs"] = json!(["A😀书"]);
    core.save_entity("books", "b", value, vec![], 0).unwrap();
    assert!(core
        .save_entity("books", "b", json!({"createdAt":0}), vec![], 1)
        .is_err());
    assert!(core
        .save_entity(
            "highlights",
            "bad",
            json!({"bookId":"b","chapterId":"ch1","text":"😀","paraIndex":0,"start":1,"end":2}),
            vec![],
            0
        )
        .is_err());
    core.save_entity(
        "highlights",
        "h",
        json!({"bookId":"b","chapterId":"ch1","text":"😀","paraIndex":0,"start":1,"end":3}),
        vec![],
        0,
    )
    .unwrap();
    let checkpoint = json!({"chapterId":"ch1","ratio":0.5});
    core.checkpoint("b", "read-session", checkpoint.clone(), 30)
        .unwrap();
    core.checkpoint("b", "read-session", checkpoint, 30)
        .unwrap();
    let record = core.entity("books", "b").unwrap();
    assert_eq!(record.value["readingSessions"].as_array().unwrap().len(), 1);
    assert_eq!(
        record.value["readingSessions"][0]["endedAt"]
            .as_u64()
            .unwrap()
            - record.value["readingSessions"][0]["startedAt"]
                .as_u64()
                .unwrap(),
        30000
    );
    assert_eq!(record.value["lastOpenedAt"], 1000000);
}

#[test]
fn local_library_validates_references_and_keeps_cascade_atomic() {
    let dir = tempfile::tempdir().unwrap();
    let repo = SqliteRepository::open(&dir.path().join("library.db"), "w", "r").unwrap();
    let mut core = CoreSession::new(repo, Clock(Cell::new(0)), "w".into(), "r".into()).unwrap();
    core.save_entity("books", "b", book(), vec![], 0).unwrap();
    core.save_entity(
        "notes",
        "n",
        json!({"title":"我的笔记","content":"自己的正文"}),
        vec![],
        0,
    )
    .unwrap();
    core.save_entity(
        "studySets",
        "s",
        json!({"name":"读书","bookIds":["b"]}),
        vec![],
        0,
    )
    .unwrap();
    assert!(core
        .save_entity(
            "highlights",
            "bad",
            json!({"bookId":"missing","chapterId":"ch1","chapterTitle":"x","text":"x"}),
            vec![],
            0
        )
        .is_err());
    core.save_entity("highlights","h",json!({"bookId":"b","chapterId":"ch1","chapterTitle":"第一章","text":"共同的文段","paraIndex":0,"start":0,"end":5}),vec![],0).unwrap();
    core.link_citation("h", "n", 1, 1).unwrap();
    let n = core.entity("notes", "n").unwrap();
    assert!(n.value["content"]
        .as_str()
        .unwrap()
        .contains("shufang-citation-id:h"));
    core.delete_entity("books", "b", 1).unwrap();
    assert!(core.entities("books").unwrap().is_empty());
    assert!(core.entities("highlights").unwrap().is_empty());
    assert_eq!(
        core.entity("studySets", "s").unwrap().value["bookIds"],
        json!([])
    );
    assert_eq!(
        core.entity("notes", "n").unwrap().value["content"],
        "自己的正文"
    );
    assert!(core.save_entity("books", "b", book(), vec![], 2).is_err());
}

#[test]
fn revisions_progress_review_and_search_are_core_use_cases() {
    let dir = tempfile::tempdir().unwrap();
    let repo = SqliteRepository::open(&dir.path().join("library.db"), "w", "r").unwrap();
    let mut core = CoreSession::new(repo, Clock(Cell::new(0)), "w".into(), "r".into()).unwrap();
    core.save_entity("books", "b", book(), vec![], 0).unwrap();
    assert!(core
        .save_entity("books", "b", json!({"title":"bad stale"}), vec![], 0)
        .is_err());
    assert!(core
        .save_entity(
            "books",
            "b",
            json!({"progress":{"chapterId":"missing","ratio":0.5}}),
            vec![],
            1
        )
        .is_err());
    core.save_entity(
        "books",
        "b",
        json!({"progress":{"chapterId":"ch1","ratio":0.5}}),
        vec![],
        1,
    )
    .unwrap();
    core.save_entity(
        "highlights",
        "h",
        json!({"bookId":"b","chapterId":"ch1","chapterTitle":"第一章","text":"共同的文段"}),
        vec![],
        0,
    )
    .unwrap();
    let reviewed = core.review("h", 3, 1).unwrap();
    assert_eq!(reviewed.value["review"]["interval"], 1);
    assert_eq!(reviewed.value["review"]["due"], 87_400_000u64);
    assert_eq!(core.search("共同").unwrap().len(), 2);
    let failed = core.review("h", 1, 2).unwrap();
    assert_eq!(failed.value["review"]["due"], 1_300_000u64);
}
