use serde_json::json;
use shufang_domain::associations::pair_key;
#[test]
fn pair_identity_matches_existing_javascript_wire_encoding() {
    let a = json!({"kind":"text","bookId":"b","chapterId":"c","paraIndex":0,"start":0,"end":2});
    let mut b = a.clone();
    b["bookId"] = "a".into();
    let expected="bidirectional:%5B%22text%3A%255B%2522text%2522%252C%2522a%2522%252C%2522c%2522%252C0%252C0%252C2%255D%22%2C%22text%3A%255B%2522text%2522%252C%2522b%2522%252C%2522c%2522%252C0%252C0%252C2%255D%22%5D";
    assert_eq!(pair_key(&a, &b, "bidirectional").unwrap(), expected);
    assert_eq!(pair_key(&b, &a, "bidirectional").unwrap(), expected);
    let p = json!({"kind":"pdf","bookId":"b","chapterId":"c","pdfAnchor":{"page":1,"rects":[{"x":0.25,"y":0.5,"width":1.0,"height":0.000001}]}});
    let mut reversed = p.clone();
    reversed["chapterId"] = "different".into();
    assert!(pair_key(&p, &reversed, "bidirectional").is_err());
}
