use serde::{Deserialize, Serialize};
use url::Url;

use super::AuthError;

pub const PENDING_TTL_MS: u64 = 10 * 60 * 1_000;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct PendingAuthorization {
    pub state: String,
    pub verifier: String,
    pub created_at_ms: u64,
}

#[derive(Clone, Debug)]
pub struct ValidatedCallback {
    pub code: String,
    pub verifier: String,
}

pub fn parse_callback(
    callback_url: &str,
    pending: &PendingAuthorization,
    now_ms: u64,
) -> Result<ValidatedCallback, AuthError> {
    let url = Url::parse(callback_url).map_err(|_| AuthError::InvalidCallback)?;
    if url.scheme() != "dev.orchestrat.app"
        || url.host_str() != Some("auth")
        || url.path() != "/callback"
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(AuthError::InvalidCallback);
    }

    let mut states = Vec::new();
    let mut codes = Vec::new();
    let mut has_error = false;
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "state" => states.push(value.into_owned()),
            "code" => codes.push(value.into_owned()),
            "error" => has_error = true,
            _ => {}
        }
    }
    if states.len() != 1 || states[0].is_empty() {
        return Err(AuthError::InvalidCallback);
    }
    if states[0] != pending.state {
        return Err(AuthError::StateMismatch);
    }
    if now_ms < pending.created_at_ms || now_ms - pending.created_at_ms > PENDING_TTL_MS {
        return Err(AuthError::CallbackExpired);
    }
    if has_error {
        return Err(AuthError::AccessDenied);
    }
    if codes.len() != 1 || codes[0].is_empty() {
        return Err(AuthError::InvalidCallback);
    }

    Ok(ValidatedCallback {
        code: codes.remove(0),
        verifier: pending.verifier.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pending() -> PendingAuthorization {
        PendingAuthorization {
            state: "expected-state".into(),
            verifier: "verifier".into(),
            created_at_ms: 1_000,
        }
    }

    #[test]
    fn accepts_only_the_registered_fresh_single_use_callback() {
        let parsed = parse_callback(
            "dev.orchestrat.app://auth/callback?code=code-123&state=expected-state",
            &pending(),
            1_100,
        )
        .expect("valid callback");
        assert_eq!(parsed.code, "code-123");
        assert_eq!(parsed.verifier, "verifier");

        assert_eq!(
            parse_callback(
                "evil.app://auth/callback?code=x&state=expected-state",
                &pending(),
                1_100
            )
            .unwrap_err()
            .code(),
            "invalid_callback"
        );
        assert_eq!(
            parse_callback(
                "dev.orchestrat.app://auth/callback?code=x&state=wrong",
                &pending(),
                1_100
            )
            .unwrap_err()
            .code(),
            "state_mismatch"
        );
        assert_eq!(
            parse_callback(
                "dev.orchestrat.app://auth/callback?error=access_denied&state=expected-state",
                &pending(),
                1_100
            )
            .unwrap_err()
            .code(),
            "access_denied"
        );
        assert_eq!(
            parse_callback(
                "dev.orchestrat.app://auth/callback?code=x&state=expected-state",
                &pending(),
                1_000 + PENDING_TTL_MS + 1
            )
            .unwrap_err()
            .code(),
            "callback_expired"
        );
        assert_eq!(
            parse_callback(
                "dev.orchestrat.app://auth/callback?code=x&state=expected-state",
                &pending(),
                999
            )
            .unwrap_err()
            .code(),
            "callback_expired"
        );
    }
}
