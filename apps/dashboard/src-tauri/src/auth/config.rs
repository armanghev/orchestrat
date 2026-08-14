use url::Url;

use super::AuthError;

pub const REDIRECT_URI: &str = "dev.orchestrat.app://auth/callback";

#[derive(Clone, Debug)]
pub struct OAuthConfig {
    pub client_id: String,
    pub authorization_url: Url,
    pub token_url: Url,
    pub revocation_url: Url,
    pub redirect_uri: String,
}

impl OAuthConfig {
    pub fn from_build() -> Result<Self, AuthError> {
        let client_id = required(option_env!("ORCHESTRAT_CLERK_OAUTH_CLIENT_ID"))?;
        let authorization_url = https_url(option_env!("ORCHESTRAT_CLERK_OAUTH_AUTHORIZATION_URL"))?;
        let token_url = https_url(option_env!("ORCHESTRAT_CLERK_OAUTH_TOKEN_URL"))?;
        let revocation_url = https_url(option_env!("ORCHESTRAT_CLERK_OAUTH_REVOCATION_URL"))?;
        let redirect_uri = required(option_env!("ORCHESTRAT_CLERK_OAUTH_REDIRECT_URI"))?;
        if redirect_uri != REDIRECT_URI {
            return Err(AuthError::Configuration);
        }
        Ok(Self {
            client_id,
            authorization_url,
            token_url,
            revocation_url,
            redirect_uri,
        })
    }
}

fn required(value: Option<&str>) -> Result<String, AuthError> {
    value
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or(AuthError::Configuration)
}

fn https_url(value: Option<&str>) -> Result<Url, AuthError> {
    let value = required(value)?;
    let parsed = Url::parse(&value).map_err(|_| AuthError::Configuration)?;
    if parsed.scheme() != "https"
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.fragment().is_some()
    {
        return Err(AuthError::Configuration);
    }
    Ok(parsed)
}
