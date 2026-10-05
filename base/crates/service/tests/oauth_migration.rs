use serde_json::json;
#[test]
fn node_oauth_import_preserves_owner_token_hashes_deadlines_and_replay_history() {
    let request = json!({"client_id":"client","redirect_uri":"https://client.example/cb","response_type":"code","resource":"https://library.example/mcp","scope":"library:read","code_challenge":"a".repeat(43),"code_challenge_method":"S256","state":"state"});
    let owner = json!({"userId":"Owner","credentialVersion":7});
    let state = json!({"version":1,"clients":{"client":{"client_id":"client","client_name":"Client","redirect_uris":["https://client.example/cb"]}},"pending":{"pending":{"request":request,"csrfHash":"c".repeat(64),"expires":1800000100123u64}},"codes":{"code":{"request":request,"owner":owner,"expires":1800000100123u64}},"grants":{"grant":{"owner":owner,"clientId":"client","resource":"https://library.example/mcp","scope":"library:read","expires":1800010000123u64,"revoked":false}},"tokens":{"access":{"grantId":"grant","kind":"access","expires":1800000900123u64,"used":false},"refresh":{"grantId":"grant","kind":"refresh","expires":1800010000123u64,"used":false},"used":{"grantId":"grant","kind":"refresh","expires":1800010000123u64,"used":true}}});
    let migrated = shufang_service::oauth_migration::convert(&state).unwrap();
    assert_eq!(migrated["codes"]["code"]["owner"], owner);
    assert_eq!(migrated["pending"]["pending"]["csrfHash"], "c".repeat(64));
    assert_eq!(migrated["access"]["access"]["expires"], 1800000900u64);
    assert_eq!(migrated["access"]["access"]["grant"], "grant");
    assert_eq!(
        migrated["refresh"]["refresh"]["grant_expires"],
        1800010000u64
    );
    assert_eq!(migrated["used_refresh"]["used"]["grant"], "grant");
    assert!(shufang_service::oauth_migration::convert(&json!({"version":2})).is_err());
    let mut revoked = state;
    revoked["grants"]["grant"]["revoked"] = true.into();
    assert!(
        shufang_service::oauth_migration::convert(&revoked).unwrap()["access"]
            .as_object()
            .unwrap()
            .is_empty()
    );
}
