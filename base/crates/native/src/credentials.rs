use std::path::Path;
pub fn store(root: &Path, provider: &str, secret: &str) -> Result<(), String> {
    valid(provider)?;
    if secret.len() > 4096 {
        return Err("invalid_secret".into());
    }
    let bytes = protect(secret.as_bytes(), false, provider)?;
    let directory = root.join("credentials");
    std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700))
            .map_err(|_| "credential_permissions_failed")?;
    }
    use std::io::Write;
    let mut file = tempfile::NamedTempFile::new_in(&directory).map_err(|e| e.to_string())?;
    file.write_all(&bytes).map_err(|e| e.to_string())?;
    file.as_file().sync_all().map_err(|e| e.to_string())?;
    file.persist(directory.join(provider))
        .map_err(|e| e.to_string())?;
    Ok(())
}
pub fn load(root: &Path, provider: &str) -> Result<String, String> {
    if let Some(name) = provider.strip_prefix("sync-peer-env-") {
        environment_reference(name)?;
        let secret = std::env::var(name).map_err(|_| "sync_peer_token_not_configured")?;
        if secret.is_empty() || secret.len() > 4096 {
            return Err("invalid_peer_token".into());
        }
        return Ok(secret);
    }
    valid(provider)?;
    let path = root.join("credentials").join(provider);
    if std::fs::metadata(&path)
        .map_err(|_| "api_key_not_configured")?
        .len()
        > 8192
    {
        return Err("invalid_stored_secret".into());
    }
    let bytes = std::fs::read(path).map_err(|_| "api_key_not_configured")?;
    String::from_utf8(protect(&bytes, true, provider)?).map_err(|_| "invalid_stored_secret".into())
}
fn valid(provider: &str) -> Result<(), String> {
    if ["openai", "deepseek", "kimi", "minimax", "service"].contains(&provider)
        || provider
            .strip_prefix("webhook-")
            .is_some_and(|id| uuid::Uuid::parse_str(id).is_ok())
        || provider
            .strip_prefix("sync-peer-")
            .is_some_and(|id| uuid::Uuid::parse_str(id).is_ok())
    {
        Ok(())
    } else {
        Err("invalid_provider".into())
    }
}
#[cfg(windows)]
fn protect(bytes: &[u8], decrypt: bool, _provider: &str) -> Result<Vec<u8>, String> {
    #[repr(C)]
    struct Blob {
        length: u32,
        data: *mut u8,
    }
    #[link(name = "crypt32")]
    extern "system" {
        fn CryptProtectData(
            input: *const Blob,
            description: *const u16,
            entropy: *const Blob,
            reserved: *mut std::ffi::c_void,
            prompt: *mut std::ffi::c_void,
            flags: u32,
            output: *mut Blob,
        ) -> i32;
        fn CryptUnprotectData(
            input: *const Blob,
            description: *mut *mut u16,
            entropy: *const Blob,
            reserved: *mut std::ffi::c_void,
            prompt: *mut std::ffi::c_void,
            flags: u32,
            output: *mut Blob,
        ) -> i32;
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn LocalFree(memory: *mut std::ffi::c_void) -> *mut std::ffi::c_void;
    }
    let input = Blob {
        length: u32::try_from(bytes.len()).map_err(|_| "secret_too_large")?,
        data: bytes.as_ptr() as *mut u8,
    };
    let mut output = Blob {
        length: 0,
        data: std::ptr::null_mut(),
    };
    unsafe {
        let ok = if decrypt {
            CryptUnprotectData(
                &input,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                1,
                &mut output,
            )
        } else {
            CryptProtectData(
                &input,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                1,
                &mut output,
            )
        };
        if ok == 0 {
            return Err("credential_protection_failed".into());
        }
        let result = std::slice::from_raw_parts(output.data, output.length as usize).to_vec();
        LocalFree(output.data.cast());
        Ok(result)
    }
}
#[cfg(not(windows))]
fn protect(bytes: &[u8], decrypt: bool, provider: &str) -> Result<Vec<u8>, String> {
    portable::protect(bytes, decrypt, provider)
}

pub fn environment_reference(name: &str) -> Result<String, String> {
    if name.is_empty()
        || name.len() > 128
        || !name
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
    {
        return Err("invalid_credential_environment".into());
    }
    Ok(format!("sync-peer-env-{name}"))
}

#[cfg(not(windows))]
mod portable;
