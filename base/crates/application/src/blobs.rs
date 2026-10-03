use crate::Result;
use serde::{Deserialize, Serialize};
pub const CHUNK_SIZE: u64 = 256 * 1024;
pub const MAX_BLOB_SIZE: u64 = 256 * 1024 * 1024;
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct BlobManifest {
    pub sha256: String,
    pub size: u64,
    pub name: String,
    #[serde(rename = "type")]
    pub content_type: String,
}
impl BlobManifest {
    pub fn valid_hash(hash: &str) -> bool {
        hash.len() == 64
            && hash
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    }
    pub fn validate(&self) -> Result<()> {
        if !Self::valid_hash(&self.sha256)
            || self.size > MAX_BLOB_SIZE
            || self.name.encode_utf16().count() > 255
            || self.content_type.encode_utf16().count() > 128
        {
            return Err("invalid_blob_manifest".into());
        }
        Ok(())
    }
    pub fn chunks(&self) -> u64 {
        self.size.div_ceil(CHUNK_SIZE)
    }
    pub fn chunk_length(&self, index: u64) -> Result<u64> {
        if index >= self.chunks() {
            return Err("invalid_chunk".into());
        }
        Ok(CHUNK_SIZE.min(self.size - index * CHUNK_SIZE))
    }
}
