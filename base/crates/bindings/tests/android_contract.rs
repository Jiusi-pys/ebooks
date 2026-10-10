use serde_json::{json, Value};
use shufang_bindings::execute;

fn call(session: &str, action: &str, args: Value) -> Value {
    execute(&json!({"version":1,"command":"sessionCommand","session":session,"action":action,"args":args}).to_string())
}

#[test]
fn android_paged_reads_keep_revisions_and_reject_invalid_limits() {
    let root = tempfile::tempdir().unwrap();
    let opened = execute(&json!({"version":1,"command":"sessionOpen","path":root.path().join("library.sqlite"),"workspace":"android-test","replica":"phone"}).to_string());
    let session = opened["value"]["session"].as_str().unwrap();
    for id in ["a", "b", "c"] {
        let saved = call(
            session,
            "save",
            json!({"kind":"notes","id":id,"expected":0,"patch":{"title":id,"content":"中文 🚀"}}),
        );
        assert_eq!(saved["ok"], true, "{saved}");
    }
    let first = call(
        session,
        "listPage",
        json!({"kind":"notes","offset":0,"limit":2}),
    );
    assert_eq!(first["ok"], true, "{first}");
    assert_eq!(first["value"]["items"].as_array().unwrap().len(), 2);
    assert_eq!(first["value"]["total"], 3);
    assert_eq!(first["value"]["nextOffset"], 2);
    assert_eq!(first["value"]["items"][0]["revision"], 1);
    let last = call(
        session,
        "listPage",
        json!({"kind":"notes","offset":2,"limit":2}),
    );
    assert!(last["value"]["nextOffset"].is_null());
    assert_eq!(
        call(session, "listPage", json!({"kind":"notes","limit":0}))["ok"],
        false
    );
    assert_eq!(
        call(session, "listPage", json!({"kind":"notes","limit":201}))["ok"],
        false
    );
    assert_eq!(
        call(session, "listPage", json!({"kind":"unknown","limit":10}))["ok"],
        false
    );
    execute(&json!({"version":1,"command":"sessionClose","session":session}).to_string());
}

#[test]
fn parsed_import_commits_source_and_book_once_and_survives_reopen() {
    let root = tempfile::tempdir().unwrap();
    let database = root.path().join("library.sqlite");
    let source = root.path().join("测试.txt");
    let parsed = root.path().join("parsed.json");
    std::fs::write(&source, "正文 🚀").unwrap();
    std::fs::write(&parsed,json!({"title":"测试","author":"作者","format":"txt","coverTone":0,"chapters":[{"id":"chapter","title":"第一章","paragraphs":["正文 🚀"]}],"progress":{"chapterId":"chapter","ratio":0}}).to_string()).unwrap();
    let open = || {
        execute(&json!({"version":1,"command":"sessionOpen","path":database,"workspace":"android-test","replica":"phone"}).to_string())
    };
    let opened = open();
    let session = opened["value"]["session"].as_str().unwrap();
    let args = json!({"path":source,"parsedPath":parsed});
    let first = call(session, "importParsed", args.clone());
    assert_eq!(first["ok"], true, "{first}");
    let id = first["value"]["value"]["id"].as_str().unwrap().to_owned();
    let hits = call(session, "searchPage", json!({"query":"🚀","limit":20}));
    assert_eq!(hits["ok"], true, "{hits}");
    assert_eq!(hits["value"]["items"][0]["anchor"]["start"], 3);
    assert_eq!(hits["value"]["items"][0]["anchor"]["end"], 5);
    assert!(hits["value"]["items"][0]["record"]["value"]
        .get("chapters")
        .is_none());
    let second = call(session, "importParsed", args);
    assert_eq!(second["value"]["value"]["id"], id);
    assert_eq!(
        call(session, "listPage", json!({"kind":"books","limit":20}))["value"]["total"],
        1
    );
    let resource = call(session, "bookResource", json!({"id":id}));
    assert_eq!(
        std::fs::read(resource["value"]["path"].as_str().unwrap()).unwrap(),
        "正文 🚀".as_bytes()
    );
    execute(&json!({"version":1,"command":"sessionClose","session":session}).to_string());
    let reopened = open();
    let session = reopened["value"]["session"].as_str().unwrap();
    assert_eq!(
        call(session, "get", json!({"kind":"books","id":id}))["value"]["value"]["chapters"][0]
            ["paragraphs"][0],
        "正文 🚀"
    );
    std::fs::write(&parsed, "{}").unwrap();
    assert_eq!(
        call(
            session,
            "importParsed",
            json!({"path":source,"parsedPath":parsed})
        )["ok"],
        false
    );
    assert_eq!(
        call(session, "listPage", json!({"kind":"books","limit":20}))["value"]["total"],
        1
    );
    execute(&json!({"version":1,"command":"sessionClose","session":session}).to_string());
}

#[test]
fn large_android_edits_use_staged_requests_without_exceeding_json_abi_limit() {
    let root = tempfile::tempdir().unwrap();
    let opened=execute(&json!({"version":1,"command":"sessionOpen","path":root.path().join("library.sqlite"),"workspace":"large-note","replica":"phone"}).to_string());
    let session = opened["value"]["session"].as_str().unwrap();
    let content = "x".repeat(3 * 1024 * 1024);
    let request = json!({"kind":"notes","id":"large","expected":0,"patch":{"title":"Large","content":content}});
    let path = root.path().join("edit.json");
    std::fs::write(&path, request.to_string()).unwrap();
    let result = call(session, "saveFromFile", json!({"path":path}));
    assert_eq!(result["ok"], true, "{result}");
    let record: Value =
        serde_json::from_slice(&std::fs::read(result["value"]["path"].as_str().unwrap()).unwrap())
            .unwrap();
    assert_eq!(record["value"]["content"], content);
    assert_eq!(record["revision"], 1);
    let preview = call(session, "listPage", json!({"kind":"notes","limit":50}));
    assert_eq!(
        preview["value"]["items"][0]["value"]["content"]
            .as_str()
            .unwrap()
            .chars()
            .count(),
        4096
    );
    assert_eq!(
        call(session, "saveFromFile", json!({"path":path}))["ok"],
        false
    );
    execute(&json!({"version":1,"command":"sessionClose","session":session}).to_string());
}

#[test]
fn search_lists_each_matching_passage_and_does_not_search_missing_json_fields() {
    let root = tempfile::tempdir().unwrap();
    let opened=execute(&json!({"version":1,"command":"sessionOpen","path":root.path().join("library.sqlite"),"workspace":"search-test","replica":"phone"}).to_string());
    let session = opened["value"]["session"].as_str().unwrap();
    assert_eq!(
        call(
            session,
            "save",
            json!({"kind":"books","id":"book","expected":0,"patch":{"title":"Search","author":"","format":"txt","coverTone":0,"chapters":[{"id":"chapter","title":"Chapter","paragraphs":["needle one","needle two"]}],"progress":{"chapterId":"chapter","ratio":0}}})
        )["ok"],
        true
    );
    let result = call(
        session,
        "searchPage",
        json!({"query":"needle","kind":"content","limit":1}),
    );
    assert_eq!(result["value"]["total"], 2);
    assert_eq!(result["value"]["nextOffset"], 1);
    let second = call(
        session,
        "searchPage",
        json!({"query":"needle","kind":"content","limit":1,"offset":1}),
    );
    assert_eq!(second["value"]["items"][0]["anchor"]["paraIndex"], 1);
    assert_eq!(
        call(session, "searchPage", json!({"query":"null"}))["value"]["total"],
        0
    );
    assert_eq!(
        call(
            session,
            "searchPage",
            json!({"query":"needle","kind":"books"})
        )["value"]["total"],
        0
    );
    assert_eq!(
        call(session, "searchPage", json!({"query":"Chapter"}))["value"]["total"],
        1
    );
    assert_eq!(
        call(
            session,
            "save",
            json!({"kind":"notes","id":"comment-note","expected":0,"patch":{"title":"Visible","content":"<!--hidden-citation-secret-->"}})
        )["ok"],
        true
    );
    assert_eq!(
        call(
            session,
            "searchPage",
            json!({"query":"hidden-citation-secret"})
        )["value"]["total"],
        0
    );
    execute(&json!({"version":1,"command":"sessionClose","session":session}).to_string());
}
