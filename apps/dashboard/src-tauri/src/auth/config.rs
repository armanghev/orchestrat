use url::Url;

use super::AuthError;

pub const REDIRECT_URI: &str = "dev.orchestrat.app://auth/callback";
const KEY_PREFIX: &str = "sb_publishable_";

#[derive(Clone, Debug)]
pub struct SupabaseConfig {
    pub(crate) base_url: Url,
    pub(crate) publishable_key: String,
    pub(crate) environment: String,
    pub(crate) redirect_uri: Url,
    pub(crate) portal_url: Url,
}

impl SupabaseConfig {
    pub fn from_build() -> Result<Self, AuthError> {
        Self::parse(
            required(option_env!("ORCHESTRAT_SUPABASE_URL"))?,
            required(option_env!("ORCHESTRAT_SUPABASE_PUBLISHABLE_KEY"))?,
            required(option_env!("ORCHESTRAT_AUTH_ENVIRONMENT"))?,
            required(option_env!("ORCHESTRAT_DESKTOP_AUTH_REDIRECT_URI"))?,
            required(option_env!("ORCHESTRAT_DESKTOP_AUTH_PORTAL_URL"))?,
        )
    }

    pub fn parse(
        base: &str,
        key: &str,
        environment: &str,
        redirect: &str,
        portal: &str,
    ) -> Result<Self, AuthError> {
        let base_url = Url::parse(base).map_err(|_| AuthError::Configuration)?;
        let expected_origin = base_url.origin().ascii_serialization();
        if base.trim_end_matches('/') != expected_origin
            || base_url.scheme() != "https"
            || base_url.host_str().is_none()
            || base_url.port().is_some()
            || !base_url.username().is_empty()
            || base_url.password().is_some()
            || base_url.path() != "/"
            || base_url.query().is_some()
            || base_url.fragment().is_some()
        {
            return Err(AuthError::Configuration);
        }
        if !is_publishable_key(key) || !is_environment(environment) || redirect != REDIRECT_URI {
            return Err(AuthError::Configuration);
        }
        let redirect_uri = Url::parse(redirect).map_err(|_| AuthError::Configuration)?;
        if redirect_uri.scheme() != "dev.orchestrat.app"
            || redirect_uri.host_str() != Some("auth")
            || redirect_uri.path() != "/callback"
            || redirect_uri.port().is_some()
            || !redirect_uri.username().is_empty()
            || redirect_uri.password().is_some()
            || redirect_uri.query().is_some()
            || redirect_uri.fragment().is_some()
        {
            return Err(AuthError::Configuration);
        }
        let portal_url = Url::parse(portal).map_err(|_| AuthError::Configuration)?;
        if portal_url.path() != "/auth/desktop"
            || portal_url.query().is_some()
            || portal_url.fragment().is_some()
            || !portal_url.username().is_empty()
            || portal_url.password().is_some()
            || !(portal_url.scheme() == "https"
                || (portal_url.scheme() == "http"
                    && matches!(
                        portal_url.host_str(),
                        Some("localhost" | "127.0.0.1" | "[::1]")
                    )))
        {
            return Err(AuthError::Configuration);
        }
        Ok(Self {
            base_url,
            publishable_key: key.into(),
            environment: environment.into(),
            redirect_uri,
            portal_url,
        })
    }

    fn endpoint(&self, path: &str) -> Url {
        let mut url = self.base_url.clone();
        url.set_path(path);
        url
    }
    pub fn otp_url(&self) -> Url {
        self.endpoint("/auth/v1/otp")
    }
    pub fn token_url(&self) -> Url {
        self.endpoint("/auth/v1/token")
    }
    pub fn logout_url(&self) -> Url {
        self.endpoint("/auth/v1/logout")
    }
    pub fn keychain_service(&self) -> String {
        format!("dev.orchestrat.app.auth.{}", self.environment)
    }
}

pub(crate) fn is_publishable_key(value: &str) -> bool {
    let Some(suffix) = value.strip_prefix(KEY_PREFIX) else {
        return false;
    };
    (20..=128).contains(&suffix.len())
        && suffix
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
}

pub(crate) fn is_environment(value: &str) -> bool {
    (1..=32).contains(&value.len())
        && !value.starts_with('-')
        && !value.ends_with('-')
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn required(value: Option<&str>) -> Result<&str, AuthError> {
    value
        .filter(|v| !v.is_empty())
        .ok_or(AuthError::Configuration)
}

#[cfg(test)]
mod tests {
    use super::*;
    const PORTAL_URL: &str = "http://localhost:5173/auth/desktop";
    #[test]
    fn rejects_non_root_origins_keys_environments_and_redirect_variants() {
        let key = "sb_publishable_abcdefghijklmnopqrstuvwxyz";
        assert!(SupabaseConfig::parse(
            "https://project.test",
            key,
            "production",
            REDIRECT_URI,
            PORTAL_URL
        )
        .is_ok());
        for base in [
            "http://project.test",
            "https://project.test/path",
            "https://project.test:444",
            "https://project.test:443",
            "https://u@project.test",
            "https://project.test?q=1",
        ] {
            assert!(
                SupabaseConfig::parse(base, key, "production", REDIRECT_URI, PORTAL_URL).is_err()
            );
        }
        for env in ["", "Production", "-prod", "prod-", "prod_env"] {
            assert!(SupabaseConfig::parse(
                "https://project.test",
                key,
                env,
                REDIRECT_URI,
                PORTAL_URL
            )
            .is_err());
        }
        assert!(SupabaseConfig::parse(
            "https://project.test",
            "eyJhbGciOiJIUzI1NiJ9.payload.signature",
            "production",
            REDIRECT_URI,
            PORTAL_URL
        )
        .is_err());
        assert!(SupabaseConfig::parse(
            "https://project.test",
            key,
            "production",
            "dev.orchestrat.app://auth/callback?x=1",
            PORTAL_URL
        )
        .is_err());
        for portal in [
            "http://example.com/auth/desktop",
            "https://app.orchestrat.dev/auth/desktop?x=1",
            "https://app.orchestrat.dev/other",
        ] {
            assert!(SupabaseConfig::parse(
                "https://project.test",
                key,
                "production",
                REDIRECT_URI,
                portal
            )
            .is_err());
        }
    }
}
