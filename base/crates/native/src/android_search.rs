use crate::workspace::{Result, Workspace};
use serde_json::{json, Value};

fn visible_text(text: &str) -> String {
    let mut visible=String::new();let mut rest=text;
    while let Some(start)=rest.find("<!--") {
        visible.push_str(&rest[..start]);
        let Some(end)=rest[start+4..].find("-->") else {return visible;};
        rest=&rest[start+4+end+3..];
    }
    visible.push_str(rest);visible
}

/// Preserve JavaScript's UTF-16 coordinates, including expanding lowercase chars.
fn range(text: &str, query: &str) -> Option<(usize, usize)> {
    let mut lowered = String::new();
    let mut offsets = Vec::new();
    let mut ends = Vec::new();
    let mut offset = 0;
    for character in text.chars() {
        for lower in character.to_lowercase() {
            for _ in 0..lower.len_utf8() { offsets.push(offset); ends.push(offset + character.len_utf16()); }
            lowered.push(lower);
        }
        offset += character.len_utf16();
    }
    let start = lowered.find(query)?;
    let after = start + query.len();
    Some((offsets[start], ends[after - 1]))
}

pub fn summary(record: &mut Value) {
    if let Some(value) = record.get_mut("value").and_then(Value::as_object_mut) {
        if let Some(chapters) = value.remove("chapters") {
            value.insert("chapterCount".into(), json!(chapters.as_array().map_or(0,Vec::len)));
        }
        preview_value(value);
    }
}
pub fn preview(value:&mut Value) {
    if let Some(value)=value.as_object_mut() {preview_value(value);}
}
fn preview_value(value:&mut serde_json::Map<String,Value>) {
        for key in ["content", "text", "note"] {
            if let Some(text) = value.get(key).and_then(Value::as_str) {
                if text.chars().count() > 4096 {
                    let preview: String = text.chars().take(4096).collect();
                    value.insert(key.into(),preview.into());
                    value.insert("androidPreview".into(),true.into());
                }
            }
        }
}

pub fn search(workspace: &Workspace, args: &Value) -> Result<Value> {
    let query = args["query"].as_str().ok_or("invalid_query")?.trim().to_lowercase();
    if query.len() > 1024 { return Err("query_too_long".into()); }
    let filter = args["kind"].as_str().unwrap_or("all");
    if !["all", "books", "content", "notes", "highlights"].contains(&filter) { return Err("invalid_search_kind".into()); }
    let limit = args["limit"].as_u64().unwrap_or(50);
    if limit == 0 || limit > 200 { return Err("invalid_page_limit".into()); }
    let offset = usize::try_from(args["offset"].as_u64().unwrap_or(0)).map_err(|_| "invalid_page_offset")?;
    let mut hits = vec![];
    if !query.is_empty() {
        let core = workspace.core.lock().map_err(|_| "core_lock_failed")?;
        let scope = args["bookIds"].as_array();
        let mut linked_notes=std::collections::BTreeSet::new();
        if let Some(ids)=scope {
            let mut offset=0;
            loop {
                let (page,total)=core.entities_page("highlights",offset,200,&["text","note"], |_| {})?;
                offset+=page.len();
                for record in page {if ids.contains(&record.value["bookId"]) {if let Some(id)=record.value["noteId"].as_str(){linked_notes.insert(id.to_owned());}}}
                if offset>=total {break;}
            }
        }
        'records: for kind in ["books", "notes", "highlights"] {
            if filter != "all" && filter != kind && !(filter == "content" && kind == "books") { continue; }
            let mut page_offset=0;
            loop {
            let (page,total)=core.entities_page(kind,page_offset,200,&["chapters","content","text","note"], |_| {})?;
            page_offset+=page.len();
            for metadata in page {
                let id=metadata.value["id"].as_str().ok_or("invalid_record")?.to_owned();
                if let Some(ids) = scope {
                    let included=if kind=="notes" {linked_notes.contains(&id)}else{ids.contains(if kind=="books" {&metadata.value["id"]}else{&metadata.value["bookId"]})};
                    if !included {continue;}
                }
                let record=if kind=="books" {metadata}else{core.entity(kind,&id)?};
                let metadata_match = filter != "content" && ["title", "author", "content", "text", "note", "tags"].iter().any(|key| {
                    let value = &record.value[*key];
                    value.as_str().is_some_and(|s| visible_text(s).to_lowercase().contains(&query)) || value.as_array().is_some_and(|a| a.iter().any(|v|v.as_str().is_some_and(|s|s.to_lowercase().contains(&query))))
                });
                let mut projected = serde_json::to_value(&record).map_err(|e| e.to_string())?;
                summary(&mut projected);
                if metadata_match {
                    let anchor = if kind == "highlights" {record.value.clone()} else {Value::Null};
                    hits.push(json!({"kind":kind,"record":projected,"anchor":anchor,"preview":""}));
                    if hits.len() >= 500 {break 'records;}
                }
                if kind == "books" && filter != "books" {
                    let hydrated = core.entity("books", &id)?;
                    if let Some(chapters) = hydrated.value["chapters"].as_array() {
                        for chapter in chapters {
                            if filter=="all" && chapter["title"].as_str().is_some_and(|s|s.to_lowercase().contains(&query)) {
                                let anchor=json!({"bookId":id,"chapterId":chapter["id"],"chapterTitle":chapter["title"],"readerMode":"reflow"});
                                hits.push(json!({"kind":"books","matchKind":"chapter","record":projected,"anchor":anchor,"preview":chapter["title"]}));
                                if hits.len()>=500 {break 'records;}
                            }
                            if let Some(paragraphs) = chapter["paragraphs"].as_array() {
                                for (index, paragraph) in paragraphs.iter().enumerate() {
                                    let Some(text) = paragraph.as_str() else {continue;};
                                    if let Some((start,end)) = range(text, &query) {
                                        let selected = String::from_utf16(&text.encode_utf16().skip(start).take(end-start).collect::<Vec<_>>()).map_err(|_|"invalid_search_range")?;
                                        let anchor = json!({"kind":"text","readerMode":"reflow","bookId":id,"chapterId":chapter["id"],"chapterTitle":chapter["title"],"paraIndex":index,"start":start,"end":end,"text":selected});
                                        hits.push(json!({"kind":"books","matchKind":"content","record":projected,"anchor":anchor,"preview":text.chars().take(300).collect::<String>()}));
                                        if hits.len() >= 500 {break 'records;}
                                    }
                                }
                            }
                        }
                    }
                }
            }
            if page_offset>=total {break;}
            }
        }
    }
    let total=hits.len();let start=offset.min(total);let end=start.saturating_add(limit as usize).min(total);
    Ok(json!({"items":&hits[start..end],"total":total,"truncated":total==500,"nextOffset":if end<total {Some(end)}else{None}}))
}
