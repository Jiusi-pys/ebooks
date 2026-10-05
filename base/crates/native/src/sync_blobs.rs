//! Filesystem adapter for content-addressed blobs. Only verified objects publish.
use crate::workspace::Result;
use serde::Serialize;
use sha2::{Digest, Sha256};
use shufang_application::{BlobManifest, CHUNK_SIZE};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};
pub struct BlobStore {
    root: PathBuf,
}
impl shufang_application::externalize::FieldObjects for BlobStore {
    fn put_field(&mut self, manifest: &BlobManifest, json: &str) -> Result<()> {
        manifest.validate()?;
        if json.len() as u64 != manifest.size
            || format!("{:x}", Sha256::digest(json.as_bytes())) != manifest.sha256
        {
            return Err("blob_hash_mismatch".into());
        }
        let upload = self.create(manifest)?;
        if !upload.present {
            for (index, bytes) in json.as_bytes().chunks(CHUNK_SIZE as usize).enumerate() {
                self.put(
                    &upload.id,
                    index as u64,
                    bytes,
                    &format!("{:x}", Sha256::digest(bytes)),
                )?;
            }
            if self.commit(&upload.id)? != *manifest {
                return Err("blob_manifest_mismatch".into());
            }
        }
        Ok(())
    }
}
impl shufang_application::externalize::FieldReader for BlobStore {
    fn read_field(&self, hash: &str, size: u64) -> Result<Vec<u8>> {
        if size > shufang_application::MAX_BLOB_SIZE {
            return Err("invalid_blob_manifest".into());
        }
        let path = self.path(hash)?;
        let file = File::open(path).map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                "sync_field_pending".into()
            } else {
                io(e)
            }
        })?;
        if file.metadata().map_err(io)?.len() != size {
            return Err("blob_size_mismatch".into());
        }
        let mut bytes = Vec::new();
        file.take(size + 1).read_to_end(&mut bytes).map_err(io)?;
        if bytes.len() as u64 != size || format!("{:x}", Sha256::digest(&bytes)) != hash {
            return Err("blob_hash_mismatch".into());
        }
        Ok(bytes)
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Upload {
    pub id: String,
    pub chunk_size: u64,
    pub chunks: u64,
    pub present: bool,
}
#[derive(Serialize)]
pub struct UploadStatus {
    pub manifest: BlobManifest,
    pub missing: Vec<u64>,
}
fn io(error: impl std::fmt::Display) -> String {
    format!("blob_io: {error}")
}
impl BlobStore {
    pub fn new(root: &Path) -> Self {
        Self { root: root.into() }
    }
    pub(crate) fn lock(&self) -> Result<File> {
        fs::create_dir_all(&self.root).map_err(io)?;
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(self.root.join("store.lock"))
            .map_err(io)?;
        fs2::FileExt::lock_exclusive(&lock).map_err(io)?;
        Ok(lock)
    }
    pub fn path(&self, hash: &str) -> Result<PathBuf> {
        if !BlobManifest::valid_hash(hash) {
            return Err("invalid_hash".into());
        }
        Ok(self.root.join("objects").join(hash))
    }
    fn session(&self, id: &str) -> Result<PathBuf> {
        let parsed = uuid::Uuid::parse_str(id).map_err(|_| "invalid_upload_id")?;
        if parsed.to_string() != id {
            return Err("invalid_upload_id".into());
        }
        Ok(self.root.join("uploads").join(id))
    }
    fn legacy_directory(&self, book: &str, hash: &str) -> Result<PathBuf> {
        if !shufang_domain::sync::valid_identifier(book) || !BlobManifest::valid_hash(hash) {
            return Err("invalid_source_upload".into());
        }
        Ok(self
            .root
            .join("legacy")
            .join(format!("{:x}", Sha256::digest(book.as_bytes())))
            .join(hash))
    }
    pub fn stage_legacy(&self, book: &str, hash: &str, index: u64, bytes: &[u8]) -> Result<()> {
        if index >= 1024 || bytes.len() > CHUNK_SIZE as usize {
            return Err("invalid_chunk".into());
        }
        let directory = self.legacy_directory(book, hash)?;
        let _lock = self.lock()?;
        fs::create_dir_all(&directory).map_err(io)?;
        let path = directory.join(index.to_string());
        match fs::read(&path) {
            Ok(prior) => {
                return if prior == bytes {
                    Ok(())
                } else {
                    Err("chunk_id_reused".into())
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(io(e)),
        }
        let mut temporary = tempfile::NamedTempFile::new_in(&directory).map_err(io)?;
        temporary.write_all(bytes).map_err(io)?;
        temporary.as_file().sync_all().map_err(io)?;
        temporary.persist_noclobber(path).map_err(io)?;
        Ok(())
    }
    pub fn complete_legacy(&self, book: &str, manifest: &BlobManifest) -> Result<BlobManifest> {
        let directory = self.legacy_directory(book, &manifest.sha256)?;
        let upload = self.create(manifest)?;
        if !upload.present {
            for index in 0..upload.chunks {
                let path = directory.join(index.to_string());
                let file = File::open(path).map_err(|e| {
                    if e.kind() == std::io::ErrorKind::NotFound {
                        "missing_chunks".to_owned()
                    } else {
                        io(e)
                    }
                })?;
                if file.metadata().map_err(io)?.len() > CHUNK_SIZE {
                    return Err("invalid_chunk".into());
                }
                let mut bytes = Vec::new();
                file.take(CHUNK_SIZE + 1)
                    .read_to_end(&mut bytes)
                    .map_err(io)?;
                self.put(
                    &upload.id,
                    index,
                    &bytes,
                    &format!("{:x}", Sha256::digest(&bytes)),
                )?;
            }
        }
        self.commit(&upload.id)
    }
    pub fn has(&self, hash: &str) -> Result<bool> {
        let path = self.path(hash)?;
        let mut file = match File::open(path) {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(e) => return Err(io(e)),
        };
        if file.metadata().map_err(io)?.len() > shufang_application::MAX_BLOB_SIZE {
            return Ok(false);
        }
        let mut digest = Sha256::new();
        let mut buffer = vec![0u8; CHUNK_SIZE as usize];
        loop {
            let n = file.read(&mut buffer).map_err(io)?;
            if n == 0 {
                break;
            }
            digest.update(&buffer[..n]);
        }
        Ok(format!("{:x}", digest.finalize()) == hash)
    }
    pub fn create(&self, manifest: &BlobManifest) -> Result<Upload> {
        manifest.validate()?;
        let _lock = self.lock()?;
        let id = uuid::Uuid::new_v4().to_string();
        let path = self.session(&id)?;
        fs::create_dir_all(&path).map_err(io)?;
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(path.join("manifest.json"))
            .map_err(io)?;
        file.write_all(&serde_json::to_vec(manifest).map_err(io)?)
            .map_err(io)?;
        file.sync_all().map_err(io)?;
        Ok(Upload {
            id,
            chunk_size: CHUNK_SIZE,
            chunks: manifest.chunks(),
            present: self.has(&manifest.sha256)?,
        })
    }
    fn manifest(&self, id: &str) -> Result<BlobManifest> {
        let bytes =
            fs::read(self.session(id)?.join("manifest.json")).map_err(|_| "upload_not_found")?;
        if bytes.len() > 4096 {
            return Err("invalid_blob_manifest".into());
        }
        let value: BlobManifest =
            serde_json::from_slice(&bytes).map_err(|_| "invalid_blob_manifest")?;
        value.validate()?;
        Ok(value)
    }
    pub fn status(&self, id: &str) -> Result<UploadStatus> {
        let manifest = self.manifest(id)?;
        let path = self.session(id)?;
        let missing = if self.has(&manifest.sha256)? {
            vec![]
        } else {
            (0..manifest.chunks())
                .filter(|i| !path.join(i.to_string()).is_file())
                .collect()
        };
        Ok(UploadStatus { manifest, missing })
    }
    pub fn put(&self, id: &str, index: u64, bytes: &[u8], hash: &str) -> Result<()> {
        let _lock = self.lock()?;
        let manifest = self.manifest(id)?;
        if bytes.len() as u64 != manifest.chunk_length(index)?
            || format!("{:x}", Sha256::digest(bytes)) != hash
        {
            return Err("chunk_checksum_mismatch".into());
        }
        let directory = self.session(id)?;
        let mut tmp = tempfile::NamedTempFile::new_in(&directory).map_err(io)?;
        tmp.write_all(bytes).map_err(io)?;
        tmp.as_file().sync_all().map_err(io)?;
        tmp.persist(directory.join(index.to_string())).map_err(io)?;
        Ok(())
    }
    pub fn commit(&self, id: &str) -> Result<BlobManifest> {
        let _lock = self.lock()?;
        let status = self.status(id)?;
        let manifest = status.manifest;
        if self.has(&manifest.sha256)? {
            return Ok(manifest);
        }
        if !status.missing.is_empty() {
            return Err("missing_chunks".into());
        }
        let path = self.path(&manifest.sha256)?;
        let directory = path.parent().ok_or("invalid_blob_path")?;
        fs::create_dir_all(directory).map_err(io)?;
        let mut tmp = tempfile::NamedTempFile::new_in(directory).map_err(io)?;
        let mut hash = Sha256::new();
        let mut size = 0u64;
        let mut buffer = vec![0u8; CHUNK_SIZE as usize];
        for index in 0..manifest.chunks() {
            let mut file = File::open(self.session(id)?.join(index.to_string())).map_err(io)?;
            loop {
                let n = file.read(&mut buffer).map_err(io)?;
                if n == 0 {
                    break;
                }
                size = size.checked_add(n as u64).ok_or("blob_size_overflow")?;
                if size > manifest.size {
                    return Err("file_checksum_mismatch".into());
                }
                hash.update(&buffer[..n]);
                tmp.write_all(&buffer[..n]).map_err(io)?;
            }
        }
        if size != manifest.size || format!("{hash:x}", hash = hash.finalize()) != manifest.sha256 {
            return Err("file_checksum_mismatch".into());
        }
        tmp.as_file().sync_all().map_err(io)?;
        tmp.persist(&path).map_err(io)?;
        Ok(manifest)
    }
}
