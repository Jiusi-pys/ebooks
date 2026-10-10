use serde_json::{json,Value};
use shufang_native::workspace::Workspace;

#[test]
fn imported_review_preserves_swift_numeric_dates_and_rejects_overwrite() {
    let directory=tempfile::tempdir().unwrap();
    let workspace=Workspace::open(&directory.path().join("library.sqlite"),"review-import","android").unwrap();
    workspace.execute("save",json!({"kind":"books","id":"book","expected":0,"patch":{"title":"Book","author":"","format":"txt","chapters":[{"id":"c","title":"Chapter","paragraphs":["Text"]}]}})).unwrap();
    workspace.execute("save",json!({"kind":"highlights","id":"quote","expected":0,"patch":{"bookId":"book","chapterId":"c","paraIndex":0,"start":0,"end":4,"text":"Text"}})).unwrap();
    let event=json!({"highlightId":"quote","event":"review","createdAt":1760000000000.25,"deviceId":"ios","state":{"lastRating":3.0,"due":1760086400000.25,"lastReviewedAt":1760000000000.25,"reps":1.0,"lapses":0.0,"interval":1.0}});
    let imported=workspace.core.lock().unwrap().import_review_event("historical",event.clone()).unwrap();
    for key in ["createdAt","state","deviceId"]{assert_eq!(imported.value[key],event[key]);}
    let before=workspace.execute("changes",json!({"after":0})).unwrap();
    assert_eq!(workspace.core.lock().unwrap().import_review_event("historical",event.clone()).unwrap_err(),"review_identity_exists");
    for (index,mut invalid) in [event.clone(),event.clone(),event.clone()].into_iter().enumerate(){
        match index{0=>invalid["state"]["lastRating"]=2.5.into(),1=>invalid["highlightId"]="missing".into(),_=>invalid["state"]["reps"]=(-1).into()}
        assert!(workspace.core.lock().unwrap().import_review_event(&format!("invalid-{index}"),invalid).is_err());
    }
    assert_eq!(workspace.execute("changes",json!({"after":0})).unwrap(),before);
}

#[test]
fn ios_and_android_share_review_state_and_atomic_events() {
    let rows:Vec<Value>=serde_json::from_str(include_str!("../../../../ios/ShufangTests/Fixtures/review-v1.json")).unwrap();
    let directory=tempfile::tempdir().unwrap();
    let workspace=Workspace::open(&directory.path().join("library.sqlite"),"review-parity","android").unwrap();
    workspace.execute("save",json!({"kind":"books","id":"book","expected":0,"patch":{"title":"Book","author":"","format":"txt","coverTone":0,"chapters":[{"id":"chapter","title":"Chapter","paragraphs":["Text"]}],"progress":{"chapterId":"chapter","ratio":0}}})).unwrap();
    for (index,row) in rows.iter().enumerate() {
        let id=format!("quote-{index}");
        workspace.execute("save",json!({"kind":"highlights","id":id,"expected":0,"patch":{"bookId":"book","chapterId":"chapter","paraIndex":0,"start":0,"end":4,"text":"Text","review":{"due":0,"reps":row["reps"],"interval":row["interval"],"lapses":0,"addedAt":0}}})).unwrap();
        let result=workspace.execute("review",json!({"id":id,"expected":1,"rating":row["rating"]})).unwrap();
        let state=&result["value"]["review"];
        assert_eq!(state["reps"],row["expectedReps"]);
        assert_eq!(state["lapses"],row["expectedLapses"]);
        assert_eq!(state["interval"],row["expectedInterval"]);
        assert_eq!(state["due"].as_u64().unwrap()-state["lastReviewedAt"].as_u64().unwrap(),row["dueOffset"].as_u64().unwrap());
        let events=workspace.execute("list",json!({"kind":"reviews"})).unwrap();
        let matching:Vec<_>=events.as_array().unwrap().iter().filter(|event|event["value"]["highlightId"]==id).collect();
        assert_eq!(matching.len(),1);
        assert_eq!(matching[0]["value"]["state"],*state);
    }
}

#[test]
fn locally_graded_and_restored_review_events_are_accepted_by_a_real_peer_core() {
    let a=tempfile::tempdir().unwrap();let b=tempfile::tempdir().unwrap();
    let source=Workspace::open(&a.path().join("library.sqlite"),"reviews-network","android").unwrap();
    let target=Workspace::open(&b.path().join("library.sqlite"),"reviews-network","peer").unwrap();
    source.execute("save",json!({"kind":"books","id":"b","expected":0,"patch":{"title":"B","author":"","format":"txt","chapters":[{"id":"c","title":"C","paragraphs":["Text"]}]}})).unwrap();
    source.execute("save",json!({"kind":"highlights","id":"h","expected":0,"patch":{"bookId":"b","chapterId":"c","paraIndex":0,"start":0,"end":4,"text":"Text"}})).unwrap();
    source.execute("review",json!({"id":"h","expected":1,"rating":3})).unwrap();
    let rows=source.core.lock().unwrap().replication_operations(0,100).unwrap();
    let events:Vec<_>=rows.iter().filter(|r|r.operation.kind=="reviews").collect();assert_eq!(events.len(),1);
    assert_eq!(events[0].operation.operation_id,events[0].operation.entity_id,"v2 immutable review identity contract");
    let operations:Vec<_>=rows.into_iter().map(|row|row.operation).collect();target.core.lock().unwrap().receive_operations(&operations,None).unwrap();
    assert_eq!(target.core.lock().unwrap().entities("reviews").unwrap().len(),1);
}
