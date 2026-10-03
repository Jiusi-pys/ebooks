use serde_json::json;
use shufang_native::workspace::Workspace;

#[test]
fn outline_commands_preserve_chapters_and_reject_stale_edits() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.sqlite");
    let w = Workspace::open(&path, "test", "windows").unwrap();
    let book = w.execute("save", json!({"kind":"books","id":"b","expected":0,"patch":{"title":"书","author":"","format":"txt","chapters":[{"id":"c","title":"章","paragraphs":["中文😀正文"]}],"progress":{"ratio":0,"chapterId":"c"}}})).unwrap();
    let chapters = book["value"]["chapters"].clone();
    let outline = w.execute("outline", json!({"id":"b"})).unwrap();
    assert_eq!(outline[0]["id"], "chapter:c");
    assert!(w
        .execute(
            "editOutline",
            json!({"id":"b","expected":1,"action":"delete","entry":"chapter:c"})
        )
        .is_err());
    let added = w.execute("editOutline", json!({"id":"b","expected":1,"action":"add","target":{"chapterId":"c","paraIndex":0,"start":0,"end":2},"title":"小节"})).unwrap();
    assert_eq!(added["value"]["chapters"], chapters);
    assert_eq!(added["value"]["outline"][1]["depth"], 1);
    assert!(w
        .execute(
            "editOutline",
            json!({"id":"b","expected":1,"action":"rename","entry":"chapter:c","title":"改名"})
        )
        .is_err());
    assert!(w.execute("editOutline", json!({"id":"b","expected":2,"action":"add","target":{"chapterId":"c","paraIndex":99},"title":"坏锚点"})).is_err());
    let renamed = w
        .execute(
            "editOutline",
            json!({"id":"b","expected":2,"action":"rename","entry":"chapter:c","title":"目录名"}),
        )
        .unwrap();
    assert_eq!(renamed["value"]["outline"][0]["title"], "目录名");
    drop(w);
    let w = Workspace::open(&path, "test", "windows").unwrap();
    assert_eq!(
        w.execute("outline", json!({"id":"b"})).unwrap()[0]["title"],
        "目录名"
    );
}
#[test]
fn outline_moves_complete_subtrees_and_deletion_promotes_children() {
    let dir = tempfile::tempdir().unwrap();
    let w = Workspace::open(&dir.path().join("db"), "w", "r").unwrap();
    w.execute("save",json!({"kind":"books","id":"b","expected":0,"patch":{"title":"B","author":"","format":"txt","chapters":[{"id":"c","title":"C","paragraphs":["abc"]}],"outline":[{"id":"chapter:c","title":"C","chapterId":"c","depth":0},{"id":"a","title":"A","chapterId":"c","depth":1},{"id":"child","title":"Child","chapterId":"c","depth":2},{"id":"sibling","title":"Sibling","chapterId":"c","depth":1}]}})).unwrap();
    let moved = w
        .execute(
            "editOutline",
            json!({"id":"b","expected":1,"action":"down","entry":"a"}),
        )
        .unwrap();
    assert_eq!(moved["value"]["outline"][1]["id"], "sibling");
    assert_eq!(moved["value"]["outline"][3]["id"], "child");
    let promoted = w
        .execute(
            "editOutline",
            json!({"id":"b","expected":2,"action":"delete","entry":"a"}),
        )
        .unwrap();
    assert_eq!(promoted["value"]["outline"][2]["depth"], 1);
    let mut revision = 3;
    for action in ["indent", "outdent", "outdent"] {
        let result = w
            .execute(
                "editOutline",
                json!({"id":"b","expected":revision,"action":action,"entry":"child"}),
            )
            .unwrap();
        revision = result["revision"].as_u64().unwrap();
    }
    assert!(w
        .execute(
            "editOutline",
            json!({"id":"b","expected":revision,"action":"outdent","entry":"child"})
        )
        .is_err());
    assert!(w
        .execute(
            "save",
            json!({"kind":"books","id":"b","expected":revision,"patch":{"outline":[]}})
        )
        .is_err());
}
