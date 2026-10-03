use crate::{
    externalize::{self, FieldStorage, INLINE_FIELD_LIMIT},
    CoreSession, Repository, Result, Runtime,
};
use serde_json::{Map, Value};
use shufang_domain::{
    lossless_json::Json,
    sync::{materialize, EntityState},
};
impl<R: Repository, T: Runtime> CoreSession<R, T> {
    pub fn with_field_storage(mut self, storage: Box<dyn FieldStorage>) -> Self {
        self.field_storage = Some(storage);
        self
    }
    pub(crate) fn prepare_patch(
        &mut self,
        patch: Map<String, Value>,
    ) -> Result<Map<String, Value>> {
        if !patch
            .values()
            .any(|value| value.to_string().len() > INLINE_FIELD_LIMIT)
        {
            return Ok(patch);
        }
        let storage = self
            .field_storage
            .as_deref_mut()
            .ok_or("field_storage_not_configured")?;
        let value = Json::parse(&Value::Object(patch).to_string())?;
        let prepared = externalize::prepare_fields(&value, storage)?;
        serde_json::from_str(&prepared.stringify(false))
            .map_err(|_| "invalid_prepared_fields".into())
    }
    pub(crate) fn materialize_state(&self, state: &EntityState) -> Result<Option<Value>> {
        let is_reference = |value: &Value| {
            value["$blob"]["sha256"]
                .as_str()
                .is_some_and(crate::BlobManifest::valid_hash)
                && value["$blob"]["size"].as_f64().is_some_and(|size| {
                    size.fract() == 0.0 && (0.0..=crate::MAX_BLOB_SIZE as f64).contains(&size)
                })
        };
        if state.deleted
            || !state
                .fields
                .values()
                .any(|f| f.value.as_ref().is_some_and(&is_reference))
        {
            return materialize(state);
        }
        let storage = self.field_storage.as_deref().ok_or("sync_field_pending")?;
        let values = state
            .fields
            .iter()
            .filter_map(|(key, field)| field.value.as_ref().map(|v| (key.clone(), v.clone())))
            .collect::<Map<_, _>>();
        let hydrated = externalize::hydrate_fields(
            &Json::parse(&Value::Object(values).to_string())?,
            storage,
        )?;
        let values: Map<String, Value> = serde_json::from_str(&hydrated.stringify(false))
            .map_err(|_| "invalid_hydrated_fields")?;
        let mut projection = state.clone();
        for (key, value) in values {
            if let Some(field) = projection.fields.get_mut(&key) {
                field.value = Some(value);
            }
        }
        materialize(&projection)
    }
}
