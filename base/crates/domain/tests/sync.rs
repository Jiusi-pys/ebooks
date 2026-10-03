use serde_json::json;
use shufang_domain::sync::{
    apply_operation, compare_clock, materialize, merge_states, next_clock, Operation,
};

fn operation(id: &str, replica: &str, clock: &str, patch: serde_json::Value) -> Operation {
    serde_json::from_value(json!({
        "workspaceId":"w", "operationId":id, "replicaId":replica,
        "kind":"notes", "entityId":"n", "clock":clock, "patch":patch,
        "unset":[], "deleted":false
    }))
    .unwrap()
}

#[test]
fn preserves_unacknowledged_fields_and_converges() {
    let a = operation("a", "a", "5:0", json!({"title":"unsent"}));
    let b = operation("b", "b", "2:0", json!({"title":"old", "content":"remote"}));
    let left = apply_operation(None, &a).unwrap();
    let right = apply_operation(None, &b).unwrap();
    assert_eq!(
        materialize(&merge_states(Some(&left), &right).unwrap()).unwrap(),
        Some(json!({"id":"n","title":"unsent","content":"remote"}))
    );
    assert_eq!(
        apply_operation(Some(&left), &b).unwrap(),
        apply_operation(Some(&right), &a).unwrap()
    );
}

#[test]
fn never_resurrects_a_tombstone() {
    let mut deleted = operation("delete", "a", "10:0", json!({}));
    deleted.deleted = true;
    let state = apply_operation(None, &deleted).unwrap();
    let late = operation("late", "b", "999:0", json!({"title":"late"}));
    assert_eq!(
        materialize(&apply_operation(Some(&state), &late).unwrap()).unwrap(),
        None
    );
}

#[test]
fn exact_clocks_and_monotonicity() {
    assert_eq!(
        next_clock("9007199254740993:1", 1).unwrap(),
        "9007199254740993:2"
    );
    assert_eq!(
        compare_clock("9007199254740993:0", "9007199254740992:9").unwrap(),
        std::cmp::Ordering::Greater
    );
    assert!(next_clock("bad", 0).is_err());
    assert!(next_clock("1:9999999999", 0).is_err());
}

#[test]
fn validates_untrusted_operations_and_entity_identity() {
    let mut op = operation("a", "a", "1:0", json!({"__proto__":"invalid"}));
    assert!(apply_operation(None, &op).is_err());
    op.patch = serde_json::from_value(json!({"title":"valid"})).unwrap();
    let state = apply_operation(None, &op).unwrap();
    op.entity_id = "other".into();
    assert!(apply_operation(Some(&state), &op).is_err());
}

#[test]
fn explicit_null_survives_a_json_round_trip() {
    let op = operation("a", "a", "1:0", json!({"metadata":null}));
    let state = apply_operation(None, &op).unwrap();
    let encoded = serde_json::to_string(&state).unwrap();
    let decoded = serde_json::from_str(&encoded).unwrap();
    assert_eq!(
        materialize(&decoded).unwrap(),
        Some(json!({"id":"n","metadata":null}))
    );
}

#[test]
fn deep_mind_maps_fail_explicitly_instead_of_silently_truncating() {
    let mut op = operation("a", "a", "1:0", json!({}));
    op.kind = "mindMaps".into();
    for index in 0..140 {
        op.patch
            .insert(format!("@node:n{index}:text"), json!("text"));
        op.patch.insert(
            format!("@node:n{index}:parent"),
            if index == 0 {
                serde_json::Value::Null
            } else {
                json!(format!("n{}", index - 1))
            },
        );
        op.patch.insert(format!("@node:n{index}:order"), json!(0));
    }
    let state = apply_operation(None, &op).unwrap();
    assert_eq!(materialize(&state).unwrap_err(), "mind_map_depth_exceeded");
}
