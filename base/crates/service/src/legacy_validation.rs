use serde_json::{json, Value};
type Result<T> = std::result::Result<T, String>;
pub fn association(body: &Value, prior: &Value, create: bool) -> Result<()> {
    if !create
        && ![
            "source",
            "target",
            "direction",
            "label",
            "pairKey",
            "updatedAt",
        ]
        .iter()
        .any(|k| body.get(*k).is_some())
    {
        return Err("invalid_association".into());
    }
    if body
        .get("label")
        .is_some_and(|v| !v.is_null() && !string(v, 255, false))
    {
        return Err("invalid_association".into());
    }
    for key in ["source", "target"] {
        if let Some(anchor) = body.get(key) {
            let allowed = if anchor["kind"] == "text" {
                vec![
                    "kind",
                    "bookId",
                    "chapterId",
                    "chapterTitle",
                    "text",
                    "paraIndex",
                    "start",
                    "end",
                ]
            } else {
                vec![
                    "kind",
                    "bookId",
                    "chapterId",
                    "chapterTitle",
                    "text",
                    "pdfAnchor",
                ]
            };
            if anchor
                .as_object()
                .is_none_or(|o| o.keys().any(|k| !allowed.contains(&k.as_str())))
                || !string(&anchor["bookId"], 64, true)
                || !string(&anchor["chapterId"], 64, true)
                || !string(&anchor["chapterTitle"], 255, false)
                || !string(&anchor["text"], 20000, true)
            {
                return Err("invalid_association".into());
            }
            if anchor["kind"] == "text"
                && (["paraIndex", "start", "end"]
                    .iter()
                    .any(|k| anchor[*k].as_u64().is_none_or(|n| n > 20000000))
                    || anchor["end"].as_u64() <= anchor["start"].as_u64())
            {
                return Err("invalid_association".into());
            }
        } else if create {
            return Err("invalid_association".into());
        }
    }
    if create
        && ["direction", "pairKey", "createdAt", "updatedAt"]
            .iter()
            .any(|k| body.get(*k).is_none())
    {
        return Err("invalid_association".into());
    }
    let created = body
        .get("createdAt")
        .or_else(|| prior.get("legacyCreatedAt"))
        .or_else(|| prior.get("createdAt"));
    if let (Some(created), Some(updated)) = (created, body.get("updatedAt")) {
        if created.as_u64().is_none()
            || updated.as_u64().is_none()
            || updated.as_u64() < created.as_u64()
        {
            return Err("invalid_association".into());
        }
    }
    Ok(())
}
fn string(v: &Value, max: usize, nonempty: bool) -> bool {
    v.as_str()
        .is_some_and(|s| s.encode_utf16().count() <= max && (!nonempty || !s.is_empty()))
}
pub fn metadata(value: &mut Value) -> Result<()> {
    let object = value.as_object_mut().ok_or("invalid_metadata")?;
    let allowed = [
        "version",
        "subtitle",
        "contributors",
        "publisher",
        "publishedDate",
        "languages",
        "identifiers",
        "series",
        "seriesIndex",
        "subjects",
        "description",
        "edition",
        "rights",
        "rating",
    ];
    if object.keys().any(|s| !allowed.contains(&s.as_str()))
        || object.get("version") != Some(&json!(1))
    {
        return Err("invalid_metadata".into());
    }
    for (key, max) in [
        ("subtitle", 255),
        ("publisher", 255),
        ("series", 255),
        ("description", 20000),
        ("edition", 128),
        ("rights", 2000),
    ] {
        if object.get(key).is_some_and(|v| !string(v, max, false)) {
            return Err("invalid_metadata".into());
        }
    }
    for (key, max) in [("rating", 5.0), ("seriesIndex", 100000.0)] {
        if object
            .get(key)
            .is_some_and(|v| v.as_f64().is_none_or(|n| !(0.0..=max).contains(&n)))
        {
            return Err("invalid_metadata".into());
        }
    }
    if let Some(v) = object.get("publishedDate") {
        let date = v.as_str().ok_or("invalid_metadata")?;
        let parts = date.split('-').collect::<Vec<_>>();
        if parts.is_empty()
            || parts.len() > 3
            || parts[0].len() != 4
            || parts.iter().skip(1).any(|p| p.len() != 2)
            || parts.iter().any(|p| !p.bytes().all(|b| b.is_ascii_digit()))
        {
            return Err("invalid_metadata".into());
        }
        let year = parts[0].parse::<i32>().map_err(|_| "invalid_metadata")?;
        let month = parts
            .get(1)
            .unwrap_or(&"01")
            .parse()
            .map_err(|_| "invalid_metadata")?;
        let day = parts
            .get(2)
            .unwrap_or(&"01")
            .parse()
            .map_err(|_| "invalid_metadata")?;
        if year < 100 || chrono::NaiveDate::from_ymd_opt(year, month, day).is_none() {
            return Err("invalid_metadata".into());
        }
    }
    for (key, maxlen) in [("subjects", 64), ("languages", 64)] {
        if let Some(v) = object.get(key) {
            let array = v
                .as_array()
                .filter(|a| a.len() <= 32)
                .ok_or("invalid_metadata")?;
            for v in array {
                if !string(v, maxlen, true) {
                    return Err("invalid_metadata".into());
                }
                if key == "languages" {
                    let parts = v.as_str().unwrap().split('-').collect::<Vec<_>>();
                    let first = parts[0];
                    if !((2..=8).contains(&first.len())
                        && first.bytes().all(|b| b.is_ascii_alphabetic())
                        || first.eq_ignore_ascii_case("x") && parts.len() > 1)
                        || parts.iter().skip(1).any(|s| {
                            s.is_empty()
                                || s.len() > 8
                                || !s.bytes().all(|b| b.is_ascii_alphanumeric())
                        })
                    {
                        return Err("invalid_metadata".into());
                    }
                }
            }
        }
    }
    for (key, limit) in [("contributors", 64), ("identifiers", 32)] {
        if let Some(v) = object.get_mut(key) {
            let array = v
                .as_array_mut()
                .filter(|a| a.len() <= limit)
                .ok_or("invalid_metadata")?;
            for v in array {
                let o = v.as_object_mut().ok_or("invalid_metadata")?;
                let (a, b) = if key == "contributors" {
                    ("name", "role")
                } else {
                    ("scheme", "value")
                };
                if o.len() != 2 || !o.contains_key(a) || !o.contains_key(b) {
                    return Err("invalid_metadata".into());
                }
                for field in [a, b] {
                    let s = o[field]
                        .as_str()
                        .ok_or("invalid_metadata")?
                        .trim()
                        .to_owned();
                    if s.is_empty()
                        || s.encode_utf16().count() > if field == "scheme" { 32 } else { 255 }
                    {
                        return Err("invalid_metadata".into());
                    }
                    o.insert(field.into(), s.into());
                }
                if key == "contributors"
                    && !["author", "editor", "translator", "illustrator", "other"]
                        .contains(&o["role"].as_str().unwrap())
                {
                    return Err("invalid_metadata".into());
                }
            }
        }
    }
    if let Some(contributors) = object.get("contributors").and_then(Value::as_array) {
        let authors = contributors
            .iter()
            .filter(|v| v["role"] == "author")
            .map(|v| v["name"].as_str().unwrap())
            .collect::<Vec<_>>()
            .join("；");
        if authors.encode_utf16().count() > 255 {
            return Err("invalid_metadata".into());
        }
    }
    if serde_json::to_vec(value)
        .map_err(|_| "invalid_metadata")?
        .len()
        > 60000
    {
        return Err("invalid_metadata".into());
    }
    Ok(())
}
pub fn highlight(body: &Value) -> Result<()> {
    for (key, max) in [("note", 20000), ("styleColor", 32), ("noteExtId", 64)] {
        if body
            .get(key)
            .is_some_and(|v| !v.is_null() && !string(v, max, false))
        {
            return Err(format!("invalid_{key}"));
        }
    }
    for (key, max) in [("tags", 64), ("cloze", 255)] {
        if body.get(key).is_some_and(|v| {
            v.as_array()
                .is_none_or(|a| a.len() > 32 || a.iter().any(|v| !string(v, max, true)))
        }) {
            return Err(format!("invalid_{key}"));
        }
    }
    if let Some(v) = body.get("aiQa") {
        if v.as_array().is_none_or(|a| {
            a.iter().any(|v| {
                v.as_object().is_none_or(|o| o.len() != 3)
                    || !v["q"].is_string()
                    || !v["a"].is_string()
                    || !v["ts"].is_number()
            })
        }) {
            return Err("invalid_aiQa".into());
        }
    }
    if let Some(v) = body.get("review").filter(|v| !v.is_null()) {
        if !v.is_object()
            || !v["due"].is_number()
            || !v["addedAt"].is_number()
            || v["interval"].as_f64().is_none_or(|n| n < 0.0)
            || ["reps", "lapses"].iter().any(|k| v[*k].as_u64().is_none())
            || v.get("lastRating")
                .is_some_and(|v| v.as_u64().is_none_or(|n| !(1..=4).contains(&n)))
            || v.get("lastReviewedAt").is_some_and(|v| !v.is_number())
        {
            return Err("invalid_review".into());
        }
    }
    Ok(())
}
pub fn tree(value: &mut Value, depth: usize) -> Result<()> {
    if depth > 64
        || !string(&value["id"], 64, true)
        || !string(&value["text"], 255, true)
        || value
            .get("chapterId")
            .is_some_and(|v| !string(v, 64, false))
        || value.get("collapsed").is_some_and(|v| !v.is_boolean())
    {
        return Err("invalid_mindmap".into());
    }
    if value.get("children").is_none() {
        value["children"] = json!([]);
    }
    let children = value["children"]
        .as_array_mut()
        .filter(|a| a.len() <= 200)
        .ok_or("invalid_mindmap")?;
    for child in children {
        tree(child, depth + 1)?;
    }
    Ok(())
}
