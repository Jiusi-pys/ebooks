//! Node v2 cookie compatibility. A signature is not authorization: callers must
//! also validate the persisted account and credential version before granting access.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use hmac::{Hmac, Mac};
use serde::Deserialize;
use sha2::Sha256;

#[derive(Debug, PartialEq, Eq)]
pub struct Session {
    pub user_id: String,
    pub issued_at: i64,
    pub expires_at: i64,
    pub setup_required: bool,
    pub credential_version: u64,
}
#[derive(Deserialize)]
struct Payload {
    v: u8,
    sub: String,
    iat: i64,
    exp: i64,
    nonce: String,
    setup: bool,
    cv: u64,
}

/// `now` is Unix seconds, as in the Node verifier. Does not touch cookies or DB.
pub fn verify(token: &str, secret: &str, now: i64) -> Option<Session> {
    if secret.len() < 32 || token.len() > 4096 {
        return None;
    }
    let (encoded, signature) = token.split_once('.')?;
    let alphabet = |s: &str| {
        s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    };
    if encoded.is_empty() || !alphabet(encoded) || signature.len() != 43 || !alphabet(signature) {
        return None;
    }
    let signature = URL_SAFE_NO_PAD.decode(signature).ok()?;
    let key = format!("{secret}\0shufang-session-v2");
    let mut mac = Hmac::<Sha256>::new_from_slice(key.as_bytes()).ok()?;
    mac.update(encoded.as_bytes());
    mac.verify_slice(&signature).ok()?;
    let payload: Payload = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(encoded).ok()?).ok()?;
    if payload.v != 2
        || payload.sub.is_empty()
        || payload.sub.encode_utf16().count() > 256
        || payload.nonce.encode_utf16().count() < 16
        || payload.iat > now.checked_add(60)?
        || payload.exp <= now
        || payload.exp.checked_sub(payload.iat)? > 7 * 24 * 60 * 60
    {
        return None;
    }
    Some(Session {
        user_id: payload.sub,
        issued_at: payload.iat.checked_mul(1000)?,
        expires_at: payload.exp.checked_mul(1000)?,
        setup_required: payload.setup,
        credential_version: payload.cv,
    })
}
