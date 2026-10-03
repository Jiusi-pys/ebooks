use crate::{BlobManifest, Result};
use sha2::{Digest, Sha256};
use shufang_domain::lossless_json::{quote_units, Json};
pub const INLINE_FIELD_LIMIT: usize = 128 * 1024;
pub fn external_field_policy(size: u64) -> Result<bool> {
    if size > crate::MAX_BLOB_SIZE {
        return Err("blob_too_large".into());
    }
    Ok(size > INLINE_FIELD_LIMIT as u64)
}
pub fn validate_source_link(book: &str, file: &str, size: u64) -> Result<()> {
    if book != file {
        return Err("source_identity_mismatch".into());
    }
    shufang_domain::sync::validate_operation(&shufang_domain::sync::Operation {
        workspace_id: "source".into(),
        replica_id: "source".into(),
        operation_id: "source".into(),
        entity_id: book.into(),
        kind: "sources".into(),
        clock: "0:0".into(),
        patch: Default::default(),
        unset: vec![],
        deleted: false,
    })?;
    external_field_policy(size)?;
    Ok(())
}
pub trait FieldObjects {
    /// Publish only after independently verifying these bytes against manifest.
    /// No operation/entity is committed by this infrastructure port.
    fn put_field(&mut self, manifest: &BlobManifest, json: &str) -> Result<()>;
}
pub trait FieldReader {
    fn read_field(&self, hash: &str, size: u64) -> Result<Vec<u8>>;
}
pub trait FieldStorage: FieldObjects + FieldReader + Send {}
impl<T: FieldObjects + FieldReader + Send> FieldStorage for T {}
pub fn hydrate_fields(patch: &Json, store: &(impl FieldReader + ?Sized)) -> Result<Json> {
    let mut prepared = Vec::new();
    for (key, value) in patch.entries().ok_or("invalid_patch")? {
        let reference = value
            .get("$blob")
            .map(|v| v.to_owned())
            .and_then(|reference| {
                let hash = reference
                    .get("sha256")
                    .and_then(|v| {
                        v.to_owned()
                            .string_units()
                            .map(|s| String::from_utf16(s).ok())
                    })
                    .flatten()?;
                let size = reference.get("size").and_then(|v| v.number()).filter(|n| {
                    n.fract() == 0.0 && (0.0..=crate::MAX_BLOB_SIZE as f64).contains(n)
                })? as u64;
                if !BlobManifest::valid_hash(&hash) {
                    return None;
                }
                Some((hash, size))
            });
        let encoded = if let Some((hash, size)) = reference {
            let bytes = store.read_field(&hash, size)?;
            if bytes.len() as u64 != size || format!("{:x}", Sha256::digest(&bytes)) != hash {
                return Err("blob_hash_mismatch".into());
            }
            let text = String::from_utf8(bytes).map_err(|_| "invalid_field_utf8")?;
            Json::parse(&text)?.stringify(false)
        } else {
            value.stringify(false)
        };
        prepared.push(format!("{}:{encoded}", quote_units(&key)));
    }
    Json::parse(&format!("{{{}}}", prepared.join(",")))
}
pub fn prepare_fields(patch: &Json, store: &mut (impl FieldObjects + ?Sized)) -> Result<Json> {
    if !patch.has_only_finite_numbers() {
        return Err("invalid_json_value".into());
    }
    let entries = patch.entries().ok_or("invalid_patch")?;
    let mut prepared = Vec::new();
    for (key, value) in entries {
        let body = value.stringify(true);
        let encoded = if body.len() > INLINE_FIELD_LIMIT {
            let manifest = BlobManifest {
                sha256: format!("{:x}", Sha256::digest(body.as_bytes())),
                size: body.len() as u64,
                name: "field.json".into(),
                content_type: "application/json".into(),
            };
            manifest.validate()?;
            store.put_field(&manifest, &body)?;
            serde_json::json!({"$blob":manifest}).to_string()
        } else {
            body
        };
        prepared.push(format!("{}:{encoded}", quote_units(&key)));
    }
    Json::parse(&format!("{{{}}}", prepared.join(",")))
}
