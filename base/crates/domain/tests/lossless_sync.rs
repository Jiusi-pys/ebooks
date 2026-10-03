use shufang_domain::lossless_sync::{ReplicaOperation, ReplicaState};

#[test]
fn snapshot_states_reject_invalid_identity_versions_and_payloads() {
    let valid = r#"{"id":"n","kind":"notes","deleted":false,"fields":{"title":{"version":"0000000000000005:0000000000:a:one","value":"\ud800"}}}"#;
    assert!(ReplicaState::parse(valid).is_ok());
    for invalid in [
        valid.replace("\"n\"", "\"bad/id\""),
        valid.replace("\"notes\"", "\"unknown\""),
        valid.replace("\"title\"", "\"__proto__\""),
        valid.replace(
            "0000000000000005:0000000000:a:one",
            "9999999999999999:bad:a:one",
        ),
        valid.replace("0000000000000005:0000000000:a:one", "5:0:a:one"),
        valid.replace(
            "0000000000000005:0000000000:a:one",
            "0000000000000005:0000000000::",
        ),
        valid.replace(r#""value":"\ud800""#, r#""value":1e400"#),
    ] {
        if invalid == valid {
            continue;
        }
        assert!(ReplicaState::parse(&invalid).is_err(), "{invalid}");
    }
    let missing = valid.replace(",\"value\":\"\\ud800\"", "");
    assert!(ReplicaState::parse(&missing).is_err());
    let removed = missing.replace("a:one\"", "a:one\",\"removed\":true");
    assert!(ReplicaState::parse(&removed).is_ok());
}

#[test]
fn operation_and_state_preserve_surrogate_keys_text_and_immutable_versions() {
    let op=ReplicaOperation::parse(r#"{"workspaceId":"w","replicaId":"a","operationId":"one","kind":"notes","entityId":"n","clock":"5:0","patch":{"title":"\ud800","\udfff":{"deep":["\ud800",0.0]}}}"#).unwrap();
    let state = ReplicaState::apply(None, &op).unwrap();
    let text = state.stringify();
    assert!(text.contains(r#""value":"\ud800""#));
    assert!(text.contains(r#""\udfff":{"version""#));
    assert_eq!(ReplicaState::parse(&text).unwrap(), state);
    let earlier=ReplicaOperation::parse(r#"{"workspaceId":"w","replicaId":"b","operationId":"two","kind":"notes","entityId":"n","clock":"4:0","patch":{"title":"old"},"unset":["\udfff"]}"#).unwrap();
    assert_eq!(ReplicaState::apply(Some(&state), &earlier).unwrap(), state);
    let mut deletion = earlier;
    deletion.deleted = true;
    assert!(
        ReplicaState::apply(Some(&state), &deletion)
            .unwrap()
            .deleted
    );
}

#[test]
fn unsets_and_progress_truthiness_match_the_shared_field_rule() {
    for progress in ["null", "false", "0", "\"\"", "[]", "{}", "\"\\ud800\""] {
        let op=ReplicaOperation::parse(&format!(r#"{{"workspaceId":"w","replicaId":"a","operationId":"one","kind":"books","entityId":"b","clock":"5:0","patch":{{"progress":{progress}}}}}"#)).unwrap();
        let state = ReplicaState::apply(None, &op).unwrap();
        let expected = matches!(progress, "[]" | "{}" | "\"\\ud800\"");
        assert_eq!(
            state
                .fields
                .contains_key(&"@progress:a".encode_utf16().collect::<Vec<_>>()),
            expected
        );
    }
    for invalid in [
        r#"{"workspaceId":"w"}"#,
        r#"{"workspaceId":"w","replicaId":"a","operationId":"one","kind":"notes","entityId":"n","clock":"5:0","patch":{"id":"forbidden"}}"#,
    ] {
        assert!(ReplicaOperation::parse(invalid).is_err());
    }
}

#[test]
fn overwritten_nonfinite_values_are_discarded_but_live_nonfinite_payloads_rejected() {
    let prefix = r#"{"workspaceId":"w","replicaId":"a","operationId":"one","kind":"notes","entityId":"n","clock":"5:0","patch":PN}"#;
    assert!(ReplicaOperation::parse(&prefix.replace("PN", r#"{"future":1e400}"#)).is_err());
    assert!(
        ReplicaOperation::parse(&prefix.replace("PN", r#"{"future":1e400,"future":2}"#)).is_ok()
    );
}
