use shufang_native::replication::Peer;

#[test]
fn browser_and_machine_auth_headers_are_separate() {
    let browser=Peer{id:"server".into(),url:"https://books.example".into(),token:String::new(),cookie:Some("shufang_session=signed".into())};
    let headers=browser.headers();
    assert_eq!(headers["cookie"],"shufang_session=signed");
    assert_eq!(headers["origin"],"https://books.example");
    assert!(!headers.contains_key("authorization"));
    let machine=Peer{id:"server".into(),url:"https://books.example".into(),token:"machine-token".into(),cookie:None};
    let headers=machine.headers();
    assert_eq!(headers["authorization"],"Bearer machine-token");
    assert!(!headers.contains_key("cookie"));
}
