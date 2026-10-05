use shufang_service::browser_session::verify;

#[test]
fn accepts_node_session_and_rejects_expiration_tampering_and_weak_configuration() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/node-session.json")).unwrap();
    let secret = fixture["secret"].as_str().unwrap();
    let token = fixture["token"].as_str().unwrap();
    let session = verify(token, secret, 1_800_000_001).unwrap();
    assert_eq!(session.user_id, "用户甲");
    assert_eq!(session.credential_version, 7);
    assert!(!session.setup_required);
    assert!(verify(token, secret, 1_800_043_200).is_none());
    assert!(verify(token, "weak", 1_800_000_001).is_none());
    assert!(verify(&format!("x{token}"), secret, 1_800_000_001).is_none());
    assert!(verify(token, &"x".repeat(32), 1_800_000_001).is_none());
}
