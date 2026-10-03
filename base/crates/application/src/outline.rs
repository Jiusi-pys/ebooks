use crate::{CoreSession, Record, Repository, Result, Runtime};
use serde_json::{json, Value};
use std::collections::BTreeSet;

fn entries(book: &Value) -> Result<Vec<Value>> {
    let list = book
        .get("outline")
        .filter(|v| !v.is_null())
        .map(|v| v.as_array().cloned().ok_or("invalid_outline"));
    let list = match list { Some(v) => v?, None => book["chapters"].as_array().ok_or("invalid_chapters")?.iter().map(|c| json!({"id":format!("chapter:{}",c["id"].as_str().unwrap_or("")),"title":c["title"],"chapterId":c["id"],"depth":0})).collect() };
    validate(book, &list)?;
    Ok(list)
}
pub(crate) fn validate_book(book: &Value) -> Result<()> {
    entries(book).map(|_| ())
}
fn depth(v: &Value) -> Result<u64> {
    v["depth"]
        .as_u64()
        .filter(|d| *d <= 3)
        .ok_or("invalid_outline_depth".into())
}
fn end(list: &[Value], index: usize) -> usize {
    let d = list[index]["depth"].as_u64().unwrap_or(0);
    (index + 1..list.len())
        .find(|i| list[*i]["depth"].as_u64().unwrap_or(0) <= d)
        .unwrap_or(list.len())
}
fn validate(book: &Value, list: &[Value]) -> Result<()> {
    if list.len() > 10000 {
        return Err("outline_limit".into());
    }
    let mut ids = BTreeSet::new();
    let mut previous = 0;
    for (i, v) in list.iter().enumerate() {
        let id = v["id"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 128)
            .ok_or("invalid_outline_id")?;
        if !ids.insert(id) {
            return Err("duplicate_outline_id".into());
        }
        let title = v["title"]
            .as_str()
            .filter(|s| !s.trim().is_empty() && s.len() <= 1024)
            .ok_or("invalid_outline_title")?;
        let _ = title;
        let d = depth(v)?;
        if (i == 0 && d != 0) || d > previous + 1 {
            return Err("invalid_outline_depth".into());
        }
        previous = d;
        let chapter = book["chapters"]
            .as_array()
            .ok_or("invalid_chapters")?
            .iter()
            .find(|c| c["id"] == v["chapterId"])
            .ok_or("outline_chapter_missing")?;
        if id.starts_with("chapter:")
            && id != format!("chapter:{}", chapter["id"].as_str().unwrap_or(""))
        {
            return Err("invalid_outline_id".into());
        }
        if let Some(p) = v.get("paraIndex") {
            let text = p
                .as_u64()
                .and_then(|p| chapter["paragraphs"].as_array()?.get(p as usize)?.as_str())
                .ok_or("outline_paragraph_missing")?;
            if v.get("start").is_some() || v.get("end").is_some() {
                let s = v["start"].as_u64().ok_or("invalid_outline_range")?;
                let e = v["end"].as_u64().ok_or("invalid_outline_range")?;
                let units: Vec<_> = text.encode_utf16().collect();
                let boundary = |n: usize| {
                    n == 0
                        || n == units.len()
                        || !(units[n - 1] >= 0xD800
                            && units[n - 1] <= 0xDBFF
                            && units[n] >= 0xDC00
                            && units[n] <= 0xDFFF)
                };
                if s > e || e > units.len() as u64 || !boundary(s as usize) || !boundary(e as usize)
                {
                    return Err("invalid_outline_range".into());
                }
            }
        }
    }
    for c in book["chapters"].as_array().ok_or("invalid_chapters")? {
        if !ids.contains(format!("chapter:{}", c["id"].as_str().unwrap_or("")).as_str()) {
            return Err("outline_chapter_missing".into());
        }
    }
    Ok(())
}
impl<R: Repository, T: Runtime> CoreSession<R, T> {
    pub fn outline(&self, id: &str) -> Result<Value> {
        Ok(entries(&self.entity("books", id)?.value)?.into())
    }
    pub fn edit_outline(&mut self, id: &str, expected: u64, args: &Value) -> Result<Record> {
        let book = self.entity("books", id)?;
        if book.revision != expected {
            return Err("revision_conflict".into());
        }
        let mut list = entries(&book.value)?;
        let action = args["action"].as_str().ok_or("invalid_outline_action")?;
        if action == "add" {
            let target = args["target"].as_object().ok_or("invalid_outline_target")?;
            let chapter = target
                .get("chapterId")
                .and_then(Value::as_str)
                .ok_or("outline_chapter_missing")?;
            let base = list
                .iter()
                .position(|v| v["id"] == format!("chapter:{chapter}"))
                .ok_or("outline_chapter_missing")?;
            let mut item = json!({"id":format!("outline:{}",self.runtime.new_id()),"title":args["title"],"chapterId":chapter,"depth":(depth(&list[base])?+1).min(3)});
            for key in ["paraIndex", "start", "end"] {
                if let Some(v) = target.get(key) {
                    item[key] = v.clone();
                }
            }
            let pos = end(&list, base);
            list.insert(pos, item);
        } else {
            let i = list
                .iter()
                .position(|v| v["id"] == args["entry"])
                .ok_or("outline_entry_missing")?;
            let last = end(&list, i);
            let d = depth(&list[i])?;
            match action {
                "rename" => list[i]["title"] = args["title"].clone(),
                "delete" => {
                    if list[i]["id"].as_str().unwrap_or("").starts_with("chapter:") {
                        return Err("outline_chapter_immutable".into());
                    }
                    for v in &mut list[i + 1..last] {
                        v["depth"] = (depth(v)? - 1).into();
                    }
                    list.remove(i);
                }
                "indent" | "outdent" => {
                    let delta = if action == "indent" { 1i64 } else { -1 };
                    if delta < 0 && d == 0 {
                        return Err("invalid_outline_depth".into());
                    }
                    if delta > 0
                        && !(0..i)
                            .rev()
                            .take_while(|j| depth(&list[*j]).unwrap_or(0) >= d)
                            .any(|j| depth(&list[j]).unwrap_or(0) == d)
                    {
                        return Err("outline_sibling_missing".into());
                    }
                    for v in &mut list[i..last] {
                        let next = depth(v)? as i64 + delta;
                        if !(0..=3).contains(&next) {
                            return Err("invalid_outline_depth".into());
                        }
                        v["depth"] = next.into();
                    }
                }
                "up" => {
                    let prev = (0..i)
                        .rev()
                        .find(|j| depth(&list[*j]).unwrap_or(0) <= d)
                        .filter(|j| depth(&list[*j]).unwrap_or(0) == d)
                        .ok_or("outline_sibling_missing")?;
                    list[prev..last].rotate_right(last - i);
                }
                "down" => {
                    if last == list.len() || depth(&list[last])? != d {
                        return Err("outline_sibling_missing".into());
                    }
                    let next = end(&list, last);
                    list[i..next].rotate_left(last - i);
                }
                _ => return Err("invalid_outline_action".into()),
            }
        }
        validate(&book.value, &list)?;
        self.save_entity("books", id, json!({"outline":list}), vec![], expected)
    }
}
