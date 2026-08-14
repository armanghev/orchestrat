use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use sha2::{Digest, Sha256};

pub struct Pkce {
    pub state: String,
    pub verifier: String,
    pub challenge: String,
    pub challenge_method: &'static str,
}

impl Pkce {
    pub fn is_valid_verifier(verifier: &str) -> bool {
        (43..=128).contains(&verifier.len())
            && verifier.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~')
            })
    }

    pub fn generate() -> Self {
        let state_bytes: [u8; 32] = rand::random();
        let verifier_bytes: [u8; 32] = rand::random();
        let state = URL_SAFE_NO_PAD.encode(state_bytes);
        let verifier = URL_SAFE_NO_PAD.encode(verifier_bytes);
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        Self {
            state,
            verifier,
            challenge,
            challenge_method: "S256",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_invalid_verifier_formats() {
        assert!(Pkce::is_valid_verifier(&"a".repeat(43)));
        assert!(!Pkce::is_valid_verifier("short"));
        assert!(!Pkce::is_valid_verifier(&format!("{}=", "a".repeat(42))));
    }

    #[test]
    fn generates_unique_url_safe_pkce_material() {
        let first = Pkce::generate();
        let second = Pkce::generate();
        assert_ne!(first.state, second.state);
        assert_ne!(first.verifier, second.verifier);
        assert!(first.state.len() >= 43);
        assert!(first.verifier.len() >= 43);
        assert!(!first.state.contains('='));
        assert!(!first.challenge.contains('='));
        assert_eq!(first.challenge_method, "S256");
    }
}
