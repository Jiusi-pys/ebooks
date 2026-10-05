use serde_json::{json, Value};
use shufang_native::workspace::Workspace;
use shufang_service::{mcp, Host};

fn result(host: &Host, name: &str, arguments: Value) -> Value {
    mcp::dispatch(host, json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":name,"arguments":arguments}})).unwrap()
}

#[test]
fn native_mcp_uses_the_shared_snake_case_tool_contract() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = Workspace::open(&dir.path().join("db"), "w", "r").unwrap();
    workspace.execute("save", json!({"kind":"notes","id":"note-one","expected":0,"patch":{"title":"Title","content":"Body"}})).unwrap();
    let host = Host::new(workspace, "token".into(), "http://127.0.0.1:31417".into());
    let initialized =
        mcp::dispatch(&host, json!({"jsonrpc":"2.0","id":1,"method":"initialize"})).unwrap();
    assert_eq!(initialized["result"]["serverInfo"]["version"], "1.0.0");
    let listed =
        mcp::dispatch(&host, json!({"jsonrpc":"2.0","id":1,"method":"tools/list"})).unwrap();
    let tools = listed["result"]["tools"].as_array().unwrap();
    let get_note = tools
        .iter()
        .find(|tool| tool["name"] == "get_note")
        .unwrap();
    assert_eq!(get_note["inputSchema"]["required"], json!(["note_id"]));
    assert_eq!(get_note["description"], "按 ID 读取一条已同步笔记。");
    assert!(get_note["inputSchema"]["properties"]
        .get("note_id")
        .is_some());
    assert!(get_note["inputSchema"]["properties"]
        .get("noteId")
        .is_none());
    let note = result(&host, "get_note", json!({"note_id":"note-one"}));
    let body: Value =
        serde_json::from_str(note["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(body["extId"], "note-one");
    assert_eq!(body["title"], "Title");
    assert_eq!(body["content"], "Body");
    assert!(result(&host, "get_note", json!({}))["error"].is_object());
}

#[test]
fn native_mcp_discovers_modern_revision_without_a_session() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = Workspace::open(&dir.path().join("db"), "w", "r").unwrap();
    let host = Host::new(workspace, "token".into(), "http://127.0.0.1:31417".into());
    let envelope = json!({"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientInfo":{"name":"test","version":"1.0"},"io.modelcontextprotocol/clientCapabilities":{}});
    let discovered = mcp::dispatch(
        &host,
        json!({"jsonrpc":"2.0","id":1,"method":"server/discover","params":{"_meta":envelope}}),
    )
    .unwrap();
    assert_eq!(
        discovered["result"]["supportedVersions"],
        json!(["2026-07-28"])
    );
    assert_eq!(discovered["result"]["resultType"], "complete");
    assert_eq!(
        discovered["result"]["_meta"]["io.modelcontextprotocol/serverInfo"],
        json!({"name":"shufang-library","version":"1.0.0"})
    );
    let tools = mcp::dispatch(
        &host,
        json!({"jsonrpc":"2.0","id":2,"method":"tools/list","params":{"_meta":envelope}}),
    )
    .unwrap();
    assert_eq!(tools["result"]["resultType"], "complete");
    assert_eq!(tools["result"]["tools"].as_array().unwrap().len(), 6);
}
#[test]
fn production_mcp_refuses_incomplete_blob_values() {
    use shufang_service::V1Contract;
    let dir = tempfile::tempdir().unwrap();
    let w = Workspace::open(&dir.path().join("db"), "w", "n").unwrap();
    let op = json!({"workspaceId":"w","operationId":"op","replicaId":"peer","kind":"notes","entityId":"note","clock":"1:0","patch":{"title":"Title","content":{"$blob":{"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","size":100}}},"unset":[],"deleted":false});
    w.core
        .lock()
        .unwrap()
        .receive_operations(&[serde_json::from_value(op).unwrap()], None)
        .unwrap();
    let h = Host::with_contract(
        w,
        "token".into(),
        "http://localhost".into(),
        true,
        V1Contract::SyncEntities,
    );
    let response = result(&h, "search_notes", json!({"query":"Title"}));
    assert!(response["error"].is_object(), "{response}");
}
