use crate::{legacy, Host};
use serde_json::{json, Value};
pub fn dispatch(host: &Host, request: Value) -> Result<Value, String> {
    if request["jsonrpc"] != "2.0" {
        return Err("invalid_jsonrpc".into());
    }
    let id = request.get("id").cloned();
    let method = request["method"].as_str().ok_or("invalid_method")?;
    if id.is_none() {
        return Ok(Value::Null);
    }
    let modern = method == "server/discover"
        || request["params"]["_meta"]["io.modelcontextprotocol/protocolVersion"] == "2026-07-28";
    if modern
        && request["params"]["_meta"]["io.modelcontextprotocol/protocolVersion"] != "2026-07-28"
    {
        return Ok(
            json!({"jsonrpc":"2.0","id":id,"error":{"code":-32602,"message":"invalid_protocol_envelope"}}),
        );
    }
    let result = match method {
        "server/discover" if modern => {
            Ok(json!({"supportedVersions":["2026-07-28"],"capabilities":{"tools":{}}}))
        }
        "initialize" => Ok(
            json!({"protocolVersion":"2025-11-25","capabilities":{"tools":{}},"serverInfo":{"name":"shufang-library","version":"1.0.0"}}),
        ),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({"tools":tools()})),
        "tools/call" => tool(
            host,
            request["params"]["name"].as_str().unwrap_or(""),
            &request["params"]["arguments"],
        ),
        _ => Err("method_not_found".into()),
    };
    Ok(match result {
        Ok(mut value) => {
            if modern {
                value["resultType"] = json!("complete");
                value["_meta"]["io.modelcontextprotocol/serverInfo"] =
                    json!({"name":"shufang-library","version":"1.0.0"});
                if method == "server/discover" || method == "tools/list" {
                    value["ttlMs"] = json!(0);
                    value["cacheScope"] = json!("private");
                }
            }
            json!({"jsonrpc":"2.0","id":id,"result":value})
        }
        Err(error) => json!({"jsonrpc":"2.0","id":id,"error":{"code":-32602,"message":error}}),
    })
}
fn tools() -> Vec<Value> {
    let specs = [
        (
            "list_books",
            "列出书籍",
            "列出服务端已同步的书目，可按书名或作者筛选。最多返回 100 本。",
            json!({"type":"object","properties":{"query":{"type":"string","maxLength":200},"limit":{"type":"integer","minimum":1,"maximum":100,"default":50}},"additionalProperties":false}),
        ),
        (
            "get_reading_progress",
            "查询阅读进度",
            "读取一本书已同步到服务端的阅读进度和最近打开时间。",
            json!({"type":"object","properties":{"book_id":{"type":"string","minLength":1,"maxLength":64}},"required":["book_id"],"additionalProperties":false}),
        ),
        (
            "search_highlights",
            "搜索书摘和批注",
            "按关键词查找服务端已同步的书摘、批注和卡片标签。",
            json!({"type":"object","properties":{"query":{"type":"string","minLength":1,"maxLength":200},"book_id":{"type":"string","maxLength":64},"limit":{"type":"integer","minimum":1,"maximum":100,"default":30}},"required":["query"],"additionalProperties":false}),
        ),
        (
            "get_review_queue",
            "查询复习队列",
            "查询已到期的复习卡；可选择包含所有复习卡。",
            json!({"type":"object","properties":{"include_all":{"type":"boolean","default":false},"limit":{"type":"integer","minimum":1,"maximum":100,"default":50}},"additionalProperties":false}),
        ),
        (
            "search_notes",
            "搜索笔记",
            "搜索已同步笔记的标题和正文，最多扫描 100 条笔记。",
            json!({"type":"object","properties":{"query":{"type":"string","minLength":1,"maxLength":200},"limit":{"type":"integer","minimum":1,"maximum":50,"default":20}},"required":["query"],"additionalProperties":false}),
        ),
        (
            "get_note",
            "读取笔记",
            "按 ID 读取一条已同步笔记。",
            json!({"type":"object","properties":{"note_id":{"type":"string","minLength":1,"maxLength":64}},"required":["note_id"],"additionalProperties":false}),
        ),
    ];
    specs.into_iter().map(|(name,title,description,input_schema)|json!({"name":name,"title":title,"description":description,"annotations":{"readOnlyHint":true,"destructiveHint":false},"inputSchema":input_schema})).collect()
}
fn arg<'a>(args: &'a Value, key: &str, legacy: &str) -> Option<&'a Value> {
    args.get(key).or_else(|| args.get(legacy))
}
fn string_arg(
    args: &Value,
    key: &str,
    legacy: &str,
    required: bool,
    max: usize,
) -> Result<String, String> {
    match arg(args, key, legacy) {
        None if !required => Ok(String::new()),
        Some(Value::String(s))
            if s.trim().encode_utf16().count() <= max && (!required || !s.trim().is_empty()) =>
        {
            Ok(s.trim().to_owned())
        }
        _ => Err(format!("invalid_{key}")),
    }
}
fn limit(args: &Value, default: u64, max: u64) -> Result<usize, String> {
    let value = args
        .get("limit")
        .map_or(Some(default), Value::as_u64)
        .ok_or("invalid_limit")?;
    if !(1..=max).contains(&value) {
        return Err("invalid_limit".into());
    }
    Ok(value as usize)
}
fn list(host: &Host, kind: &str) -> Result<Vec<Value>, String> {
    host.workspace
        .execute("list", json!({"kind":kind}))?
        .as_array()
        .cloned()
        .ok_or("invalid_records".into())
}
fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_owned();
    }
    format!("{}\n[内容已截断]", s.chars().take(max).collect::<String>())
}
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_f64().is_some_and(|number| number != 0.0),
        Value::String(value) => !value.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}
fn preview(v: &Value) -> Value {
    json!({"id":v["extId"],"bookId":v["bookExtId"],"bookTitle":v["bookTitle"],"chapterTitle":v["chapterTitle"],"text":truncate(v["text"].as_str().unwrap_or(""),3000),"note":truncate(v["note"].as_str().unwrap_or(""),2000),"name":v["name"],"tags":v["tags"],"cloze":v["cloze"],"review":v["review"],"createdAt":v["createdAt"]})
}
fn text(value: Value) -> Result<Value, String> {
    Ok(
        json!({"content":[{"type":"text","text":serde_json::to_string_pretty(&value).map_err(|e|e.to_string())?}]}),
    )
}
fn tool(host: &Host, name: &str, args: &Value) -> Result<Value, String> {
    if !args.is_object() {
        return Err("invalid_arguments".into());
    }
    match name {
        "list_books" => {
            let query = string_arg(args, "query", "query", false, 200)?.to_lowercase();
            let folders = list(host, "folders")?;
            let books = list(host, "books")?;
            let selected:Vec<Value>=books.iter().map(|r|legacy::project("books",r,&folders,&books,true))
                .filter(|b|query.is_empty()||format!("{} {}",b["title"].as_str().unwrap_or(""),b["author"].as_str().unwrap_or("")).to_lowercase().contains(&query))
                .take(limit(args,50,100)?).map(|b|json!({"id":b["extId"],"title":b["title"],"author":b["author"],"format":b["format"],"folder":b["folder"],"createdAt":b["createdAt"]})).collect();
            text(json!({"count":selected.len(),"books":selected}))
        }
        "get_reading_progress" => {
            let id = string_arg(args, "book_id", "bookId", true, 64)?;
            let book = host
                .workspace
                .execute("get", json!({"kind":"books","id":id}))?;
            let v = &book["value"];
            text(
                json!({"bookId":id,"progress":v["progress"],"lastOpenedAt":v["lastOpenedAt"],"synced":truthy(&v["progress"])||truthy(&v["lastOpenedAt"])}),
            )
        }
        "search_highlights" => {
            let query = string_arg(args, "query", "query", true, 200)?.to_lowercase();
            let book_id = string_arg(args, "book_id", "bookId", false, 64)?;
            let books = list(host, "books")?;
            let selected: Vec<Value> = list(host, "highlights")?
                .iter()
                .map(|r| legacy::project("highlights", r, &[], &books, false))
                .filter(|v| book_id.is_empty() || v["bookExtId"] == book_id)
                .filter(|v| {
                    let mut haystack = format!(
                        "{} {} {}",
                        v["text"].as_str().unwrap_or(""),
                        v["note"].as_str().unwrap_or(""),
                        v["name"].as_str().unwrap_or("")
                    );
                    if let Some(tags) = v["tags"].as_array() {
                        for tag in tags {
                            haystack.push_str(tag.as_str().unwrap_or(""));
                        }
                    }
                    haystack.to_lowercase().contains(&query)
                })
                .take(limit(args, 30, 100)?)
                .map(|v| preview(&v))
                .collect();
            text(json!({"count":selected.len(),"highlights":selected}))
        }
        "get_review_queue" => {
            let include_all = arg(args, "include_all", "includeAll")
                .map_or(Some(false), Value::as_bool)
                .ok_or("invalid_include_all")?;
            let max = limit(args, 50, 100)?;
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64;
            let books = list(host, "books")?;
            let mut cards: Vec<Value> = list(host, "highlights")?
                .iter()
                .map(|r| legacy::project("highlights", r, &[], &books, false))
                .filter(|v| {
                    v["review"].is_object()
                        && (include_all || v["review"]["due"].as_u64().is_some_and(|d| d <= now))
                })
                .collect();
            cards.sort_by_key(|v| v["review"]["due"].as_u64().unwrap_or(0));
            let count = cards.len().min(max);
            text(
                json!({"now":now,"count":count,"cards":cards.into_iter().take(max).map(|v|preview(&v)).collect::<Vec<_>>()}),
            )
        }
        "search_notes" => {
            let query = string_arg(args, "query", "query", true, 200)?.to_lowercase();
            let selected:Vec<Value>=list(host,"notes")?.iter().take(100).map(|r|legacy::project("notes",r,&[],&[],false))
                .filter(|n|format!("{} {}",n["title"].as_str().unwrap_or(""),n["content"].as_str().unwrap_or("")).to_lowercase().contains(&query))
                .take(limit(args,20,50)?).map(|n|json!({"extId":n["extId"],"title":n["title"],"content":truncate(n["content"].as_str().unwrap_or(""),2000),"updatedAt":n["updatedAt"]})).collect();
            text(json!({"count":selected.len(),"notes":selected}))
        }
        "get_note" => {
            let id = string_arg(args, "note_id", "noteId", true, 64)?;
            let record = host
                .workspace
                .execute("get", json!({"kind":"notes","id":id}))?;
            let mut note = legacy::project("notes", &record, &[], &[], false);
            note["content"] = truncate(note["content"].as_str().unwrap_or(""), 10000).into();
            text(note)
        }
        _ => Err("unknown_tool".into()),
    }
}
