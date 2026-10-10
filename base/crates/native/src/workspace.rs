use crate::storage::Storage;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use shufang_application::{CoreSession, Runtime};
use shufang_domain::sync::{valid_identifier, Operation, ENTITY_KINDS};
use shufang_sqlite::SqliteRepository;
use std::{
    collections::BTreeMap,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};

pub type Result<T> = std::result::Result<T, String>;
pub struct SystemRuntime;
impl Runtime for SystemRuntime {
    fn now(&self) -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64
    }
    fn new_id(&self) -> String {
        uuid::Uuid::new_v4().to_string()
    }
}
pub type Session = CoreSession<Storage, SystemRuntime>;
pub struct Workspace {
    pub root: PathBuf,
    pub(crate) database: PathBuf,
    pub core: Mutex<Session>,
    jobs: Mutex<BTreeMap<String, Arc<Job>>>,
    instance: String,
    _lease: std::fs::File,
    _update_lease: std::fs::File,
}
#[derive(Clone, Serialize)]
pub struct JobState {
    pub id: String,
    pub kind: String,
    pub status: String,
    pub progress: f64,
    pub result: Value,
    pub error: Option<String>,
}
pub struct Job {
    pub state: Mutex<JobState>,
    pub cancelled: AtomicBool,
}
impl Job {
    pub fn check(&self) -> Result<()> {
        if self.cancelled.load(Ordering::Acquire) {
            Err("cancelled".into())
        } else {
            Ok(())
        }
    }
    pub fn progress(&self, value: f64) {
        if let Ok(mut s) = self.state.lock() {
            s.progress = value;
        }
    }
}

impl Workspace {
    pub fn service_token(&self) -> Result<String> {
        #[cfg(not(windows))]
        if let Ok(token) = std::env::var("SHUFANG_SERVICE_TOKEN") {
            if token.len() < 32 || token.len() > 4096 {
                return Err("invalid_service_token".into());
            }
            return Ok(token);
        }
        {
            let lock = std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .open(self.root.join("credentials.lock"))
                .map_err(|e| e.to_string())?;
            fs2::FileExt::lock_exclusive(&lock).map_err(|e| e.to_string())?;
            match crate::credentials::load(&self.root, "service") {
                Ok(token) => Ok(token),
                Err(error) if error == "api_key_not_configured" => {
                    let token = format!(
                        "{}{}",
                        uuid::Uuid::new_v4().simple(),
                        uuid::Uuid::new_v4().simple()
                    );
                    crate::credentials::store(&self.root, "service", &token)?;
                    Ok(token)
                }
                Err(error) => Err(error),
            }
        }
    }
    pub fn cancel_all(&self) {
        if let Ok(jobs) = self.jobs.lock() {
            for job in jobs.values() {
                job.cancelled.store(true, Ordering::Release);
            }
        }
    }
    pub fn open(path: &Path, workspace: &str, replica: &str) -> Result<Arc<Self>> {
        if !path.is_absolute() {
            return Err("absolute_database_path_required".into());
        }
        std::fs::create_dir_all(path.parent().ok_or("invalid_database_path")?)
            .map_err(|e| e.to_string())?;
        let storage = Storage::Sqlite(SqliteRepository::open(path, workspace, replica)?);
        Self::open_storage(path, workspace, replica, storage)
    }
    #[cfg(feature = "server-mysql")]
    pub fn open_mysql(
        path: &Path,
        url: &str,
        workspace: &str,
        replica: &str,
        read_only: bool,
    ) -> Result<Arc<Self>> {
        if !path.is_absolute() {
            return Err("absolute_database_path_required".into());
        }
        if path
            .parent()
            .ok_or("invalid_database_path")?
            .join("restore.pending")
            .exists()
        {
            return Err("workspace_restore_incomplete".into());
        }
        let storage = Storage::Mysql(shufang_mysql::MysqlRepository::open(
            url, workspace, replica, read_only,
        )?);
        Self::open_storage(path, workspace, replica, storage)
    }
    fn open_storage(
        path: &Path,
        workspace: &str,
        replica: &str,
        storage: Storage,
    ) -> Result<Arc<Self>> {
        if !path.is_absolute() {
            return Err("absolute_database_path_required".into());
        }
        let root = path.parent().ok_or("invalid_database_path")?;
        if root.join("restore.pending").exists() {
            return Err("workspace_restore_incomplete".into());
        }
        std::fs::create_dir_all(root).map_err(|e| e.to_string())?;
        let update_lease = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(root.join("update.lock"))
            .map_err(|e| e.to_string())?;
        fs2::FileExt::try_lock_shared(&update_lease).map_err(|_| "workspace_update_in_progress")?;
        let core = CoreSession::new(storage, SystemRuntime, workspace.into(), replica.into())?
            .with_field_storage(Box::new(crate::sync_blobs::BlobStore::new(
                &root.join("sync-blobs"),
            )));
        let instance = uuid::Uuid::new_v4().to_string();
        std::fs::create_dir_all(root.join("jobs")).map_err(|e| e.to_string())?;
        let lease = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(root.join("jobs").join(format!("{instance}.lock")))
            .map_err(|e| e.to_string())?;
        fs2::FileExt::lock_exclusive(&lease).map_err(|e| e.to_string())?;
        Ok(Arc::new(Self {
            root: root.into(),
            database: path.into(),
            core: Mutex::new(core),
            jobs: Mutex::new(BTreeMap::new()),
            instance,
            _lease: lease,
            _update_lease: update_lease,
        }))
    }
    pub fn execute(self: &Arc<Self>, command: &str, args: Value) -> Result<Value> {
        #[derive(Deserialize)]
        struct Save {
            kind: String,
            id: String,
            patch: Value,
            #[serde(default)]
            unset: Vec<String>,
            expected: u64,
        }
        #[derive(Deserialize)]
        struct Target {
            kind: String,
            id: String,
            expected: u64,
        }
        match command {
            "enableSyncConflicts"|"syncConflicts"|"syncConflictPreview"|"resolveSyncConflict"=>crate::offline_sync::command(self,command,&args),
            "downloadState"|"removeDownload"|"enableDownload" => crate::local_download::command(self,command,&args),
            "exportStudyBackup" => crate::study_backup::export(self,&args),
            "previewStudyRestore" => crate::study_backup::preview(self,&args),
            "commitStudyRestore" => crate::study_backup::commit(self,&args),
            "cancelStudyRestore" => crate::study_backup::cancel(self,&args),
            "putAttachment" => crate::attachments::put(self,&args),
            "attachmentResource" => crate::attachments::resource(self,&args),
            "getReplica"=>serde_json::to_value(self.core.lock().map_err(|_|"core_lock_failed")?.replica_entity(string(&args,"kind")?,string(&args,"id")?)?).map_err(|e|e.to_string()),
            "mutateReplica"=>{
                let mut core=self.core.lock().map_err(|_|"core_lock_failed")?;
                let patch=args["patch"].as_object().cloned().ok_or("invalid_patch")?;
                let unset=serde_json::from_value(args.get("unset").cloned().unwrap_or(json!([]))).map_err(|_|"invalid_unset")?;
                let (duplicate,sequence)=core.local_replica_command_with_creation(string(&args,"kind")?,string(&args,"id")?,string(&args,"operationId")?,patch,unset,args["deleted"].as_bool().unwrap_or(false),args["create"].as_bool().unwrap_or(false))?;
                Ok(json!({"duplicate":duplicate,"sequence":sequence.to_string()}))
            },
            "syncConfig" => crate::sync_config::public_config(self),
            "saveSyncPeer" => crate::sync_config::save_peer(self,&args),
            "pauseSync" => crate::sync_config::pause(self,&args),
            "removeSyncPeer" => crate::sync_config::remove(self, &args),
            "requestSync" => crate::sync_config::request(self),
            "syncStatus" => crate::sync_config::status(self),
            "syncProgress" => {
                let id=string(&args,"id")?;let url=string(&args,"url")?;
                if !shufang_domain::sync::valid_identifier(id) {return Err("invalid_peer".into());}
                crate::sync_config::validate_url(url)?;
                let identity=format!("{:x}",Sha256::digest(json!([id,url,args["epoch"]]).to_string().as_bytes()));
                let core=self.core.lock().map_err(|_|"core_lock_failed")?;
                let (_,position)=core.sync_checkpoint(&format!("sync:send:{identity}"))?;
                let after=position.as_str().unwrap_or("0").parse().map_err(|_|"invalid_sync_checkpoint")?;
                let pending=core.replication_operations(after,100)?.len();
                let mut sources=Vec::new();let mut cursor=String::new();
                loop {let page=core.replication_entities(Some("sources"),&cursor)?;let more=page.len()==100;if let Some(last)=page.last(){cursor=format!("{}:{}",last.kind,last.id);}sources.extend(page);if !more {break;}}
                let originals=sources.iter().filter(|r|!r.deleted).count();
                drop(core);
                let mut missing=0;for source in sources.iter().filter(|r|!r.deleted){if self.book_file(&source.id).is_err(){missing+=1;}}
                Ok(json!({"pendingMetadata":pending,"pendingAtLeast":pending==100,"originals":originals,"missingOriginals":missing}))
            },
            "syncOnce" => {
                let peer:crate::replication::Peer=serde_json::from_value(args.clone()).map_err(|_|"invalid_peer")?;
                let workspace=self.clone();
                self.start("sync",move|job| {
                    job.check()?;
                    let runtime=tokio::runtime::Runtime::new().map_err(|_|"runtime_failed")?;
                    runtime.block_on(async {
                        let host=crate::transport_host::SyncHost::new(workspace.clone(),false);
                        tokio::select! {
                            result=crate::replication::tick_peer(&host,&peer)=>result,
                            _=async {loop {tokio::time::sleep(std::time::Duration::from_millis(100)).await;if job.check().is_err(){break;}}}=>Err("cancelled".into())
                        }
                    })?;
                    Ok(json!({"completed":true}))
                })
            },
            "deleteLegacyNote" => { self.core.lock().map_err(|_|"core_lock_failed")?.delete_legacy_note(string(&args,"id")?,number(&args,"expected")?)?;Ok(Value::Null) },
            "lookupMetadata" => { let query=string(&args,"query")?.to_owned();self.start("metadata",move|job|crate::metadata::lookup(&query,&job)) },
            "epubRendition" => crate::books::epub_rendition(&self.book_file(string(&args,"id")?)?),
            "outline" => self.core.lock().map_err(|_|"core_lock_failed")?.outline(string(&args,"id")?),
            "editOutline" => serde_json::to_value(self.core.lock().map_err(|_|"core_lock_failed")?.edit_outline(string(&args,"id")?,number(&args,"expected")?,&args)?).map_err(|e|e.to_string()),
            "setCover"=>{let path=PathBuf::from(string(&args,"path")?);if !path.is_absolute(){return Err("absolute_path_required".into());}let cover=crate::books::cover_data(&path)?;serde_json::to_value(self.core.lock().map_err(|_|"core_lock_failed")?.save_entity("books",string(&args,"id")?,json!({"customCover":cover}),vec![],number(&args,"expected")?)?).map_err(|e|e.to_string())},
            "saveAiResult"=>crate::ai::save_result(self,&args),
            "backup"=>{let destination=PathBuf::from(string(&args,"path")?);let workspace=self.clone();self.start("backup",move|job|{job.check()?;let core=workspace.core.lock().map_err(|_|"core_lock_failed")?;workspace.backup_locked(&core,&destination)?;Ok(json!({"path":destination}))})},
            "restore"=>{let archive=PathBuf::from(string(&args,"path")?);let destination=PathBuf::from(string(&args,"destination")?);let workspace=self.clone();self.start("restore",move|job|{job.check()?;let core=workspace.core.lock().map_err(|_|"core_lock_failed")?;workspace.restore_locked(&core,&archive,&destination,&args)?;Ok(json!({"path":destination}))})},
            "createVersion"=>self.create_version(),
            "listVersions"=>self.list_versions(),
            "deleteVersion"=>self.delete_version(string(&args,"id")?),
            "restoreVersion"=>self.restore_version(string(&args,"id")?, &args),
            "restoreVersionEntity"=>self.restore_version_entity(&args),
            "checkpoint"=>{
                let mut record=self.core.lock().map_err(|_|"core_lock_failed")?.checkpoint(string(&args,"id")?,string(&args,"session")?,args["progress"].clone(),number(&args,"activeSeconds")?)?;
                if args["summary"]==true {record.value.as_object_mut().ok_or("invalid_book")?.remove("chapters");}
                serde_json::to_value(record).map_err(|e|e.to_string())
            },
            "bookResource"=>Ok(json!({"path":self.book_file(string(&args,"id")?)?})),
            "serviceToken"=>Ok(json!({"token":self.service_token()?})),
            "list"=>serde_json::to_value(self.core.lock().map_err(|_|"core_lock_failed")?.entities(string(&args,"kind")?)?).map_err(|e|e.to_string()),
            "listPage" => {
                let limit=args["limit"].as_u64().unwrap_or(50);
                if limit==0 || limit>200 { return Err("invalid_page_limit".into()); }
                let offset=args["offset"].as_u64().unwrap_or(0);
                let start=usize::try_from(offset).map_err(|_|"invalid_page_offset")?;
                let (items,total)=self.core.lock().map_err(|_|"core_lock_failed")?.entities_page(string(&args,"kind")?,start,limit as usize,&["chapters"],crate::android_search::preview)?;
                let end=start.saturating_add(items.len()).min(total);
                let next=if end<total {Some(end)}else{None};
                Ok(json!({"items":items,"total":total,"nextOffset":next}))
            },
            "importParsed" => self.import_parsed(&args),
            "saveFromFile" => {
                let path=PathBuf::from(string(&args,"path")?);
                let file=std::fs::File::open(&path).map_err(|e|e.to_string())?;
                if file.metadata().map_err(|e|e.to_string())?.len()>8*1024*1024 {return Err("edit_size_limit".into());}
                let request:Value=serde_json::from_reader(file).map_err(|e|e.to_string())?;
                let saved=self.execute("save",request)?;
                let dir=self.root.join("projections");std::fs::create_dir_all(&dir).map_err(|e|e.to_string())?;
                let mut file=tempfile::NamedTempFile::new_in(&dir).map_err(|e|e.to_string())?;
                serde_json::to_writer(&mut file,&saved).map_err(|e|e.to_string())?;
                let (_,path)=file.keep().map_err(|e|e.to_string())?;
                Ok(json!({"path":path}))
            },
            "mergeInto" => crate::android_merge::merge(self,&args),
            "exportEntity" => {
                let record=self.core.lock().map_err(|_|"core_lock_failed")?.entity(string(&args,"kind")?,string(&args,"id")?)?;
                let dir=self.root.join("projections");std::fs::create_dir_all(&dir).map_err(|e|e.to_string())?;
                let mut file=tempfile::NamedTempFile::new_in(&dir).map_err(|e|e.to_string())?;
                serde_json::to_writer(&mut file,&record).map_err(|e|e.to_string())?;
                let (_,path)=file.keep().map_err(|e|e.to_string())?;
                Ok(json!({"path":path}))
            },
            "get"=>serde_json::to_value(self.core.lock().map_err(|_|"core_lock_failed")?.entity(string(&args,"kind")?,string(&args,"id")?)?).map_err(|e|e.to_string()),
            "save"=>{let a:Save=serde_json::from_value(args).map_err(|e|e.to_string())?;serde_json::to_value(self.core.lock().map_err(|_|"core_lock_failed")?.save_entity(&a.kind,&a.id,a.patch,a.unset,a.expected)?).map_err(|e|e.to_string())},
            "delete"=>{let a:Target=serde_json::from_value(args).map_err(|e|e.to_string())?;self.core.lock().map_err(|_|"core_lock_failed")?.delete_entity(&a.kind,&a.id,a.expected)?;Ok(Value::Null)},
            "search"=>Ok(self.core.lock().map_err(|_|"core_lock_failed")?.search(string(&args,"query")?)?.into()),
            "searchPage"=>crate::android_search::search(self,&args),
            "reviewQueue"=>serde_json::to_value(self.core.lock().map_err(|_|"core_lock_failed")?.review_queue(args["studySet"].as_str())?).map_err(|e|e.to_string()),
            "setReview"=>serde_json::to_value(self.core.lock().map_err(|_|"core_lock_failed")?.set_review(string(&args,"id")?,args["enabled"].as_bool().ok_or("invalid_enabled")?,number(&args,"expected")?)?).map_err(|e|e.to_string()),
            "review"=>serde_json::to_value(self.core.lock().map_err(|_|"core_lock_failed")?.review(string(&args,"id")?,u8::try_from(number(&args,"rating")?).map_err(|_|"invalid_rating")?,number(&args,"expected")?)?).map_err(|e|e.to_string()),
            "cite"=>{self.core.lock().map_err(|_|"core_lock_failed")?.link_citation(string(&args,"highlight")?,string(&args,"note")?,number(&args,"highlightRevision")?,number(&args,"noteRevision")?)?;Ok(Value::Null)},
            "uncite"=>{self.core.lock().map_err(|_|"core_lock_failed")?.unlink_citation(string(&args,"highlight")?,number(&args,"highlightRevision")?,number(&args,"noteRevision")?)?;Ok(Value::Null)},
            "changes"=>serde_json::to_value(self.core.lock().map_err(|_|"core_lock_failed")?.changes(args["after"].as_u64().unwrap_or(0),1000)?).map_err(|e|e.to_string()),
            "import"=>{let source=PathBuf::from(string(&args,"path")?);let mode=args["readerMode"].as_str().unwrap_or("original").to_owned();let workspace=self.clone();self.start("import",move|job|workspace.import(&source,&mode,&job))},
            "job"=>self.job_state(string(&args,"id")?),
            "cancelJob"=>{let jobs=self.jobs.lock().map_err(|_|"jobs_lock_failed")?;jobs.get(string(&args,"id")?).ok_or("job_not_found")?.cancelled.store(true,Ordering::Release);Ok(Value::Null)},
            "forgetJob"=>{let mut jobs=self.jobs.lock().map_err(|_|"jobs_lock_failed")?;let id=string(&args,"id")?;if jobs.get(id).is_some_and(|j|j.state.lock().is_ok_and(|s|s.status=="running")){return Err("job_running".into());}jobs.remove(id);Ok(Value::Null)},
            "aiConfig"=>Ok(self.core.lock().map_err(|_|"core_lock_failed")?.local_value("ai-config")?.map(|(revision,value)|json!({"revision":revision,"value":value})).unwrap_or(json!({"revision":0,"value":{"provider":"deepseek","model":"","effort":"none"}}))),
            "saveAiConfig"=>self.save_ai_config(&args),
            "ai"=>{let workspace=self.clone();self.start("ai",move|job|crate::ai::run(&workspace,args,&job))},
            _=>Err("unknown_workspace_command".into()),
        }
    }
    fn version_path(&self, id: &str) -> Result<PathBuf> {
        if !(id.starts_with("version-") || id.starts_with("safety-"))
            || !valid_identifier(id)
            || id.len() > 80
        {
            return Err("invalid_version_id".into());
        }
        Ok(self.root.join("versions").join(format!("{id}.zip")))
    }
    fn backup_locked(&self, core: &Session, destination: &Path) -> Result<()> {
        match core.repository() {
            Storage::Sqlite(_) => crate::backup::create(&self.database, destination),
            #[cfg(feature = "server-mysql")]
            Storage::Mysql(r) => crate::backup::create_mysql(r, &self.root, destination),
        }
    }
    fn delete_snapshot_locked(&self, core: &mut Session, id: &str) -> Result<()> {
        match core.repository_mut() {
            Storage::Sqlite(_) => {
                shufang_sqlite::SqliteRepository::delete_version_snapshot(&self.database, id)
            }
            #[cfg(feature = "server-mysql")]
            Storage::Mysql(r) => r.delete_version(id),
        }
    }
    fn restore_locked(
        &self,
        core: &Session,
        archive: &Path,
        destination: &Path,
        args: &Value,
    ) -> Result<()> {
        let _ = args;
        match core.repository() {
            Storage::Sqlite(_) => crate::backup::restore(archive, destination),
            #[cfg(feature = "server-mysql")]
            Storage::Mysql(_) => {
                let reference = string(args, "databaseUrlEnv")?;
                if reference.is_empty()
                    || reference.len() > 128
                    || !reference
                        .bytes()
                        .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == b'_')
                {
                    return Err("invalid_database_reference".into());
                }
                let url =
                    std::env::var(reference).map_err(|_| "restore_database_not_configured")?;
                crate::backup::restore_mysql(archive, destination, &url).map(|_| ())
            }
        }
    }
    fn create_version(&self) -> Result<Value> {
        let id = format!("version-{}", uuid::Uuid::new_v4());
        let archive = self.version_path(&id)?;
        std::fs::create_dir_all(archive.parent().ok_or("invalid_version_path")?)
            .map_err(|e| e.to_string())?;
        let mut core = self.core.lock().map_err(|_| "core_lock_failed")?;
        let head = core.replication_head()?;
        let sequence = head.sequence.parse::<u64>().map_err(|_| "invalid_head")?;
        let checkpoint = URL_SAFE_NO_PAD.encode(json!({"workspace":head.workspace_id,"node":head.node_id,"epoch":head.epoch,"seq":head.sequence}).to_string());
        core.create_sync_snapshot(&id, &checkpoint, sequence)?;
        if let Err(error) = self.backup_locked(&core, &archive) {
            self.delete_snapshot_locked(&mut core, &id)?;
            return Err(error);
        }
        Ok(json!({"id":id,"archive":archive,"checkpoint":checkpoint}))
    }
    fn list_versions(&self) -> Result<Value> {
        let mut values = Vec::new();
        let core = self.core.lock().map_err(|_| "core_lock_failed")?;
        let versions = match core.repository() {
            Storage::Sqlite(_) => {
                shufang_sqlite::SqliteRepository::list_version_snapshots(&self.database)?
            }
            #[cfg(feature = "server-mysql")]
            Storage::Mysql(r) => r
                .list_versions()?
                .into_iter()
                .map(|(id, at)| (id, at as i64))
                .collect(),
        };
        for (id, created_at) in versions {
            let path = self.version_path(&id)?;
            if path.is_file() {
                values
                    .push(json!({"id":id,"kind":"version","createdAt":created_at,"archive":path}));
            }
        }
        let directory = self.root.join("versions");
        if directory.is_dir() {
            for entry in std::fs::read_dir(directory).map_err(|e| e.to_string())? {
                let entry = entry.map_err(|e| e.to_string())?;
                if !entry.file_type().map_err(|e| e.to_string())?.is_file() {
                    continue;
                }
                let name = entry
                    .file_name()
                    .into_string()
                    .map_err(|_| "invalid_version_path")?;
                let Some(id) = name.strip_suffix(".zip") else {
                    continue;
                };
                if id.starts_with("safety-") && self.version_path(id).is_ok() {
                    values.push(json!({"id":id,"kind":"safety","archive":entry.path()}));
                }
            }
        }
        Ok(Value::Array(values))
    }
    fn delete_version(&self, id: &str) -> Result<Value> {
        let archive = self.version_path(id)?;
        if !archive.is_file() {
            return Err("version_not_found".into());
        }
        if id.starts_with("safety-") {
            std::fs::remove_file(archive).map_err(|e| e.to_string())?;
            return Ok(Value::Null);
        }
        let deleting = archive.with_extension("deleting");
        std::fs::rename(&archive, &deleting).map_err(|e| e.to_string())?;
        let mut core = self.core.lock().map_err(|_| "core_lock_failed")?;
        if let Err(error) = self.delete_snapshot_locked(&mut core, id) {
            std::fs::rename(&deleting, &archive).map_err(|e| e.to_string())?;
            return Err(error);
        }
        std::fs::remove_file(deleting).map_err(|e| e.to_string())?;
        Ok(Value::Null)
    }
    fn restore_version(&self, id: &str, args: &Value) -> Result<Value> {
        let archive = self.version_path(id)?;
        if !id.starts_with("version-") || !archive.is_file() {
            return Err("version_not_found".into());
        }
        let safety = self.version_path(&format!("safety-{}", uuid::Uuid::new_v4()))?;
        let core = self.core.lock().map_err(|_| "core_lock_failed")?;
        self.backup_locked(&core, &safety)?;
        let destination = self
            .root
            .parent()
            .ok_or("invalid_workspace")?
            .join(format!("restored-{}", uuid::Uuid::new_v4()));
        self.restore_locked(&core, &archive, &destination, args)?;
        Ok(json!({"path":destination,"safetyBackup":safety,"activationRequired":true}))
    }
    fn restore_version_entity(&self, args: &Value) -> Result<Value> {
        let version = string(args, "version")?;
        let kind = string(args, "kind")?;
        let source = string(args, "id")?;
        let target = args["newEntityId"].as_str().unwrap_or(source);
        let operation_id = string(args, "operationId")?;
        if !ENTITY_KINDS.contains(&kind)
            || kind == "reviews"
            || !valid_identifier(source)
            || !valid_identifier(target)
            || !valid_identifier(operation_id)
        {
            return Err("invalid_restore_target".into());
        }
        if !self.version_path(version)?.is_file() {
            return Err("version_not_found".into());
        }
        let mut core = self.core.lock().map_err(|_| "core_lock_failed")?;
        let state = match core.repository() {
            Storage::Sqlite(_) => shufang_sqlite::SqliteRepository::version_entity(
                &self.database,
                version,
                kind,
                source,
            )?,
            #[cfg(feature = "server-mysql")]
            Storage::Mysql(r) => r.version_entity(version, kind, source)?,
        };
        if state.deleted {
            return Err("snapshot_entity_deleted".into());
        }
        let patch: serde_json::Map<String, Value> = state
            .fields
            .into_iter()
            .filter(|(_, field)| !field.removed)
            .filter_map(|(key, field)| field.value.map(|value| (key, value)))
            .collect();
        let head = core.replication_head()?;
        let current = match core.entity(kind, target) {
            Ok(record) => Some(record),
            Err(error) if error == "not_found" || error == "entity_deleted" => None,
            Err(error) => return Err(error),
        };
        let unset = current
            .and_then(|record| record.value.as_object().cloned())
            .map(|record| {
                record
                    .keys()
                    .filter(|key| *key != "id" && !patch.contains_key(*key))
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();
        let operation = Operation {
            workspace_id: head.workspace_id,
            replica_id: head.node_id,
            operation_id: operation_id.to_owned(),
            kind: kind.to_owned(),
            entity_id: target.to_owned(),
            clock: core.mutation_clock(operation_id)?,
            patch,
            unset,
            deleted: false,
        };
        let (duplicate, sequence) = core.mutate_replica_entity(operation)?;
        Ok(
            json!({"entityId":target,"receipt":{"operationId":operation_id,"duplicate":duplicate,"seq":sequence.to_string()}}),
        )
    }
    fn save_ai_config(&self, args: &Value) -> Result<Value> {
        let config: crate::ai::Config =
            serde_json::from_value(args["config"].clone()).map_err(|_| "invalid_ai_config")?;
        config.validate()?;
        let expected = number(args, "expected")?;
        let lock = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(self.root.join("credentials.lock"))
            .map_err(|e| e.to_string())?;
        fs2::FileExt::lock_exclusive(&lock).map_err(|e| e.to_string())?;
        let mut core = self.core.lock().map_err(|_| "core_lock_failed")?;
        if core
            .local_value("ai-config")?
            .map_or(0, |(revision, _)| revision)
            != expected
        {
            return Err("revision_conflict".into());
        }
        if let Some(secret) = args["apiKey"].as_str().filter(|s| !s.is_empty()) {
            crate::credentials::store(&self.root, &config.provider, secret)?;
        }
        let revision = core.set_local_value(
            "ai-config",
            expected,
            &serde_json::to_value(config).map_err(|e| e.to_string())?,
        )?;
        Ok(json!({"revision":revision}))
    }
    pub fn start<F>(self: &Arc<Self>, kind: &str, action: F) -> Result<Value>
    where
        F: FnOnce(Arc<Job>) -> Result<Value> + Send + 'static,
    {
        self.start_with_receipt(kind, None, action)
    }
    /// Persist job creation and its retry identity in one repository transaction.
    pub fn start_with_receipt<F>(
        self: &Arc<Self>,
        kind: &str,
        receipt: Option<(&str, &str)>,
        action: F,
    ) -> Result<Value>
    where
        F: FnOnce(Arc<Job>) -> Result<Value> + Send + 'static,
    {
        let mut jobs = self.jobs.lock().map_err(|_| "jobs_lock_failed")?;
        if let Some((key, fingerprint)) = receipt {
            let core = self.core.lock().map_err(|_| "core_lock_failed")?;
            if let Some((_, existing)) = core.local_value(key)? {
                if existing["fingerprint"] != fingerprint {
                    return Err("operation_id_reused".into());
                }
                return core
                    .local_value(&format!("{key}:job"))?
                    .map(|(_, v)| v)
                    .ok_or("job_receipt_missing".into());
            }
        }
        // Terminal results are persisted in local_values and remain readable via
        // job_state after eviction. Reserve the in-memory table for active work.
        if jobs.len() >= 128 {
            let terminal: Vec<String> = jobs
                .iter()
                .filter(|(_, job)| job.state.lock().is_ok_and(|s| s.status != "running"))
                .map(|(id, _)| id.clone())
                .take(jobs.len().saturating_sub(64))
                .collect();
            for id in terminal {
                jobs.remove(&id);
            }
        }
        if jobs.len() >= 128
            || jobs
                .values()
                .filter(|j| j.state.lock().is_ok_and(|s| s.status == "running"))
                .count()
                >= 4
        {
            return Err("job_limit".into());
        }
        let id = uuid::Uuid::new_v4().to_string();
        let job = Arc::new(Job {
            state: Mutex::new(JobState {
                id: id.clone(),
                kind: kind.into(),
                status: "running".into(),
                progress: 0.0,
                result: Value::Null,
                error: None,
            }),
            cancelled: AtomicBool::new(false),
        });
        let initial =
            serde_json::to_value(job.state.lock().map_err(|_| "job_lock_failed")?.clone())
                .map_err(|e| e.to_string())?;
        let initial = json!({"owner":self.instance,"state":initial});
        {
            let mut core = self.core.lock().map_err(|_| "core_lock_failed")?;
            if let Some((key, fingerprint)) = receipt {
                core.with_receipt(
                    key,
                    fingerprint,
                    vec![shufang_application::LocalCommit {
                        key: format!("{key}:job"),
                        expected: 0,
                        value: json!({"job":id}),
                    }],
                    |c| {
                        c.set_local_value(&format!("job:{id}"), 0, &initial)?;
                        Ok(())
                    },
                )?;
            } else {
                core.set_local_value(&format!("job:{id}"), 0, &initial)?;
            }
        }
        jobs.insert(id.clone(), job.clone());
        let workspace = self.clone();
        std::thread::spawn(move || {
            let result =
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| action(job.clone())))
                    .unwrap_or_else(|_| Err("job_failed".into()));
            if let Ok(mut s) = job.state.lock() {
                match result {
                    Ok(value) => {
                        s.status = "completed".into();
                        s.progress = 1.0;
                        s.result = value;
                    }
                    Err(error) => {
                        s.status = if error == "cancelled" {
                            "cancelled"
                        } else {
                            "failed"
                        }
                        .into();
                        s.error = Some(error);
                    }
                }
                let persisted = (|| -> Result<()> {
                    let mut core = workspace.core.lock().map_err(|_| "core_lock_failed")?;
                    let key = format!("job:{}", s.id);
                    let (revision, mut value) = core.local_value(&key)?.ok_or("job_not_found")?;
                    value["state"] = serde_json::to_value(&*s).map_err(|e| e.to_string())?;
                    core.set_local_value(&key, revision, &value)?;
                    Ok(())
                })();
                if persisted.is_err() {
                    s.status = "failed".into();
                    s.error = Some("job_result_persistence_failed".into());
                }
            }
        });
        Ok(json!({"job":id}))
    }
    fn job_state(&self, id: &str) -> Result<Value> {
        if uuid::Uuid::parse_str(id).is_err() {
            return Err("job_not_found".into());
        }
        if let Some(job) = self.jobs.lock().map_err(|_| "jobs_lock_failed")?.get(id) {
            return serde_json::to_value(job.state.lock().map_err(|_| "job_lock_failed")?.clone())
                .map_err(|e| e.to_string());
        }
        let (_, mut value) = self
            .core
            .lock()
            .map_err(|_| "core_lock_failed")?
            .local_value(&format!("job:{id}"))?
            .ok_or("job_not_found")?;
        if value["state"]["status"] == "running" {
            let owner = value["owner"].as_str().ok_or("invalid_job")?;
            if uuid::Uuid::parse_str(owner).is_err() {
                return Err("invalid_job".into());
            }
            let active = std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(self.root.join("jobs").join(format!("{owner}.lock")))
                .is_ok_and(|file| fs2::FileExt::try_lock_exclusive(&file).is_err());
            if !active {
                value["state"]["status"] = "failed".into();
                value["state"]["error"] = "interrupted_restart_required".into();
            }
        }
        Ok(value["state"].take())
    }
    pub fn import(&self, source: &Path, mode: &str, job: &Job) -> Result<Value> {
        self.import_with_parsed(source, mode, job, None)
    }
    fn import_parsed(&self, args: &Value) -> Result<Value> {
        let source = PathBuf::from(string(args, "path")?);
        let parsed = PathBuf::from(string(args, "parsedPath")?);
        if !parsed.is_absolute() {
            return Err("absolute_path_required".into());
        }
        let file = std::fs::File::open(parsed).map_err(|e| e.to_string())?;
        if file.metadata().map_err(|e| e.to_string())?.len() > shufang_application::MAX_BLOB_SIZE {
            return Err("parsed_book_size_limit".into());
        }
        let book: Value = serde_json::from_reader(file).map_err(|_| "invalid_parsed_book")?;
        if !book["title"].is_string()
            || !book["author"].is_string()
            || !book["chapters"].is_array()
            || !book["progress"].is_object()
        {
            return Err("invalid_parsed_book".into());
        }
        let job = Job {
            state: Mutex::new(JobState {
                id: String::new(),
                kind: "import".into(),
                status: "running".into(),
                progress: 0.0,
                result: Value::Null,
                error: None,
            }),
            cancelled: AtomicBool::new(false),
        };
        self.import_with_parsed(
            &source,
            args["readerMode"].as_str().unwrap_or("reflow"),
            &job,
            Some(book),
        )
    }
    fn import_with_parsed(
        &self,
        source: &Path,
        mode: &str,
        job: &Job,
        parsed: Option<Value>,
    ) -> Result<Value> {
        if !source.is_absolute() || !["original", "reflow"].contains(&mode) {
            return Err("invalid_import".into());
        }
        let metadata = std::fs::metadata(source).map_err(|e| e.to_string())?;
        if !metadata.is_file() || metadata.len() > shufang_application::MAX_BLOB_SIZE {
            return Err("invalid_book_size".into());
        }
        let files = self.root.join("files");
        std::fs::create_dir_all(&files).map_err(|e| e.to_string())?;
        let mut staged = tempfile::NamedTempFile::new_in(&files).map_err(|e| e.to_string())?;
        let mut input = std::fs::File::open(source).map_err(|e| e.to_string())?;
        let mut hash = Sha256::new();
        let mut buffer = vec![0; 1024 * 1024];
        let mut total = 0u64;
        loop {
            job.check()?;
            let read = input.read(&mut buffer).map_err(|e| e.to_string())?;
            if read == 0 {
                break;
            }
            total += read as u64;
            if total > shufang_application::MAX_BLOB_SIZE {
                return Err("book_size_limit".into());
            }
            hash.update(&buffer[..read]);
            staged
                .write_all(&buffer[..read])
                .map_err(|e| e.to_string())?;
            job.progress(0.2 * (total as f64 / metadata.len().max(1) as f64));
        }
        staged.as_file().sync_all().map_err(|e| e.to_string())?;
        job.check()?;
        // Parse the staged immutable bytes, retaining only a validated extension.
        let extension = source
            .extension()
            .and_then(|v| v.to_str())
            .ok_or("unsupported_format")?
            .to_lowercase();
        if !["pdf", "epub", "mobi", "azw", "azw3", "fb2", "txt"].contains(&extension.as_str()) {
            return Err("unsupported_format".into());
        }
        let hash = format!("{:x}", hash.finalize());
        let relative = format!("{hash}.{extension}");
        let destination = files.join(&relative);
        if !destination.exists() {
            staged
                .persist_noclobber(&destination)
                .map_err(|e| e.to_string())?;
        }
        job.progress(0.25);
        let supplied = parsed.is_some();
        let mut book = match parsed {
            Some(value) => value,
            None => crate::books::parse(&destination)?,
        };
        job.check()?;
        if !supplied && ["txt", "pdf"].contains(&extension.as_str()) {
            book["title"] = source
                .file_stem()
                .and_then(|v| v.to_str())
                .unwrap_or("书籍")
                .into();
            if extension == "txt" {
                book["chapters"][0]["title"] = book["title"].clone();
            }
        }
        book["sourceFile"] = relative.into();
        book["format"] = if extension == "azw" {
            "mobi"
        } else {
            &extension
        }
        .into();
        book["contentHash"] = hash.clone().into();
        if extension == "pdf" {
            let has_text = book["chapters"].as_array().is_some_and(|chapters| {
                chapters.iter().any(|c| {
                    c["paragraphs"].as_array().is_some_and(|paragraphs| {
                        paragraphs
                            .iter()
                            .any(|p| p.as_str().is_some_and(|s| !s.trim().is_empty()))
                    })
                })
            });
            book["readerMode"] = if has_text { mode } else { "original" }.into();
        }
        let manifest = shufang_application::BlobManifest {
            sha256: hash.clone(),
            size: total,
            name: source
                .file_name()
                .and_then(|v| v.to_str())
                .ok_or("invalid_source_name")?
                .into(),
            content_type: match extension.as_str() {
                "pdf" => "application/pdf",
                "epub" => "application/epub+zip",
                "txt" => "text/plain",
                _ => "application/octet-stream",
            }
            .into(),
        };
        let blobs = crate::sync_blobs::BlobStore::new(&self.root.join("sync-blobs"));
        let upload = blobs.create(&manifest)?;
        if !upload.present {
            let mut input = std::fs::File::open(&destination).map_err(|e| e.to_string())?;
            let mut bytes = vec![0; shufang_application::CHUNK_SIZE as usize];
            for index in 0..upload.chunks {
                job.check()?;
                let length = manifest.chunk_length(index)? as usize;
                input
                    .read_exact(&mut bytes[..length])
                    .map_err(|e| e.to_string())?;
                blobs.put(
                    &upload.id,
                    index,
                    &bytes[..length],
                    &format!("{:x}", Sha256::digest(&bytes[..length])),
                )?;
            }
        }
        if blobs.commit(&upload.id)? != manifest {
            return Err("source_manifest_mismatch".into());
        }
        let mut core = self.core.lock().map_err(|_| "core_lock_failed")?;
        job.check()?;
        if let Some(existing) = core
            .entities("books")?
            .into_iter()
            .find(|r| r.value["contentHash"] == hash)
        {
            core.attach_book_source(string(&existing.value, "id")?, &manifest)?;
            return serde_json::to_value(existing).map_err(|e| e.to_string());
        }
        serde_json::to_value(core.import_book(
            &uuid::Uuid::new_v4().to_string(),
            book,
            &manifest,
        )?)
        .map_err(|e| e.to_string())
    }
    pub fn book_file(&self, id: &str) -> Result<PathBuf> {
        if !crate::local_download::enabled(self, id)? {
            return Err("download_removed".into());
        }
        let source = self
            .core
            .lock()
            .map_err(|_| "core_lock_failed")?
            .book_source(id);
        match source {
            Ok(manifest) => {
                let blobs = crate::sync_blobs::BlobStore::new(&self.root.join("sync-blobs"));
                if !blobs.has(&manifest.sha256)? {
                    return Err("source_not_available".into());
                }
                let path = blobs.path(&manifest.sha256)?;
                if std::fs::metadata(&path)
                    .map_err(|_| "source_not_available")?
                    .len()
                    != manifest.size
                {
                    return Err("source_size_mismatch".into());
                }
                return Ok(path);
            }
            Err(error) if error == "source_not_found" => {}
            Err(error) => return Err(error),
        }
        let book = self
            .core
            .lock()
            .map_err(|_| "core_lock_failed")?
            .entity("books", id)?;
        let relative = string(&book.value, "sourceFile")?;
        if relative.contains(['/', '\\', ':']) || relative.starts_with('.') {
            return Err("invalid_resource_path".into());
        }
        let files = self
            .root
            .join("files")
            .canonicalize()
            .map_err(|e| e.to_string())?;
        let path = files
            .join(relative)
            .canonicalize()
            .map_err(|e| e.to_string())?;
        if !path.starts_with(files) {
            return Err("invalid_resource_path".into());
        }
        Ok(path)
    }
}
pub fn string<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value[key].as_str().ok_or_else(|| format!("invalid_{key}"))
}
pub fn number(value: &Value, key: &str) -> Result<u64> {
    value[key].as_u64().ok_or_else(|| format!("invalid_{key}"))
}
