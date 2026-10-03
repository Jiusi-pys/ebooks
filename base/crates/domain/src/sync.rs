//! Compatibility with the existing workspace-v2 field-version protocol.
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::{cmp::Ordering, collections::BTreeMap, sync::OnceLock};

pub type Result<T> = std::result::Result<T, String>;
pub const ENTITY_KINDS: &[&str] = &[
    "books",
    "folders",
    "notes",
    "highlights",
    "associations",
    "translations",
    "mindMaps",
    "studySets",
    "reviews",
    "preferences",
    "sources",
];

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Operation {
    pub workspace_id: String,
    pub operation_id: String,
    pub replica_id: String,
    pub kind: String,
    pub entity_id: String,
    pub clock: String,
    pub patch: Map<String, Value>,
    #[serde(default)]
    pub unset: Vec<String>,
    #[serde(default)]
    pub deleted: bool,
}

/// Existing v2 hashes JSON numbers using JavaScript's IEEE-754 representation.
/// A peer may echo 0.0 as 0; that does not change the operation's contents.
pub fn equivalent_operation(a: &Operation, b: &Operation) -> bool {
    a.workspace_id == b.workspace_id
        && a.operation_id == b.operation_id
        && a.replica_id == b.replica_id
        && a.kind == b.kind
        && a.entity_id == b.entity_id
        && a.clock == b.clock
        && a.unset == b.unset
        && a.deleted == b.deleted
        && a.patch.len() == b.patch.len()
        && a.patch.iter().all(|(k, v)| {
            b.patch
                .get(k)
                .is_some_and(|other| equivalent_json(v, other))
        })
}
fn equivalent_json(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| equivalent_json(a, b))
        }
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len()
                && a.iter()
                    .all(|(k, v)| b.get(k).is_some_and(|b| equivalent_json(v, b)))
        }
        _ => a == b,
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Field {
    pub version: String,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_value"
    )]
    pub value: Option<Value>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub removed: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct EntityState {
    pub id: String,
    pub kind: String,
    pub deleted: bool,
    pub fields: BTreeMap<String, Field>,
}

fn present_value<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Option<Value>, D::Error> {
    Value::deserialize(deserializer).map(Some)
}

fn utf16_cmp(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}
pub fn newer_field(prior: Option<&str>, incoming: &str) -> bool {
    prior.is_none_or(|version| utf16_cmp(version, incoming) == Ordering::Less)
}

fn clock_parts(clock: &str) -> Result<(u64, u64)> {
    let (wall, counter) = clock.split_once(':').ok_or("invalid_clock")?;
    if wall.is_empty()
        || counter.is_empty()
        || wall.len() > 16
        || counter.len() > 10
        || !wall
            .bytes()
            .chain(counter.bytes())
            .all(|c| c.is_ascii_digit())
    {
        return Err("invalid_clock".into());
    }
    Ok((
        wall.parse().map_err(|_| "invalid_clock")?,
        counter.parse().map_err(|_| "invalid_clock")?,
    ))
}

pub fn next_clock(previous: &str, now: u64) -> Result<String> {
    let (wall, counter) = clock_parts(previous)?;
    let result = if now > wall {
        format!("{now}:0")
    } else {
        format!("{wall}:{}", counter + 1)
    };
    clock_parts(&result)?;
    Ok(result)
}

pub fn compare_clock(a: &str, b: &str) -> Result<Ordering> {
    Ok(clock_parts(a)?.cmp(&clock_parts(b)?))
}

pub fn valid_identifier(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_.:-".contains(&c))
}

pub fn validate_operation(op: &Operation) -> Result<()> {
    static ENTITY: OnceLock<regex::Regex> = OnceLock::new();
    let entity = ENTITY
        .get_or_init(|| regex::Regex::new(r"^[\p{L}\p{M}\p{N}_.:-]+$").expect("constant regex"));
    if !valid_identifier(&op.workspace_id)
        || !valid_identifier(&op.operation_id)
        || !valid_identifier(&op.replica_id)
        || !ENTITY_KINDS.contains(&op.kind.as_str())
        || op.entity_id.encode_utf16().count() > 128
        || !entity.is_match(&op.entity_id)
        || op.unset.len() > 256
    {
        return Err("invalid_operation".into());
    }
    clock_parts(&op.clock)?;
    for key in op.patch.keys().chain(op.unset.iter()) {
        if key.is_empty()
            || key.encode_utf16().count() > 256
            || ["id", "__proto__", "constructor", "prototype"].contains(&key.as_str())
        {
            return Err("reserved_or_invalid_field".into());
        }
    }
    Ok(())
}

pub fn apply_operation(prior: Option<&EntityState>, op: &Operation) -> Result<EntityState> {
    validate_operation(op)?;
    if prior.is_some_and(|p| p.id != op.entity_id || p.kind != op.kind) {
        return Err("entity_identity_mismatch".into());
    }
    let mut state = prior.cloned().unwrap_or_else(|| EntityState {
        id: op.entity_id.clone(),
        kind: op.kind.clone(),
        deleted: false,
        fields: BTreeMap::new(),
    });
    state.deleted |= op.deleted;
    let (wall, count) = op.clock.split_once(':').ok_or("invalid_clock")?;
    let stamp = format!(
        "{wall:0>16}:{count:0>10}:{}:{}",
        op.replica_id, op.operation_id
    );
    let mut patch = op.patch.clone();
    if op.kind == "books" {
        if let Some(progress) = patch
            .get("progress")
            .filter(|v| match v {
                Value::Null => false,
                Value::Bool(value) => *value,
                Value::Number(value) => value.as_f64() != Some(0.0),
                Value::String(value) => !value.is_empty(),
                _ => true,
            })
            .cloned()
        {
            patch.insert(format!("@progress:{}", op.replica_id), progress);
        }
    }
    let keys: std::collections::BTreeSet<_> =
        patch.keys().chain(op.unset.iter()).cloned().collect();
    for key in keys {
        if !newer_field(state.fields.get(&key).map(|f| f.version.as_str()), &stamp) {
            continue;
        }
        let removed = op.unset.contains(&key);
        state.fields.insert(
            key.clone(),
            Field {
                version: stamp.clone(),
                value: if removed {
                    None
                } else {
                    patch.get(&key).cloned()
                },
                removed,
            },
        );
    }
    Ok(state)
}

pub fn merge_states(prior: Option<&EntityState>, incoming: &EntityState) -> Result<EntityState> {
    let Some(prior) = prior else {
        return Ok(incoming.clone());
    };
    if prior.id != incoming.id || prior.kind != incoming.kind {
        return Err("entity_identity_mismatch".into());
    }
    let mut merged = prior.clone();
    merged.deleted |= incoming.deleted;
    for (key, field) in &incoming.fields {
        if newer_field(
            merged.fields.get(key).map(|f| f.version.as_str()),
            &field.version,
        ) {
            merged.fields.insert(key.clone(), field.clone());
        }
    }
    Ok(merged)
}

pub fn flatten_fields(kind: &str, value: &Map<String, Value>) -> Result<Map<String, Value>> {
    let mut result = value.clone();
    if kind == "studySets" {
        if let Some(Value::Array(ids)) = value.get("bookIds") {
            result.remove("bookIds");
            for id in ids {
                result.insert(
                    format!("@member:{}", id.as_str().ok_or("invalid_member")?),
                    Value::Bool(true),
                );
            }
        }
    }
    if kind == "books" {
        if let Some(Value::Array(sessions)) = value.get("readingSessions") {
            result.remove("readingSessions");
            for session in sessions {
                let id = session
                    .get("id")
                    .and_then(Value::as_str)
                    .ok_or("invalid_reading_session")?;
                result.insert(format!("@readingSession:{id}"), session.clone());
            }
        }
    }
    if kind == "mindMaps" {
        if let Some(root) = value.get("root").filter(|v| v.is_object()) {
            result.remove("root");
            flatten_node(root, Value::Null, 0, 0, &mut result)?;
        }
    }
    Ok(result)
}

fn flatten_node(
    node: &Value,
    parent: Value,
    order: usize,
    depth: usize,
    result: &mut Map<String, Value>,
) -> Result<()> {
    if depth > 128 {
        return Err("mind_map_depth_exceeded".into());
    }
    let object = node.as_object().ok_or("invalid_node")?;
    let id = object
        .get("id")
        .and_then(Value::as_str)
        .ok_or("invalid_node_id")?;
    for (key, value) in object {
        if key != "children" && key != "id" {
            result.insert(format!("@node:{id}:{key}"), value.clone());
        }
    }
    result.insert(format!("@node:{id}:parent"), parent);
    result.insert(format!("@node:{id}:order"), Value::from(order));
    if let Some(Value::Array(children)) = object.get("children") {
        for (index, child) in children.iter().enumerate() {
            flatten_node(child, Value::from(id), index, depth + 1, result)?;
        }
    }
    Ok(())
}

pub fn materialize(state: &EntityState) -> Result<Option<Value>> {
    if state.deleted {
        return Ok(None);
    }
    let mut data = Map::new();
    data.insert("id".into(), state.id.clone().into());
    for (key, field) in &state.fields {
        if !field.removed {
            if let Some(value) = &field.value {
                data.insert(key.clone(), value.clone());
            }
        }
    }
    if state.kind == "books" {
        let mut progress = Map::new();
        let mut sessions = Vec::new();
        let keys: Vec<_> = data.keys().cloned().collect();
        for key in keys {
            if let Some(id) = key.strip_prefix("@progress:") {
                progress.insert(id.into(), data.remove(&key).unwrap());
            }
            if key.starts_with("@readingSession:") {
                sessions.push(data.remove(&key).unwrap());
            }
        }
        if !progress.is_empty() {
            data.insert("progressByDevice".into(), progress.into());
        }
        // Session IDs generated by the application are UUIDs; locale-sensitive
        // legacy IDs are covered by the cross-runtime compatibility gate.
        sessions.sort_by(|a, b| {
            utf16_cmp(
                a["id"].as_str().unwrap_or(""),
                b["id"].as_str().unwrap_or(""),
            )
        });
        data.remove("readingSessions");
        if !sessions.is_empty() {
            data.insert("readingSessions".into(), sessions.into());
        }
    }
    if state.kind == "studySets" {
        let mut ids: Vec<_> = data
            .keys()
            .filter_map(|k| k.strip_prefix("@member:").map(String::from))
            .collect();
        ids.sort_by(|a, b| utf16_cmp(a, b));
        data.retain(|k, _| !k.starts_with("@member:"));
        data.insert("bookIds".into(), Value::from(ids));
    }
    if state.kind == "mindMaps" {
        let mut nodes: BTreeMap<String, Map<String, Value>> = BTreeMap::new();
        for (key, value) in &data {
            if let Some(rest) = key.strip_prefix("@node:") {
                if let Some((id, field)) = rest.rsplit_once(':') {
                    let node = nodes
                        .entry(id.into())
                        .or_insert_with(|| Map::from_iter([("id".into(), id.into())]));
                    node.insert(field.into(), value.clone());
                }
            }
        }
        data.retain(|k, _| !k.starts_with("@node:"));
        let mut roots: Vec<_> = nodes
            .iter()
            .filter(|(_, n)| n.get("parent") == Some(&Value::Null))
            .map(|(id, _)| id.clone())
            .collect();
        roots.sort_by(|a, b| utf16_cmp(a, b));
        if let Some(root) = roots.first() {
            data.insert("root".into(), build_node(root, &nodes, &mut Vec::new())?);
        }
    }
    Ok(Some(data.into()))
}

fn build_node(
    id: &str,
    nodes: &BTreeMap<String, Map<String, Value>>,
    seen: &mut Vec<String>,
) -> Result<Value> {
    if seen.len() >= 128 {
        return Err("mind_map_depth_exceeded".into());
    }
    let mut node = nodes[id].clone();
    node.remove("parent");
    node.remove("order");
    seen.push(id.into());
    let mut children: Vec<_> = nodes
        .iter()
        .filter(|(key, n)| {
            n.get("parent").and_then(Value::as_str) == Some(id) && !seen.contains(key)
        })
        .collect();
    children.sort_by(|(a, na), (b, nb)| {
        na.get("order")
            .and_then(Value::as_f64)
            .unwrap_or(0.0)
            .total_cmp(&nb.get("order").and_then(Value::as_f64).unwrap_or(0.0))
            .then_with(|| utf16_cmp(a, b))
    });
    let values: Vec<_> = children
        .into_iter()
        .map(|(key, _)| build_node(key, nodes, seen))
        .collect::<Result<Vec<_>>>()?;
    node.insert("children".into(), values.into());
    seen.pop();
    Ok(node.into())
}
