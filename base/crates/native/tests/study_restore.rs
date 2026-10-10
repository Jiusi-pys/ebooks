use serde_json::json;
use shufang_native::workspace::Workspace;

#[test]
fn restore_validates_staged_references_and_commits_all_or_nothing() {
    let dir=tempfile::tempdir().unwrap();
    let ws=Workspace::open(&dir.path().join("library.sqlite"),"test","test").unwrap();
    let mut core=ws.core.lock().unwrap();
    let clock=core.study_clock().unwrap();
    let records=vec![("books".into(),"b".into(),json!({"title":"B","author":"","format":"txt","chapters":[{"id":"c","title":"C","paragraphs":["中文😀"]}]})),("highlights".into(),"h".into(),json!({"bookId":"b","chapterId":"c","paraIndex":0,"start":2,"end":4,"text":"😀"}))];
    let mut bad=records.clone();bad[1].2["end"]=json!(99);
    assert!(core.restore_study_records(&clock,bad).is_err());
    assert!(core.entities("books").unwrap().is_empty());
    core.restore_study_records(&clock,records).unwrap();
    assert_eq!(core.entity("highlights","h").unwrap().value["bookId"],"b");
    assert_eq!(core.restore_study_records(&clock,vec![]).unwrap_err(),"restore_preview_changed");
}

#[test]
fn materialized_optional_null_ranges_survive_backup_validation() {
    let dir=tempfile::tempdir().unwrap();let ws=Workspace::open(&dir.path().join("library.sqlite"),"test","test").unwrap();
    let mut core=ws.core.lock().unwrap();let clock=core.study_clock().unwrap();
    core.restore_study_records(&clock,vec![("books".into(),"b".into(),json!({"title":"B","author":"","format":"txt","chapters":[{"id":"c","title":"C","paragraphs":["text"]}]})),("highlights".into(),"h".into(),json!({"bookId":"b","chapterId":"c","paraIndex":0,"start":0,"end":4,"text":"text","sourceRanges":null}))]).unwrap();
    assert_eq!(core.entity("highlights","h").unwrap().value["text"],"text");
}

#[test]
fn study_zip_restore_preview_rejects_stale_and_retries_without_duplicates() {
    let source=tempfile::tempdir().unwrap();let target=tempfile::tempdir().unwrap();
    let a=Workspace::open(&source.path().join("library.sqlite"),"test","a").unwrap();
    let b=Workspace::open(&target.path().join("library.sqlite"),"test","b").unwrap();
    a.execute("save",json!({"kind":"notes","id":"n","expected":0,"patch":{"title":"N","content":"中文😀"}})).unwrap();
    let archive=source.path().join("study.zip");
    a.execute("exportStudyBackup",json!({"path":archive,"origin":"offline","userID":"local"})).unwrap();
    let args=json!({"path":archive,"origin":"offline","userID":"local","policy":"keepLocal"});
    let preview=b.execute("previewStudyRestore",args.clone()).unwrap();
    b.execute("save",json!({"kind":"notes","id":"changed","expected":0,"patch":{"title":"Changed","content":""}})).unwrap();
    assert_eq!(b.execute("commitStudyRestore",preview).unwrap_err(),"restore_preview_changed");
    assert_eq!(b.execute("list",json!({"kind":"notes"})).unwrap().as_array().unwrap().len(),1);
    let preview=b.execute("previewStudyRestore",args).unwrap();
    b.execute("commitStudyRestore",preview.clone()).unwrap();
    assert_eq!(b.execute("commitStudyRestore",preview).unwrap()["duplicate"],true);
    assert_eq!(b.execute("get",json!({"kind":"notes","id":"n"})).unwrap()["value"]["content"],"中文😀");
}

#[test]
fn keep_both_rebinds_note_links_without_rewriting_extension_metadata() {
    let dir=tempfile::tempdir().unwrap();let ws=Workspace::open(&dir.path().join("library.sqlite"),"test","a").unwrap();
    ws.execute("save",json!({"kind":"notes","id":"n","expected":0,"patch":{"title":"Title","content":"[[n|label]]","metadata":{"noteId":"n"}}})).unwrap();
    let path=dir.path().join("notes.zip");ws.execute("exportStudyBackup",json!({"path":path,"origin":"offline","userID":"local"})).unwrap();
    let preview=ws.execute("previewStudyRestore",json!({"path":path,"origin":"offline","userID":"local","policy":"keepBoth"})).unwrap();
    ws.execute("commitStudyRestore",preview).unwrap();let notes=ws.execute("list",json!({"kind":"notes"})).unwrap();let copied=notes.as_array().unwrap().iter().find(|r|r["value"]["id"]!="n").unwrap();let id=copied["value"]["id"].as_str().unwrap();
    assert_eq!(copied["value"]["content"],format!("[[{id}|label]]"));assert_eq!(copied["value"]["metadata"]["noteId"],"n");
}

#[test]
fn untrusted_zip_cannot_escape_staging_or_restore_without_a_complete_manifest() {
    use std::io::Write;
    let dir=tempfile::tempdir().unwrap();let ws=Workspace::open(&dir.path().join("library.sqlite"),"test","a").unwrap();
    for (index,name) in ["../escape","attachments/../escape","study.json"].iter().enumerate(){let path=dir.path().join(format!("bad-{index}.zip"));let mut zip=zip::ZipWriter::new(std::fs::File::create(&path).unwrap());zip.start_file(*name,zip::write::SimpleFileOptions::default()).unwrap();zip.write_all(b"[]").unwrap();zip.finish().unwrap();
        assert!(ws.execute("previewStudyRestore",json!({"path":path,"origin":"offline","userID":"local","policy":"replace"})).is_err());}
    assert!(!dir.path().join("escape").exists());assert!(ws.execute("list",json!({"kind":"notes"})).unwrap().as_array().unwrap().is_empty());
}
