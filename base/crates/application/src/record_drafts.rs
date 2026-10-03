//! Record defaults are shared business rules. IDs and time come from adapters.
use crate::Result;
use shufang_domain::lossless_json::{quote_units, Json};
pub fn trim_js_string(units: &[u16]) -> &[u16] {
    let space = |unit: &u16| matches!(*unit,0x0009..=0x000d|0x0020|0x00a0|0x1680|0x2000..=0x200a|0x2028|0x2029|0x202f|0x205f|0x3000|0xfeff);
    let start = units.iter().position(|u| !space(u)).unwrap_or(units.len());
    let end = units
        .iter()
        .rposition(|u| !space(u))
        .map_or(start, |p| p + 1);
    &units[start..end]
}
pub fn create_record(
    kind: &str,
    id: &str,
    name_json: &str,
    created_at: u64,
    updated_at: u64,
) -> Result<Json> {
    if !shufang_domain::sync::valid_identifier(id) {
        return Err("invalid_identifier".into());
    }
    if created_at > 9_007_199_254_740_991 || updated_at > 9_007_199_254_740_991 {
        return Err("invalid_time".into());
    }
    let name = Json::parse(name_json)?;
    let units = trim_js_string(name.string_units().ok_or("invalid_name")?);
    let default = match kind {
        "notes" => "未命名笔记",
        "folders" => "未命名文件夹",
        "studySets" => "未命名学习集",
        _ => return Err("invalid_kind".into()),
    };
    let fallback: Vec<_> = default.encode_utf16().collect();
    let name = quote_units(if units.is_empty() { &fallback } else { units });
    let id = quote_units(&id.encode_utf16().collect::<Vec<_>>());
    let body = match kind {
        "notes" => format!(
            r#"{{"id":{id},"title":{name},"content":"","createdAt":{created_at},"updatedAt":{updated_at}}}"#
        ),
        "folders" => format!(r#"{{"id":{id},"name":{name},"createdAt":{created_at}}}"#),
        _ => format!(
            r#"{{"id":{id},"name":{name},"description":"","bookIds":[],"createdAt":{created_at},"updatedAt":{updated_at}}}"#
        ),
    };
    Json::parse(&body)
}
pub fn normalize_study_set(record_json: &str, now: u64) -> Result<Json> {
    if now > 9_007_199_254_740_991 {
        return Err("invalid_time".into());
    }
    let record = Json::parse(record_json)?;
    let name = record.get("name").ok_or("invalid_name")?.to_owned();
    let units = trim_js_string(name.string_units().ok_or("invalid_name")?);
    let fallback: Vec<_> = "未命名学习集".encode_utf16().collect();
    let name = Json::parse(&quote_units(if units.is_empty() {
        &fallback
    } else {
        units
    }))?;
    let book_ids = record
        .get("bookIds")
        .ok_or("invalid_book_ids")?
        .to_owned()
        .elements()
        .ok_or("invalid_book_ids")?;
    let mut seen = std::collections::BTreeSet::new();
    let mut ids = Vec::new();
    for id in book_ids {
        let units = id.string_units().ok_or("invalid_book_ids")?;
        if seen.insert(units.to_vec()) {
            ids.push(quote_units(units));
        }
    }
    let book_ids = Json::parse(&format!("[{}]", ids.join(",")))?;
    let mut fields = record.entries().ok_or("invalid_record")?;
    for (key, value) in &mut fields {
        if *key == "name".encode_utf16().collect::<Vec<_>>() {
            *value = name.clone();
        }
        if *key == "bookIds".encode_utf16().collect::<Vec<_>>() {
            *value = book_ids.clone();
        }
    }
    fields.retain(|(key, _)| *key != "updatedAt".encode_utf16().collect::<Vec<_>>());
    fields.push((
        "updatedAt".encode_utf16().collect(),
        Json::parse(&now.to_string())?,
    ));
    Json::from_entries(fields)
}
