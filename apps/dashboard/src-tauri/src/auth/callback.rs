use super::{pkce::Pkce, AuthError};
use serde::{Deserialize, Serialize};
use url::Url;

const GITHUB_TTL_MS: u64 = 10 * 60 * 1_000;
const MAGIC_LINK_TTL_MS: u64 = 60 * 60 * 1_000;
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PendingKind {
    Github,
    MagicLink,
}
impl PendingKind {
    fn ttl_ms(self) -> u64 {
        match self {
            Self::Github => GITHUB_TTL_MS,
            Self::MagicLink => MAGIC_LINK_TTL_MS,
        }
    }
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingAuthorization {
    pub version: u8,
    pub kind: PendingKind,
    pub flow_id: String,
    pub verifier: String,
    pub created_at_ms: u64,
}
#[derive(Clone, Debug)]
pub struct ValidatedCallback {
    pub code: Option<String>,
    pub verifier: String,
}

fn bounded(value: &str, max: usize) -> bool {
    !value.is_empty() && value.len() <= max && !value.chars().any(char::is_control)
}
fn safe_identifier(value: &str, max: usize) -> bool {
    bounded(value, max)
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'))
}

fn valid_raw_percent_encoding(input: &str) -> bool {
    fn hex(byte: u8) -> Option<u8> {
        match byte {
            b'0'..=b'9' => Some(byte - b'0'),
            b'a'..=b'f' => Some(byte - b'a' + 10),
            b'A'..=b'F' => Some(byte - b'A' + 10),
            _ => None,
        }
    }
    let bytes = input.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                return false;
            }
            let (Some(high), Some(low)) = (hex(bytes[index + 1]), hex(bytes[index + 2])) else {
                return false;
            };
            decoded.push((high << 4) | low);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    std::str::from_utf8(&decoded).is_ok()
}

pub fn parse_callback(
    input: &str,
    pending: &PendingAuthorization,
    now_ms: u64,
) -> Result<ValidatedCallback, AuthError> {
    if !valid_raw_percent_encoding(input) {
        return Err(AuthError::InvalidCallback);
    }
    if pending.version != 1
        || !Pkce::is_valid_flow_id(&pending.flow_id)
        || !Pkce::is_valid_verifier(&pending.verifier)
    {
        return Err(AuthError::InvalidCallback);
    }
    let url = Url::parse(input).map_err(|_| AuthError::InvalidCallback)?;
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
    let mut flow = Vec::new();
    let mut code = Vec::new();
    let mut error = Vec::new();
    let mut error_code = Vec::new();
    let mut description = Vec::new();
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "sb_flow_id" => flow.push(value.into_owned()),
            "code" => code.push(value.into_owned()),
            "error" => error.push(value.into_owned()),
            "error_code" => error_code.push(value.into_owned()),
            "error_description" => description.push(value.into_owned()),
            _ => return Err(AuthError::InvalidCallback),
        }
    }
    if flow.len() > 1
        || flow
            .first()
            .is_some_and(|value| !Pkce::is_valid_flow_id(value))
        || code.len() > 1
        || error.len() > 1
        || error_code.len() > 1
        || description.len() > 1
    {
        return Err(AuthError::InvalidCallback);
    }
    if flow
        .first()
        .is_some_and(|value| value != &pending.flow_id)
    {
        return Err(AuthError::FlowMismatch);
    }
    if now_ms < pending.created_at_ms || now_ms - pending.created_at_ms > pending.kind.ttl_ms() {
        return Err(AuthError::CallbackExpired);
    }
    if !error.is_empty() {
        if !code.is_empty()
            || !safe_identifier(&error[0], 128)
            || error_code.first().is_some_and(|v| !safe_identifier(v, 128))
            || description.first().is_some_and(|v| !bounded(v, 512))
        {
            return Err(AuthError::InvalidCallback);
        }
        return Err(AuthError::AccessDenied);
    }
    if !error_code.is_empty()
        || !description.is_empty()
        || code.len() != 1
        || !bounded(&code[0], 2048)
    {
        return Err(AuthError::InvalidCallback);
    }
    Ok(ValidatedCallback {
        code: Some(code.remove(0)),
        verifier: pending.verifier.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn p(kind: PendingKind) -> PendingAuthorization {
        PendingAuthorization {
            version: 1,
            kind,
            flow_id: "flow_identifier_123".into(),
            verifier: "a".repeat(43),
            created_at_ms: 1000,
        }
    }
    #[test]
    fn callback_contract_and_ttls() {
        assert!(parse_callback(
            "dev.orchestrat.app://auth/callback?code=x",
            &p(PendingKind::Github),
            1100
        )
        .is_ok());
        for bad in [
            "dev.orchestrat.app://auth/callback?code=x&sb_flow_id=flow_identifier_123&x=y",
            "dev.orchestrat.app://auth/callback?code=x&code=y&sb_flow_id=flow_identifier_123",
            "dev.orchestrat.app://auth/callback?code=x&sb_flow_id=wrong_identifier_123",
            "dev.orchestrat.app://user@auth/callback?code=x&sb_flow_id=flow_identifier_123",
        ] {
            assert!(parse_callback(bad, &p(PendingKind::Github), 1100).is_err());
        }
        assert!(matches!(parse_callback("dev.orchestrat.app://auth/callback?error=access_denied&sb_flow_id=flow_identifier_123",&p(PendingKind::Github),1100),Err(AuthError::AccessDenied)));
        assert!(matches!(
            parse_callback(
                "dev.orchestrat.app://auth/callback?code=x&sb_flow_id=flow_identifier_123",
                &p(PendingKind::Github),
                601001
            ),
            Err(AuthError::CallbackExpired)
        ));
        assert!(parse_callback(
            "dev.orchestrat.app://auth/callback?code=x&sb_flow_id=flow_identifier_123",
            &p(PendingKind::MagicLink),
            601001
        )
        .is_ok());
    }

    #[test]
    fn rejects_malformed_percent_escapes_and_invalid_decoded_utf8() {
        for input in [
            "dev.orchestrat.app://auth/callback?code=%ZZ&sb_flow_id=flow_identifier_123",
            "dev.orchestrat.app://auth/callback?code=%&sb_flow_id=flow_identifier_123",
            "dev.orchestrat.app://auth/callback?code=%FF&sb_flow_id=flow_identifier_123",
            "dev.orchestrat.app://auth/callback?code=%E2%82&sb_flow_id=flow_identifier_123",
            "dev.orchestrat.app://auth/callback?code=ok%FFmixed&sb_flow_id=flow_identifier_123",
        ] {
            assert!(matches!(
                parse_callback(input, &p(PendingKind::Github), 1_100),
                Err(AuthError::InvalidCallback)
            ));
        }
    }

    #[test]
    fn rejects_clock_rollback_and_expired_github_but_allows_email_delay() {
        assert!(matches!(
            parse_callback(
                "dev.orchestrat.app://auth/callback?code=x&sb_flow_id=flow_identifier_123",
                &p(PendingKind::Github),
                999
            ),
            Err(AuthError::CallbackExpired)
        ));
        assert!(matches!(
            parse_callback(
                "dev.orchestrat.app://auth/callback?code=x&sb_flow_id=flow_identifier_123",
                &p(PendingKind::Github),
                601_001
            ),
            Err(AuthError::CallbackExpired)
        ));
        assert!(parse_callback(
            "dev.orchestrat.app://auth/callback?code=x&sb_flow_id=flow_identifier_123",
            &p(PendingKind::MagicLink),
            601_001
        )
        .is_ok());
    }

    #[test]
    fn rejects_duplicate_unknown_control_and_oversized_provider_values() {
        let oversized_code = "a".repeat(2049);
        let oversized_description = "a".repeat(513);
        for callback in [
            "dev.orchestrat.app://auth/callback?code=x&code=y&sb_flow_id=flow_identifier_123".to_owned(),
            "dev.orchestrat.app://auth/callback?code=x&sb_flow_id=flow_identifier_123&sb_flow_id=flow_identifier_456".to_owned(),
            "dev.orchestrat.app://auth/callback?code=x&sb_flow_id=flow_identifier_123&unknown=x".to_owned(),
            "dev.orchestrat.app://auth/callback?code=x%00y&sb_flow_id=flow_identifier_123".to_owned(),
            format!("dev.orchestrat.app://auth/callback?code={oversized_code}&sb_flow_id=flow_identifier_123"),
            format!("dev.orchestrat.app://auth/callback?error=denied&error_description={oversized_description}&sb_flow_id=flow_identifier_123"),
        ] { assert!(matches!(parse_callback(&callback, &p(PendingKind::Github), 1_100), Err(AuthError::InvalidCallback))); }
    }
}
