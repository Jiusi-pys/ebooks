use serde_json::json;
use shufang_native::workspace::Workspace;
#[test]
fn ai_chapter_expansion_updates_existing_map_and_rejects_stale_revision() {
    let dir = tempfile::tempdir().unwrap();
    let w = Workspace::open(&dir.path().join("db"), "w", "r").unwrap();
    w.execute("save",json!({"kind":"books","id":"book","expected":0,"patch":{"title":"Book","author":"","format":"txt","coverTone":0,"chapters":[{"id":"chapter","title":"Chapter","paragraphs":["Text"]}],"progress":{"chapterId":"chapter","ratio":0}}})).unwrap();
    w.execute("save",json!({"kind":"mindMaps","id":"map","expected":0,"patch":{"title":"Existing","bookId":"book","root":{"id":"root","text":"Root","children":[{"id":"chapter-node","text":"Chapter","chapterId":"chapter","children":[]}]}}})).unwrap();
    let args = json!({"task":"mindmap","mindMapId":"map","expected":1,"bookId":"book","anchor":{"chapterId":"chapter"},"text":"{\"topics\":[{\"title\":\"Generated\",\"children\":[]}]}"});
    let saved = w.execute("saveAiResult", args.clone()).unwrap();
    assert_eq!(saved["value"]["id"], "map");
    assert_eq!(
        saved["value"]["root"]["children"][0]["children"][0]["text"],
        "Generated"
    );
    assert!(w.execute("saveAiResult", args).is_err());
    assert_eq!(
        w.execute("list", json!({"kind":"mindMaps"}))
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        1
    );
}
#[test]
fn generated_results_are_validated_before_any_record_is_created() {
    let dir = tempfile::tempdir().unwrap();
    let w = Workspace::open(&dir.path().join("db"), "w", "r").unwrap();
    assert!(w
        .execute(
            "saveAiResult",
            json!({"task":"mindmap","title":"脑图","text":"not JSON"})
        )
        .is_err());
    assert!(w
        .execute("list", json!({"kind":"mindMaps"}))
        .unwrap()
        .as_array()
        .unwrap()
        .is_empty());
    let saved=w.execute("saveAiResult",json!({"task":"mindmap","title":"脑图","text":"```json\n{\"topics\":[{\"title\":\"主题\",\"children\":[]}]}\n```"})).unwrap();
    assert_eq!(saved["value"]["root"]["children"][0]["text"], "主题");
    assert!(w
        .execute(
            "saveAiResult",
            json!({"task":"studyCard","title":"卡片","text":"{}"})
        )
        .is_err());
}
