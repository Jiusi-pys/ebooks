use serde_json::json;
use shufang_native::workspace::Workspace;
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
