use shufang_service::credentials::{
    decrypt_username, encrypt_username, hash_password, normalize_username, verify_password,
};

#[test]
fn node_credentials_survive_rust_migration_and_reject_corruption() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/node-credentials.json")).unwrap();
    let secret = fixture["secret"].as_str().unwrap();
    let encrypted = fixture["encrypted"].as_str().unwrap();
    assert_eq!(decrypt_username(encrypted, secret).unwrap(), "用户AB");
    assert!(decrypt_username(encrypted, "wrong").is_err());
    assert_eq!(normalize_username(" 用户ＡＢ "), "用户AB");
    assert!(verify_password(
        "public-long-test-password",
        fixture["hash"].as_str().unwrap()
    ));
    assert!(!verify_password(
        "incorrect",
        fixture["hash"].as_str().unwrap()
    ));
    assert!(!verify_password("password", "scrypt$999999999$8$3$bad$bad"));
    let new = encrypt_username(" 用户ＡＢ ", secret).unwrap();
    assert_eq!(decrypt_username(&new, secret).unwrap(), "用户AB");
    let hash = hash_password("public-long-test-password").unwrap();
    assert!(verify_password("public-long-test-password", &hash));
}
