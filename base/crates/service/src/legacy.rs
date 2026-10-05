//! Old Web REST wire projection. All writes still execute shared core use cases.
use crate::{call, error, kind, ApiResult, Host, V1Contract};
use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use serde_json::{json, Value};
use std::{collections::HashMap, sync::Arc};
pub const EVENT_TYPES: &[&str] = &[
    "book.imported",
    "book.updated",
    "book.deleted",
    "highlight.created",
    "highlight.updated",
    "highlight.deleted",
    "association.created",
    "association.updated",
    "association.deleted",
    "note.created",
    "note.updated",
    "note.deleted",
    "qa.recorded",
    "folder.created",
    "folder.deleted",
    "studyset.created",
    "studyset.updated",
    "studyset.deleted",
    "translation.created",
    "mindmap.created",
    "mindmap.updated",
    "mindmap.deleted",
    "highlight.tagged",
    "review.updated",
];

fn len(value: &Value) -> usize {
    value.as_str().unwrap_or("").encode_utf16().count()
}
pub fn project(
    name: &str,
    record: &Value,
    folders: &[Value],
    books: &[Value],
    summary: bool,
) -> Value {
    let v = &record["value"];
    let mut output = json!({"extId":v["id"],"createdAt":v["createdAt"]});
    let keys: &[&str] = match name {
        "books" => &[
            "title",
            "author",
            "metadata",
            "format",
            "contentHash",
            "updatedAt",
        ],
        "notes" => {
            if summary {
                &["title", "updatedAt"]
            } else {
                &["title", "content", "updatedAt"]
            }
        }
        "folders" => &["name"],
        "highlights" => &[
            "citationLevel",
            "chapterId",
            "chapterTitle",
            "text",
            "paraIndex",
            "start",
            "end",
            "pdfAnchor",
            "style",
            "note",
            "name",
            "aiQa",
            "tags",
            "cloze",
            "review",
        ],
        "translations" => &["chapterTitle", "targetLang", "scope", "text", "updatedAt"],
        "mindmaps" => &["title", "root", "updatedAt"],
        "associations" => &[
            "source",
            "target",
            "direction",
            "label",
            "pairKey",
            "updatedAt",
        ],
        "studysets" => &["name", "description", "bookIds", "updatedAt"],
        _ => &[],
    };
    for key in keys {
        if let Some(value) = v.get(*key) {
            output[*key] = value.clone();
        }
    }
    if name == "books" {
        if let Some(format) = v.get("legacyFormat") {
            output["format"] = format.clone();
        }
        output["metadata"] = v.get("metadata").cloned().unwrap_or(json!({"version":1}));
        output["contentHash"] = v.get("contentHash").cloned().unwrap_or(json!(""));
        output["chapterCount"] = v["chapters"].as_array().map_or(0, Vec::len).into();
        output["folder"] = folders
            .iter()
            .find(|r| r["value"]["id"] == v["folderId"] && v["folderId"].is_string())
            .map(|r| r["value"]["name"].clone())
            .unwrap_or_else(|| v.get("legacyFolder").cloned().unwrap_or(json!("")));
    }
    if name == "notes" && summary {
        output["chars"] = len(&v["content"]).into();
    }
    if ["highlights", "translations", "mindmaps"].contains(&name) {
        output["bookExtId"] = v.get("bookId").cloned().unwrap_or(json!(""));
        output["bookTitle"] = books
            .iter()
            .find(|r| r["value"]["id"] == v["bookId"])
            .map(|r| r["value"]["title"].clone())
            .unwrap_or(json!(""));
        if let Some(title) = v.get("legacyBookTitle") {
            output["bookTitle"] = title.clone();
        }
        if !output["chapterTitle"].is_string() && name != "mindmaps" {
            output["chapterTitle"] = "".into();
        }
    }
    if name == "highlights" {
        output["citationLevel"] = v.get("citationLevel").cloned().unwrap_or(json!("content"));
        output["style"] = v
            .get("style")
            .cloned()
            .unwrap_or(json!({"kind":"underline","color":"orange"}));
        for key in ["aiQa", "tags", "cloze"] {
            output[key] = v.get(key).cloned().unwrap_or(json!([]));
        }
        output["review"] = v.get("review").cloned().unwrap_or(Value::Null);
        if let Some(note) = v.get("noteId") {
            output["noteExtId"] = note.clone();
        }
        if output["chapterId"] == "" {
            output.as_object_mut().unwrap().remove("chapterId");
        }
    }
    if name == "associations" {
        for key in ["createdAt", "updatedAt"] {
            if let Some(value) = v.get(format!("legacy{}{}", key[..1].to_uppercase(), &key[1..])) {
                output[key] = value.clone();
            }
        }
        if let Ok(key) = shufang_domain::associations::pair_key(
            &v["source"],
            &v["target"],
            v["direction"].as_str().unwrap_or("bidirectional"),
        ) {
            output["pairKey"] = key.into();
        }
    }
    output
}
async fn context(h: Arc<Host>) -> Result<(Vec<Value>, Vec<Value>), (StatusCode, Json<Value>)> {
    let Json(folders) = call(h.clone(), "list", json!({"kind":"folders"})).await?;
    let Json(books) = call(h, "list", json!({"kind":"books"})).await?;
    Ok((
        folders.as_array().cloned().unwrap_or_default(),
        books.as_array().cloned().unwrap_or_default(),
    ))
}
pub async fn list(
    State(h): State<Arc<Host>>,
    Path(name): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> ApiResult {
    let k = kind(&name).map_err(error)?;
    let Json(rows) = call(h.clone(), "list", json!({"kind":k})).await?;
    if h.v1_contract == V1Contract::SyncEntities {
        if rows.as_array().into_iter().flatten().any(|r| {
            r["pendingFields"]
                .as_array()
                .is_some_and(|fields| !fields.is_empty())
        }) {
            return Err(error("sync_field_pending".into()));
        }
        let values: Vec<_> = rows
            .as_array()
            .into_iter()
            .flatten()
            .map(sync_project)
            .filter(|v| query.get("book").is_none_or(|b| v["bookId"] == *b))
            .filter(|v| {
                query
                    .get("folder")
                    .is_none_or(|f| v.get("folderId").and_then(Value::as_str).unwrap_or("") == f)
            })
            .collect();
        return Ok(Json(json!({name:values})));
    }
    let (folders, books) = context(h).await?;
    let values: Vec<_> = rows
        .as_array()
        .into_iter()
        .flatten()
        .map(|r| project(&name, r, &folders, &books, true))
        .filter(|v| {
            query.get("book").is_none_or(|b| match name.as_str() {
                "highlights" | "translations" | "mindmaps" => v["bookExtId"] == *b,
                "associations" => v["source"]["bookId"] == *b || v["target"]["bookId"] == *b,
                _ => true,
            })
        })
        .filter(|v| {
            query
                .get("folder")
                .is_none_or(|f| name != "books" || v["folder"] == *f)
        })
        .collect();
    Ok(Json(json!({name:values})))
}
pub async fn one(
    State(h): State<Arc<Host>>,
    Path((name, id)): Path<(String, String)>,
) -> ApiResult {
    let k = kind(&name).map_err(error)?;
    let Json(record) = call(h.clone(), "get", json!({"kind":k,"id":id})).await?;
    if h.v1_contract == V1Contract::SyncEntities {
        return Ok(Json(sync_project(&record)));
    }
    let (folders, books) = context(h).await?;
    Ok(Json(project(&name, &record, &folders, &books, false)))
}
fn sync_project(record: &Value) -> Value {
    let mut value = record["value"].clone();
    value["extId"] = value["id"].clone();
    value
}
fn string(value: &Value, key: &str, max: usize, required: bool) -> Result<(), String> {
    match value.get(key) {
        None if !required => Ok(()),
        Some(Value::Null) if !required && ["name", "note"].contains(&key) => Ok(()),
        Some(Value::String(s)) if len(&json!(s)) <= max && (!required || !s.trim().is_empty()) => {
            Ok(())
        }
        _ => Err(format!("invalid_{key}")),
    }
}
fn patch(
    name: &str,
    body: &Value,
    prior: &Value,
    create: bool,
) -> Result<(Value, Vec<String>), String> {
    let fields = body.as_object().ok_or("invalid_body")?;
    let allowed: &[&str] = match name {
        "books" => &[
            "extId",
            "revision",
            "title",
            "author",
            "metadata",
            "format",
            "folder",
            "contentHash",
            "chapters",
        ],
        "notes" => &["extId", "revision", "title", "content"],
        "folders" => &["extId", "revision", "name"],
        "highlights" => &[
            "extId",
            "revision",
            "bookExtId",
            "bookTitle",
            "citationLevel",
            "chapterId",
            "chapterTitle",
            "text",
            "paraIndex",
            "start",
            "end",
            "pdfAnchor",
            "styleKind",
            "styleColor",
            "note",
            "name",
            "noteExtId",
            "aiQa",
            "tags",
            "cloze",
            "review",
        ],
        "translations" => &[
            "extId",
            "revision",
            "bookExtId",
            "bookTitle",
            "chapterTitle",
            "targetLang",
            "scope",
            "text",
        ],
        "mindmaps" => &[
            "extId",
            "revision",
            "title",
            "bookExtId",
            "bookTitle",
            "root",
        ],
        "associations" => &[
            "extId",
            "revision",
            "source",
            "target",
            "direction",
            "label",
            "pairKey",
            "createdAt",
            "updatedAt",
        ],
        "studysets" => &["extId", "revision", "name", "description", "bookIds"],
        _ => return Err("not_found".into()),
    };
    if ["notes", "highlights", "associations"].contains(&name)
        && fields.keys().any(|s| !allowed.contains(&s.as_str()))
    {
        return Err("unknown_field".into());
    }
    if name == "highlights" && !create && fields.contains_key("aiQa") {
        return Err("unknown_field".into());
    }
    for key in ["title", "author", "name", "chapterTitle", "bookTitle"] {
        string(
            body,
            key,
            255,
            create
                && matches!(
                    (name, key),
                    ("books", "title")
                        | ("notes", "title")
                        | ("mindmaps", "title")
                        | ("folders", "name")
                        | ("studysets", "name")
                ),
        )?;
    }
    if ["notes", "highlights", "translations"].contains(&name) {
        string(
            body,
            if name == "notes" { "content" } else { "text" },
            if name == "translations" {
                120000
            } else if name == "notes" {
                200000
            } else {
                20000
            },
            create && name != "notes",
        )?;
    }
    if create && ["highlights", "translations", "mindmaps"].contains(&name) {
        string(body, "bookExtId", 64, true)?;
    }
    let mut result = serde_json::Map::new();
    let mut unset = Vec::new();
    for (key, value) in fields {
        if !allowed.contains(&key.as_str()) {
            continue;
        }
        if [
            "extId",
            "revision",
            "bookTitle",
            "createdAt",
            "updatedAt",
            "styleKind",
            "styleColor",
            "pairKey",
        ]
        .contains(&key.as_str())
        {
            continue;
        }
        let mapped = match key.as_str() {
            "bookExtId" => "bookId",
            "noteExtId" => "noteId",
            "folder" => "legacyFolder",
            _ => key,
        };
        if value.is_null() || key == "noteExtId" && value == "" {
            unset.push(mapped.to_string());
        } else {
            result.insert(mapped.into(), value.clone());
        }
    }
    let empty = prior.is_null();
    if name == "notes" && !result.contains_key("content") {
        result.insert("content".into(), json!(""));
    }
    if ["translations", "mindmaps"].contains(&name) && (create || fields.contains_key("bookTitle"))
    {
        result.insert(
            "legacyBookTitle".into(),
            fields.get("bookTitle").cloned().unwrap_or(json!("")),
        );
    }
    if name == "books" && create {
        if !result.contains_key("author") && empty {
            result.insert("author".into(), json!(""));
        }
        if !result.contains_key("format") {
            result.insert("format".into(), json!("unknown"));
        }
        if !result.contains_key("chapters") {
            return Err("invalid_chapters".into());
        }
        let chapters = result["chapters"]
            .as_array()
            .filter(|a| a.len() <= 500)
            .ok_or("invalid_chapters")?;
        for chapter in chapters {
            string(chapter, "id", 64, true)?;
            string(chapter, "title", 255, true)?;
            if chapter["paragraphs"].as_array().is_none_or(|a| {
                a.len() > 2000 || a.iter().any(|p| !p.is_string() || len(p) > 20000)
            }) {
                return Err("invalid_paragraphs".into());
            }
        }
    }
    if name == "books"
        && !create
        && ["chapters", "format", "contentHash"]
            .iter()
            .any(|s| fields.contains_key(*s))
    {
        return Err("immutable_book_content".into());
    }
    if name == "books" {
        for (key, max) in [("format", 16), ("folder", 255), ("contentHash", 64)] {
            string(body, key, max, false)?;
        }
        if let Some(format) = result.get("format").cloned() {
            if ![
                "pdf", "epub", "mobi", "azw3", "fb2", "txt", "builtin", "unknown",
            ]
            .contains(&format.as_str().unwrap_or(""))
            {
                result.insert("legacyFormat".into(), format);
                result.insert("format".into(), json!("unknown"));
            } else {
                unset.push("legacyFormat".into());
            }
        }
        if fields.contains_key("folder") {
            unset.push("folderId".into());
        }
        if let Some(metadata) = result.get_mut("metadata") {
            crate::legacy_validation::metadata(metadata)?;
            if metadata["version"] != 1 {
                return Err("invalid_metadata".into());
            }
            if let Some(contributors) = metadata["contributors"].as_array() {
                let author = contributors
                    .iter()
                    .filter(|v| v["role"] == "author")
                    .filter_map(|v| v["name"].as_str())
                    .collect::<Vec<_>>()
                    .join("；");
                if !author.is_empty() {
                    if fields.get("author").is_some_and(|a| a != &author) {
                        return Err("conflicting_author".into());
                    }
                    result.insert("author".into(), author.into());
                }
            }
        }
    }
    if name == "highlights" {
        crate::legacy_validation::highlight(body)?;
        let level = fields
            .get("citationLevel")
            .or_else(|| prior.get("citationLevel"))
            .and_then(Value::as_str)
            .unwrap_or("content");
        if create || fields.contains_key("citationLevel") {
            result.insert("citationLevel".into(), json!(level));
        }
        if fields.contains_key("citationLevel") && level != "content" {
            for key in ["paraIndex", "start", "end", "pdfAnchor"] {
                result.remove(key);
                unset.push(key.into());
            }
            if level == "book" {
                result.remove("chapterId");
                unset.push("chapterId".into());
            }
        }
        if empty || fields.contains_key("styleKind") || fields.contains_key("styleColor") {
            let kind = body
                .get("styleKind")
                .cloned()
                .or_else(|| prior["style"].get("kind").cloned())
                .unwrap_or(json!("underline"));
            if !["underline", "background", "color", "none"].contains(&kind.as_str().unwrap_or(""))
            {
                return Err("invalid_style".into());
            }
            result.insert("style".into(),json!({"kind":kind,"color":body.get("styleColor").cloned().or_else(||prior["style"].get("color").cloned()).unwrap_or(json!("orange"))}));
        }
    }
    if name == "translations" {
        if fields
            .get("scope")
            .is_some_and(|s| s != "passage" && s != "chapter")
        {
            return Err("invalid_scope".into());
        }
        if empty && !fields.contains_key("scope") {
            result.insert("scope".into(), json!("passage"));
        }
        string(body, "targetLang", 32, create)?;
    }
    if name == "associations" {
        let source = result.get("source").unwrap_or(&prior["source"]);
        crate::legacy_validation::association(body, prior, create)?;
        let target = result.get("target").unwrap_or(&prior["target"]);
        let direction = result
            .get("direction")
            .or_else(|| prior.get("direction"))
            .and_then(Value::as_str)
            .unwrap_or("bidirectional");
        let key = shufang_domain::associations::pair_key(source, target, direction)?;
        if fields.get("pairKey").is_some_and(|v| v != &key) {
            return Err("invalid_pairKey".into());
        }
        result.insert("pairKey".into(), key.into());
        for key in ["createdAt", "updatedAt"] {
            if let Some(value) = fields.get(key) {
                if value.as_u64().is_none_or(|n| n > 8_640_000_000_000_000) {
                    return Err("invalid_association_timestamp".into());
                }
                if key != "createdAt" || empty {
                    result.insert(
                        format!("legacy{}{}", key[..1].to_uppercase(), &key[1..]),
                        value.clone(),
                    );
                }
            }
        }
    }
    if name == "mindmaps" {
        if let Some(root) = result.get_mut("root") {
            crate::legacy_validation::tree(root, 0)?;
        }
    }
    Ok((Value::Object(result), unset))
}
pub(crate) async fn sync_mutation(
    h: Arc<Host>,
    name: &str,
    id: &str,
    headers: &HeaderMap,
    body: &Value,
    create: bool,
    deleted: bool,
) -> ApiResult {
    sync_mutation_source(h, name, id, headers, body, create, deleted, "api").await
}
#[allow(clippy::too_many_arguments)]
pub(crate) async fn sync_mutation_source(
    h: Arc<Host>,
    name: &str,
    id: &str,
    headers: &HeaderMap,
    body: &Value,
    create: bool,
    deleted: bool,
    source: &str,
) -> ApiResult {
    let k = kind(name).map_err(error)?;
    let mut patch = body
        .as_object()
        .cloned()
        .ok_or_else(|| error("invalid_patch".into()))?;
    patch.remove("extId");
    patch.remove("id");
    if let Some(value) = patch.remove("bookExtId") {
        patch.insert("bookId".into(), value);
    }
    if let Some(value) = patch.remove("folder") {
        patch.insert("folderId".into(), value);
    }
    if create {
        if k == "books" {
            patch.entry("author".to_owned()).or_insert(json!(""));
            patch.entry("format".to_owned()).or_insert(json!("txt"));
            patch.entry("chapters".to_owned()).or_insert(json!([]));
            patch.entry("coverTone".to_owned()).or_insert(json!(0));
            let chapter = patch["chapters"][0]["id"].as_str().unwrap_or("").to_owned();
            patch
                .entry("progress".to_owned())
                .or_insert(json!({"chapterId":chapter,"ratio":0}));
        }
        if k == "notes" {
            patch.entry("content".to_owned()).or_insert(json!(""));
        }
        if k == "translations" || k == "highlights" {
            patch.entry("chapterId".to_owned()).or_insert(json!(""));
        }
        if k == "highlights" {
            patch.entry("chapterTitle".to_owned()).or_insert(json!(""));
            patch.entry("text".to_owned()).or_insert(json!(""));
        }
    }
    let operation_id = headers
        .get("idempotency-key")
        .map(|h| h.to_str().map(str::to_owned))
        .transpose()
        .map_err(|_| error("invalid_operation_id".into()))?
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    use shufang_application::{ReplicationRepository, Repository};
    let mut core = h
        .workspace
        .core
        .lock()
        .map_err(|_| error("core_lock_failed".into()))?;
    if core
        .repository()
        .operation(&operation_id)
        .map_err(error)?
        .is_some()
    {
        core.local_replica_command_with_creation(
            k,
            id,
            &operation_id,
            patch,
            vec![],
            deleted,
            create,
        )
        .map_err(error)?;
    } else {
        let revision = core
            .repository()
            .load(k, id)
            .map_err(error)?
            .map_or(0, |row| row.revision)
            + 1;
        let resource = match k {
            "mindMaps" => "mindmap",
            "studySets" => "studyset",
            _ => k.strip_suffix('s').unwrap_or(k),
        };
        let action = if deleted {
            "deleted"
        } else if create {
            "created"
        } else {
            "updated"
        };
        let mut data = body.clone();
        data["extId"] = json!(id);
        let extra = vec![crate::webhooks::override_commit_source(
            &core,
            k,
            id,
            revision,
            &format!("{resource}.{action}"),
            data,
            source,
        )
        .map_err(error)?];
        let fingerprint = serde_json::to_string(
            &json!({"kind":k,"id":id,"patch":patch,"create":create,"deleted":deleted}),
        )
        .map_err(|e| error(e.to_string()))?;
        core.with_receipt(
            &format!("api-command:{operation_id}"),
            &fingerprint,
            extra,
            |c| {
                c.local_replica_command_with_creation(
                    k,
                    id,
                    &operation_id,
                    patch,
                    vec![],
                    deleted,
                    create,
                )
                .map(|_| ())
            },
        )
        .map_err(error)?;
    }
    Ok(Json(json!({"ok":true,"extId":id})))
}
pub async fn create(
    State(h): State<Arc<Host>>,
    Path(name): Path<String>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Result<(StatusCode, Json<Value>), (StatusCode, Json<Value>)> {
    if h.v1_contract == V1Contract::SyncEntities {
        let id = body["extId"]
            .as_str()
            .or_else(|| body["id"].as_str())
            .ok_or_else(|| error("invalid_id".into()))?;
        return sync_mutation(h, &name, id, &headers, &body, true, false)
            .await
            .map(|v| (StatusCode::OK, v));
    }
    let k = kind(&name).map_err(error)?;
    string(&body, "extId", 64, true).map_err(error)?;
    let id = body["extId"].as_str().unwrap();
    let prior = match call(h.clone(), "get", json!({"kind":k,"id":id})).await {
        Ok(Json(v)) => v,
        Err((status, Json(v))) if status == StatusCode::NOT_FOUND && v["error"] == "not_found" => {
            Value::Null
        }
        Err((_, Json(v))) if v["error"] == "entity_deleted" => {
            return Err((
                StatusCode::CONFLICT,
                Json(json!({"error":format!("{}_deleted",name.trim_end_matches('s'))})),
            ))
        }
        Err(e) => return Err(e),
    };
    let (patch, unset) = patch(&name, &body, &prior["value"], true).map_err(error)?;
    if name == "associations" && !prior.is_null() {
        let existing = shufang_domain::associations::pair_key(
            &prior["value"]["source"],
            &prior["value"]["target"],
            prior["value"]["direction"]
                .as_str()
                .unwrap_or("bidirectional"),
        )
        .map_err(error)?;
        if patch["pairKey"] != existing {
            return Err(error("association_conflict".into()));
        }
        return Ok((
            StatusCode::OK,
            Json(json!({"ok":true,"created":false,"extId":id,"pairKey":existing})),
        ));
    }
    let pair = patch["pairKey"].clone();
    let _=call(h,"save",json!({"kind":k,"id":id,"patch":patch,"unset":unset,"expected":prior["revision"].as_u64().unwrap_or(0)})).await?;
    if name == "associations" {
        return Ok((
            StatusCode::CREATED,
            Json(json!({"ok":true,"created":true,"extId":id,"pairKey":pair})),
        ));
    }
    Ok((StatusCode::CREATED, Json(json!({"ok":true,"extId":id}))))
}
pub async fn update(
    State(h): State<Arc<Host>>,
    Path((name, id)): Path<(String, String)>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> ApiResult {
    if h.v1_contract == V1Contract::SyncEntities {
        return sync_mutation(h, &name, &id, &headers, &body, false, false).await;
    }
    let k = kind(&name).map_err(error)?;
    let Json(prior) = call(h.clone(), "get", json!({"kind":k,"id":id})).await?;
    let expected = body["revision"]
        .as_u64()
        .or_else(|| {
            headers
                .get("if-match")
                .and_then(|v| v.to_str().ok())
                .and_then(|s| s.trim_matches('"').parse().ok())
        })
        .unwrap_or(prior["revision"].as_u64().unwrap_or(0));
    let (patch, unset) = patch(&name, &body, &prior["value"], false).map_err(error)?;
    let Json(saved) = call(
        h,
        "save",
        json!({"kind":k,"id":id,"patch":patch,"unset":unset,"expected":expected}),
    )
    .await?;
    if name == "associations" {
        return Ok(Json(
            json!({"ok":true,"association":project(&name,&saved,&[],&[],false)}),
        ));
    }
    Ok(Json(json!({"ok":true})))
}
pub async fn remove(
    State(h): State<Arc<Host>>,
    Path((name, id)): Path<(String, String)>,
    headers: HeaderMap,
) -> ApiResult {
    if h.v1_contract == V1Contract::SyncEntities {
        return sync_mutation(h, &name, &id, &headers, &json!({}), false, true).await;
    }
    if name != "notes" {
        return crate::remove(State(h), Path((name, id)), headers).await;
    }
    let Json(prior) = call(h.clone(), "get", json!({"kind":"notes","id":id})).await?;
    let expected = headers
        .get("if-match")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.trim_matches('"').parse::<u64>().ok())
        .unwrap_or(prior["revision"].as_u64().unwrap_or(0));
    let _ = call(h, "deleteLegacyNote", json!({"id":id,"expected":expected})).await?;
    Ok(Json(json!({"ok":true})))
}
pub async fn chapters(State(h): State<Arc<Host>>, Path(id): Path<String>) -> ApiResult {
    let Json(book) = call(h.clone(), "get", json!({"kind":"books","id":id})).await?;
    if h.v1_contract == V1Contract::SyncEntities {
        return Ok(Json(json!({"chapters":book["value"]["chapters"]})));
    }
    let rows:Vec<_>=book["value"]["chapters"].as_array().into_iter().flatten().enumerate().map(|(index,c)|json!({"index":index,"id":c["id"],"title":c["title"],"paragraphs":c["paragraphs"].as_array().map_or(0,Vec::len),"chars":c["paragraphs"].as_array().into_iter().flatten().map(len).sum::<usize>()})).collect();
    Ok(Json(json!({"chapters":rows})))
}
pub async fn chapter(
    State(h): State<Arc<Host>>,
    Path((id, index)): Path<(String, String)>,
) -> ApiResult {
    let index = index
        .parse::<usize>()
        .map_err(|_| error("not_found".into()))?;
    let Json(book) = call(h.clone(), "get", json!({"kind":"books","id":id})).await?;
    let mut value = book["value"]["chapters"]
        .get(index)
        .cloned()
        .ok_or_else(|| error("not_found".into()))?;
    if h.v1_contract == V1Contract::Mirror {
        value["index"] = index.into();
    }
    Ok(Json(value))
}
pub async fn reader_state(State(h): State<Arc<Host>>, Path(id): Path<String>) -> ApiResult {
    let Json(book) = call(h.clone(), "get", json!({"kind":"books","id":id})).await?;
    if h.v1_contract == V1Contract::SyncEntities {
        return Ok(Json(sync_project(&book)));
    }
    let mut state = json!({});
    for key in ["progress", "lastOpenedAt"] {
        if let Some(v) = book["value"].get(key) {
            state[key] = v.clone();
        }
    }
    Ok(Json(json!({"state":state})))
}
pub async fn events(State(h): State<Arc<Host>>, Json(mut event): Json<Value>) -> ApiResult {
    use sha2::{Digest, Sha256};
    if event.as_object().is_none_or(|o| {
        o.keys()
            .any(|k| !["deliveryId", "type", "data"].contains(&k.as_str()))
    }) {
        return Err(error("invalid_event".into()));
    }
    if event.get("deliveryId").is_none() {
        event["deliveryId"] = uuid::Uuid::new_v4().to_string().into();
    }
    let delivery = event["deliveryId"]
        .as_str()
        .filter(|s| {
            (16..=64).contains(&s.len())
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
        })
        .ok_or_else(|| error("invalid_delivery_id".into()))?;
    let typ = event["type"]
        .as_str()
        .ok_or_else(|| error("invalid_event_type".into()))?;
    if !EVENT_TYPES.contains(&typ)
        && ![
            "book.import.started",
            "book.import.chunk",
            "book.import.completed",
        ]
        .contains(&typ)
    {
        return Err(error("invalid_event_type".into()));
    }
    let mut data = event["data"].clone();
    if !data.is_object() {
        return Err(error("invalid_event_data".into()));
    }
    if h.v1_contract == crate::V1Contract::SyncEntities && typ.starts_with("book.import.") {
        data = crate::reader_event::upload(typ, data).map_err(error)?;
    }
    if h.v1_contract == crate::V1Contract::SyncEntities && !typ.starts_with("book.import.") {
        let normalized = crate::reader_event::normalize(typ, data).map_err(error)?;
        let (prefix, action) = typ
            .split_once('.')
            .ok_or_else(|| error("invalid_event_type".into()))?;
        let k = match prefix {
            "book" => "books",
            "note" => "notes",
            "folder" => "folders",
            "highlight" | "qa" | "review" => "highlights",
            "association" => "associations",
            "translation" => "translations",
            "mindmap" => "mindMaps",
            "studyset" => "studySets",
            _ => return Err(error("invalid_event_type".into())),
        };
        let mut values = normalized.as_object().unwrap().clone();
        let id = values.remove("extId").unwrap();
        for (old, new) in [
            ("bookExtId", "bookId"),
            ("noteExtId", "noteId"),
            ("folder", "folderId"),
        ] {
            if let Some(v) = values.remove(old) {
                values.insert(new.into(), v);
            }
        }
        let operation = format!("event-{:x}", Sha256::digest(delivery.as_bytes()));
        let fingerprint = format!(
            "{:x}",
            Sha256::digest(json!({"type":typ,"data":normalized}).to_string().as_bytes())
        );
        let receipt = format!("event:{delivery}");
        let typ = typ.to_owned();
        let create = ["created", "imported"].contains(&action);
        let deleted = action == "deleted";
        let workspace = h.workspace.clone();
        tokio::task::spawn_blocking(move || -> Result<(), String> {
            use shufang_application::{ReplicationRepository, Repository};
            let mut core = workspace.core.lock().map_err(|_| "core_lock_failed")?;
            if let Some((_, prior)) = core.local_value(&receipt)? {
                return if prior["fingerprint"] == fingerprint {
                    Ok(())
                } else {
                    Err("delivery_conflict".into())
                };
            }
            let previous = core.repository().operation(&operation)?;
            if create {
                let clock = core.mutation_clock(&operation)?;
                let now = clock
                    .split(':')
                    .next()
                    .ok_or("invalid_clock")?
                    .parse::<u64>()
                    .map_err(|_| "invalid_clock")?;
                values.entry("createdAt").or_insert(json!(now));
            }
            let id = id.as_str().ok_or("invalid_extId")?;
            let revision = core.repository().load(k, id)?.map_or(0, |v| v.revision);
            let extra = if previous.is_some() {
                vec![]
            } else {
                vec![crate::webhooks::override_commit(
                    &core,
                    k,
                    id,
                    revision + 1,
                    &typ,
                    normalized,
                )?]
            };
            core.with_receipt(&receipt, &fingerprint, extra, |c| {
                let (duplicate, _) =
                    c.local_replica_command(k, id, &operation, values, vec![], deleted)?;
                if duplicate {
                    c.commit_receipt()?;
                }
                Ok(())
            })?;
            Ok(())
        })
        .await
        .map_err(|_| error("event_failed".into()))?
        .map_err(error)?;
        return Ok(Json(json!({"ok":true,"mirrored":true})));
    }
    let fingerprint = format!(
        "{:x}",
        Sha256::digest(json!({"type":typ,"data":data}).to_string().as_bytes())
    );
    let receipt = format!("event:{delivery}");
    let mut core = h
        .workspace
        .core
        .lock()
        .map_err(|_| error("core_lock_failed".into()))?;
    core.purge_transport_cache().map_err(error)?;
    if let Some((_, value)) = core.local_value(&receipt).map_err(error)? {
        return if value["fingerprint"] == fingerprint {
            Ok(Json(json!({"ok":true,"mirrored":true,"duplicate":true})))
        } else {
            Err(error("delivery_conflict".into()))
        };
    }
    if core.transport_usage("event:").map_err(error)?.0 >= 100_000 {
        return Err(error("transport_cache_limit".into()));
    }
    let id = data["extId"]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 64)
        .ok_or_else(|| error("invalid_extId".into()))?
        .to_owned();
    if typ.starts_with("book.import.") {
        let upload = data["uploadId"]
            .as_str()
            .filter(|s| {
                !s.is_empty()
                    && s.len() <= 64
                    && s.bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
            })
            .ok_or_else(|| error("invalid_upload_id".into()))?;
        let key = if h.v1_contract == crate::V1Contract::SyncEntities {
            format!(
                "upload:{:x}",
                Sha256::digest(format!("{id}\0{upload}").as_bytes())
            )
        } else {
            format!("upload:{upload}")
        };
        let (revision, mut state) = core
            .local_value(&key)
            .map_err(error)?
            .unwrap_or((0, Value::Null));
        if state.is_null() && h.v1_contract == crate::V1Contract::SyncEntities {
            if let shufang_native::storage::Storage::Mysql(repo) = core.repository() {
                if let Some(legacy) = repo.legacy_upload(&id, upload).map_err(error)? {
                    state = legacy;
                }
            }
        }
        let count = data["chunkCount"]
            .as_u64()
            .filter(|n| (1..=512).contains(n))
            .ok_or_else(|| error("invalid_chunk_count".into()))?;
        match typ {
            "book.import.started" => {
                let (slots, bytes) = core.transport_usage("upload:").map_err(error)?;
                if state.is_null() && (slots >= 1024 || bytes >= 256 * 1024 * 1024) {
                    return Err(error("transport_cache_limit".into()));
                }
                let size = data["encodedBytes"]
                    .as_u64()
                    .filter(|n| (2..=96 * 1024 * 1024).contains(n))
                    .ok_or_else(|| error("invalid_upload_size".into()))?;
                if !state.is_null() && state["manifest"] != data {
                    return Err(error("upload_conflict".into()));
                }
                string(&data, "title", 255, true).map_err(error)?;
                string(&data, "author", 255, false).map_err(error)?;
                if data["chapterCount"].as_u64().is_none_or(|n| n > 5000) {
                    return Err(error("invalid_chapter_count".into()));
                }
                if core
                    .entity("books", &id)
                    .is_err_and(|e| e == "entity_deleted")
                {
                    return Err(error("book_deleted".into()));
                }
                if state.is_null() {
                    state = json!({"version":1,"manifest":data,"chunks":{},"bytes":0,"limit":size,"expires":now()+86400000});
                }
                core.with_receipt(&receipt, &fingerprint, vec![], |c| {
                    c.set_local_value(&key, revision, &state).map(|_| ())
                })
                .map_err(error)?;
            }
            "book.import.chunk" => {
                if core
                    .transport_usage("upload:")
                    .map_err(error)?
                    .1
                    .saturating_add(data["payload"].as_str().map_or(0, |s| s.len() as u64))
                    > 256 * 1024 * 1024
                {
                    return Err(error("transport_cache_limit".into()));
                }
                if state.is_null() {
                    return Err(error("upload_not_found".into()));
                }
                if state["expires"].as_u64().unwrap_or(0) < now() {
                    return Err(error("upload_expired".into()));
                }
                if state["manifest"]["extId"] != id || state["manifest"]["chunkCount"] != count {
                    return Err(error("upload_conflict".into()));
                }
                let index = data["index"]
                    .as_u64()
                    .filter(|i| *i < count)
                    .ok_or_else(|| error("invalid_chunk_index".into()))?
                    .to_string();
                let payload = data["payload"]
                    .as_str()
                    .filter(|s| !s.is_empty() && s.len() <= 512 * 1024)
                    .ok_or_else(|| error("invalid_chunk_payload".into()))?;
                if let Some(old) = state["chunks"].get(&index) {
                    if old != payload {
                        return Err(error("upload_conflict".into()));
                    }
                } else {
                    let size = state["bytes"].as_u64().unwrap_or(0) + payload.len() as u64;
                    if size > state["limit"].as_u64().unwrap_or(0) {
                        return Err(error("invalid_upload_size".into()));
                    }
                    state["bytes"] = size.into();
                    state["chunks"][&index] = payload.into();
                }
                core.with_receipt(&receipt, &fingerprint, vec![], |c| {
                    c.set_local_value(&key, revision, &state).map(|_| ())
                })
                .map_err(error)?;
            }
            "book.import.completed" => {
                if state.is_null() {
                    return Err(error("upload_not_found".into()));
                }
                if state["expires"].as_u64().unwrap_or(0) < now() {
                    return Err(error("upload_expired".into()));
                }
                if state["manifest"]["extId"] != id
                    || state["manifest"]["chunkCount"] != count
                    || data["encodedBytes"] != state["manifest"]["encodedBytes"]
                {
                    return Err(error("upload_conflict".into()));
                }
                let mut payload = String::new();
                for i in 0..count {
                    payload.push_str(
                        state["chunks"][i.to_string()]
                            .as_str()
                            .ok_or_else(|| error("upload_incomplete".into()))?,
                    );
                }
                if payload.len() as u64 != data["encodedBytes"].as_u64().unwrap_or(0) {
                    return Err(error("invalid_upload_size".into()));
                }
                let chapters: Value =
                    serde_json::from_str(&payload).map_err(|_| error("invalid_chapters".into()))?;
                if chapters.as_array().is_none_or(|c| {
                    c.len() as u64 != state["manifest"]["chapterCount"].as_u64().unwrap_or(0)
                }) {
                    return Err(error("invalid_chapters".into()));
                }
                let mut body = state["manifest"].clone();
                for key in ["uploadId", "chunkCount", "encodedBytes", "chapterCount"] {
                    body.as_object_mut().unwrap().remove(key);
                }
                body["chapters"] = chapters;
                if h.v1_contract == crate::V1Contract::SyncEntities {
                    crate::reader_event::upload_chapters(&body["chapters"]).map_err(error)?;
                }
                if h.v1_contract == crate::V1Contract::SyncEntities {
                    use shufang_application::{ReplicationRepository, Repository};
                    let operation = format!(
                        "legacy-upload-{:x}",
                        Sha256::digest(format!("{id}:{upload}").as_bytes())
                    );
                    let prior = core.repository().load("books", &id).map_err(error)?;
                    let mut values = body
                        .as_object()
                        .cloned()
                        .ok_or_else(|| error("invalid_body".into()))?;
                    values.remove("extId");
                    if let Some(folder) = values.remove("folder") {
                        values.insert("folderId".into(), folder);
                    }
                    if prior.is_none() {
                        values.insert("coverTone".into(), json!(0));
                        values.insert("progress".into(),json!({"chapterId":body["chapters"][0]["id"].as_str().unwrap_or(""),"ratio":0}));
                        let clock = core.mutation_clock(&operation).map_err(error)?;
                        values.insert(
                            "createdAt".into(),
                            json!(clock
                                .split(':')
                                .next()
                                .ok_or_else(|| error("invalid_clock".into()))?
                                .parse::<u64>()
                                .map_err(|_| error("invalid_clock".into()))?),
                        );
                    }
                    let previous = core.repository().operation(&operation).map_err(error)?;
                    if previous.is_some() {
                        return Ok(Json(json!({"ok":true,"mirrored":true})));
                    }
                    let extra = vec![shufang_application::LocalCommit {
                        key: key.clone(),
                        expected: revision,
                        value: {
                            let mut completed = state.clone();
                            completed["completed"] = json!(true);
                            completed["expires"] = json!(now() + 7 * 86400000);
                            completed
                        },
                    }];
                    core.with_receipt(&receipt, &fingerprint, extra, |c| {
                        c.local_replica_command("books", &id, &operation, values, vec![], false)
                            .map(|_| ())
                    })
                    .map_err(error)?;
                    return Ok(Json(json!({"ok":true,"mirrored":true})));
                }
                let prior = match core.entity("books", &id) {
                    Ok(r) => serde_json::to_value(r).unwrap(),
                    Err(e) if e == "not_found" => Value::Null,
                    Err(e) => return Err(error(e)),
                };
                let (patch, unset) = patch("books", &body, &prior["value"], true).map_err(error)?;
                let extra = vec![shufang_application::LocalCommit {
                    key: key.clone(),
                    expected: revision,
                    value: json!({"version":1,"completed":true,"expires":now()+7*86_400_000}),
                }, crate::webhooks::override_commit(&core,"books",&id,prior["revision"].as_u64().unwrap_or(0)+1,"book.imported",json!({"extId":id,"title":body["title"],"author":body["author"],"format":body["format"],"metadata":body["metadata"],"folder":body["folder"],"contentHash":body["contentHash"],"chapterCount":body["chapters"].as_array().map_or(0,Vec::len)})).map_err(error)?];
                core.with_receipt(&receipt, &fingerprint, extra, |c| {
                    c.save_entity(
                        "books",
                        &id,
                        patch,
                        unset,
                        prior["revision"].as_u64().unwrap_or(0),
                    )
                    .map(|_| ())
                })
                .map_err(error)?;
            }
            _ => return Err(error("invalid_event_type".into())),
        }
        return Ok(Json(json!({"ok":true,"mirrored":true})));
    }
    let (prefix, action) = typ
        .split_once('.')
        .ok_or_else(|| error("invalid_event_type".into()))?;
    let name = match prefix {
        "book" => "books",
        "note" => "notes",
        "highlight" | "review" | "qa" => "highlights",
        "folder" => "folders",
        "association" => "associations",
        "translation" => "translations",
        "mindmap" => "mindmaps",
        "studyset" => "studysets",
        _ => return Err(error("invalid_event_type".into())),
    };
    let k = kind(name).map_err(error)?;
    let prior = match core.entity(k, &id) {
        Ok(r) => serde_json::to_value(r).unwrap(),
        Err(e) if e == "not_found" => Value::Null,
        Err(e) if e == "entity_deleted" && action == "deleted" => Value::Null,
        Err(e) if e == "entity_deleted" => {
            return Err((
                StatusCode::CONFLICT,
                Json(json!({"error":format!("{}_deleted",prefix)})),
            ))
        }
        Err(e) => return Err(error(e)),
    };
    let expected = prior["revision"].as_u64().unwrap_or(0);
    let mut outgoing = event["data"].clone();
    if typ == "book.imported" {
        outgoing["chapterCount"] = outgoing["chapters"].as_array().map_or(0, Vec::len).into();
        outgoing.as_object_mut().unwrap().retain(|key, _| {
            [
                "extId",
                "title",
                "author",
                "format",
                "folder",
                "contentHash",
                "metadata",
                "chapterCount",
            ]
            .contains(&key.as_str())
        });
    }
    let extra = if action == "deleted" && prior.is_null() {
        vec![]
    } else {
        vec![
            crate::webhooks::override_commit(&core, k, &id, expected + 1, typ, outgoing)
                .map_err(error)?,
        ]
    };
    if action == "deleted" {
        core.with_receipt(&receipt, &fingerprint, extra, |c| {
            if prior.is_null() {
                c.commit_receipt()
            } else if name == "notes" {
                c.delete_legacy_note(&id, expected)
            } else {
                c.delete_entity(k, &id, expected)
            }
        })
        .map_err(error)?;
    } else {
        if let Some(note) = data.get("noteId").cloned() {
            if data.get("noteExtId").is_some_and(|v| v != &note) {
                return Err(error("conflicting_note_id".into()));
            }
            data["noteExtId"] = note;
            data.as_object_mut().unwrap().remove("noteId");
        }
        for key in ["updatedAt", "nodeCount", "sourceLength", "question"] {
            data.as_object_mut().unwrap().remove(key);
        }
        if prefix == "review" {
            if data["inReview"] == false {
                data["review"] = Value::Null;
            } else if data.get("review").is_none() && data.get("due").is_some() {
                let mut review = prior["value"]["review"].clone();
                if !review.is_object() {
                    review = json!({"due":now(),"reps":0,"lapses":0,"interval":0,"addedAt":now()});
                }
                for key in ["due", "reps", "lapses"] {
                    if let Some(v) = data.get(key) {
                        review[key] = v.clone();
                    }
                }
                data["review"] = review;
            } else if data["inReview"] == true && data.get("review").is_none() {
                data["review"] =
                    json!({"due":now(),"reps":0,"lapses":0,"interval":0,"addedAt":now()});
            }
            for key in ["inReview", "due", "reps", "lapses", "rating"] {
                data.as_object_mut().unwrap().remove(key);
            }
        }
        if !["created", "updated", "imported", "recorded", "tagged"].contains(&action) {
            return Err(error("invalid_event_type".into()));
        }
        let create = action == "created" || action == "imported";
        let (patch, unset) = patch(name, &data, &prior["value"], create).map_err(error)?;
        core.with_receipt(&receipt, &fingerprint, extra, |c| {
            c.save_entity(k, &id, patch, unset, expected).map(|_| ())
        })
        .map_err(error)?;
    }
    Ok(Json(json!({"ok":true,"mirrored":true})))
}
fn now() -> u64 {
    use shufang_application::Runtime;
    shufang_native::workspace::SystemRuntime.now()
}
pub async fn due(
    State(h): State<Arc<Host>>,
    Query(query): Query<HashMap<String, String>>,
) -> ApiResult {
    let Json(rows) = call(h.clone(), "list", json!({"kind":"highlights"})).await?;
    let (folders, books) = context(h).await?;
    let timestamp = now();
    let mut cards: Vec<_> = rows
        .as_array()
        .into_iter()
        .flatten()
        .filter(|r| {
            r["value"]["review"].is_object()
                && (query.get("all").is_some_and(|s| s == "1")
                    || r["value"]["review"]["due"].as_u64().unwrap_or(u64::MAX) <= timestamp)
        })
        .map(|r| project("highlights", r, &folders, &books, false))
        .collect();
    cards.sort_by_key(|r| r["review"]["due"].as_u64().unwrap_or(0));
    Ok(Json(
        json!({"now":timestamp,"count":cards.len(),"cards":cards}),
    ))
}
pub async fn digest(State(h): State<Arc<Host>>, Path(hash): Path<String>) -> ApiResult {
    let core = h
        .workspace
        .core
        .lock()
        .map_err(|_| error("core_lock_failed".into()))?;
    let value = core
        .local_value(&format!("digest:{hash}"))
        .map_err(error)?
        .map(|(_, v)| v)
        .filter(|v| v["invalidated"] != true)
        .ok_or_else(|| error("not_found".into()))?;
    Ok(Json(value))
}
async fn answer(h: Arc<Host>, request: Value) -> Result<String, (StatusCode, Json<Value>)> {
    let Json(start) = call(h.clone(), "ai", request).await?;
    let id = start["job"]
        .as_str()
        .ok_or_else(|| error("invalid_ai_job".into()))?;
    loop {
        let Json(job) = call(h.clone(), "job", json!({"id":id})).await?;
        if job["status"] == "completed" {
            let text = job["result"]["text"].as_str().unwrap_or("").to_owned();
            let _ = call(h, "forgetJob", json!({"id":id})).await?;
            return Ok(text);
        }
        if job["status"] != "running" {
            let message = job["error"].as_str().unwrap_or("ai_failed").to_owned();
            let _ = call(h, "forgetJob", json!({"id":id})).await?;
            return Err(error(message));
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
}
pub async fn ask(State(h): State<Arc<Host>>, Json(body): Json<Value>) -> ApiResult {
    string(&body, "question", 20000, true).map_err(error)?;
    string(&body, "selection", 20000, false).map_err(error)?;
    string(&body, "chapterContext", 30000, false).map_err(error)?;
    string(&body, "structure", 100000, false).map_err(error)?;
    let mut overview = String::new();
    let mut structure = body["structure"].as_str().unwrap_or("").to_owned();
    if let Some(hash) = body["contentHash"].as_str() {
        if hash.len() != 64 {
            return Err(error("invalid_content_hash".into()));
        }
        let cached = {
            h.workspace
                .core
                .lock()
                .map_err(|_| error("core_lock_failed".into()))?
                .local_value(&format!("digest:{hash}"))
                .map_err(error)?
        };
        if let Some((_, value)) = cached.as_ref().filter(|(_, v)| v["invalidated"] != true) {
            overview = value["overview"].as_str().unwrap_or("").to_owned();
            structure = value["structure"].as_str().unwrap_or("").to_owned();
        } else if !structure.is_empty() {
            overview=answer(h.clone(),json!({"task":"digest","text":structure,"question":"根据全书结构写一段200字以内的导读。"})).await.unwrap_or_default();
            let mut core = h
                .workspace
                .core
                .lock()
                .map_err(|_| error("core_lock_failed".into()))?;
            if let Some(book) = core
                .entities("books")
                .map_err(error)?
                .iter()
                .find(|r| r.value["contentHash"] == hash)
            {
                let value = json!({"version":1,"id":now(),"contentHash":hash,"title":book.value["title"],"author":book.value["author"],"structure":structure,"overview":overview,"createdAt":now(),"updatedAt":now()});
                core.set_local_value(
                    &format!("digest:{hash}"),
                    cached.map_or(0, |(r, _)| r),
                    &value,
                )
                .map_err(error)?;
            }
        }
    }
    let text = format!(
        "全书导读：{overview}\n全书结构：{}\n当前章节：{}\n划线文段：{}",
        structure.chars().take(8000).collect::<String>(),
        body["chapterContext"].as_str().unwrap_or(""),
        body["selection"].as_str().unwrap_or("")
    );
    let result = answer(
        h.clone(),
        json!({"task":"chat","text":text,"question":body["question"]}),
    )
    .await?;
    if let Some(id) = body["highlightExtId"].as_str() {
        let mut core = h
            .workspace
            .core
            .lock()
            .map_err(|_| error("core_lock_failed".into()))?;
        if let Ok(prior) = core.entity("highlights", id) {
            let mut qa = prior.value["aiQa"].as_array().cloned().unwrap_or_default();
            if qa.len() >= 500 {
                return Err(error("qa_limit".into()));
            }
            qa.push(json!({"q":body["question"],"a":result,"ts":now()}));
            core.save_entity("highlights", id, json!({"aiQa":qa}), vec![], prior.revision)
                .map_err(error)?;
        }
    }
    Ok(Json(
        json!({"answer":result,"cachedDigest":!overview.is_empty()&&body["contentHash"].is_string()}),
    ))
}
pub async fn translate(State(h): State<Arc<Host>>, Json(body): Json<Value>) -> ApiResult {
    string(&body, "text", 120000, true).map_err(error)?;
    string(&body, "bookExtId", 64, true).map_err(error)?;
    let lang = body["targetLang"].as_str().unwrap_or("中文");
    if !["中文", "English", "日本語", "Français", "Deutsch"].contains(&lang) {
        return Err(error("invalid_target_language".into()));
    }
    let mode = body["mode"].as_str().unwrap_or("passage");
    if !["passage", "chapter"].contains(&mode) {
        return Err(error("invalid_translation_scope".into()));
    }
    let _ = call(
        h.clone(),
        "get",
        json!({"kind":"books","id":body["bookExtId"]}),
    )
    .await?;
    let translation=answer(h.clone(),json!({"task":"translate","text":body["text"],"targetLang":lang,"question":if mode=="chapter"{"严格保持段落顺序，以空行分隔，不合并或拆分段落。"}else{"保持原文语气与专名。"}})).await?;
    let id = body["extId"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    if id.len() > 64 {
        return Err(error("invalid_extId".into()));
    }
    let request = json!({"extId":id,"bookExtId":body["bookExtId"],"chapterTitle":body["chapterTitle"].as_str().unwrap_or(""),"targetLang":lang,"scope":mode,"text":translation});
    let _ = create(
        State(h),
        Path("translations".into()),
        HeaderMap::new(),
        Json(request),
    )
    .await?;
    Ok(Json(
        json!({"extId":id,"translation":translation,"targetLang":lang}),
    ))
}
pub async fn directory() -> Json<Value> {
    Json(
        json!({"name":"Shufang API","version":"1.0","auth":"X-API-Key or Authorization: Bearer <API key>","eventTypes":EVENT_TYPES,"webhookSignature":"X-Shufang-Signature: sha256=<hmac(secret, body)>","endpoints":["GET/POST /api/v1/books","GET/PATCH/DELETE /api/v1/books/:extId","GET /api/v1/books/:extId/state","GET /api/v1/books/:extId/chapters","GET /api/v1/books/:extId/chapters/:index","GET /api/v1/digest/:contentHash","GET/POST /api/v1/highlights","PATCH/DELETE /api/v1/highlights/:extId","GET /api/v1/review/due","GET/POST /api/v1/associations","GET/PATCH/DELETE /api/v1/associations/:extId","GET/POST /api/v1/notes","GET/PATCH/DELETE /api/v1/notes/:extId","GET/POST /api/v1/folders","DELETE /api/v1/folders/:extId","POST /api/v1/ask","POST /api/v1/translate","GET/POST /api/v1/translations","DELETE /api/v1/translations/:extId","GET/POST /api/v1/mindmaps","GET/PATCH/DELETE /api/v1/mindmaps/:extId","POST /api/v1/events","GET/POST /api/v1/webhooks","PATCH/DELETE /api/v1/webhooks/:id","POST /api/v1/webhooks/:id/test","GET/POST /api/v1/studysets"]}),
    )
}

pub async fn book_state(
    State(h): State<Arc<Host>>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(input): Json<Value>,
) -> ApiResult {
    if h.v1_contract != V1Contract::SyncEntities {
        return Err(error("unsupported_state_mutation".into()));
    }
    sync_mutation(h, "books", &id, &headers, &input, false, false).await
}
