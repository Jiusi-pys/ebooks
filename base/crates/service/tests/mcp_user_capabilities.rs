use axum::{body::Body, http::Request};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use shufang_native::workspace::Workspace;
use shufang_service::{router, Host};
use std::sync::Arc;
use tower::ServiceExt;
async fn rpc(h: Arc<Host>, method: &str, params: Value, token: &str) -> Value {
    let r = router(h)
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/mcp")
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"jsonrpc":"2.0","id":1,"method":method,"params":params}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    serde_json::from_slice(&r.into_body().collect().await.unwrap().to_bytes()).unwrap()
}
async fn call(h: Arc<Host>, name: &str, args: Value) -> Value {
    rpc(
        h,
        "tools/call",
        json!({"name":name,"arguments":args}),
        "key",
    )
    .await
}
fn host(dir: &tempfile::TempDir, readonly: bool) -> Arc<Host> {
    let w = Workspace::open(&dir.path().join("db"), "w", "n").unwrap();
    if readonly {
        Host::new_read_only(w, "key".into(), "http://localhost".into())
    } else {
        Host::new(w, "key".into(), "http://localhost".into())
    }
}
#[tokio::test]
async fn catalogue_has_user_actions_and_never_control_actions() {
    let d = tempfile::tempdir().unwrap();
    let h = host(&d, false);
    let v = rpc(h, "tools/list", json!({}), "key").await;
    let t = v["result"]["tools"].as_array().unwrap();
    assert_eq!(t.len(), 85);
    assert_eq!(
        t.iter()
            .map(|t| t["name"].as_str().unwrap())
            .collect::<std::collections::HashSet<_>>()
            .len(),
        t.len()
    );
    for name in [
        "create_book",
        "update_book",
        "delete_book",
        "get_book_source",
        "import_book",
        "set_book_cover",
        "update_note",
        "create_association",
        "review_highlight",
        "ai_chat",
        "create_version",
        "restore_version_entity",
        "save_reading_progress",
    ] {
        assert!(t.iter().any(|x| x["name"] == name), "missing {name}");
    }
    for x in t {
        let name = x["name"].as_str().unwrap();
        assert!(![
            "sync",
            "peer",
            "deploy",
            "service_token",
            "login",
            "webhook"
        ]
        .iter()
        .any(|bad| name.contains(bad)));
    }
}

#[tokio::test]
#[ignore = "requires isolated fully migrated MySQL"]
async fn real_mysql_mcp_mutations_and_single_entity_restore() {
    let url = std::env::var("SHUFANG_TEST_MYSQL_URL").unwrap();
    let d = tempfile::tempdir().unwrap();
    let workspace = format!("mcp-{}", uuid::Uuid::new_v4());
    let w =
        Workspace::open_mysql(&d.path().join("db"), &url, &workspace, "mcp-node", false).unwrap();
    let h = Host::new(w, "key".into(), "http://localhost".into());
    seed_book(h.clone()).await;
    ok(&call(
        h.clone(),
        "create_note",
        json!({"id":"note","operation_id":"create","data":{"title":"N","content":"Original"}}),
    )
    .await);
    let version = ok(&call(h.clone(), "create_version", json!({})).await);
    let update =
        json!({"id":"note","expected":1,"operation_id":"edit","data":{"content":"Changed"}});
    ok(&call(h.clone(), "update_note", update.clone()).await);
    let retry = ok(&call(h.clone(), "update_note", update).await);
    assert_eq!(retry["duplicate"], true);
    ok(&call(
        h.clone(),
        "restore_version_entity",
        json!({"version_id":version["id"],"kind":"notes","id":"note","operation_id":"restore"}),
    )
    .await);
    let note = ok(&call(h.clone(), "get_note", json!({"note_id":"note"})).await);
    assert_eq!(note["content"], "Original");
    ok(&call(
        h.clone(),
        "delete_version",
        json!({"version_id":version["id"]}),
    )
    .await);
    let books = ok(&call(h, "list_library_books", json!({})).await);
    assert_eq!(books["records"][0]["title"], "Title");
}
#[tokio::test]
async fn book_crud_preserves_full_content_cover_and_revision_conflicts() {
    let d = tempfile::tempdir().unwrap();
    let h = host(&d, false);
    let create=call(h.clone(),"create_book",json!({"id":"book","operation_id":"create-1","data":{"title":"Title","author":"A","format":"txt","chapters":[{"id":"chapter","title":"C","paragraphs":["Full text"]}]}})).await;
    assert_eq!(create["result"]["isError"], false, "{create}");
    let book = call(h.clone(), "get_book", json!({"id":"book"})).await;
    let rev = book["result"]["structuredContent"]["revision"]
        .as_u64()
        .unwrap();
    let cover=call(h.clone(),"set_book_cover",json!({"id":"book","expected":rev,"operation_id":"cover-1","cover":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=="})).await;
    assert_eq!(cover["result"]["isError"], false, "{cover}");
    let retry=call(h.clone(),"set_book_cover",json!({"id":"book","expected":rev,"operation_id":"cover-1","cover":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=="})).await;
    assert_eq!(retry["result"]["isError"], false, "{retry}");
    let stale = call(
        h.clone(),
        "update_book",
        json!({"id":"book","expected":rev,"operation_id":"update-2","data":{"title":"Stale"}}),
    )
    .await;
    assert_eq!(stale["result"]["isError"], true, "{stale}");
    let chapter = call(h, "get_book_chapter", json!({"id":"book","index":0})).await;
    assert_eq!(
        chapter["result"]["structuredContent"]["paragraphs"],
        json!(["Full text"])
    );
}
#[tokio::test]
async fn readonly_host_and_unknown_actions_cannot_mutate() {
    let d = tempfile::tempdir().unwrap();
    let h = host(&d, true);
    let v = call(
        h.clone(),
        "create_note",
        json!({"id":"n","operation_id":"op","data":{"title":"T","content":"B"}}),
    )
    .await;
    assert_eq!(v["result"]["isError"], true, "{v}");
    for name in [
        "requestSync",
        "serviceToken",
        "saveSyncPeer",
        "workspace_execute",
    ] {
        assert!(call(h.clone(), name, json!({})).await["error"].is_object());
    }
    assert!(h
        .workspace
        .execute("list", json!({"kind":"notes"}))
        .unwrap()
        .as_array()
        .unwrap()
        .is_empty());
}

fn ok(v: &Value) -> Value {
    assert_eq!(v["result"]["isError"], false, "{v}");
    v["result"]["structuredContent"].clone()
}
async fn seed_book(h: Arc<Host>) {
    ok(&call(h,"create_book",json!({"id":"book","operation_id":"book-create","data":{"title":"Title","format":"txt","chapters":[{"id":"chapter","title":"Chapter","paragraphs":["Text"]}]}})).await);
}
#[tokio::test]
async fn every_user_entity_supports_create_read_update_delete_and_validation() {
    for (name, kind, data, patch) in [
        (
            "folder",
            "folders",
            json!({"name":"Folder","icon":"heart"}),
            json!({"name":"Edited"}),
        ),
        (
            "note",
            "notes",
            json!({"title":"Note","content":"Body"}),
            json!({"content":"Edited"}),
        ),
        (
            "highlight",
            "highlights",
            json!({"bookId":"book","chapterId":"chapter","chapterTitle":"C","text":"Text","paraIndex":0,"start":0,"end":4,"style":{"kind":"underline","color":"orange"}}),
            json!({"note":"Edited"}),
        ),
        (
            "translation",
            "translations",
            json!({"bookId":"book","chapterId":"chapter","text":"译文","targetLang":"中文"}),
            json!({"text":"Edited"}),
        ),
        (
            "mindmap",
            "mindMaps",
            json!({"bookId":"book","title":"Map","root":{"id":"root","text":"Root","children":[]}}),
            json!({"title":"Edited"}),
        ),
        (
            "studyset",
            "studySets",
            json!({"name":"Set","bookIds":["book"]}),
            json!({"description":"Edited"}),
        ),
        (
            "preference",
            "preferences",
            json!({"value":{"fontSize":20}}),
            json!({"value":{"fontSize":22}}),
        ),
        (
            "association",
            "associations",
            json!({"direction":"bidirectional","source":{"kind":"text","bookId":"book","chapterId":"chapter","chapterTitle":"C","text":"T","paraIndex":0,"start":0,"end":1},"target":{"kind":"text","bookId":"book","chapterId":"chapter","chapterTitle":"C","text":"e","paraIndex":0,"start":1,"end":2}}),
            json!({"label":"Edited"}),
        ),
    ] {
        let d = tempfile::tempdir().unwrap();
        let h = host(&d, false);
        seed_book(h.clone()).await;
        let created = call(
            h.clone(),
            &format!("create_{name}"),
            json!({"id":"entity","operation_id":"create","data":data}),
        )
        .await;
        ok(&created);
        let row = h
            .workspace
            .execute("get", json!({"kind":kind,"id":"entity"}))
            .unwrap();
        let rev = row["revision"].clone();
        ok(&call(
            h.clone(),
            &format!("update_{name}"),
            json!({"id":"entity","expected":rev,"operation_id":"update","data":patch}),
        )
        .await);
        let invalid=call(h.clone(),&format!("update_{name}"),json!({"id":"entity","expected":rev,"operation_id":"bad","data":{"sourceFile":"secret"}})).await;
        assert_eq!(invalid["result"]["isError"], true);
        let listed = ok(&call(
            h.clone(),
            &format!("list_library_{}", kind.to_ascii_lowercase()),
            json!({"limit":1}),
        )
        .await);
        assert_eq!(listed["records"][0]["id"], "entity");
        let row = h
            .workspace
            .execute("get", json!({"kind":kind,"id":"entity"}))
            .unwrap();
        ok(&call(
            h.clone(),
            &format!("delete_{name}"),
            json!({"id":"entity","expected":row["revision"],"operation_id":"delete"}),
        )
        .await);
        assert!(h
            .workspace
            .execute("get", json!({"kind":kind,"id":"entity"}))
            .is_err());
    }
}
#[tokio::test]
async fn review_citation_reading_and_version_restore_are_real_business_operations() {
    let d = tempfile::tempdir().unwrap();
    let h = host(&d, false);
    seed_book(h.clone()).await;
    ok(&call(
        h.clone(),
        "create_note",
        json!({"id":"note","operation_id":"note-create","data":{"title":"N","content":"Original"}}),
    )
    .await);
    ok(&call(h.clone(),"create_highlight",json!({"id":"highlight","operation_id":"highlight-create","data":{"bookId":"book","chapterId":"chapter","chapterTitle":"C","text":"Text","paraIndex":0,"start":0,"end":4}})).await);
    let rev = h
        .workspace
        .execute("get", json!({"kind":"highlights","id":"highlight"}))
        .unwrap()["revision"]
        .clone();
    ok(&call(
        h.clone(),
        "set_review_enrollment",
        json!({"id":"highlight","expected":rev,"operation_id":"enroll","enabled":true}),
    )
    .await);
    let rev = h
        .workspace
        .execute("get", json!({"kind":"highlights","id":"highlight"}))
        .unwrap()["revision"]
        .clone();
    ok(&call(
        h.clone(),
        "review_highlight",
        json!({"id":"highlight","expected":rev,"operation_id":"review","rating":4}),
    )
    .await);
    let rev = h
        .workspace
        .execute("get", json!({"kind":"highlights","id":"highlight"}))
        .unwrap()["revision"]
        .clone();
    ok(&call(h.clone(),"link_citation",json!({"highlight_id":"highlight","note_id":"note","highlight_revision":rev,"note_revision":1,"operation_id":"link"})).await);
    ok(&call(h.clone(),"save_reading_progress",json!({"id":"book","session":"reading","progress":{"chapterId":"chapter","ratio":0.5},"active_seconds":20,"operation_id":"checkpoint"})).await);
    let book = ok(&call(h.clone(), "get_book", json!({"id":"book"})).await);
    assert_eq!(book["progress"]["ratio"], 0.5);
    let original = h
        .workspace
        .execute("get", json!({"kind":"notes","id":"note"}))
        .unwrap()["value"]["content"]
        .clone();
    let version = ok(&call(h.clone(), "create_version", json!({})).await);
    assert!(version.get("archive").is_none());
    assert!(version.get("checkpoint").is_none());
    let rev = h
        .workspace
        .execute("get", json!({"kind":"notes","id":"note"}))
        .unwrap()["revision"]
        .clone();
    ok(&call(
        h.clone(),
        "update_note",
        json!({"id":"note","expected":rev,"operation_id":"edit-note","data":{"content":"Changed"}}),
    )
    .await);
    ok(&call(
        h.clone(),
        "restore_version_entity",
        json!({"version_id":version["id"],"kind":"notes","id":"note","operation_id":"restore"}),
    )
    .await);
    let note = ok(&call(h.clone(), "get_note", json!({"note_id":"note"})).await);
    assert_eq!(note["content"], original);
    ok(&call(h, "delete_version", json!({"version_id":version["id"]})).await);
}
#[tokio::test]
async fn oauth_read_grants_cannot_write_or_reach_control_routes() {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    use sha2::{Digest, Sha256};
    let d = tempfile::tempdir().unwrap();
    let h = host(&d, false);
    let hash = |s: &str| URL_SAFE_NO_PAD.encode(Sha256::digest(s.as_bytes()));
    h.workspace.core.lock().unwrap().set_local_value("oauth-store",0,&json!({"clients":{},"pending":{},"codes":{},"refresh":{},"used_refresh":{},"access":{hash("reader"):{"resource":"http://localhost/mcp","scope":"library:read","expires":u64::MAX},hash("writer"):{"resource":"http://localhost/mcp","scope":"library:read library:write","expires":u64::MAX}}})).unwrap();
    let read = rpc(h.clone(), "tools/list", json!({}), "reader").await;
    assert!(read["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .all(|t| t["annotations"]["readOnlyHint"] == true));
    let args = json!({"name":"create_note","arguments":{"id":"note","operation_id":"create","data":{"title":"N","content":"Body"}}});
    let forbidden = rpc(h.clone(), "tools/call", args.clone(), "reader").await;
    assert_eq!(forbidden["error"], "insufficient_scope");
    ok(&rpc(h.clone(), "tools/call", args, "writer").await);
    for path in ["/admin/sync/run", "/admin/stop"] {
        let r = router(h.clone())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(path)
                    .header("authorization", "Bearer writer")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(r.status(), 401);
    }
}
#[tokio::test]
async fn import_and_source_pagination_are_complete_and_retries_do_not_duplicate() {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let d = tempfile::tempdir().unwrap();
    let h = host(&d, false);
    let payload = STANDARD.encode("原文第一行\n第二行".as_bytes());
    let args = json!({"filename":"book.txt","payload":payload,"operation_id":"import"});
    let first = ok(&call(h.clone(), "import_book", args.clone()).await);
    let again = ok(&call(h.clone(), "import_book", args).await);
    assert_eq!(first["job"], again["job"]);
    let mut completed = false;
    for _ in 0..100 {
        let job = ok(&call(h.clone(), "get_job", json!({"job_id":first["job"]})).await);
        if job["status"] == "completed" {
            completed = true;
            break;
        }
        assert_ne!(job["status"], "failed", "{job}");
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert!(completed);
    let rows = h
        .workspace
        .execute("list", json!({"kind":"books"}))
        .unwrap();
    assert_eq!(rows.as_array().unwrap().len(), 1);
    let id = rows[0]["value"]["id"].clone();
    let mut bytes = Vec::new();
    let mut offset = 0;
    loop {
        let page = ok(&call(
            h.clone(),
            "get_book_source",
            json!({"id":id,"offset":offset,"limit":3}),
        )
        .await);
        bytes.extend(STANDARD.decode(page["payload"].as_str().unwrap()).unwrap());
        let Some(next) = page["next_offset"].as_u64() else {
            break;
        };
        offset = next;
    }
    assert_eq!(bytes, "原文第一行\n第二行".as_bytes());
    let bad = call(
        h,
        "import_book",
        json!({"filename":"../secret.txt","payload":"eA==","operation_id":"bad"}),
    )
    .await;
    assert_eq!(bad["result"]["isError"], true);
}

#[tokio::test]
async fn chunked_large_book_import_parses_into_the_same_book() {
    use base64::{engine::general_purpose::STANDARD, Engine};
    use sha2::{Digest, Sha256};
    let d = tempfile::tempdir().unwrap();
    let h = host(&d, false);
    ok(&call(
        h.clone(),
        "create_book",
        json!({"id":"large","operation_id":"large-create","data":{"title":"Large","format":"txt"}}),
    )
    .await);
    let bytes = vec![b'A'; 300000];
    let hash = format!("{:x}", Sha256::digest(&bytes));
    for (index, chunk) in bytes.chunks(262144).enumerate() {
        ok(&call(
            h.clone(),
            "upload_book_source_chunk",
            json!({"id":"large","upload_id":hash,"index":index,"payload":STANDARD.encode(chunk)}),
        )
        .await);
    }
    ok(&call(h.clone(),"complete_book_source",json!({"id":"large","sha256":hash,"size":bytes.len(),"name":"large.txt","mime_type":"text/plain"})).await);
    let args = json!({"id":"large","expected":1,"operation_id":"parse-large"});
    let first = ok(&call(h.clone(), "parse_book_source", args.clone()).await);
    let retry = ok(&call(h.clone(), "parse_book_source", args).await);
    assert_eq!(first["job"], retry["job"]);
    let mut completed = false;
    for _ in 0..200 {
        let job = ok(&call(h.clone(), "get_job", json!({"job_id":first["job"]})).await);
        if job["status"] == "completed" {
            completed = true;
            break;
        }
        assert_ne!(job["status"], "failed", "{job}");
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert!(completed);
    let book = ok(&call(h.clone(), "get_book", json!({"id":"large"})).await);
    assert_eq!(book["title"], "Large");
    assert_eq!(
        book["chapters"][0]["paragraphs"][0]
            .as_str()
            .unwrap()
            .as_bytes(),
        &bytes
    );
    let listed = ok(&call(h, "list_library_books", json!({})).await);
    assert_eq!(listed["total"], 1);
}
