//! Restoration retains client registrations but never restores bearer grants.
use serde_json::{json, Value};
pub fn reset_oauth(value: &mut Value) -> Result<(), String> {
    let store = value.as_object_mut().ok_or("invalid_oauth_store")?;
    for key in ["pending", "codes", "access", "refresh", "used_refresh"] {
        store.insert(key.into(), json!({}));
    }
    // Keep an initialized store so historical Node import cannot resurrect grants.
    store.entry("clients").or_insert_with(|| json!({}));
    Ok(())
}
