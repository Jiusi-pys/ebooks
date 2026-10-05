use crate::{
    trpc::{config, fail, secret, Failure},
    Host,
};
use serde_json::{json, Value};
use shufang_native::{ai::Config, workspace::Workspace};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
pub trait Executor: Send + Sync {
    fn start(
        &self,
        workspace: Arc<Workspace>,
        config: Config,
        key: Option<String>,
        request: Value,
    ) -> Result<String, String>;
}
pub struct NativeExecutor;
impl Executor for NativeExecutor {
    fn start(
        &self,
        w: Arc<Workspace>,
        c: Config,
        k: Option<String>,
        r: Value,
    ) -> Result<String, String> {
        let target = w.clone();
        let v = w.start("ai", move |j| {
            shufang_native::ai::run_with_config(&target, r, c, k, &j)
        })?;
        v["job"]
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| "job_not_started".into())
    }
}
struct Cancel {
    workspace: Arc<Workspace>,
    id: String,
    done: bool,
}
impl Drop for Cancel {
    fn drop(&mut self) {
        if !self.done {
            let _ = self.workspace.execute("cancelJob", json!({"id":self.id}));
        }
    }
}
fn string<'a>(v: &'a Value, k: &str, min: usize, max: usize) -> Result<&'a str, Failure> {
    v[k].as_str()
        .filter(|s| {
            let n = s.encode_utf16().count();
            n >= min && n <= max
        })
        .ok_or_else(|| fail("BAD_REQUEST", format!("Invalid {k}")))
}
fn trim(v: &Value, n: usize) -> String {
    v.as_str().unwrap_or("").trim().chars().take(n).collect()
}
fn parse(s: &str) -> Value {
    s.find('{')
        .zip(s.rfind('}'))
        .and_then(|(a, b)| serde_json::from_str(&s[a..=b]).ok())
        .unwrap_or(Value::Null)
}
fn topic(v: &Value, d: usize) -> Option<Value> {
    let t = trim(&v["title"], 80);
    if t.is_empty() {
        return None;
    }
    let children = if d < 3 {
        v["children"]
            .as_array()
            .map(|v| {
                v.iter()
                    .take(10)
                    .filter_map(|v| topic(v, d + 1))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default()
    } else {
        vec![]
    };
    Some(json!({"title":t,"children":children}))
}
pub(crate) async fn call(h: &Arc<Host>, path: &str, input: Value) -> Result<Value, Failure> {
    call_with_timeout(h, path, input, None).await
}
async fn call_with_timeout(
    h: &Arc<Host>,
    path: &str,
    input: Value,
    timeout: Option<Duration>,
) -> Result<Value, Failure> {
    if matches!(path, "ai.getDigest" | "ai.saveDigest") {
        let hash = string(&input, "contentHash", 64, 64)?.to_owned();
        if !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(fail("BAD_REQUEST", "Invalid content hash"));
        }
        let value = if path == "ai.saveDigest" {
            string(&input, "title", 1, 255)?;
            string(&input, "structure", 1, 200000)?;
            if input.get("author").is_some() {
                string(&input, "author", 0, 255)?;
            }
            if input.get("overview").is_some() {
                string(&input, "overview", 0, 20000)?;
            }
            Some(
                json!({"contentHash":hash,"title":input["title"],"author":input["author"].as_str().unwrap_or(""),"structure":input["structure"],"overview":input["overview"].as_str().filter(|s|!s.is_empty())}),
            )
        } else {
            None
        };
        let w = h.workspace.clone();
        return tokio::task::spawn_blocking(move || {
            let mut core = w
                .core
                .lock()
                .map_err(|_| fail("INTERNAL_SERVER_ERROR", "Storage unavailable"))?;
            let key = format!("digest:{hash}");
            let existing = core
                .local_value(&key)
                .map_err(|_| fail("INTERNAL_SERVER_ERROR", "Storage unavailable"))?;
            if let Some(value) = value {
                core.set_local_value(&key, existing.map_or(0, |v| v.0), &value)
                    .map_err(|e| {
                        if e == "digest_unreferenced" {
                            fail("PRECONDITION_FAILED", "Book is no longer available")
                        } else {
                            fail("INTERNAL_SERVER_ERROR", "Digest could not be saved")
                        }
                    })?;
                Ok(json!({"ok":true,"storage":"database"}))
            } else {
                Ok(existing.map(|v| v.1).unwrap_or(Value::Null))
            }
        })
        .await
        .map_err(|_| fail("INTERNAL_SERVER_ERROR", "Storage unavailable"))?;
    }
    let (cfg, supplied) = if path == "ai.models" {
        let p = string(&input, "provider", 1, 32)?;
        config(
            &json!({"provider":p,"model":"models","effort":if p=="codex"{"medium"}else{"none"},"apiKey":input.get("apiKey").cloned().unwrap_or(json!(""))}),
            false,
        )?
    } else {
        config(&input["config"], false)?
    };
    let key = secret(&cfg.provider, supplied);
    if cfg.provider == "codex" {
        let s = h.codex.status().await;
        if s["authenticated"] != true || s["method"] != "chatgpt" {
            return Err(fail("PRECONDITION_FAILED", "Codex requires ChatGPT login"));
        }
    } else if key.is_none() {
        return Err(fail("PRECONDITION_FAILED", "AI API key is not configured"));
    }
    let mut request = json!({"task":path.strip_prefix("ai.").unwrap_or(path)});
    match path {
        "ai.models" => {}
        "ai.testConnection" => request["task"] = json!("test"),
        "ai.chat" => {
            let m = input["messages"]
                .as_array()
                .filter(|v| !v.is_empty() && v.len() <= 24)
                .ok_or_else(|| fail("BAD_REQUEST", "Invalid messages"))?;
            for row in m {
                if !["system", "user", "assistant"].contains(&string(row, "role", 1, 16)?) {
                    return Err(fail("BAD_REQUEST", "Invalid role"));
                }
                string(row, "content", 1, 60000)?;
            }
            request["messages"] = json!(m);
        }
        "ai.translate" => {
            request["text"] = json!(string(&input, "text", 1, 120000)?);
            let target = input["targetLang"].as_str().unwrap_or("中文");
            let mode = input["mode"].as_str().unwrap_or("passage");
            if !["中文", "现代汉语"].contains(&target) || !["passage", "chapter"].contains(&mode)
            {
                return Err(fail("BAD_REQUEST", "Invalid translation options"));
            }
            if input.get("sourceLang").is_some() {
                string(&input, "sourceLang", 0, 40)?;
            }
            request["question"] = json!(format!(
                "Target: {target}; mode: {mode}; source: {}",
                input["sourceLang"].as_str().unwrap_or("")
            ));
        }
        "ai.mindmap" | "ai.studyCard" => {
            string(&input, "bookTitle", 1, 255)?;
            string(&input, "chapterTitle", 1, 255)?;
            let card = path == "ai.studyCard";
            request["text"] = json!(string(
                &input,
                "text",
                if card { 2 } else { 1 },
                if card { 20000 } else { 80000 }
            )?);
            if card {
                if input.get("context").is_some() {
                    string(&input, "context", 0, 30000)?;
                }
                request["question"] = json!(input["context"].as_str().unwrap_or(""));
            } else {
                let max = input
                    .get("maxTopics")
                    .map(|v| {
                        v.as_u64()
                            .filter(|n| (3..=12).contains(n))
                            .ok_or_else(|| fail("BAD_REQUEST", "Invalid topic limit"))
                    })
                    .transpose()?
                    .unwrap_or(6);
                request["question"] = json!(format!("At most {max} topics"));
            }
        }
        _ => return Err(fail("NOT_FOUND", "Interface does not exist")),
    }
    let _permit = h
        .ai_slots
        .try_acquire()
        .map_err(|_| fail("TOO_MANY_REQUESTS", "AI is busy"))?;
    let w = h.workspace.clone();
    let executor = h.ai_executor.clone();
    let target = w.clone();
    let mut guard = tokio::task::spawn_blocking(move || {
        let id = executor.start(target.clone(), cfg, key, request)?;
        Ok::<Cancel, String>(Cancel {
            workspace: target,
            id,
            done: false,
        })
    })
    .await
    .map_err(|_| fail("INTERNAL_SERVER_ERROR", "AI failed"))?
    .map_err(|_| fail("INTERNAL_SERVER_ERROR", "AI could not start"))?;
    let id = guard.id.clone();
    let deadline = Instant::now()
        + timeout
            .unwrap_or_else(|| Duration::from_secs(if path == "ai.models" { 20 } else { 180 }));
    let result = loop {
        let target = w.clone();
        let job = id.clone();
        let s = tokio::task::spawn_blocking(move || target.execute("job", json!({"id":job})))
            .await
            .map_err(|_| fail("INTERNAL_SERVER_ERROR", "AI state unavailable"))?
            .map_err(|_| fail("INTERNAL_SERVER_ERROR", "AI state unavailable"))?;
        match s["status"].as_str() {
            Some("completed") => {
                guard.done = true;
                break s["result"].clone();
            }
            Some("failed" | "cancelled") => {
                guard.done = true;
                return Err(fail("INTERNAL_SERVER_ERROR", "AI request failed"));
            }
            _ => {}
        }
        if Instant::now() >= deadline {
            return Err(fail("TIMEOUT", "AI request timed out"));
        }
        tokio::time::sleep(Duration::from_millis(30)).await;
    };
    if path == "ai.models" {
        return Ok(json!({"models":result["models"]}));
    }
    let text = result["text"].as_str().unwrap_or("");
    Ok(match path {
        "ai.translate" => json!(text),
        "ai.testConnection" => json!({"ok":true,"content":text}),
        "ai.chat" => json!({"content":text}),
        "ai.mindmap" => {
            let v = parse(text);
            let max = input["maxTopics"].as_u64().unwrap_or(6) as usize;
            let mut topics = v["topics"]
                .as_array()
                .map(|v| {
                    v.iter()
                        .filter_map(|v| topic(v, 1))
                        .take(max)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            if topics.is_empty() {
                topics = text
                    .lines()
                    .map(|s| s.trim().trim_start_matches(['-', '*', '#', ' ']))
                    .filter(|s| s.chars().count() >= 2)
                    .take(max)
                    .map(|s| json!({"title":s.chars().take(80).collect::<String>(),"children":[]}))
                    .collect();
            }
            json!({"topics":topics})
        }
        "ai.studyCard" => {
            let v = parse(text);
            let mut title = trim(&v["title"], 80);
            if title.is_empty() {
                title = input["text"]
                    .as_str()
                    .unwrap_or("")
                    .trim()
                    .chars()
                    .take(40)
                    .collect();
            }
            let mut note = trim(&v["note"], 1000);
            if note.is_empty() {
                note = text.trim().chars().take(1000).collect();
            }
            let source = input["text"].as_str().unwrap_or("");
            let cloze = v["cloze"]
                .as_array()
                .map(|v| {
                    v.iter()
                        .filter_map(Value::as_str)
                        .filter(|s| !s.is_empty() && source.contains(s))
                        .take(5)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let tags = v["tags"]
                .as_array()
                .map(|v| {
                    v.iter()
                        .map(|v| trim(v, 24))
                        .filter(|s| !s.is_empty())
                        .take(5)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_else(|| vec!["AI 制卡".into()]);
            json!({"title":title,"note":note,"cloze":cloze,"tags":tags})
        }
        _ => Value::Null,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Slow(Arc<std::sync::Mutex<Option<String>>>);
    impl Executor for Slow {
        fn start(
            &self,
            w: Arc<Workspace>,
            _: Config,
            _: Option<String>,
            _: Value,
        ) -> Result<String, String> {
            let v = w.start("ai", move |j| loop {
                j.check()?;
                std::thread::sleep(Duration::from_millis(5));
            })?;
            let id = v["job"].as_str().unwrap().to_owned();
            *self.0.lock().unwrap() = Some(id.clone());
            Ok(id)
        }
    }
    #[tokio::test]
    async fn cancelling_http_cancels_job_and_releases_admission() {
        let dir = tempfile::tempdir().unwrap();
        let w = Workspace::open(&dir.path().join("db"), "w", "n").unwrap();
        let id = Arc::new(std::sync::Mutex::new(None));
        let mut h = Host::new(w.clone(), "token".into(), "https://library.example".into());
        Arc::get_mut(&mut h).unwrap().ai_executor = Arc::new(Slow(id.clone()));
        let input = json!({"config":{"provider":"deepseek","model":"chat","effort":"none","apiKey":"public-test-key"},"messages":[{"role":"user","content":"question"}]});
        assert!(call(
            &h,
            "ai.chat",
            json!({"config":input["config"],"messages":[]})
        )
        .await
        .is_err());
        assert!(id.lock().unwrap().is_none());
        let permits = h.ai_slots.acquire_many(2).await.unwrap();
        assert!(call(&h, "ai.chat", input.clone()).await.is_err());
        assert!(id.lock().unwrap().is_none());
        drop(permits);
        assert!(call_with_timeout(
            &h,
            "ai.chat",
            input.clone(),
            Some(Duration::from_millis(10))
        )
        .await
        .is_err());
        let timed_out = id.lock().unwrap().clone().unwrap();
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                if w.execute("job", json!({"id":timed_out})).unwrap()["status"] == "cancelled" {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        *id.lock().unwrap() = None;
        let target = h.clone();
        let task = tokio::spawn(async move { call(&target, "ai.chat", input).await });
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                if id.lock().unwrap().is_some() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        task.abort();
        let _ = task.await;
        let job = id.lock().unwrap().clone().unwrap();
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                if w.execute("job", json!({"id":job})).unwrap()["status"] == "cancelled" {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(h.ai_slots.available_permits(), 2);
    }
}
