use serde_json::{json, Value};
type Result<T> = std::result::Result<T, String>;
fn string(v: &Value, key: &str, min: usize, max: usize, required: bool) -> Result<()> {
    match v.get(key) {
        None if !required => Ok(()),
        Some(x)
            if x.as_str().is_some_and(|s| {
                let n = s.encode_utf16().count();
                n >= min && n <= max
            }) =>
        {
            Ok(())
        }
        _ => Err("invalid_event_data".into()),
    }
}
pub fn normalize(typ: &str, mut data: Value) -> Result<Value> {
    let fields: &[&str] = match typ {
        "note.created" | "note.updated" => &["extId", "title", "content", "updatedAt"],
        "note.deleted" | "studyset.deleted" => &["extId"],
        "book.imported" => &[
            "extId",
            "title",
            "author",
            "metadata",
            "format",
            "folder",
            "contentHash",
            "chapters",
        ],
        "book.updated" => &["extId", "title", "author", "folder", "metadata"],
        "book.deleted" | "mindmap.deleted" => &["extId", "title"],
        "folder.created" | "folder.deleted" => &["extId", "name"],
        "studyset.created" | "studyset.updated" => &["extId", "name", "description", "bookIds"],
        "highlight.created" | "highlight.updated" => &[
            "extId",
            "bookExtId",
            "bookTitle",
            "chapterTitle",
            "citationLevel",
            "chapterId",
            "paraIndex",
            "start",
            "end",
            "pdfAnchor",
            "styleKind",
            "styleColor",
            "note",
            "noteExtId",
            "noteId",
            "name",
            "aiQa",
            "tags",
            "cloze",
            "review",
            "text",
        ],
        "highlight.deleted" => &["extId", "bookTitle"],
        "highlight.tagged" => &["extId", "tags"],
        "qa.recorded" => &["extId", "bookTitle", "question", "aiQa"],
        "review.updated" => &[
            "extId", "inReview", "review", "due", "reps", "lapses", "rating",
        ],
        "translation.created" => &[
            "extId",
            "bookExtId",
            "bookTitle",
            "chapterTitle",
            "targetLang",
            "scope",
            "text",
            "sourceLength",
        ],
        "mindmap.created" | "mindmap.updated" => &[
            "extId",
            "title",
            "bookExtId",
            "bookTitle",
            "root",
            "nodeCount",
        ],
        "association.created" | "association.updated" => &[
            "extId",
            "source",
            "target",
            "direction",
            "label",
            "pairKey",
            "createdAt",
            "updatedAt",
        ],
        "association.deleted" => &["extId", "pairKey"],
        _ => return Err("invalid_event_type".into()),
    };
    let object = data.as_object().ok_or("invalid_event_data")?;
    if object.keys().any(|k| !fields.contains(&k.as_str())) {
        return Err("unknown_field".into());
    }
    string(&data, "extId", 1, 64, true)?;
    let create = typ.ends_with(".created") || typ == "book.imported";
    for key in ["title", "author", "name", "bookTitle", "chapterTitle"] {
        if key == "name" && typ.starts_with("highlight.") && data.get(key) == Some(&Value::Null) {
            continue;
        }
        string(
            &data,
            key,
            if create && ["title", "name"].contains(&key) {
                1
            } else {
                0
            },
            255,
            create
                && matches!(
                    (typ, key),
                    ("note.created", "title")
                        | ("book.imported", "title")
                        | ("mindmap.created", "title")
                        | ("folder.created", "name")
                        | ("studyset.created", "name")
                        | ("studyset.updated", "name")
                ),
        )?;
    }
    for (key, max) in [
        ("content", 200000),
        (
            "text",
            if typ == "translation.created" {
                120000
            } else {
                20000
            },
        ),
        ("question", 20000),
        ("description", 20000),
        ("format", 16),
        ("folder", 255),
        ("contentHash", 64),
        ("styleColor", 32),
        ("targetLang", 32),
        ("bookExtId", 64),
        ("chapterId", 64),
    ] {
        if key == "chapterId" && data.get(key) == Some(&Value::Null) && typ == "highlight.updated" {
            continue;
        }
        string(
            &data,
            key,
            if ["text", "targetLang", "bookExtId"].contains(&key)
                && !(key == "bookExtId" && typ.starts_with("mindmap."))
            {
                1
            } else {
                0
            },
            max,
            create
                && matches!(
                    (typ, key),
                    ("note.created", "content")
                        | ("highlight.created", "text")
                        | ("highlight.created", "bookExtId")
                        | ("translation.created", "text")
                        | ("translation.created", "targetLang")
                        | ("translation.created", "bookExtId")
                ),
        )?;
    }
    for key in ["note", "name", "noteExtId", "noteId"] {
        if data.get(key).is_some_and(|v| !v.is_null()) {
            string(
                &data,
                key,
                0,
                if key == "note" {
                    20000
                } else if key == "name" {
                    255
                } else {
                    64
                },
                true,
            )?;
        }
    }
    if let (Some(a), Some(b)) = (data.get("noteExtId"), data.get("noteId")) {
        if a != b {
            return Err("conflicting_note_id".into());
        }
    }
    for key in [
        "updatedAt",
        "createdAt",
        "nodeCount",
        "sourceLength",
        "reps",
        "lapses",
        "paraIndex",
        "start",
        "end",
    ] {
        if let Some(v) = data.get(key) {
            if v.is_null()
                && typ == "highlight.updated"
                && ["paraIndex", "start", "end"].contains(&key)
            {
                continue;
            }
            if v.as_u64().is_none() {
                return Err("invalid_event_data".into());
            }
        }
    }
    if typ.starts_with("note.") && !typ.ends_with("deleted") && data["updatedAt"].as_u64().is_none()
    {
        return Err("invalid_event_data".into());
    }
    for (key, limit, max) in [("tags", 32, 64), ("cloze", 32, 255), ("bookIds", 2000, 64)] {
        if let Some(v) = data.get(key) {
            let a = v
                .as_array()
                .filter(|a| a.len() <= limit)
                .ok_or("invalid_event_data")?;
            for v in a {
                if v.as_str()
                    .is_none_or(|s| s.is_empty() || s.encode_utf16().count() > max)
                {
                    return Err("invalid_event_data".into());
                }
            }
        }
    }
    if typ == "highlight.tagged" && data.get("tags").is_none() {
        return Err("invalid_event_data".into());
    }
    if typ.starts_with("studyset.") && !typ.ends_with("deleted") && data.get("bookIds").is_none() {
        return Err("invalid_event_data".into());
    }
    if let Some(v) = data.get("aiQa") {
        let a = v
            .as_array()
            .filter(|a| a.len() <= 500)
            .ok_or("invalid_event_data")?;
        for v in a {
            let o = v.as_object().ok_or("invalid_event_data")?;
            if o.len() != 3
                || !v["q"].is_string()
                || !v["a"].is_string()
                || v["ts"].as_f64().is_none()
            {
                return Err("invalid_event_data".into());
            }
        }
    } else if typ == "qa.recorded" {
        return Err("invalid_event_data".into());
    }
    if let Some(v) = data.get("review").filter(|v| !v.is_null()) {
        let o = v.as_object().ok_or("invalid_event_data")?;
        if o.keys().any(|k| {
            ![
                "due",
                "reps",
                "lapses",
                "interval",
                "lastRating",
                "lastReviewedAt",
                "addedAt",
            ]
            .contains(&k.as_str())
        }) || ["due", "interval", "addedAt"]
            .iter()
            .any(|k| v[*k].as_f64().is_none())
            || ["reps", "lapses"].iter().any(|k| v[*k].as_u64().is_none())
            || v["interval"].as_f64().is_some_and(|n| n < 0.0)
        {
            return Err("invalid_event_data".into());
        }
    }
    for key in ["due"] {
        if data.get(key).is_some_and(|v| v.as_f64().is_none()) {
            return Err("invalid_event_data".into());
        }
    }
    if data.get("inReview").is_some_and(|v| !v.is_boolean())
        || data
            .get("rating")
            .is_some_and(|v| v.as_u64().is_none_or(|n| !(1..=4).contains(&n)))
    {
        return Err("invalid_event_data".into());
    }
    if let Some(v) = data.get("metadata").cloned() {
        let mut v = v;
        crate::legacy_validation::metadata(&mut v)?;
        data["metadata"] = v;
    }
    if let Some(v) = data.get("chapters") {
        let rows = v
            .as_array()
            .filter(|v| v.len() <= 500)
            .ok_or("invalid_chapters")?;
        for v in rows {
            let o = v.as_object().ok_or("invalid_chapters")?;
            if o.len() != 3
                || o.keys()
                    .any(|k| !["id", "title", "paragraphs"].contains(&k.as_str()))
            {
                return Err("invalid_chapters".into());
            }
            string(v, "id", 1, 64, true)?;
            string(v, "title", 1, 255, true)?;
            let p = v["paragraphs"]
                .as_array()
                .filter(|v| v.len() <= 2000)
                .ok_or("invalid_chapters")?;
            if p.iter()
                .any(|v| v.as_str().is_none_or(|s| s.encode_utf16().count() > 20000))
            {
                return Err("invalid_chapters".into());
            }
        }
    } else if typ == "book.imported" {
        return Err("invalid_chapters".into());
    }
    for (key, values) in [
        (
            "styleKind",
            &["underline", "background", "color", "none"][..],
        ),
        ("scope", &["passage", "chapter"][..]),
        ("citationLevel", &["book", "chapter", "content"][..]),
    ] {
        if data
            .get(key)
            .is_some_and(|v| v.as_str().is_none_or(|s| !values.contains(&s)))
        {
            return Err("invalid_event_data".into());
        }
    }
    if typ == "note.updated" && data.get("title").is_none() && data.get("content").is_none()
        || typ == "book.updated"
            && ["title", "author", "folder", "metadata"]
                .iter()
                .all(|k| data.get(*k).is_none())
        || typ == "review.updated"
            && ["inReview", "review", "due"]
                .iter()
                .all(|k| data.get(*k).is_none())
    {
        return Err("invalid_event_data".into());
    }
    if typ.starts_with("association.") && typ != "association.deleted" {
        crate::legacy_validation::association(&data, &Value::Null, true)?;
        let direction = data["direction"].as_str().ok_or("invalid_direction")?;
        for key in ["source", "target"] {
            let anchor = &data[key];
            if anchor["kind"] == "pdf" {
                pdf(&anchor["pdfAnchor"])?;
            } else if anchor["kind"] != "text" {
                return Err("invalid_anchor_kind".into());
            }
        }
        let expected =
            shufang_domain::associations::pair_key(&data["source"], &data["target"], direction)?;
        if data["pairKey"] != expected {
            return Err("invalid_pair_key".into());
        }
    }
    if typ == "association.deleted" && data.get("pairKey").is_some() {
        return Err("unknown_field".into());
    }
    if typ.starts_with("mindmap.") && !typ.ends_with("deleted") {
        if let Some(root) = data.get_mut("root") {
            tree(root, 0)?;
        } else if create {
            return Err("invalid_mindmap".into());
        }
        if create {
            string(&data, "bookExtId", 0, 64, true)?;
        }
        if typ == "mindmap.updated"
            && ["title", "bookExtId", "root"]
                .iter()
                .all(|k| data.get(*k).is_none())
        {
            return Err("invalid_mindmap".into());
        }
    }
    if let Some(anchor) = data.get("pdfAnchor").filter(|v| !v.is_null()) {
        pdf(anchor)?;
    }
    if typ == "highlight.created" {
        let level = data["citationLevel"].as_str().unwrap_or("content");
        if level == "chapter" {
            string(&data, "chapterId", 1, 64, true)?;
        }
        if level == "content" && data.get("pdfAnchor").is_none() {
            string(&data, "chapterId", 1, 64, true)?;
            if ["paraIndex", "start", "end"]
                .iter()
                .any(|k| data[*k].as_u64().is_none_or(|n| n > 20000000))
                || data["end"].as_u64() <= data["start"].as_u64()
            {
                return Err("invalid_citation".into());
            }
        }
    }
    for key in ["paraIndex", "start", "end"] {
        if data[key].as_u64().is_some_and(|n| n > 20000000) {
            return Err("invalid_citation".into());
        }
    }
    if data["sourceLength"].as_u64().is_some_and(|n| n > 120000)
        || data["nodeCount"].as_u64().is_some_and(|n| n > 1000000)
    {
        return Err("invalid_event_data".into());
    }
    for key in ["title", "name"] {
        if data.get(key).is_some()
            && ((key == "title"
                && !typ.ends_with("deleted")
                && (typ.starts_with("book.") || typ.starts_with("mindmap.")))
                || (key == "name" && (typ == "folder.created" || typ.starts_with("studyset."))))
        {
            let trimmed = data[key]
                .as_str()
                .ok_or("invalid_event_data")?
                .trim()
                .to_owned();
            if trimmed.is_empty() {
                return Err("invalid_event_data".into());
            }
            data[key] = json!(trimmed);
        }
    }
    let o = data.as_object_mut().unwrap();
    if typ == "book.imported" {
        for (k, v) in [
            ("format", json!("unknown")),
            ("folder", json!("")),
            ("contentHash", json!("")),
        ] {
            o.entry(k).or_insert(v);
        }
    }
    if typ == "highlight.created" {
        for (k, v) in [
            ("bookTitle", json!("")),
            ("chapterTitle", json!("")),
            ("styleKind", json!("underline")),
            ("styleColor", json!("orange")),
            ("citationLevel", json!("content")),
            ("chapterId", json!("")),
        ] {
            o.entry(k).or_insert(v);
        }
    }
    if typ == "translation.created" {
        o.entry("chapterTitle").or_insert(json!(""));
        o.entry("scope").or_insert(json!("passage"));
    }
    if let Some(v) = o.remove("noteId") {
        o.entry("noteExtId").or_insert(v);
    }
    Ok(data)
}

fn tree(v: &mut Value, depth: usize) -> Result<()> {
    if depth > 64 {
        return Err("invalid_mindmap".into());
    }
    let o = v.as_object().ok_or("invalid_mindmap")?;
    if o.keys().any(|k| {
        ![
            "id",
            "text",
            "chapterId",
            "sourceHighlightId",
            "collapsed",
            "children",
        ]
        .contains(&k.as_str())
    }) {
        return Err("invalid_mindmap".into());
    }
    string(v, "id", 1, 64, true)?;
    string(v, "text", 1, 255, true)?;
    string(v, "chapterId", 1, 64, false)?;
    string(v, "sourceHighlightId", 1, 64, false)?;
    if v.get("collapsed").is_some_and(|v| !v.is_boolean()) {
        return Err("invalid_mindmap".into());
    }
    if v.get("children").is_none() {
        v["children"] = json!([]);
    }
    let children = v["children"]
        .as_array_mut()
        .filter(|v| v.len() <= 200)
        .ok_or("invalid_mindmap")?;
    for child in children {
        tree(child, depth + 1)?;
    }
    Ok(())
}
fn pdf(v: &Value) -> Result<()> {
    let o = v.as_object().ok_or("invalid_pdf_anchor")?;
    if o.len() != 2
        || v["page"]
            .as_u64()
            .is_none_or(|n| !(1..=1000000).contains(&n))
    {
        return Err("invalid_pdf_anchor".into());
    }
    let rects = v["rects"]
        .as_array()
        .filter(|a| !a.is_empty() && a.len() <= 256)
        .ok_or("invalid_pdf_anchor")?;
    for r in rects {
        if r.as_object().is_none_or(|o| o.len() != 4)
            || ["x", "y", "width", "height"]
                .iter()
                .any(|k| r[*k].as_f64().is_none_or(|n| !(0.0..=1.0).contains(&n)))
            || r["width"].as_f64().unwrap_or(0.0) <= 0.0
            || r["height"].as_f64().unwrap_or(0.0) <= 0.0
            || r["x"].as_f64().unwrap() + r["width"].as_f64().unwrap() > 1.000001
            || r["y"].as_f64().unwrap() + r["height"].as_f64().unwrap() > 1.000001
        {
            return Err("invalid_pdf_anchor".into());
        }
    }
    Ok(())
}
pub fn upload(typ: &str, mut data: Value) -> Result<Value> {
    let fields: &[&str] = match typ {
        "book.import.started" => &[
            "extId",
            "uploadId",
            "chunkCount",
            "encodedBytes",
            "title",
            "author",
            "format",
            "folder",
            "contentHash",
            "chapterCount",
        ],
        "book.import.chunk" => &["extId", "uploadId", "chunkCount", "index", "payload"],
        "book.import.completed" => &["extId", "uploadId", "chunkCount", "encodedBytes"],
        _ => return Err("invalid_event_type".into()),
    };
    if data
        .as_object()
        .is_none_or(|o| o.keys().any(|k| !fields.contains(&k.as_str())))
    {
        return Err("invalid_event_data".into());
    }
    string(&data, "extId", 1, 64, true)?;
    string(&data, "uploadId", 1, 64, true)?;
    if !data["uploadId"]
        .as_str()
        .unwrap()
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
        || data["chunkCount"]
            .as_u64()
            .is_none_or(|n| !(1..=512).contains(&n))
    {
        return Err("invalid_upload".into());
    }
    if typ != "book.import.chunk"
        && data["encodedBytes"]
            .as_u64()
            .is_none_or(|n| !(2..=96 * 1024 * 1024).contains(&n))
    {
        return Err("invalid_upload_size".into());
    }
    if typ == "book.import.started" {
        string(&data, "title", 1, 255, true)?;
        string(&data, "author", 0, 255, true)?;
        string(&data, "format", 1, 16, true)?;
        string(&data, "folder", 0, 255, false)?;
        string(&data, "contentHash", 0, 64, false)?;
        if data["chapterCount"].as_u64().is_none_or(|n| n > 5000) {
            return Err("invalid_chapter_count".into());
        }
        let o = data.as_object_mut().unwrap();
        o.entry("folder").or_insert(json!(""));
        o.entry("contentHash").or_insert(json!(""));
    }
    if typ == "book.import.chunk"
        && (data["index"].as_u64().is_none_or(|n| n >= 512)
            || data["payload"]
                .as_str()
                .is_none_or(|s| s.is_empty() || s.len() > 512 * 1024))
    {
        return Err("invalid_chunk_payload".into());
    }
    Ok(data)
}
pub fn upload_chapters(chapters: &Value) -> Result<()> {
    let rows = chapters
        .as_array()
        .filter(|v| v.len() <= 5000)
        .ok_or("invalid_chapters")?;
    let mut paragraphs = 0usize;
    let mut notes = 0usize;
    let mut characters = 0usize;
    for chapter in rows {
        if chapter.as_object().is_none_or(|o| {
            o.keys()
                .any(|k| !["id", "title", "paragraphs", "footnotes"].contains(&k.as_str()))
        }) {
            return Err("invalid_chapters".into());
        }
        string(chapter, "id", 1, 64, true)?;
        string(chapter, "title", 0, 255, true)?;
        let parts = chapter["paragraphs"].as_array().ok_or("invalid_chapters")?;
        paragraphs += parts.len();
        for v in parts {
            characters = characters
                .checked_add(v.as_str().ok_or("invalid_chapters")?.encode_utf16().count())
                .ok_or("invalid_chapters")?;
        }
        if let Some(footnotes) = chapter.get("footnotes") {
            let fs = footnotes.as_array().ok_or("invalid_footnotes")?;
            notes += fs.len();
            for f in fs {
                if f.as_object().is_none_or(|o| o.len() != 4) {
                    return Err("invalid_footnotes".into());
                }
                let idx = f["paraIndex"]
                    .as_u64()
                    .and_then(|i| usize::try_from(i).ok())
                    .ok_or("invalid_footnotes")?;
                let paragraph = parts
                    .get(idx)
                    .and_then(Value::as_str)
                    .ok_or("invalid_footnotes")?;
                let start = f["start"].as_u64().ok_or("invalid_footnotes")?;
                let end = f["end"].as_u64().ok_or("invalid_footnotes")?;
                if start >= end || end > paragraph.encode_utf16().count() as u64 {
                    return Err("invalid_footnotes".into());
                }
                characters = characters
                    .checked_add(
                        f["content"]
                            .as_str()
                            .ok_or("invalid_footnotes")?
                            .encode_utf16()
                            .count(),
                    )
                    .ok_or("invalid_footnotes")?;
            }
        }
        if paragraphs > 250000 || notes > 250000 || characters > 70 * 1024 * 1024 {
            return Err("invalid_chapters".into());
        }
    }
    Ok(())
}
