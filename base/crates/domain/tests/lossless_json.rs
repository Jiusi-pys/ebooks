use shufang_domain::lossless_json::Json;

#[test]
fn utf16_units_keys_and_duplicate_keys_roundtrip_without_markers() {
    let input =
        r#"{"\ud800":"\udfff","literal":"@core-key:0","😀":"汉字","duplicate":1,"duplicate":2}"#;
    let value = Json::parse(input).unwrap();
    assert_eq!(
        value.get_units(&[0xd800]).unwrap().string_units().unwrap(),
        &[0xdfff]
    );
    assert_eq!(value.get("duplicate").unwrap().number().unwrap(), 2.0);
    let text = value.stringify(false);
    assert_eq!(Json::parse(&text).unwrap(), value);
    assert!(text.contains(r#""\ud800":"\udfff""#));
}

#[test]
fn canonical_order_is_utf16_and_numbers_are_javascript_numbers() {
    let value =
        Json::parse(r#"{"\ue000":-0,"😀":1e21,"a":9007199254740993,"b":1e-7,"c":1e-6}"#).unwrap();
    assert_eq!(
        value.stringify(true),
        r#"{"a":9007199254740992,"b":1e-7,"c":0.000001,"😀":1e+21,"":0}"#
    );
}

#[test]
fn malformed_json_is_rejected_and_deep_documents_do_not_use_recursive_parsing() {
    for invalid in [
        "",
        "01",
        "1.",
        "1e",
        "[1,]",
        "{\"a\":1,}",
        "\"\n\"",
        "true false",
        "{1:2}",
        "[",
        r#""\x20""#,
    ] {
        assert!(Json::parse(invalid).is_err(), "{invalid}");
    }
    let input = format!("{}0{}", "[".repeat(2048), "]".repeat(2048));
    let value = Json::parse(&input).unwrap();
    assert_eq!(value.stringify(false), input);
}
