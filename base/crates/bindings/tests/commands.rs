use serde_json::json;
use shufang_bindings::execute;

#[test]
fn versioned_dispatch_rejects_unknown_commands_and_malformed_payloads() {
    assert_eq!(
        execute(r#"{"version":2,"command":"nextClock","previous":"0:0","now":1}"#)["ok"],
        false
    );
    assert_eq!(execute("not json")["ok"], false);
    assert_eq!(execute(r#"{"version":1,"command":"unknown"}"#)["ok"], false);
    let input = json!({"version":1,"command":"nextClock","previous":"9007199254740993:1","now":1});
    assert_eq!(
        execute(&input.to_string()),
        json!({"ok":true,"value":"9007199254740993:2"})
    );
}

#[test]
fn buffer_lifecycle_rejects_stale_handles_and_double_free() {
    use shufang_bindings::{core_alloc, core_buffer_len, core_execute, core_free};
    assert_eq!(core_alloc(0), 0);
    assert_eq!(core_alloc(17 * 1024 * 1024), 0);
    let input = core_alloc(8);
    assert_eq!(core_buffer_len(input), 8);
    core_free(input);
    core_free(input);
    assert_eq!(core_buffer_len(input), 0);
    let output = core_execute(0);
    assert!(core_buffer_len(output) > 0);
    core_free(output);
}
