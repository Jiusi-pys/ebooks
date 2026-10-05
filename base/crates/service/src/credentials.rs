//! Compatible with persisted Node credentials; never accept attacker-selected KDF costs.
use aes_gcm::{
    aead::{Aead, Generate, KeyInit},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use sha2::{Digest, Sha256};
use unicode_normalization::UnicodeNormalization;

pub fn normalize_username(value: &str) -> String {
    value.trim_matches(|c| matches!(c, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')).nfkc().collect()
}
pub fn validate_username(value: &str) -> bool {
    let username = normalize_username(value);
    (2..=64).contains(&username.encode_utf16().count()) && !username.chars().any(char::is_control)
}
pub fn validate_password(value: &str) -> bool {
    (12..=1024).contains(&value.encode_utf16().count())
}
fn key(secret: &str) -> [u8; 32] {
    Sha256::digest(format!("{secret}\0shufang-username-encryption-v1").as_bytes()).into()
}
pub fn encrypt_username(username: &str, secret: &str) -> Result<String, String> {
    let cipher = Aes256Gcm::new_from_slice(&key(secret)).map_err(|_| "credential_format")?;
    let nonce = Nonce::generate();
    let ciphertext = cipher
        .encrypt(&nonce, normalize_username(username).as_bytes())
        .map_err(|_| "credential_format")?;
    let (encrypted, tag) = ciphertext.split_at(ciphertext.len() - 16);
    Ok(format!(
        "aes-256-gcm$v1${}${}${}",
        URL_SAFE_NO_PAD.encode(nonce),
        URL_SAFE_NO_PAD.encode(tag),
        URL_SAFE_NO_PAD.encode(encrypted)
    ))
}
pub fn decrypt_username(value: &str, secret: &str) -> Result<String, String> {
    let parts: Vec<_> = value.split('$').collect();
    if parts.len() != 5 || parts[0] != "aes-256-gcm" || parts[1] != "v1" || value.len() > 512 {
        return Err("credential_format".into());
    }
    let iv = URL_SAFE_NO_PAD
        .decode(parts[2])
        .map_err(|_| "credential_format")?;
    let tag = URL_SAFE_NO_PAD
        .decode(parts[3])
        .map_err(|_| "credential_format")?;
    let mut ciphertext = URL_SAFE_NO_PAD
        .decode(parts[4])
        .map_err(|_| "credential_format")?;
    if iv.len() != 12 || tag.len() != 16 || ciphertext.is_empty() {
        return Err("credential_format".into());
    }
    ciphertext.extend(tag);
    let cipher = Aes256Gcm::new_from_slice(&key(secret)).map_err(|_| "credential_format")?;
    let nonce: [u8; 12] = iv.try_into().map_err(|_| "credential_format")?;
    let decrypted = cipher
        .decrypt(&nonce.into(), ciphertext.as_ref())
        .map_err(|_| "credential_format")?;
    String::from_utf8(decrypted).map_err(|_| "credential_format".into())
}
fn derive(password: &str, salt: &[u8]) -> Result<[u8; 64], String> {
    let mut output = [0u8; 64];
    let params = scrypt::Params::new(15, 8, 3).map_err(|_| "credential_format")?;
    scrypt::scrypt(password.as_bytes(), salt, &params, &mut output)
        .map_err(|_| "credential_format")?;
    Ok(output)
}
pub fn hash_password(password: &str) -> Result<String, String> {
    if !validate_password(password) {
        return Err("invalid_password".into());
    }
    // Generate via the audited AEAD crate's OS randomness interface.
    let salt = aes_gcm::aead::Key::<Aes256Gcm>::generate();
    let salt = &salt[..16];
    Ok(format!(
        "scrypt$32768$8$3${}${}",
        URL_SAFE_NO_PAD.encode(salt),
        URL_SAFE_NO_PAD.encode(derive(password, salt)?)
    ))
}
pub fn verify_password(password: &str, value: &str) -> bool {
    if password.encode_utf16().count() > 1024 || value.len() > 255 {
        return false;
    }
    let parts: Vec<_> = value.split('$').collect();
    if parts.len() != 6 || parts[..4] != ["scrypt", "32768", "8", "3"] {
        return false;
    }
    let (Ok(salt), Ok(expected)) = (
        URL_SAFE_NO_PAD.decode(parts[4]),
        URL_SAFE_NO_PAD.decode(parts[5]),
    ) else {
        return false;
    };
    if salt.len() != 16 || expected.len() != 64 {
        return false;
    }
    let Ok(actual) = derive(password, &salt) else {
        return false;
    };
    actual
        .iter()
        .zip(expected)
        .fold(0u8, |a, (b, c)| a | (b ^ c))
        == 0
}
