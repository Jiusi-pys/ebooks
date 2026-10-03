use crate::{external, Host};
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
    let result = match method {
        "initialize" => Ok(
            json!({"protocolVersion":"2025-11-25","capabilities":{"tools":{}},"serverInfo":{"name":"shufang-library","version":"0.2.0"}}),
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
        Ok(value) => json!({"jsonrpc":"2.0","id":id,"result":value}),
        Err(error) => json!({"jsonrpc":"2.0","id":id,"error":{"code":-32602,"message":error}}),
    })
}
fn tools() -> Vec<Value> {
    [("list_books","列出书籍"),("get_reading_progress","读取进度"),("search_highlights","搜索书摘"),("get_review_queue","复习队列"),("search_notes","搜索笔记"),("get_note","读取笔记")].into_iter().map(|(name,title)|json!({"name":name,"title":title,"description":title,"annotations":{"readOnlyHint":true,"destructiveHint":false},"inputSchema":{"type":"object","properties":{"query":{"type":"string","maxLength":200},"bookId":{"type":"string"},"noteId":{"type":"string"},"limit":{"type":"integer","minimum":1,"maximum":100}},"additionalProperties":false}})).collect()
}
fn tool(host: &Host, name: &str, args: &Value) -> Result<Value, String> {
    let kind = match name {
        "list_books" | "get_reading_progress" => "books",
        "search_highlights" | "get_review_queue" => "highlights",
        "search_notes" | "get_note" => "notes",
        _ => return Err("unknown_tool".into()),
    };
    let rows = host.workspace.execute("list", json!({"kind":kind}))?;
    let query = args["query"].as_str().unwrap_or("").to_lowercase();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let rows = rows
        .as_array()
        .ok_or("invalid_records")?
        .iter()
        .filter(|row| {
            let value = &row["value"];
            if let Some(id) = args["bookId"].as_str() {
                if (kind == "books" && value["id"] != id)
                    || (kind != "books" && value["bookId"] != id)
                {
                    return false;
                }
            }
            if name == "get_note" && value["id"] != args["noteId"] {
                return false;
            }
            if name == "get_review_queue" && value["review"]["due"].as_u64().is_none_or(|d| d > now)
            {
                return false;
            }
            query.is_empty() || value.to_string().to_lowercase().contains(&query)
        })
        .take(args["limit"].as_u64().unwrap_or(50).clamp(1, 100) as usize)
        .map(|r| {
            let mut value = external(r);
            if kind == "books" {
                value.as_object_mut().unwrap().remove("chapters");
            }
            value
        })
        .collect::<Vec<_>>();
    Ok(
        json!({"content":[{"type":"text","text":serde_json::to_string(&rows).map_err(|e|e.to_string())?}]}),
    )
}
