use serde_json::json;
use shufang_native::workspace::Workspace;

#[test]
fn unlink_preserves_enriched_quotes_and_deletes_citation_only_anchors() {
    let dir = tempfile::tempdir().unwrap();
    let w = Workspace::open(&dir.path().join("db"), "w", "r").unwrap();
    w.execute("save",json!({"kind":"books","id":"b","expected":0,"patch":{"title":"Book","author":"","format":"txt","coverTone":0,"chapters":[{"id":"c","title":"Chapter","paragraphs":["Text"]}],"progress":{"chapterId":"c","ratio":0}}})).unwrap();
    w.execute("save",json!({"kind":"notes","id":"n","expected":0,"patch":{"title":"Note","content":"Keep this text"}})).unwrap();
    w.execute("save",json!({"kind":"highlights","id":"h","expected":0,"patch":{"bookId":"b","chapterId":"c","paraIndex":0,"start":0,"end":4,"text":"Text","note":"Keep annotation","style":{"kind":"background","color":"blue"}}})).unwrap();
    w.execute(
        "cite",
        json!({"highlight":"h","note":"n","highlightRevision":1,"noteRevision":1}),
    )
    .unwrap();
    assert!(w
        .execute(
            "uncite",
            json!({"highlight":"h","highlightRevision":2,"noteRevision":1})
        )
        .is_err());
    w.execute(
        "uncite",
        json!({"highlight":"h","highlightRevision":2,"noteRevision":2}),
    )
    .unwrap();
    let h = w
        .execute("get", json!({"kind":"highlights","id":"h"}))
        .unwrap();
    assert!(h["value"].get("noteId").is_none());
    assert!(h["value"].get("citation").is_none());
    assert_eq!(h["value"]["note"], "Keep annotation");
    assert_eq!(
        w.execute("get", json!({"kind":"notes","id":"n"})).unwrap()["value"]["content"],
        "Keep this text"
    );
    w.execute("save",json!({"kind":"highlights","id":"enriched-book","expected":0,"patch":{"bookId":"b","chapterId":"","chapterTitle":"","text":"Book","note":"Keep book annotation","citation":{"level":"book"},"style":{"kind":"none","color":"yellow"}}})).unwrap();
    w.execute(
        "cite",
        json!({"highlight":"enriched-book","note":"n","highlightRevision":1,"noteRevision":3}),
    )
    .unwrap();
    w.execute(
        "uncite",
        json!({"highlight":"enriched-book","highlightRevision":2,"noteRevision":4}),
    )
    .unwrap();
    let retained = w
        .execute("get", json!({"kind":"highlights","id":"enriched-book"}))
        .unwrap();
    assert_eq!(retained["value"]["note"], "Keep book annotation");
    assert!(retained["value"].get("citation").is_none());
    w.execute("save",json!({"kind":"highlights","id":"enriched-book","expected":3,"patch":{"note":"Still editable after unlink"}})).unwrap();
    w.execute("save",json!({"kind":"highlights","id":"only","expected":0,"patch":{"bookId":"b","chapterId":"","chapterTitle":"","text":"Book","citation":{"level":"book"},"style":{"kind":"none","color":"yellow"}}})).unwrap();
    w.execute(
        "cite",
        json!({"highlight":"only","note":"n","highlightRevision":1,"noteRevision":5}),
    )
    .unwrap();
    w.execute(
        "uncite",
        json!({"highlight":"only","highlightRevision":2,"noteRevision":6}),
    )
    .unwrap();
    assert!(w
        .execute("get", json!({"kind":"highlights","id":"only"}))
        .is_err());
    assert_eq!(
        w.execute("get", json!({"kind":"notes","id":"n"})).unwrap()["value"]["content"],
        "Keep this text"
    );
}

#[test]
fn canonical_web_book_and_chapter_citations_validate_and_generate_matching_notes() {
    let directory = tempfile::tempdir().unwrap();
    let workspace = Workspace::open(
        &directory.path().join("library.sqlite"),
        "citation-test",
        "phone",
    )
    .unwrap();
    workspace.execute("save",json!({"kind":"books","id":"book","expected":0,"patch":{"title":"书名","author":"作者","format":"txt","coverTone":0,"chapters":[{"id":"chapter","title":"章节","paragraphs":["正文"]}],"progress":{"chapterId":"chapter","ratio":0}}})).unwrap();
    for level in ["book", "chapter"] {
        let mut patch = json!({"bookId":"book","chapterId":"","chapterTitle":"","text":"书名","citation":{"level":level}});
        if level == "chapter" {
            patch["chapterId"] = "chapter".into();
            patch["chapterTitle"] = "章节".into();
            patch["citation"]["chapterId"] = "chapter".into();
        }
        workspace.execute("save",json!({"kind":"notes","id":format!("note-{level}"),"expected":0,"patch":{"title":"引用笔记","content":"用户正文"}})).unwrap();
        workspace.execute("save",json!({"kind":"highlights","id":format!("quote-{level}"),"expected":0,"patch":patch})).unwrap();
        workspace.execute("cite",json!({"highlight":format!("quote-{level}"),"note":format!("note-{level}"),"highlightRevision":1,"noteRevision":1})).unwrap();
        let note = workspace
            .execute("get", json!({"kind":"notes","id":format!("note-{level}")}))
            .unwrap();
        assert!(note["value"]["content"]
            .as_str()
            .unwrap()
            .contains(if level == "book" {
                "> 书籍引用：[[书名]]"
            } else {
                "> 章节引用：[[书名]] → 章节"
            }));
    }
}

#[test]
fn web_original_pdf_without_extracted_chapters_accepts_geometric_page_anchors() {
    let directory = tempfile::tempdir().unwrap();
    let workspace = Workspace::open(
        &directory.path().join("library.sqlite"),
        "pdf-test",
        "phone",
    )
    .unwrap();
    workspace.execute("save",json!({"kind":"books","id":"pdf","expected":0,"patch":{"title":"扫描 PDF","author":"","format":"pdf","coverTone":0,"chapters":[],"pageCount":100,"readerMode":"original","progress":{"chapterId":"","ratio":0}}})).unwrap();
    let patch = json!({"bookId":"pdf","chapterId":"","chapterTitle":"第 99 页","text":"原版选文","pdfAnchor":{"page":99,"rects":[{"x":0.1,"y":0.2,"width":0.3,"height":0.05}]}});
    workspace
        .execute(
            "save",
            json!({"kind":"highlights","id":"pdf-quote","expected":0,"patch":patch}),
        )
        .unwrap();
    let mut invalid = patch.clone();
    invalid["pdfAnchor"]["page"] = 101.into();
    assert!(workspace
        .execute(
            "save",
            json!({"kind":"highlights","id":"bad-page","expected":0,"patch":invalid})
        )
        .is_err());
    let mut invalid = patch;
    invalid["pdfAnchor"]["rects"][0]["width"] = 1.into();
    assert!(workspace
        .execute(
            "save",
            json!({"kind":"highlights","id":"bad-rectangle","expected":0,"patch":invalid})
        )
        .is_err());
}

#[test]
fn ios_multi_paragraph_card_keeps_one_identity_and_validates_all_utf16_ranges() {
    let directory = tempfile::tempdir().unwrap();
    let workspace = Workspace::open(
        &directory.path().join("library.sqlite"),
        "cross-range",
        "phone",
    )
    .unwrap();
    workspace.execute("save",json!({"kind":"books","id":"b","expected":0,"patch":{"title":"跨段","author":"","format":"txt","coverTone":0,"chapters":[{"id":"c","title":"章","paragraphs":["中文🚀甲","下一段乙"]}],"progress":{"chapterId":"c","ratio":0}}})).unwrap();
    let ranges = json!([{"kind":"text","bookId":"b","chapterId":"c","paraIndex":0,"start":2,"end":5,"text":"🚀甲"},{"kind":"text","bookId":"b","chapterId":"c","paraIndex":1,"start":0,"end":3,"text":"下一段"}]);
    let patch = json!({"bookId":"b","chapterId":"c","paraIndex":0,"start":2,"end":5,"text":"🚀甲\n下一段","sourceRanges":ranges});
    workspace
        .execute(
            "save",
            json!({"kind":"highlights","id":"card","expected":0,"patch":patch}),
        )
        .unwrap();
    let mut bad = patch;
    bad["sourceRanges"][1]["end"] = 999.into();
    assert!(workspace
        .execute(
            "save",
            json!({"kind":"highlights","id":"bad","expected":0,"patch":bad})
        )
        .is_err());
    assert_eq!(
        workspace
            .execute("get", json!({"kind":"highlights","id":"card"}))
            .unwrap()["value"]["sourceRanges"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
}

#[test]
fn review_state_and_ios_history_event_commit_together() {
    let directory = tempfile::tempdir().unwrap();
    let w = Workspace::open(
        &directory.path().join("library.sqlite"),
        "review-events",
        "phone",
    )
    .unwrap();
    w.execute("save",json!({"kind":"books","id":"b","expected":0,"patch":{"title":"书","author":"","format":"txt","coverTone":0,"chapters":[{"id":"c","title":"章","paragraphs":["正文"]}],"progress":{"chapterId":"c","ratio":0}}})).unwrap();
    w.execute("save",json!({"kind":"highlights","id":"h","expected":0,"patch":{"bookId":"b","chapterId":"c","paraIndex":0,"start":0,"end":2,"text":"正文"}})).unwrap();
    w.execute("setReview", json!({"id":"h","enabled":true,"expected":1}))
        .unwrap();
    let graded = w
        .execute("review", json!({"id":"h","rating":3,"expected":2}))
        .unwrap();
    let events = w.execute("listPage", json!({"kind":"reviews"})).unwrap();
    assert_eq!(events["total"], 1);
    assert_eq!(
        events["items"][0]["value"]["state"],
        graded["value"]["review"]
    );
    assert!(w
        .execute("review", json!({"id":"h","rating":4,"expected":2}))
        .is_err());
    assert_eq!(
        w.execute("listPage", json!({"kind":"reviews"})).unwrap()["total"],
        1
    );
}
