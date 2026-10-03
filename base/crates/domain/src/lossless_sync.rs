//! Replication values own UTF-16 keys/text; no host slot table is required.
use crate::{
    lossless_json::{quote_units, Json},
    sync::{self, Operation, Result},
};
use std::collections::{BTreeMap, BTreeSet};
type Key = Vec<u16>;
#[derive(Clone, Debug, PartialEq)]
pub struct ReplicaOperation {
    pub workspace_id: String,
    pub replica_id: String,
    pub operation_id: String,
    pub kind: String,
    pub entity_id: String,
    pub clock: String,
    pub patch: BTreeMap<Key, Json>,
    pub unset: Vec<Key>,
    pub deleted: bool,
}
#[derive(Clone, Debug, PartialEq)]
pub struct ReplicaField {
    pub version: String,
    pub value: Option<Json>,
    pub removed: bool,
}
#[derive(Clone, Debug, PartialEq)]
pub struct ReplicaState {
    pub id: String,
    pub kind: String,
    pub deleted: bool,
    pub fields: BTreeMap<Key, ReplicaField>,
}
fn text(value: &Json, key: &str) -> Result<String> {
    let field = value.get(key).ok_or("invalid_replica_json")?.to_owned();
    String::from_utf16(field.string_units().ok_or("invalid_replica_json")?)
        .map_err(|_| "invalid_identifier".into())
}
fn flag(value: &Json, key: &str, default: bool) -> Result<bool> {
    value
        .get(key)
        .map(|v| v.to_owned().boolean().ok_or("invalid_replica_json".into()))
        .unwrap_or(Ok(default))
}
fn key_valid(key: &[u16]) -> bool {
    !key.is_empty()
        && key.len() <= 256
        && !["id", "__proto__", "constructor", "prototype"]
            .iter()
            .any(|s| key == s.encode_utf16().collect::<Vec<_>>())
}
fn object(parts: Vec<(Key, String)>) -> String {
    format!(
        "{{{}}}",
        parts
            .into_iter()
            .map(|(k, v)| format!("{}:{v}", quote_units(&k)))
            .collect::<Vec<_>>()
            .join(",")
    )
}
fn key(s: &str) -> Key {
    s.encode_utf16().collect()
}
fn quoted(s: &str) -> String {
    quote_units(&key(s))
}
impl ReplicaOperation {
    pub fn parse(input: &str) -> Result<Self> {
        let value = Json::parse(input)?;
        if !value.has_only_finite_numbers() {
            return Err("invalid_operation".into());
        }
        let entries = value.entries().ok_or("invalid_operation")?;
        let known = [
            "workspaceId",
            "replicaId",
            "operationId",
            "kind",
            "entityId",
            "clock",
            "patch",
            "unset",
            "deleted",
        ];
        if entries
            .iter()
            .any(|(k, _)| !known.iter().any(|s| *k == key(s)))
        {
            return Err("invalid_operation".into());
        }
        let patch = value
            .get("patch")
            .ok_or("invalid_operation")?
            .to_owned()
            .entries()
            .ok_or("invalid_operation")?
            .into_iter()
            .collect::<BTreeMap<_, _>>();
        let unset = match value.get("unset") {
            None => vec![],
            Some(v) => v
                .to_owned()
                .elements()
                .ok_or("invalid_operation")?
                .iter()
                .map(|v| {
                    v.string_units()
                        .map(|s| s.to_vec())
                        .ok_or("invalid_operation".into())
                })
                .collect::<Result<Vec<_>>>()?,
        };
        let result = Self {
            workspace_id: text(&value, "workspaceId")?,
            replica_id: text(&value, "replicaId")?,
            operation_id: text(&value, "operationId")?,
            kind: text(&value, "kind")?,
            entity_id: text(&value, "entityId")?,
            clock: text(&value, "clock")?,
            patch,
            unset,
            deleted: flag(&value, "deleted", false)?,
        };
        result.validate()?;
        Ok(result)
    }
    pub fn validate(&self) -> Result<()> {
        sync::validate_operation(&Operation {
            workspace_id: self.workspace_id.clone(),
            replica_id: self.replica_id.clone(),
            operation_id: self.operation_id.clone(),
            kind: self.kind.clone(),
            entity_id: self.entity_id.clone(),
            clock: self.clock.clone(),
            patch: Default::default(),
            unset: vec![],
            deleted: self.deleted,
        })?;
        if self.patch.values().any(|v| !v.has_only_finite_numbers()) {
            return Err("invalid_operation".into());
        }
        if self.unset.len() > 256
            || self
                .patch
                .keys()
                .chain(self.unset.iter())
                .any(|k| !key_valid(k))
        {
            return Err("reserved_or_invalid_field".into());
        }
        Ok(())
    }
    pub fn stringify(&self) -> String {
        object(vec![
            (key("workspaceId"), quoted(&self.workspace_id)),
            (key("replicaId"), quoted(&self.replica_id)),
            (key("operationId"), quoted(&self.operation_id)),
            (key("kind"), quoted(&self.kind)),
            (key("entityId"), quoted(&self.entity_id)),
            (key("clock"), quoted(&self.clock)),
            (
                key("patch"),
                object(
                    self.patch
                        .iter()
                        .map(|(k, v)| (k.clone(), v.stringify(false)))
                        .collect(),
                ),
            ),
            (
                key("unset"),
                format!(
                    "[{}]",
                    self.unset
                        .iter()
                        .map(|s| quote_units(s))
                        .collect::<Vec<_>>()
                        .join(",")
                ),
            ),
            (key("deleted"), self.deleted.to_string()),
        ])
    }
}
impl ReplicaState {
    pub fn parse(input: &str) -> Result<Self> {
        let value = Json::parse(input)?;
        let fields = value
            .get("fields")
            .ok_or("invalid_state")?
            .to_owned()
            .entries()
            .ok_or("invalid_state")?
            .into_iter()
            .map(|(key, v)| {
                Ok((
                    key,
                    ReplicaField {
                        version: text(&v, "version")?,
                        value: v.get("value").map(|v| v.to_owned()),
                        removed: flag(&v, "removed", false)?,
                    },
                ))
            })
            .collect::<Result<BTreeMap<_, _>>>()?;
        let state = Self {
            id: text(&value, "id")?,
            kind: text(&value, "kind")?,
            deleted: flag(&value, "deleted", false)?,
            fields,
        };
        state.validate()?;
        Ok(state)
    }
    pub fn validate(&self) -> Result<()> {
        sync::validate_operation(&Operation {
            workspace_id: "snapshot".into(),
            replica_id: "snapshot".into(),
            operation_id: "snapshot".into(),
            entity_id: self.id.clone(),
            kind: self.kind.clone(),
            clock: "0:0".into(),
            patch: Default::default(),
            unset: vec![],
            deleted: self.deleted,
        })?;
        for (key, field) in &self.fields {
            if !key_valid(key)
                || (!field.removed && field.value.is_none())
                || field
                    .value
                    .as_ref()
                    .is_some_and(|v| !v.has_only_finite_numbers())
            {
                return Err("invalid_state".into());
            }
            field_clock(&field.version)?;
        }
        Ok(())
    }
    pub fn stringify(&self) -> String {
        let fields = self
            .fields
            .iter()
            .map(|(k, f)| {
                let mut parts = vec![(key("version"), quoted(&f.version))];
                if let Some(v) = &f.value {
                    parts.push((key("value"), v.stringify(false)));
                }
                if f.removed {
                    parts.push((key("removed"), "true".into()));
                }
                (k.clone(), object(parts))
            })
            .collect();
        object(vec![
            (key("id"), quoted(&self.id)),
            (key("kind"), quoted(&self.kind)),
            (key("deleted"), self.deleted.to_string()),
            (key("fields"), object(fields)),
        ])
    }
    pub fn apply(prior: Option<&Self>, op: &ReplicaOperation) -> Result<Self> {
        op.validate()?;
        if let Some(prior) = prior {
            prior.validate()?;
        }
        if prior.is_some_and(|s| s.id != op.entity_id || s.kind != op.kind) {
            return Err("entity_identity_mismatch".into());
        }
        let mut state = prior.cloned().unwrap_or(Self {
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
            if let Some(progress) = patch.get(&key("progress")).filter(|v| v.truthy()).cloned() {
                patch.insert(key(&format!("@progress:{}", op.replica_id)), progress);
            }
        }
        let unset: BTreeSet<_> = op.unset.iter().cloned().collect();
        let keys: BTreeSet<_> = patch.keys().chain(unset.iter()).cloned().collect();
        for key in keys {
            if !sync::newer_field(state.fields.get(&key).map(|f| f.version.as_str()), &stamp) {
                continue;
            }
            let removed = unset.contains(&key);
            state.fields.insert(
                key.clone(),
                ReplicaField {
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
    pub fn merge(prior: Option<&Self>, incoming: &Self) -> Result<Self> {
        incoming.validate()?;
        if let Some(prior) = prior {
            prior.validate()?;
        }
        let Some(prior) = prior else {
            return Ok(incoming.clone());
        };
        if prior.id != incoming.id || prior.kind != incoming.kind {
            return Err("entity_identity_mismatch".into());
        }
        let mut merged = prior.clone();
        merged.deleted |= incoming.deleted;
        for (key, field) in &incoming.fields {
            if merged
                .fields
                .get(key)
                .is_some_and(|prior| prior.version == field.version && prior != field)
            {
                return Err("field_version_reused".into());
            }
            if sync::newer_field(
                merged.fields.get(key).map(|f| f.version.as_str()),
                &field.version,
            ) {
                merged.fields.insert(key.clone(), field.clone());
            }
        }
        Ok(merged)
    }
}

/// Field stamps use fixed-width clock components, followed by two identifiers.
/// Identifiers may themselves contain colons, so accept any valid partition.
pub fn field_clock(version: &str) -> Result<String> {
    let bytes = version.as_bytes();
    if bytes.len() < 31
        || bytes.get(16) != Some(&b':')
        || bytes.get(27) != Some(&b':')
        || !bytes[..16]
            .iter()
            .chain(bytes[17..27].iter())
            .all(u8::is_ascii_digit)
    {
        return Err("invalid_field_version".into());
    }
    let suffix = version.get(28..).ok_or("invalid_field_version")?;
    if !suffix.match_indices(':').any(|(index, _)| {
        sync::valid_identifier(&suffix[..index]) && sync::valid_identifier(&suffix[index + 1..])
    }) {
        return Err("invalid_field_version".into());
    }
    Ok(format!("{}:{}", &version[..16], &version[17..27]))
}
