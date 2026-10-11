//! macOS host Keychain adapter. Only trusted in-process code installs callbacks.
use std::{path::Path, sync::OnceLock};
pub type Store = unsafe extern "C" fn(*const u8, usize, *const u8, usize, *const u8, usize) -> i32;
pub type Load = unsafe extern "C" fn(*const u8, usize, *const u8, usize, *mut u8, usize) -> isize;
static HOST: OnceLock<(Store, Load)> = OnceLock::new();
pub fn installed() -> bool {
    HOST.get().is_some()
}
pub fn install(store: Store, load: Load) -> bool {
    let installed = HOST.get_or_init(|| (store, load));
    installed.0 as usize == store as usize && installed.1 as usize == load as usize
}
pub fn store(root: &Path, provider: &str, secret: &str) -> Option<Result<(), String>> {
    let host = HOST.get()?;
    let root = root.to_string_lossy();
    let result = unsafe {
        (host.0)(
            root.as_ptr(),
            root.len(),
            provider.as_ptr(),
            provider.len(),
            secret.as_ptr(),
            secret.len(),
        )
    };
    Some(if result == 0 {
        Ok(())
    } else {
        Err("keychain_store_failed".into())
    })
}
pub fn load(root: &Path, provider: &str) -> Option<Result<String, String>> {
    let host = HOST.get()?;
    let root = root.to_string_lossy();
    let mut bytes = vec![0u8; 4096];
    let result = unsafe {
        (host.1)(
            root.as_ptr(),
            root.len(),
            provider.as_ptr(),
            provider.len(),
            bytes.as_mut_ptr(),
            bytes.len(),
        )
    };
    Some(if result == -2 {
        Err("api_key_not_configured".into())
    } else if result < 0 || result as usize > bytes.len() {
        Err("keychain_load_failed".into())
    } else {
        bytes.truncate(result as usize);
        String::from_utf8(bytes).map_err(|_| "invalid_stored_secret".into())
    })
}
