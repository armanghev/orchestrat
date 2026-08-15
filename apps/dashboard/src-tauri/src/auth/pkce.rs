use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use sha2::{Digest, Sha256};

pub struct Pkce {
    pub flow_id: String,
    pub verifier: String,
    pub challenge: String,
    pub challenge_method: &'static str,
}
impl Pkce {
    pub fn is_valid_verifier(value: &str) -> bool {
        (43..=128).contains(&value.len())
            && value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~'))
    }
    pub fn is_valid_flow_id(value: &str) -> bool {
        (16..=128).contains(&value.len())
            && value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
    }
    pub fn generate() -> Self {
        let flow_bytes: [u8; 24] = rand::random();
        let verifier_bytes: [u8; 32] = rand::random();
        let flow_id = URL_SAFE_NO_PAD.encode(flow_bytes);
        let verifier = URL_SAFE_NO_PAD.encode(verifier_bytes);
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        Self {
            flow_id,
            verifier,
            challenge,
            challenge_method: "s256",
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn generates_unique_separate_url_safe_material() {
        let a = Pkce::generate();
        let b = Pkce::generate();
        assert_ne!(a.flow_id, b.flow_id);
        assert_ne!(a.verifier, b.verifier);
        assert!(Pkce::is_valid_flow_id(&a.flow_id));
        assert!(Pkce::is_valid_verifier(&a.verifier));
        assert_eq!(a.challenge_method, "s256");
        assert!(!a.challenge.contains('='));
    }
    #[test]
    fn validates_bounds() {
        assert!(!Pkce::is_valid_verifier("short"));
        assert!(!Pkce::is_valid_flow_id("bad+flow+identifier"));
    }
}
