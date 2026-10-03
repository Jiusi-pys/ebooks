//! Headless Linux vault. Deployment key is never saved alongside ciphertext.
use ring::{
    aead,
    rand::{SecureRandom, SystemRandom},
};
const MAGIC: &[u8; 4] = b"SFC1";
pub(super) fn protect(bytes: &[u8], decrypt: bool, provider: &str) -> Result<Vec<u8>, String> {
    let configured = std::env::var("SHUFANG_CREDENTIAL_KEY")
        .map_err(|_| "credential_key_environment_required")?;
    if configured.len() != 64 || !configured.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("invalid_credential_key".into());
    }
    let mut key = [0u8; 32];
    for (i, value) in key.iter_mut().enumerate() {
        *value = u8::from_str_radix(&configured[i * 2..i * 2 + 2], 16)
            .map_err(|_| "invalid_credential_key")?;
    }
    crypt(bytes, decrypt, provider, &key)
}
fn crypt(bytes: &[u8], decrypt: bool, provider: &str, key: &[u8; 32]) -> Result<Vec<u8>, String> {
    let key = aead::LessSafeKey::new(
        aead::UnboundKey::new(&aead::AES_256_GCM, key)
            .map_err(|_| "credential_protection_failed")?,
    );
    let aad = aead::Aad::from(provider.as_bytes());
    if decrypt {
        if bytes.len() < 32 || bytes.len() > 8192 || &bytes[..4] != MAGIC {
            return Err("invalid_stored_secret".into());
        }
        let nonce = aead::Nonce::try_assume_unique_for_key(&bytes[4..16])
            .map_err(|_| "invalid_stored_secret")?;
        let mut content = bytes[16..].to_vec();
        Ok(key
            .open_in_place(nonce, aad, &mut content)
            .map_err(|_| "credential_protection_failed")?
            .to_vec())
    } else {
        let mut nonce = [0u8; 12];
        SystemRandom::new()
            .fill(&mut nonce)
            .map_err(|_| "credential_protection_failed")?;
        let mut content = bytes.to_vec();
        key.seal_in_place_append_tag(aead::Nonce::assume_unique_for_key(nonce), aad, &mut content)
            .map_err(|_| "credential_protection_failed")?;
        let mut envelope = MAGIC.to_vec();
        envelope.extend_from_slice(&nonce);
        envelope.extend_from_slice(&content);
        Ok(envelope)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unique_nonce_wrong_key_provider_and_tamper_are_checked() {
        let key = [17u8; 32];
        let first = crypt(b"secret", false, "service", &key).unwrap();
        let second = crypt(b"secret", false, "service", &key).unwrap();
        assert_ne!(first, second);
        assert_eq!(crypt(&first, true, "service", &key).unwrap(), b"secret");
        assert!(crypt(&first, true, "service", &[18u8; 32]).is_err());
        assert!(crypt(&first, true, "openai", &key).is_err());
        let mut tampered = first;
        tampered[20] ^= 1;
        assert!(crypt(&tampered, true, "service", &key).is_err());
        assert!(crypt(b"unknown plaintext", true, "service", &key).is_err());
    }
}
