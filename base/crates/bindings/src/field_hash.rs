//! Bounded synchronous hashing keeps IndexedDB transactions alive and avoids
//! copying a whole large field through the 16 MiB JSON command boundary.
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    sync::{Mutex, OnceLock},
};
#[derive(Default)]
struct Hashers {
    next: u32,
    values: BTreeMap<u32, (Sha256, u64)>,
}
fn registry() -> &'static Mutex<Hashers> {
    static HASHERS: OnceLock<Mutex<Hashers>> = OnceLock::new();
    HASHERS.get_or_init(|| Mutex::new(Hashers::default()))
}
pub fn begin() -> Result<u32, String> {
    let mut hashes = registry().lock().map_err(|_| "hash_lock_failed")?;
    if hashes.values.len() >= 64 {
        return Err("too_many_hashers".into());
    }
    hashes.next = hashes.next.checked_add(1).ok_or("hash_handle_exhausted")?;
    let handle = hashes.next;
    hashes.values.insert(handle, (Sha256::new(), 0));
    Ok(handle)
}
pub fn append(handle: u32, hex: &str) -> Result<(), String> {
    if hex.len() > 2 * 262144
        || !hex.as_bytes().chunks_exact(2).remainder().is_empty()
        || !hex.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err("invalid_hash_chunk".into());
    }
    let bytes = hex
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let digit = |b: u8| {
                if b <= b'9' {
                    b - b'0'
                } else {
                    b.to_ascii_lowercase() - b'a' + 10
                }
            };
            digit(pair[0]) * 16 + digit(pair[1])
        })
        .collect::<Vec<_>>();
    let mut hashes = registry().lock().map_err(|_| "hash_lock_failed")?;
    let (hash, size) = hashes
        .values
        .get_mut(&handle)
        .ok_or("invalid_hash_handle")?;
    let next = *size + bytes.len() as u64;
    if next > shufang_application::MAX_BLOB_SIZE {
        return Err("blob_too_large".into());
    }
    hash.update(bytes);
    *size = next;
    Ok(())
}
pub fn finish(handle: u32) -> Result<String, String> {
    let (hash, _) = registry()
        .lock()
        .map_err(|_| "hash_lock_failed")?
        .values
        .remove(&handle)
        .ok_or("invalid_hash_handle")?;
    Ok(format!("{:x}", hash.finalize()))
}
pub fn abort(handle: u32) {
    if let Ok(mut hashes) = registry().lock() {
        hashes.values.remove(&handle);
    }
}
