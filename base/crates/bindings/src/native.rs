use serde::Deserialize;
use serde_json::{json, Value};
use shufang_native::workspace::Workspace;
use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{Arc, Mutex, OnceLock},
};

#[derive(Deserialize)]
#[serde(tag = "command")]
enum Command {
    #[serde(rename = "sessionConfigureVault")]
    ConfigureVault { key: String },
    #[serde(rename = "sessionDatabaseVersion")]
    DatabaseVersion { database: PathBuf },
    #[serde(rename = "sessionBackupClosed")]
    BackupClosed {
        database: PathBuf,
        destination: PathBuf,
    },
    #[serde(rename = "sessionOpen")]
    Open {
        path: PathBuf,
        workspace: String,
        replica: String,
    },
    #[serde(rename = "sessionClose")]
    Close { session: String },
    #[serde(rename = "sessionNotes")]
    Notes { session: String },
    #[serde(rename = "sessionSaveNote")]
    SaveNote {
        session: String,
        id: String,
        title: String,
        content: String,
        expected: u64,
    },
    #[serde(rename = "sessionPending")]
    Pending { session: String },
    #[serde(rename = "sessionCommand")]
    Dispatch {
        session: String,
        action: String,
        #[serde(default)]
        args: Value,
    },
}
pub fn execute(value: Value) -> Result<Value, String> {
    static SESSIONS: OnceLock<Mutex<BTreeMap<String, Arc<Workspace>>>> = OnceLock::new();
    let command: Command = serde_json::from_value(value).map_err(|_| "invalid_command")?;
    if let Command::ConfigureVault { key } = command {
        #[cfg(target_os = "android")]
        {
            if key.len() != 64 || !key.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err("invalid_credential_key".into());
            }
            static KEY: OnceLock<String> = OnceLock::new();
            let prior = KEY.get_or_init(|| {
                std::env::set_var("SHUFANG_CREDENTIAL_KEY", &key);
                key.clone()
            });
            if prior != &key {
                return Err("credential_key_already_initialized".into());
            }
            return Ok(Value::Null);
        }
        #[cfg(not(target_os = "android"))]
        {
            let _ = key;
            return Err("android_command_required".into());
        }
    }
    if let Command::DatabaseVersion { database } = command {
        if !database.is_absolute() {
            return Err("absolute_path_required".into());
        }
        return Ok(json!(shufang_sqlite::SqliteRepository::read_version(
            &database
        )?));
    }
    if let Command::BackupClosed {
        database,
        destination,
    } = command
    {
        if !database.is_absolute() || !destination.is_absolute() {
            return Err("absolute_path_required".into());
        }
        shufang_native::backup::create(&database, &destination)?;
        return Ok(json!({"path":destination}));
    }
    let mut sessions = SESSIONS
        .get_or_init(|| Mutex::new(BTreeMap::new()))
        .lock()
        .map_err(|_| "session_lock_failed")?;
    if let Command::Open {
        path,
        workspace,
        replica,
    } = command
    {
        if sessions.len() >= 64 {
            return Err("session_limit".into());
        }
        let core = Workspace::open(&path, &workspace, &replica)?;
        let session = uuid::Uuid::new_v4().to_string();
        sessions.insert(session.clone(), core);
        return Ok(json!({"session":session}));
    }
    if let Command::Close { session } = command {
        let workspace = sessions.remove(&session).ok_or("session_closed")?;
        workspace.cancel_all();
        return Ok(Value::Null);
    }
    let session = match &command {
        Command::Notes { session }
        | Command::SaveNote { session, .. }
        | Command::Pending { session }
        | Command::Dispatch { session, .. } => session,
        _ => unreachable!(),
    };
    let workspace = sessions.get(session).cloned().ok_or("session_closed")?;
    drop(sessions);
    match command {
        Command::Dispatch { action, args, .. } => workspace.execute(&action, args),
        Command::Notes { .. } => Ok(workspace
            .core
            .lock()
            .map_err(|_| "core_lock_failed")?
            .notes()?
            .into()),
        Command::Pending { .. } => serde_json::to_value(
            workspace
                .core
                .lock()
                .map_err(|_| "core_lock_failed")?
                .pending()?,
        )
        .map_err(|_| "serialization_error".into()),
        Command::SaveNote {
            id,
            title,
            content,
            expected,
            ..
        } => workspace
            .core
            .lock()
            .map_err(|_| "core_lock_failed")?
            .save_note(&id, &title, &content, expected),
        _ => unreachable!(),
    }
}
