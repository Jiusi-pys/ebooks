use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use shufang_application::{CoreSession, Runtime};
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
pub type Session = CoreSession<SqliteRepository, SystemRuntime>;
pub struct Workspace {
    pub root: PathBuf,
    database: PathBuf,
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
        let root = path.parent().ok_or("invalid_database_path")?;
        std::fs::create_dir_all(root).map_err(|e| e.to_string())?;
        let update_lease = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(root.join("update.lock"))
            .map_err(|e| e.to_string())?;
        fs2::FileExt::try_lock_shared(&update_lease).map_err(|_| "workspace_update_in_progress")?;
        let core = CoreSession::new(
            SqliteRepository::open(path, workspace, replica)?,
            SystemRuntime,
            workspace.into(),
            replica.into(),
        )?
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
            "syncConfig" => crate::sync_config::public_config(self),
            "saveSyncPeer" => crate::sync_config::save_peer(self,&args),
            "pauseSync" => crate::sync_config::pause(self,&args),
            "removeSyncPeer" => crate::sync_config::remove(self, &args),
            "requestSync" => crate::sync_config::request(self),
            "syncStatus" => crate::sync_config::status(self),
            "deleteLegacyNote" => { self.core.lock().map_err(|_|"core_lock_failed")?.delete_legacy_note(string(&args,"id")?,number(&args,"expected")?)?;Ok(Value::Null) },
            "lookupMetadata" => { let query=string(&args,"query")?.to_owned();self.start("metadata",move|job|crate::metadata::lookup(&query,&job)) },
            "epubRendition" => crate::books::epub_rendition(&self.book_file(string(&args,"id")?)?),
            "outline" => self.core.lock().map_err(|_|"core_lock_failed")?.outline(string(&args,"id")?),
            "editOutline" => serde_json::to_value(self.core.lock().map_err(|_|"core_lock_failed")?.edit_outline(string(&args,"id")?,number(&args,"expected")?,&args)?).map_err(|e|e.to_string()),
            "setCover"=>{let path=PathBuf::from(string(&args,"path")?);if !path.is_absolute(){return Err("absolute_path_required".into());}let cover=crate::books::cover_data(&path)?;serde_json::to_value(self.core.lock().map_err(|_|"core_lock_failed")?.save_entity("books",string(&args,"id")?,json!({"customCover":cover}),vec![],number(&args,"expected")?)?).map_err(|e|e.to_string())},
            "saveAiResult"=>crate::ai::save_result(self,&args),
            "backup"=>{let destination=PathBuf::from(string(&args,"path")?);let database=self.database.clone();self.start("backup",move|job|{job.check()?;crate::backup::create(&database,&destination)?;Ok(json!({"path":destination}))})},
            "restore"=>{let archive=PathBuf::from(string(&args,"path")?);let destination=PathBuf::from(string(&args,"destination")?);self.start("restore",move|job|{job.check()?;crate::backup::restore(&archive,&destination)?;Ok(json!({"path":destination}))})},
            "checkpoint"=>serde_json::to_value(self.core.lock().map_err(|_|"core_lock_failed")?.checkpoint(string(&args,"id")?,string(&args,"session")?,args["progress"].clone(),number(&args,"activeSeconds")?)?).map_err(|e|e.to_string()),
            "bookResource"=>Ok(json!({"path":self.book_file(string(&args,"id")?)?})),
            "serviceToken"=>Ok(json!({"token":self.service_token()?})),
            "list"=>serde_json::to_value(self.core.lock().map_err(|_|"core_lock_failed")?.entities(string(&args,"kind")?)?).map_err(|e|e.to_string()),
            "get"=>serde_json::to_value(self.core.lock().map_err(|_|"core_lock_failed")?.entity(string(&args,"kind")?,string(&args,"id")?)?).map_err(|e|e.to_string()),
            "save"=>{let a:Save=serde_json::from_value(args).map_err(|e|e.to_string())?;serde_json::to_value(self.core.lock().map_err(|_|"core_lock_failed")?.save_entity(&a.kind,&a.id,a.patch,a.unset,a.expected)?).map_err(|e|e.to_string())},
            "delete"=>{let a:Target=serde_json::from_value(args).map_err(|e|e.to_string())?;self.core.lock().map_err(|_|"core_lock_failed")?.delete_entity(&a.kind,&a.id,a.expected)?;Ok(Value::Null)},
            "search"=>Ok(self.core.lock().map_err(|_|"core_lock_failed")?.search(string(&args,"query")?)?.into()),
            "reviewQueue"=>serde_json::to_value(self.core.lock().map_err(|_|"core_lock_failed")?.review_queue(args["studySet"].as_str())?).map_err(|e|e.to_string()),
            "setReview"=>serde_json::to_value(self.core.lock().map_err(|_|"core_lock_failed")?.set_review(string(&args,"id")?,args["enabled"].as_bool().ok_or("invalid_enabled")?,number(&args,"expected")?)?).map_err(|e|e.to_string()),
            "review"=>serde_json::to_value(self.core.lock().map_err(|_|"core_lock_failed")?.review(string(&args,"id")?,u8::try_from(number(&args,"rating")?).map_err(|_|"invalid_rating")?,number(&args,"expected")?)?).map_err(|e|e.to_string()),
            "cite"=>{self.core.lock().map_err(|_|"core_lock_failed")?.link_citation(string(&args,"highlight")?,string(&args,"note")?,number(&args,"highlightRevision")?,number(&args,"noteRevision")?)?;Ok(Value::Null)},
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
        let mut jobs = self.jobs.lock().map_err(|_| "jobs_lock_failed")?;
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
        self.core
            .lock()
            .map_err(|_| "core_lock_failed")?
            .set_local_value(
                &format!("job:{id}"),
                0,
                &json!({"owner":self.instance,"state":initial}),
            )?;
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
        let mut book = crate::books::parse(&destination)?;
        job.check()?;
        if ["txt", "pdf"].contains(&extension.as_str()) {
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
        book["contentHash"] = hash.clone().into();
        if extension == "pdf" {
            book["readerMode"] = mode.into();
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
