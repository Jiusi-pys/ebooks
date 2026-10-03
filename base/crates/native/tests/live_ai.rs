use serde_json::json;
use shufang_native::workspace::Workspace;

/// Explicit live acceptance only; never consumes account quota in ordinary CI.
#[test]
#[ignore = "requires a logged-in Codex CLI and explicitly selected live model"]
fn codex_live_question_uses_the_native_job_and_persists_result() {
    let model = std::env::var("SHUFANG_LIVE_MODEL").expect("select a live model");
    let dir = tempfile::tempdir().unwrap();
    let w = Workspace::open(&dir.path().join("db"), "live-test", "windows").unwrap();
    w.execute(
        "saveAiConfig",
        json!({"expected":0,"config":{"provider":"codex","model":model,"effort":"low"}}),
    )
    .unwrap();
    let start = w.execute("ai",json!({"task":"chat","text":"合成测试文本：小林种了三棵树，又种了两棵树。","question":"小林一共种了几棵树？只用中文回答，不使用任何工具。"})).unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(200);
    let result = loop {
        assert!(std::time::Instant::now() < deadline, "live AI timeout");
        let job = w.execute("job", json!({"id":start["job"]})).unwrap();
        if job["status"] != "running" {
            break job;
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    };
    assert_eq!(result["status"], "completed", "{result}");
    let text = result["result"]["text"].as_str().unwrap();
    assert!(text.contains('五') || text.contains('5'), "{text}");
    let saved=w.execute("save",json!({"kind":"notes","id":"answer","expected":0,"patch":{"title":"真实AI合成验证","content":text}})).unwrap();
    drop(w);
    let w = Workspace::open(&dir.path().join("db"), "live-test", "windows").unwrap();
    assert_eq!(
        w.execute("get", json!({"kind":"notes","id":"answer"}))
            .unwrap(),
        saved
    );
    println!("LIVE provider=codex model={model} response={text}");
}
