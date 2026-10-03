//! The native and WebAssembly exports share one bounded JSON command boundary.
use serde::Deserialize;
use serde_json::{json, Map, Value};
mod field_hash;
use shufang_domain::sync::{self, EntityState, Operation};
use std::{
    collections::BTreeMap,
    sync::{Mutex, OnceLock},
};

#[cfg(not(target_arch = "wasm32"))]
mod native;

#[derive(Deserialize)]
#[serde(
    tag = "command",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum Command {
    ValidateSourceLink {
        book_id: String,
        file_id: String,
        size: u64,
        name_json: Option<String>,
        type_json: Option<String>,
    },
    FieldHashBegin {},
    FieldHashAppend {
        handle: u32,
        hex: String,
    },
    FieldHashFinish {
        handle: u32,
    },
    FieldHashAbort {
        handle: u32,
    },
    ExternalFieldPolicy {
        size: u64,
    },
    PlanFolderDeletion {
        folder_json: String,
        books_json: String,
    },
    ValidateSyncReceipts {
        operation_ids: Vec<String>,
        receipts: Value,
    },
    NextClock {
        previous: String,
        now: u64,
    },
    CompareClock {
        a: String,
        b: String,
    },
    ApplyOperation {
        prior: Option<EntityState>,
        operation: Operation,
    },
    MergeStates {
        prior: Option<EntityState>,
        incoming: EntityState,
    },
    Materialize {
        state: EntityState,
    },
    FlattenFields {
        kind: String,
        value: Map<String, Value>,
    },
    ValidatePatch {
        operation: Operation,
    },
    NormalizeJson {
        json: String,
        canonical: bool,
    },
    ApplyReplicaOperation {
        prior_json: Option<String>,
        operation_json: String,
    },
    MergeReplicaStates {
        prior_json: Option<String>,
        incoming_json: String,
    },
    CreateLibraryRecord {
        kind: String,
        id: String,
        name_json: String,
        created_at: u64,
        updated_at: u64,
    },
    NormalizeStudySet {
        record_json: String,
        now: u64,
    },
}

pub fn execute(input: &str) -> Value {
    let run = || -> Result<Value, String> {
        if input.len() > 16 * 1024 * 1024 {
            return Err("request_too_large".into());
        }
        let value: Value = serde_json::from_str(input).map_err(|_| "invalid_json")?;
        if value.get("version").and_then(Value::as_u64) != Some(1) {
            return Err("unsupported_contract_version".into());
        }
        #[cfg(not(target_arch = "wasm32"))]
        if value
            .get("command")
            .and_then(Value::as_str)
            .is_some_and(|c| c.starts_with("session"))
        {
            return native::execute(value);
        }
        let cmd: Command = serde_json::from_value(value).map_err(|_| "invalid_command")?;
        match cmd {
            Command::ValidateSourceLink {
                book_id,
                file_id,
                size,
                name_json,
                type_json,
            } => {
                shufang_application::externalize::validate_source_link(&book_id, &file_id, size)?;
                for (value, limit) in [(name_json, 255), (type_json, 128)] {
                    if let Some(value) = value {
                        let parsed = shufang_domain::lossless_json::Json::parse(&value)?;
                        if parsed
                            .string_units()
                            .ok_or("invalid_source_metadata")?
                            .len()
                            > limit
                        {
                            return Err("invalid_source_metadata".into());
                        }
                    }
                }
                Ok(Value::Bool(true))
            }
            Command::FieldHashBegin {} => Ok(field_hash::begin()?.into()),
            Command::FieldHashAppend { handle, hex } => {
                field_hash::append(handle, &hex)?;
                Ok(Value::Bool(true))
            }
            Command::FieldHashFinish { handle } => Ok(field_hash::finish(handle)?.into()),
            Command::FieldHashAbort { handle } => {
                field_hash::abort(handle);
                Ok(Value::Bool(true))
            }
            Command::ExternalFieldPolicy { size } => {
                Ok(shufang_application::externalize::external_field_policy(size)?.into())
            }
            Command::PlanFolderDeletion {
                folder_json,
                books_json,
            } => Ok(
                shufang_application::folder_deletion::plan_json(&folder_json, &books_json)?.into(),
            ),
            Command::ValidateSyncReceipts {
                operation_ids,
                receipts,
            } => {
                shufang_application::sync_receipts::validate_sync_receipts(
                    &operation_ids,
                    &receipts,
                )?;
                Ok(Value::Bool(true))
            }
            Command::NextClock { previous, now } => Ok(sync::next_clock(&previous, now)?.into()),
            Command::CompareClock { a, b } => Ok(match sync::compare_clock(&a, &b)? {
                std::cmp::Ordering::Less => -1,
                std::cmp::Ordering::Equal => 0,
                std::cmp::Ordering::Greater => 1,
            }
            .into()),
            Command::ApplyOperation { prior, operation } => {
                serde_json::to_value(sync::apply_operation(prior.as_ref(), &operation)?)
                    .map_err(|_| "serialization_error".into())
            }
            Command::MergeStates { prior, incoming } => {
                serde_json::to_value(sync::merge_states(prior.as_ref(), &incoming)?)
                    .map_err(|_| "serialization_error".into())
            }
            Command::Materialize { state } => Ok(sync::materialize(&state)?.unwrap_or(Value::Null)),
            Command::FlattenFields { kind, value } => {
                Ok(sync::flatten_fields(&kind, &value)?.into())
            }
            Command::ValidatePatch { operation } => {
                shufang_domain::sync_validation::validate_patch(&operation)?;
                Ok(Value::Bool(true))
            }
            Command::NormalizeJson { json, canonical } => {
                Ok(shufang_domain::lossless_json::Json::parse(&json)?
                    .stringify(canonical)
                    .into())
            }
            Command::ApplyReplicaOperation {
                prior_json,
                operation_json,
            } => {
                use shufang_domain::lossless_sync::{ReplicaOperation, ReplicaState};
                let prior = prior_json.as_deref().map(ReplicaState::parse).transpose()?;
                Ok(
                    ReplicaState::apply(
                        prior.as_ref(),
                        &ReplicaOperation::parse(&operation_json)?,
                    )?
                    .stringify()
                    .into(),
                )
            }
            Command::MergeReplicaStates {
                prior_json,
                incoming_json,
            } => {
                use shufang_domain::lossless_sync::ReplicaState;
                let prior = prior_json.as_deref().map(ReplicaState::parse).transpose()?;
                Ok(
                    ReplicaState::merge(prior.as_ref(), &ReplicaState::parse(&incoming_json)?)?
                        .stringify()
                        .into(),
                )
            }
            Command::CreateLibraryRecord {
                kind,
                id,
                name_json,
                created_at,
                updated_at,
            } => Ok(shufang_application::record_drafts::create_record(
                &kind, &id, &name_json, created_at, updated_at,
            )?
            .stringify(false)
            .into()),
            Command::NormalizeStudySet { record_json, now } => Ok(
                shufang_application::record_drafts::normalize_study_set(&record_json, now)?
                    .stringify(false)
                    .into(),
            ),
        }
    };
    match run() {
        Ok(value) => json!({"ok":true,"value":value}),
        Err(code) => json!({"ok":false,"error":{"code":code}}),
    }
}

// Own every exported allocation in a registry. Invalid/double-free pointers are
// rejected rather than reconstructed with Vec::from_raw_parts.
fn buffers() -> &'static Mutex<BTreeMap<usize, Box<[u8]>>> {
    static BUFFERS: OnceLock<Mutex<BTreeMap<usize, Box<[u8]>>>> = OnceLock::new();
    BUFFERS.get_or_init(|| Mutex::new(BTreeMap::new()))
}
fn store(bytes: Vec<u8>) -> usize {
    let mut bytes = bytes.into_boxed_slice();
    let ptr = bytes.as_mut_ptr() as usize;
    let Ok(mut registry) = buffers().lock() else {
        return 0;
    };
    registry.insert(ptr, bytes);
    ptr
}

#[no_mangle]
pub extern "C" fn core_abi_version() -> u32 {
    1
}
#[no_mangle]
pub extern "C" fn core_alloc(length: usize) -> usize {
    if length == 0 || length > 16 * 1024 * 1024 {
        return 0;
    }
    store(vec![0; length])
}
#[no_mangle]
pub extern "C" fn core_buffer_len(pointer: usize) -> usize {
    buffers()
        .lock()
        .ok()
        .and_then(|b| b.get(&pointer).map(|v| v.len()))
        .unwrap_or(0)
}
#[no_mangle]
pub extern "C" fn core_free(pointer: usize) {
    if let Ok(mut registry) = buffers().lock() {
        registry.remove(&pointer);
    }
}
#[no_mangle]
pub extern "C" fn core_execute(pointer: usize) -> usize {
    let result = std::panic::catch_unwind(|| {
        let input = buffers()
            .lock()
            .ok()
            .and_then(|b| b.get(&pointer).map(|v| v.to_vec()));
        match input.and_then(|b| String::from_utf8(b).ok()) {
            Some(input) => execute(&input),
            None => json!({"ok":false,"error":{"code":"invalid_buffer"}}),
        }
    })
    .unwrap_or_else(|_| json!({"ok":false,"error":{"code":"internal_error"}}));
    store(result.to_string().into_bytes())
}
