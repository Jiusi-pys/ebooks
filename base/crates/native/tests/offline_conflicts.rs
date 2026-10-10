use serde_json::json;
use shufang_native::workspace::Workspace;

#[test]
fn offline_edits_capture_base_atomically_and_emit_only_changed_fields() {
    let dir = tempfile::tempdir().unwrap();
    let w = Workspace::open(&dir.path().join("library.sqlite"), "test", "local").unwrap();
    let mut core = w.core.lock().unwrap();
    core.enable_sync_conflicts().unwrap();
    core.save_entity(
        "notes",
        "n",
        json!({"title":"A","content":"base😀"}),
        vec![],
        0,
    )
    .unwrap();
    let first = core.sync_edit("notes", "n").unwrap().unwrap();
    assert_eq!(first["base"], serde_json::Value::Null);
    let row = core.entity("notes", "n").unwrap();
    core.save_entity(
        "notes",
        "n",
        json!({"content":"local"}),
        vec![],
        row.revision,
    )
    .unwrap();
    let ops = core.replication_operations(0, 100).unwrap();
    assert!(!ops[1].operation.patch.contains_key("title"));
    assert_eq!(
        core.sync_edit("notes", "n").unwrap().unwrap()["operations"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
}

#[test]
fn conditional_push_checks_state_but_recognizes_a_lost_reply() {
    let dir = tempfile::tempdir().unwrap();
    let w = Workspace::open(&dir.path().join("library.sqlite"), "test", "local").unwrap();
    let mut core = w.core.lock().unwrap();
    core.save_entity(
        "notes",
        "n",
        json!({"title":"A","content":"base"}),
        vec![],
        0,
    )
    .unwrap();
    let row = core.replication_operations(0, 100).unwrap().remove(0);
    // Already accepted operations remain idempotent, even after another writer.
    assert!(core.check_sync_precondition(&row.operation, None).unwrap());
    let old = core.replication_entity_state("notes", "n").unwrap();
    let entity = core.entity("notes", "n").unwrap();
    core.save_entity(
        "notes",
        "n",
        json!({"content":"later"}),
        vec![],
        entity.revision,
    )
    .unwrap();
    let mut incoming = row.operation;
    incoming.operation_id = "incoming".into();
    incoming.replica_id = "other".into();
    assert_eq!(
        core.check_sync_precondition(&incoming, old.as_ref())
            .unwrap_err(),
        "sync_precondition_failed"
    );
}

#[test]
fn different_fields_merge_but_same_field_persists_and_remote_choice_withdraws_history() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("library.sqlite");
    let w = Workspace::open(&db, "test", "local").unwrap();
    let mut core = w.core.lock().unwrap();
    core.enable_sync_conflicts().unwrap();
    core.save_entity(
        "notes",
        "n",
        json!({"title":"A","content":"base"}),
        vec![],
        0,
    )
    .unwrap();
    let initial = core.replication_operations(0, 100).unwrap().remove(0);
    core.acknowledge_guarded_sync(
        "sync:send:test",
        0,
        &initial,
        &json!([{"operationId":initial.operation.operation_id,"persisted":true,"seq":"1"}]),
    )
    .unwrap();
    let old = core
        .replication_entity_state("notes", "n")
        .unwrap()
        .unwrap();
    let row = core.entity("notes", "n").unwrap();
    core.save_entity(
        "notes",
        "n",
        json!({"content":"my offline draft 😀"}),
        vec![],
        row.revision,
    )
    .unwrap();
    let local = core
        .replication_operations(initial.sequence, 100)
        .unwrap()
        .remove(0);
    let mut remote = initial.operation.clone();
    remote.replica_id = "other".into();
    remote.operation_id = "remote-title".into();
    remote.clock = shufang_domain::sync::next_clock(&local.operation.clock, 0).unwrap();
    remote.patch = json!({"title":"Remote title"}).as_object().unwrap().clone();
    let different = shufang_domain::sync::apply_operation(Some(&old), &remote).unwrap();
    assert!(core
        .inspect_sync_conflict("peer", &local.operation, Some(&different))
        .unwrap()
        .is_none());
    remote.patch = json!({"content":"other offline draft"})
        .as_object()
        .unwrap()
        .clone();
    let conflicting = shufang_domain::sync::apply_operation(Some(&old), &remote).unwrap();
    let preview = core
        .inspect_sync_conflict("peer", &local.operation, Some(&conflicting))
        .unwrap()
        .unwrap();
    drop(core);
    drop(w);
    let w = Workspace::open(&db, "test", "local").unwrap();
    let mut core = w.core.lock().unwrap();
    assert_eq!(core.sync_conflicts().unwrap().len(), 1);
    core.resolve_sync_conflict(
        preview["id"].as_str().unwrap(),
        preview["fingerprint"].as_str().unwrap(),
        "remote",
    )
    .unwrap();
    assert!(core.sync_conflicts().unwrap().is_empty());
    assert_eq!(
        core.entity("notes", "n").unwrap().value["content"],
        "other offline draft"
    );
    assert!(core
        .operation_withdrawn(&local.operation.operation_id)
        .unwrap());
    assert_eq!(
        core.replication_operation(&local.operation.operation_id)
            .unwrap()
            .unwrap(),
        local.operation
    );
    let resolution = core
        .replication_operations(local.sequence, 100)
        .unwrap()
        .remove(0);
    assert!(core
        .inspect_sync_conflict("peer", &resolution.operation, Some(&conflicting))
        .unwrap()
        .is_none());
}

#[test]
fn stale_preview_rejects_decision_and_copy_preserves_both_versions() {
    let dir = tempfile::tempdir().unwrap();
    let w = Workspace::open(&dir.path().join("library.sqlite"), "test", "local").unwrap();
    let mut core = w.core.lock().unwrap();
    core.enable_sync_conflicts().unwrap();
    core.save_entity(
        "notes",
        "n",
        json!({"title":"A","content":"local"}),
        vec![],
        0,
    )
    .unwrap();
    let op = core
        .replication_operations(0, 100)
        .unwrap()
        .remove(0)
        .operation;
    let mut other = op.clone();
    other.operation_id = "other".into();
    other.replica_id = "other".into();
    other.patch.insert("content".into(), json!("remote"));
    let remote = shufang_domain::sync::apply_operation(None, &other).unwrap();
    let preview = core
        .inspect_sync_conflict("peer", &op, Some(&remote))
        .unwrap()
        .unwrap();
    let current = core.entity("notes", "n").unwrap();
    core.save_entity(
        "notes",
        "n",
        json!({"content":"late local"}),
        vec![],
        current.revision,
    )
    .unwrap();
    assert_eq!(
        core.resolve_sync_conflict(
            preview["id"].as_str().unwrap(),
            preview["fingerprint"].as_str().unwrap(),
            "copy"
        )
        .unwrap_err(),
        "sync_conflict_preview_changed"
    );
    let fresh = core
        .inspect_sync_conflict("peer", &op, Some(&remote))
        .unwrap()
        .unwrap();
    let result = core
        .resolve_sync_conflict(
            fresh["id"].as_str().unwrap(),
            fresh["fingerprint"].as_str().unwrap(),
            "copy",
        )
        .unwrap();
    assert_eq!(
        core.entity("notes", "n").unwrap().value["content"],
        "remote"
    );
    assert_eq!(
        core.entity("notes", result["copyId"].as_str().unwrap())
            .unwrap()
            .value["content"],
        "late local"
    );
}

#[test]
fn deleted_remote_book_keeps_local_learning_dependency_graph_as_new_identities() {
    let dir = tempfile::tempdir().unwrap();
    let w = Workspace::open(&dir.path().join("library.sqlite"), "test", "local").unwrap();
    let mut c = w.core.lock().unwrap();
    c.save_entity("books","book",json!({"title":"Book","author":"A","format":"txt","chapters":[{"id":"chapter","title":"One","paragraphs":["original"]}],"progress":{"chapterId":"chapter","ratio":0}}),vec![],0).unwrap();
    let source=shufang_application::BlobManifest{sha256:"a".repeat(64),size:8,name:"book.txt".into(),content_type:"text/plain".into()};
    c.attach_book_source("book",&source).unwrap();
    c.save_entity(
        "notes",
        "note",
        json!({"title":"Linked note","content":"Local analysis"}),
        vec![],
        0,
    )
    .unwrap();
    c.save_entity("highlights","card",json!({"bookId":"book","chapterId":"chapter","chapterTitle":"One","text":"original","noteId":"note"}),vec![],0).unwrap();
    c.save_entity(
        "studySets",
        "set",
        json!({"name":"Study","bookIds":["book"]}),
        vec![],
        0,
    )
    .unwrap();
    c.enable_sync_conflicts().unwrap();
    let r = c.entity("books", "book").unwrap();
    c.save_entity(
        "books",
        "book",
        json!({"title":"Offline title"}),
        vec![],
        r.revision,
    )
    .unwrap();
    let op = c
        .replication_operations(0, 100)
        .unwrap()
        .into_iter()
        .rfind(|r| r.operation.kind == "books")
        .unwrap()
        .operation;
    let base: shufang_domain::sync::EntityState =
        serde_json::from_value(c.sync_edit("books", "book").unwrap().unwrap()["base"].clone())
            .unwrap();
    let mut remote = base;
    remote.deleted = true;
    let preview = c
        .inspect_sync_conflict("peer", &op, Some(&remote))
        .unwrap()
        .unwrap();
    let result = c
        .resolve_sync_conflict(
            preview["id"].as_str().unwrap(),
            preview["fingerprint"].as_str().unwrap(),
            "local",
        )
        .unwrap();
    let book = result["copyId"].as_str().unwrap();
    assert_ne!(book, "book");
    assert_eq!(c.book_source(book).unwrap(),source);
    assert_eq!(
        c.entity("books", book).unwrap().value["title"],
        "Offline title"
    );
    let card = c
        .entities("highlights")
        .unwrap()
        .into_iter()
        .find(|r| r.value["bookId"] == book)
        .unwrap();
    let note = c
        .entity("notes", card.value["noteId"].as_str().unwrap())
        .unwrap();
    assert_ne!(note.value["id"], "note");
    assert!(note.value["content"]
        .as_str()
        .unwrap()
        .contains("Local analysis"));
    assert!(c
        .entities("studySets")
        .unwrap()
        .iter()
        .any(|r| r.value["bookIds"][0] == book));
    assert!(c.entity("books", "book").is_err());
}
