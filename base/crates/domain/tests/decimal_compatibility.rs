#[test]
fn ordinary_operation_reader_preserves_js_binary64_decimals_exactly() {
    for (json, expected) in [
        ("0.9996250697544643", 0.9996250697544643_f64),
        ("0.9411411411411411", 0.9411411411411411_f64),
        ("1790759706314.6821", 1790759706314.6821_f64),
    ] {
        let parsed: serde_json::Value = serde_json::from_str(json).unwrap();
        assert_eq!(
            parsed.as_f64().unwrap().to_bits(),
            expected.to_bits(),
            "{json}"
        );
        let original = shufang_domain::lossless_json::Json::parse(json).unwrap();
        let echoed = shufang_domain::lossless_json::Json::parse(&parsed.to_string()).unwrap();
        assert_eq!(
            original, echoed,
            "operation replay must not change numeric value"
        );
    }
}
