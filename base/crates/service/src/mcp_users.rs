//! Explicit user capability catalogue. Never dispatch caller-supplied commands or paths.
use crate::{ApiResult, Host};
use axum::{
    extract::{Path, State},
    Json,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::Arc;

const KINDS: &[(&str, &str)] = &[
    ("book", "books"),
    ("folder", "folders"),
    ("note", "notes"),
    ("highlight", "highlights"),
    ("association", "associations"),
    ("translation", "translations"),
    ("mindmap", "mindMaps"),
    ("studyset", "studySets"),
    ("preference", "preferences"),
];
#[derive(Clone)]
pub(crate) enum Action {
    List(&'static str),
    Get(&'static str),
    Create(&'static str),
    Update(&'static str),
    Delete(&'static str),
    Source,
    Import,
    ParseSource,
    SourceChunk,
    SourceComplete,
    Cover,
    Chapters,
    Chapter,
    Outline,
    EditOutline,
    Checkpoint,
    Review,
    Enrollment,
    Citation,
    Search,
    Versions,
    CreateVersion,
    DeleteVersion,
    RestoreEntity,
    Ai(&'static str),
    AiConfig,
    SaveAiConfig,
    Job,
    CancelJob,
    ForgetJob,
    Metadata,
    Rendition,
}
pub(crate) struct Spec {
    pub name: String,
    pub schema: Value,
    pub write: bool,
    pub destructive: bool,
    pub action: Action,
    pub description: String,
}
fn id() -> Value {
    json!({"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_.:-]+$"})
}
fn number(max: u64) -> Value {
    json!({"type":"integer","minimum":0,"maximum":max})
}
fn object() -> Value {
    json!({"type":"object"})
}
fn string(max: usize) -> Value {
    json!({"type":"string","maxLength":max})
}
fn schema(properties: Value, required: &[&str]) -> Value {
    json!({"type":"object","properties":properties,"required":required,"additionalProperties":false})
}
fn spec(
    name: &str,
    description: &str,
    action: Action,
    write: bool,
    destructive: bool,
    properties: Value,
    required: &[&str],
) -> Spec {
    Spec {
        name: name.into(),
        description: description.into(),
        action,
        write,
        destructive,
        schema: schema(properties, required),
    }
}
pub(crate) fn catalogue() -> Vec<Spec> {
    let mut out = Vec::new();
    for &(singular, kind) in KINDS {
        out.push(spec(
            &format!("list_library_{}", kind.to_ascii_lowercase()),
            "分页列出完整用户记录；包含 revision。offset/limit 用于读取后续页。",
            Action::List(kind),
            false,
            false,
            json!({"offset":number(1000000),"limit":{"type":"integer","minimum":1,"maximum":100}}),
            &[],
        ));
        if singular != "note" {
            out.push(spec(
                &format!("get_{singular}"),
                "按 ID 读取完整用户记录及 revision。",
                Action::Get(kind),
                false,
                false,
                json!({"id":id()}),
                &["id"],
            ));
        }
        out.push(spec(
            &format!("create_{singular}"),
            "创建用户记录。id 和 operation_id 由调用方生成以便安全重试；data 使用书库业务字段。",
            Action::Create(kind),
            true,
            false,
            json!({"id":id(),"operation_id":id(),"data":data_schema(kind)}),
            &["id", "operation_id", "data"],
        ));
        out.push(spec(&format!("update_{singular}"),"修改用户记录；expected 必须等于当前 revision，operation_id 用于幂等重试。",Action::Update(kind),true,false,json!({"id":id(),"expected":number(u64::MAX),"operation_id":id(),"data":data_schema(kind),"unset":{"type":"array","items":{"type":"string"},"maxItems":50}}),&["id","expected","operation_id","data"]));
        out.push(spec(
            &format!("delete_{singular}"),
            "删除用户记录；检查 expected revision，使用 operation_id 安全重试。",
            Action::Delete(kind),
            true,
            true,
            json!({"id":id(),"expected":number(u64::MAX),"operation_id":id()}),
            &["id", "expected", "operation_id"],
        ));
    }
    out.extend([
        spec("get_book_source","分页读取完整原文件。返回 base64、size、next_offset；重复调用直到 next_offset 为 null。",Action::Source,false,false,json!({"id":id(),"offset":number(536870912),"limit":{"type":"integer","minimum":1,"maximum":262144}}),&["id"]),
        spec("import_book","导入 base64 编码的原书文件，支持 txt/epub/pdf/mobi/azw3/fb2。返回可轮询的 job。大文件可用创建书籍及原文件分块工具。",Action::Import,true,false,json!({"filename":string(200),"payload":string(12000000),"operation_id":id()}),&["filename","payload","operation_id"]),
        spec("parse_book_source","从已上传的原文件解析正文到同一本书，保持书名/作者及自定义封面；会替换章节并重置阅读进度，返回 job。用于大文件分块导入的最后一步。",Action::ParseSource,true,true,json!({"id":id(),"expected":number(u64::MAX),"operation_id":id()}),&["id","expected","operation_id"]),
        spec("upload_book_source_chunk","上传原文件的一块（最多 262144 字节）；uploadId 为完整文件 SHA-256，同一索引重复内容可安全重试。",Action::SourceChunk,true,false,json!({"id":id(),"upload_id":string(64),"index":number(2048),"payload":string(350000)}),&["id","upload_id","index","payload"]),
        spec("complete_book_source","校验原文件 SHA-256、大小与所有分块，并关联到书籍。",Action::SourceComplete,true,false,json!({"id":id(),"sha256":string(64),"size":number(268435456),"name":string(255),"mime_type":string(128)}),&["id","sha256","size","name","mime_type"]),
        spec("set_book_cover","更换封面；cover 为图片 data URL，解码并限制尺寸后保存。null 表示移除自定义封面。",Action::Cover,true,false,json!({"id":id(),"expected":number(u64::MAX),"operation_id":id(),"cover":{"type":["string","null"],"maxLength":12000000}}),&["id","expected","operation_id","cover"]),
        spec("get_book_chapters","读取完整章节及原文。",Action::Chapters,false,false,json!({"id":id()}),&["id"]),
        spec("get_book_chapter","按零起始章节索引读取完整原文。",Action::Chapter,false,false,json!({"id":id(),"index":number(1000000)}),&["id","index"]),
        spec("get_book_outline","读取书籍目录。",Action::Outline,false,false,json!({"id":id()}),&["id"]),
        spec("edit_book_outline","添加、重命名、缩进、移位或删除目录项；data 使用现有 editOutline 业务参数，entry_id 是要编辑的目录项 ID。",Action::EditOutline,true,false,json!({"id":id(),"expected":number(u64::MAX),"operation_id":id(),"data":object()}),&["id","expected","operation_id","data"]),
        spec("save_reading_progress","保存阅读进度和本次有效阅读秒数，更新阅读记录。",Action::Checkpoint,true,false,json!({"id":id(),"session":id(),"progress":object(),"active_seconds":number(86400),"operation_id":id()}),&["id","session","progress","active_seconds","operation_id"]),
        spec("review_highlight","复习书摘卡片，rating 为 1 到 4；检查当前 revision。",Action::Review,true,false,json!({"id":id(),"expected":number(u64::MAX),"operation_id":id(),"rating":{"type":"integer","minimum":1,"maximum":4}}),&["id","expected","operation_id","rating"]),
        spec("set_review_enrollment","将书摘加入或移出复习队列。",Action::Enrollment,true,false,json!({"id":id(),"expected":number(u64::MAX),"operation_id":id(),"enabled":{"type":"boolean"}}),&["id","expected","operation_id","enabled"]),
        spec("link_citation","关联书摘和笔记，原子检查双方 revision。",Action::Citation,true,false,json!({"highlight_id":id(),"note_id":id(),"highlight_revision":number(u64::MAX),"note_revision":number(u64::MAX),"operation_id":id()}),&["highlight_id","note_id","highlight_revision","note_revision","operation_id"]),
        spec("search_library","搜索完整书库内容。",Action::Search,false,false,json!({"query":string(200)}),&["query"]),
        spec("list_versions","列出可手动选择的书库版本。",Action::Versions,false,false,json!({}),&[]),
        spec("create_version","创建可用于单条恢复的版本快照；不自动删除旧版本。",Action::CreateVersion,true,false,json!({}),&[]),
        spec("delete_version","删除用户选择的版本快照。",Action::DeleteVersion,true,true,json!({"version_id":id()}),&["version_id"]),
        spec("restore_version_entity","从版本恢复一条用户记录，可指定 new_entity_id。不会恢复整库或切换写入者。",Action::RestoreEntity,true,true,json!({"version_id":id(),"kind":{"type":"string","enum":KINDS.iter().map(|(_,k)|*k).collect::<Vec<_>>()},"id":id(),"new_entity_id":id(),"operation_id":id()}),&["version_id","kind","id","operation_id"]),
        spec("get_ai_config","读取 AI 模型配置，不返回密钥。",Action::AiConfig,false,false,json!({}),&[]),
        spec("save_ai_config","保存 AI 模型配置；可设置 API Key，但不会返回 Key。",Action::SaveAiConfig,true,false,json!({"expected":number(u64::MAX),"config":object(),"api_key":string(512)}),&["expected","config"]),
        spec("get_job","查询导入、AI 或元数据作业状态。",Action::Job,false,false,json!({"job_id":id()}),&["job_id"]),
        spec("cancel_job","取消用户作业。",Action::CancelJob,true,false,json!({"job_id":id()}),&["job_id"]),
        spec("forget_job","移除已结束作业的当前会话缓存。",Action::ForgetJob,true,false,json!({"job_id":id()}),&["job_id"]),
        spec("lookup_book_metadata","根据书名或 ISBN 查询外部元数据，返回 job。会访问外部书目服务。",Action::Metadata,true,false,json!({"query":string(200)}),&["query"]),
        spec("get_epub_rendition","读取 EPUB 的阅读数据。",Action::Rendition,false,false,json!({"id":id()}),&["id"]),
    ]);
    for (name,path,write,description) in [
        ("ai_status","ai.status",false,"查询 AI 提供方与模型可用状态，不返回密钥。"),
        ("ai_models","ai.models",true,"列出 AI 提供方模型；data 包含 provider 和可选 apiKey。会访问外部模型服务。"),
        ("ai_test_connection","ai.testConnection",true,"测试 AI 配置；data.config 包含 provider/model/effort 和可选 apiKey；可能产生费用。"),
        ("ai_chat","ai.chat",true,"调用 AI 对话；data 包含 config、messages。可能发送内容至外部服务并产生费用。"),
        ("ai_translate","ai.translate",true,"调用 AI 翻译；data 包含 config、text、targetLang、mode。可能产生费用。"),
        ("ai_mindmap","ai.mindmap",true,"生成脑图；data 包含 config、text、bookTitle、chapterTitle。通过 create_mindmap 保存。可能产生费用。"),
        ("ai_study_card","ai.studyCard",true,"生成学习卡；data 包含 config、text、bookTitle、chapterTitle。通过 create_highlight 保存。可能产生费用。"),
        ("get_book_digest","ai.getDigest",false,"按 contentHash 读取书籍摘要。"),
        ("save_book_digest","ai.saveDigest",true,"保存书籍摘要；data 包含 contentHash/title/author/structure/overview。"),
    ] {out.push(spec(name,description,Action::Ai(path),write,false,json!({"data":object()}),&["data"]));}
    out
}
fn data_schema(kind: &str) -> Value {
    let fields: &[&str] = match kind {
        "books" => &[
            "title",
            "author",
            "metadata",
            "format",
            "folderId",
            "contentHash",
            "chapters",
            "coverTone",
            "customCover",
            "progress",
            "lastOpenedAt",
            "readingSessions",
            "outline",
            "readerMode",
            "cover",
            "typeSettings",
            "pageCount",
        ],
        "folders" => &["name", "icon"],
        "notes" => &["title", "content"],
        "highlights" => &[
            "bookId",
            "bookTitle",
            "citationLevel",
            "chapterId",
            "chapterTitle",
            "text",
            "paraIndex",
            "start",
            "end",
            "pdfAnchor",
            "color",
            "note",
            "name",
            "tags",
            "cloze",
            "review",
            "noteId",
            "style",
            "citation",
            "aiQa",
        ],
        "translations" => &[
            "bookId",
            "chapterId",
            "scope",
            "sourceLang",
            "targetLang",
            "text",
            "paragraphs",
            "title",
        ],
        "mindMaps" => &["title", "bookId", "bookTitle", "root"],
        "studySets" => &["name", "description", "bookIds"],
        "associations" => &["source", "target", "direction", "label"],
        "preferences" => &[
            "theme",
            "fontSize",
            "fontFamily",
            "lineHeight",
            "readerMode",
            "value",
        ],
        _ => &[],
    };
    let properties = fields
        .iter()
        .map(|k| ((*k).to_owned(), json!({})))
        .collect::<serde_json::Map<_, _>>();
    schema(Value::Object(properties), &[])
}
pub(crate) fn tools() -> Vec<Value> {
    catalogue().into_iter().map(|s|json!({"name":s.name,"description":s.description,"inputSchema":s.schema,"annotations":{"readOnlyHint":!s.write,"destructiveHint":s.destructive,"openWorldHint":matches!(s.action,Action::Ai(_)|Action::Metadata)}})).collect()
}
pub(crate) fn validate(schema: &Value, v: &Value) -> Result<(), String> {
    if let Some(types) = schema.get("type") {
        let accepts = |t: &str| match t {
            "object" => v.is_object(),
            "array" => v.is_array(),
            "string" => v.is_string(),
            "integer" => v.as_u64().is_some(),
            "boolean" => v.is_boolean(),
            "null" => v.is_null(),
            _ => false,
        };
        if !types.as_str().map_or_else(
            || {
                types
                    .as_array()
                    .is_some_and(|a| a.iter().any(|t| t.as_str().is_some_and(accepts)))
            },
            accepts,
        ) {
            return Err("invalid_arguments".into());
        }
    }
    if schema["enum"].as_array().is_some_and(|a| !a.contains(v)) {
        return Err("invalid_arguments".into());
    }
    if let Some(s) = v.as_str() {
        let n = s.chars().count() as u64;
        if schema["minLength"].as_u64().is_some_and(|m| n < m)
            || schema["maxLength"].as_u64().is_some_and(|m| n > m)
            || (schema.get("pattern").is_some() && !shufang_domain::sync::valid_identifier(s))
        {
            return Err("invalid_arguments".into());
        }
    }
    if let Some(n) = v.as_u64() {
        if schema["minimum"].as_u64().is_some_and(|m| n < m)
            || schema["maximum"].as_u64().is_some_and(|m| n > m)
        {
            return Err("invalid_arguments".into());
        }
    }
    if let Some(o) = v.as_object() {
        if schema["required"]
            .as_array()
            .is_some_and(|a| a.iter().any(|k| !o.contains_key(k.as_str().unwrap_or(""))))
        {
            return Err("invalid_arguments".into());
        }
        for (k, value) in o {
            if let Some(s) = schema["properties"].get(k) {
                validate(s, value)?;
            } else if schema["additionalProperties"] == false {
                return Err("invalid_arguments".into());
            }
        }
    }
    if let Some(a) = v.as_array() {
        if schema["maxItems"]
            .as_u64()
            .is_some_and(|m| a.len() as u64 > m)
        {
            return Err("invalid_arguments".into());
        }
        if let Some(s) = schema.get("items") {
            for v in a {
                validate(s, v)?;
            }
        }
    }
    Ok(())
}
fn api(r: ApiResult) -> Result<Value, String> {
    r.map(|v| v.0)
        .map_err(|(_, v)| v.0["error"].as_str().unwrap_or("operation_failed").into())
}
async fn workspace(h: Arc<Host>, action: &str, args: Value) -> Result<Value, String> {
    api(crate::call(h, action, args).await)
}
fn str_arg<'a>(a: &'a Value, k: &str) -> &'a str {
    a[k].as_str().unwrap_or("")
}
fn value(record: Value) -> Value {
    let mut v = record["value"].clone();
    v["revision"] = record["revision"].clone();
    v
}
fn sanitize(v: &mut Value) {
    if let Some(o) = v.as_object_mut() {
        for k in [
            "archive",
            "path",
            "checkpoint",
            "sourceFile",
            "safetyBackup",
        ] {
            o.remove(k);
        }
        for v in o.values_mut() {
            sanitize(v);
        }
    }
    if let Some(a) = v.as_array_mut() {
        for v in a {
            sanitize(v);
        }
    }
}
async fn command(h: Arc<Host>, s: &Spec, a: Value) -> Result<Value, String> {
    let action = s.action.clone();
    let name = s.name.clone();
    tokio::task::spawn_blocking(move || {
        let mut c = h.workspace.core.lock().map_err(|_| "core_lock_failed")?;
        let id = str_arg(&a, "id");
        let operation = str_arg(&a, "operation_id");
        let expected = a["expected"].as_u64().unwrap_or(0);
        let fingerprint = serde_json::to_string(&json!({"tool":name,"args":a}))
            .map_err(|_| "invalid_arguments")?;
        let duplicate = c.with_receipt(
            &format!("mcp-command:{operation}"),
            &fingerprint,
            vec![],
            |c| {
                match action {
                    Action::Create(kind) | Action::Update(kind) => {
                        let mut patch = a["data"].clone();
                        if matches!(action, Action::Create(_)) {
                            if c.entity(kind, id).is_ok() {
                                return Err("entity_exists".into());
                            }
                            if kind == "books" {
                                for (k, v) in [
                                    ("author", json!("")),
                                    ("format", json!("txt")),
                                    ("chapters", json!([])),
                                    ("coverTone", json!(0)),
                                ] {
                                    patch
                                        .as_object_mut()
                                        .ok_or("invalid_data")?
                                        .entry(k)
                                        .or_insert(v);
                                }
                            }
                            if kind == "notes" {
                                patch
                                    .as_object_mut()
                                    .ok_or("invalid_data")?
                                    .entry("content")
                                    .or_insert(json!(""));
                            }
                        }
                        let unset: Vec<String> =
                            serde_json::from_value(a.get("unset").cloned().unwrap_or(json!([])))
                                .map_err(|_| "invalid_unset")?;
                        if unset
                            .iter()
                            .any(|k| data_schema(kind)["properties"].get(k).is_none())
                        {
                            return Err("invalid_unset".into());
                        }
                        c.save_entity(kind, id, patch, unset, expected)?;
                    }
                    Action::Delete(kind) => c.delete_entity(kind, id, expected)?,
                    Action::Cover => {
                        c.save_entity(
                            "books",
                            id,
                            json!({"customCover":a["cover"]}),
                            vec![],
                            expected,
                        )?;
                    }
                    Action::EditOutline => {
                        let mut data = a["data"].clone();
                        if let Some(entry) = data.get("entry_id").cloned() {
                            data["id"] = entry;
                        }
                        c.edit_outline(id, expected, &data)?;
                    }
                    Action::Checkpoint => {
                        c.checkpoint(
                            id,
                            str_arg(&a, "session"),
                            a["progress"].clone(),
                            a["active_seconds"].as_u64().unwrap_or(0),
                        )?;
                    }
                    Action::Review => {
                        c.review(id, a["rating"].as_u64().unwrap_or(0) as u8, expected)?;
                    }
                    Action::Enrollment => {
                        c.set_review(id, a["enabled"].as_bool().unwrap_or(false), expected)?;
                    }
                    Action::Citation => c.link_citation(
                        str_arg(&a, "highlight_id"),
                        str_arg(&a, "note_id"),
                        a["highlight_revision"].as_u64().unwrap_or(0),
                        a["note_revision"].as_u64().unwrap_or(0),
                    )?,
                    _ => return Err("unknown_tool".into()),
                };
                Ok(())
            },
        )?;
        Ok(json!({"ok":true,"duplicate":duplicate}))
    })
    .await
    .map_err(|_| "worker_failed")?
}
pub(crate) async fn execute(h: Arc<Host>, s: Spec, mut a: Value) -> Result<Value, String> {
    use tokio::io::{AsyncReadExt, AsyncSeekExt};
    validate(&s.schema, &a)?;
    reject_internal_references(&a)?;
    if s.write && h.is_read_only() {
        return Err("read_only_replica".into());
    }
    if matches!(s.action, Action::Create("books") | Action::Update("books")) {
        for key in ["cover", "customCover"] {
            if let Some(cover) = a["data"].get(key).cloned() {
                a["data"][key] = normalize_cover(cover).await?;
            }
        }
    }
    if matches!(
        s.action,
        Action::Job | Action::CancelJob | Action::ForgetJob
    ) {
        let job = workspace(h.clone(), "job", json!({"id":a["job_id"]})).await?;
        if !["import", "parse-book", "ai", "metadata"].contains(&job["kind"].as_str().unwrap_or(""))
        {
            return Err("user_job_required".into());
        }
    }
    let id = str_arg(&a, "id").to_owned();
    let mut result=match &s.action {
        Action::List(kind)=> {let rows=workspace(h,"list",json!({"kind":kind})).await?;let rows=rows.as_array().ok_or("invalid_records")?;if rows.iter().any(|r|r["pendingFields"].as_array().is_some_and(|a|!a.is_empty())){return Err("sync_field_pending".into());}let offset=a["offset"].as_u64().unwrap_or(0) as usize;let limit=a["limit"].as_u64().unwrap_or(50) as usize;json!({"records":rows.iter().skip(offset).take(limit).cloned().map(value).collect::<Vec<_>>(),"total":rows.len(),"next_offset":if offset.saturating_add(limit)<rows.len(){Some(offset+limit)}else{None}})},
        Action::Get(kind)=>value(workspace(h,"get",json!({"kind":kind,"id":id})).await?),
        Action::Create(_)|Action::Update(_)|Action::Delete(_)|Action::EditOutline|Action::Checkpoint|Action::Review|Action::Enrollment|Action::Citation=>command(h,&s,a).await?,
        Action::Cover=> {
            a["cover"]=normalize_cover(a["cover"].clone()).await?;
            command(h,&s,a).await?
        },
        Action::Chapters=>api(crate::chapters(State(h),Path(id)).await)?,
        Action::Chapter=>api(crate::chapter(State(h),Path((id,a["index"].as_u64().unwrap_or(0) as usize))).await)?,
        Action::Outline=>workspace(h,"outline",json!({"id":id})).await?,
        Action::Source=>{let owner=h.clone();let book=id.clone();let path=tokio::task::spawn_blocking(move||owner.workspace.book_file(&book)).await.map_err(|_|"worker_failed")?.map_err(|_|"source_not_available")?;let mut f=tokio::fs::File::open(path).await.map_err(|_|"source_not_available")?;let size=f.metadata().await.map_err(|_|"source_not_available")?.len();let offset=a["offset"].as_u64().unwrap_or(0);if offset>size {return Err("invalid_offset".into());}let limit=a["limit"].as_u64().unwrap_or(262144);f.seek(std::io::SeekFrom::Start(offset)).await.map_err(|_|"source_not_available")?;let mut bytes=vec![0;(size-offset).min(limit) as usize];f.read_exact(&mut bytes).await.map_err(|_|"source_not_available")?;json!({"payload":STANDARD.encode(&bytes),"offset":offset,"size":size,"next_offset":if offset+(bytes.len() as u64)<size {Some(offset+bytes.len() as u64)}else{None}})},
        Action::Import=> {
            let filename=str_arg(&a,"filename").to_owned();
            if filename.is_empty()||filename.contains(['/', '\\', ':'])||filename.starts_with('.')||filename.chars().any(char::is_control){return Err("invalid_filename".into());}
            let ext=std::path::Path::new(&filename).extension().and_then(|e|e.to_str()).unwrap_or("").to_lowercase();
            if !["txt","epub","pdf","mobi","azw3","fb2"].contains(&ext.as_str()){return Err("unsupported_format".into());}
            let bytes=STANDARD.decode(str_arg(&a,"payload")).map_err(|_|"invalid_payload")?;
            let fingerprint=format!("{}:{:x}",filename,Sha256::digest(&bytes));
            let operation=str_arg(&a,"operation_id").to_owned();
            tokio::task::spawn_blocking(move|| -> Result<Value,String> {
                let dir=tempfile::tempdir().map_err(|_|"upload_storage_failed")?;let path=dir.path().join(filename);
                std::fs::write(&path,bytes).map_err(|_|"upload_storage_failed")?;
                let owner=h.workspace.clone();let w=owner.clone();
                w.start_with_receipt("import",Some((&format!("mcp-import:{operation}"),&fingerprint)),move|job|{let _dir=dir;owner.import(&path,"original",&job)})
            }).await.map_err(|_|"worker_failed")??
        },
        Action::ParseSource=> {
            tokio::task::spawn_blocking(move|| -> Result<Value,String> {
                let owner=h.workspace.clone();let w=owner.clone();
                let fingerprint=a.to_string();let key=format!("mcp-parse:{}",str_arg(&a,"operation_id"));
                w.start_with_receipt("parse-book",Some((&key,&fingerprint)),move|job| {
                    job.check()?;
                    let (format,source)={let c=owner.core.lock().map_err(|_|"core_lock_failed")?;let book=c.entity("books",&id)?;(book.value["format"].as_str().ok_or("invalid_format")?.to_owned(),c.book_source(&id)?)};
                    if !["txt","epub","pdf","mobi","azw3","fb2"].contains(&format.as_str()){return Err("unsupported_format".into());}
                    let file=owner.book_file(&id)?;
                    let dir=tempfile::tempdir_in(&owner.root).map_err(|_|"upload_storage_failed")?;let staged=dir.path().join(format!("source.{format}"));
                    if std::fs::hard_link(&file,&staged).is_err(){std::fs::copy(&file,&staged).map_err(|_|"upload_storage_failed")?;}
                    let parsed=shufang_native::books::parse(&staged)?;
                    job.check()?;
                    let mut patch=json!({"chapters":parsed["chapters"],"contentHash":source.sha256,"progress":{"chapterId":parsed["chapters"][0]["id"].as_str().unwrap_or(""),"ratio":0}});
                    for k in ["cover","metadata","pageCount"] {if let Some(v)=parsed.get(k){patch[k]=v.clone();}}
                    let mut c=owner.core.lock().map_err(|_|"core_lock_failed")?;
                    if c.book_source(&id)?.sha256!=source.sha256 {return Err("source_changed".into());}
                    let saved=c.save_entity("books",&id,patch,vec!["outline".into()],a["expected"].as_u64().unwrap_or(0))?;
                    Ok(json!({"id":id,"revision":saved.revision,"parsed_title":parsed["title"],"parsed_author":parsed["author"]}))
                })
            }).await.map_err(|_|"worker_failed")??
        },
        Action::SourceChunk=>api(crate::library::source_chunk(State(h),Path(id),Json(json!({"uploadId":a["upload_id"],"index":a["index"],"payload":a["payload"]}))).await)?,
        Action::SourceComplete=>api(crate::library::source_complete(State(h),Path(id),Json(json!({"uploadId":a["sha256"],"sha256":a["sha256"],"size":a["size"],"chunks":a["size"].as_u64().unwrap_or(0).div_ceil(shufang_application::CHUNK_SIZE),"name":a["name"],"type":a["mime_type"]}))).await)?,
        Action::Search=>workspace(h,"search",a).await?,
        Action::Versions=>workspace(h,"listVersions",json!({})).await?,
        Action::CreateVersion=>workspace(h,"createVersion",json!({})).await?,
        Action::DeleteVersion=>workspace(h,"deleteVersion",json!({"id":a["version_id"]})).await?,
        Action::RestoreEntity=>workspace(h,"restoreVersionEntity",json!({"version":a["version_id"],"kind":a["kind"],"id":id,"newEntityId":a.get("new_entity_id").cloned().unwrap_or(json!(id)),"operationId":a["operation_id"]})).await?,
        Action::Ai(path)=>crate::trpc::call(&h,path,if ["ai.status","ai.getDigest"].contains(path){"GET"}else{"POST"},a["data"].clone()).await.map_err(|e|e.message)?,
        Action::AiConfig=>workspace(h,"aiConfig",json!({})).await?,
        Action::SaveAiConfig=>workspace(h,"saveAiConfig",json!({"expected":a["expected"],"config":a["config"],"apiKey":a["api_key"]})).await?,
        Action::Job=>workspace(h,"job",json!({"id":a["job_id"]})).await?,
        Action::CancelJob=>workspace(h,"cancelJob",json!({"id":a["job_id"]})).await?,
        Action::ForgetJob=>workspace(h,"forgetJob",json!({"id":a["job_id"]})).await?,
        Action::Metadata=>workspace(h,"lookupMetadata",a).await?,
        Action::Rendition=>workspace(h,"epubRendition",json!({"id":id})).await?,
    };
    sanitize(&mut result);
    Ok(result)
}

fn reject_internal_references(v: &Value) -> Result<(), String> {
    if let Some(o) = v.as_object() {
        if o.contains_key("$blob") {
            return Err("invalid_user_value".into());
        }
        for v in o.values() {
            reject_internal_references(v)?;
        }
    }
    if let Some(a) = v.as_array() {
        for v in a {
            reject_internal_references(v)?;
        }
    }
    Ok(())
}
async fn normalize_cover(cover: Value) -> Result<Value, String> {
    if cover.is_null() {
        return Ok(Value::Null);
    }
    let cover = cover.as_str().ok_or("invalid_cover")?;
    let (_, payload) = cover
        .split_once(";base64,")
        .filter(|(mime, _)| {
            [
                "data:image/png",
                "data:image/jpeg",
                "data:image/webp",
                "data:image/gif",
            ]
            .contains(mime)
        })
        .ok_or("invalid_cover")?;
    let bytes = STANDARD.decode(payload).map_err(|_| "invalid_cover")?;
    if bytes.len() > 8 * 1024 * 1024 {
        return Err("invalid_cover".into());
    }
    tokio::task::spawn_blocking(move || {
        let file = tempfile::NamedTempFile::new().map_err(|_| "upload_storage_failed")?;
        std::fs::write(file.path(), bytes).map_err(|_| "upload_storage_failed")?;
        shufang_native::books::cover_data(file.path()).map(Value::String)
    })
    .await
    .map_err(|_| "worker_failed")?
}
