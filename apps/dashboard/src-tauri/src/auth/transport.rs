use async_trait::async_trait;
use std::time::Duration;

use serde::Deserialize;

use super::{config::OAuthConfig, AuthError};

#[derive(Clone, Debug)]
pub struct TokenGrant {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_in: u64,
}

#[async_trait]
pub trait OAuthTransport: Send + Sync {
    async fn exchange_code(&self, code: &str, verifier: &str) -> Result<TokenGrant, AuthError>;
    async fn refresh(&self, refresh_token: &str) -> Result<TokenGrant, AuthError>;
    async fn revoke(&self, refresh_token: &str) -> Result<(), AuthError>;
}

pub struct ClerkOAuthTransport {
    client: reqwest::Client,
    config: OAuthConfig,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: u64,
    token_type: String,
}

const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const READ_TIMEOUT: Duration = Duration::from_secs(10);

impl ClerkOAuthTransport {
    pub fn new(config: OAuthConfig) -> Self {
        Self::with_deadlines(config, CONNECT_TIMEOUT, REQUEST_TIMEOUT, READ_TIMEOUT)
    }

    fn with_deadlines(
        config: OAuthConfig,
        connect_timeout: Duration,
        request_timeout: Duration,
        read_timeout: Duration,
    ) -> Self {
        Self {
            client: reqwest::Client::builder()
                .connect_timeout(connect_timeout)
                .timeout(request_timeout)
                .read_timeout(read_timeout)
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("valid HTTP client configuration"),
            config,
        }
    }

    #[cfg(test)]
    fn with_test_deadlines(config: OAuthConfig, request_timeout: Duration) -> Self {
        Self::with_deadlines(config, request_timeout, request_timeout, request_timeout)
    }

    async fn token(&self, form: Vec<(&str, &str)>) -> Result<TokenGrant, AuthError> {
        let response = self
            .client
            .post(self.config.token_url.clone())
            .form(&form)
            .send()
            .await
            .map_err(|_| AuthError::TokenExchange)?;
        if !response.status().is_success() {
            return Err(AuthError::TokenExchange);
        }
        let token: TokenResponse = response
            .json()
            .await
            .map_err(|_| AuthError::TokenExchange)?;
        if token.access_token.is_empty() || !token.token_type.eq_ignore_ascii_case("bearer") {
            return Err(AuthError::TokenExchange);
        }
        if token.refresh_token.as_deref().is_some_and(str::is_empty) {
            return Err(AuthError::TokenExchange);
        }
        Ok(TokenGrant {
            access_token: token.access_token,
            refresh_token: token.refresh_token,
            expires_in: token.expires_in,
        })
    }
}

#[async_trait]
impl OAuthTransport for ClerkOAuthTransport {
    async fn exchange_code(&self, code: &str, verifier: &str) -> Result<TokenGrant, AuthError> {
        self.token(vec![
            ("grant_type", "authorization_code"),
            ("client_id", &self.config.client_id),
            ("code", code),
            ("redirect_uri", &self.config.redirect_uri),
            ("code_verifier", verifier),
        ])
        .await
    }

    async fn refresh(&self, refresh_token: &str) -> Result<TokenGrant, AuthError> {
        self.token(vec![
            ("grant_type", "refresh_token"),
            ("client_id", &self.config.client_id),
            ("refresh_token", refresh_token),
        ])
        .await
    }

    async fn revoke(&self, refresh_token: &str) -> Result<(), AuthError> {
        let response = self
            .client
            .post(self.config.revocation_url.clone())
            .form(&[
                ("client_id", self.config.client_id.as_str()),
                ("token", refresh_token),
                ("token_type_hint", "refresh_token"),
            ])
            .send()
            .await
            .map_err(|_| AuthError::TokenExchange)?;
        if response.status().is_success() {
            Ok(())
        } else {
            Err(AuthError::TokenExchange)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use httpmock::prelude::*;
    use url::Url;

    fn config(server: &MockServer) -> OAuthConfig {
        OAuthConfig {
            client_id: "desktop-client".into(),
            authorization_url: Url::parse("https://issuer.example/authorize").unwrap(),
            token_url: Url::parse(&server.url("/token")).unwrap(),
            revocation_url: Url::parse(&server.url("/revoke")).unwrap(),
            redirect_uri: "dev.orchestrat.app://auth/callback".into(),
        }
    }

    #[tokio::test]
    async fn sends_exact_exchange_refresh_and_revocation_forms() {
        let server = MockServer::start();
        let exchange = server.mock(|when, then| {
            when.method(POST).path("/token")
                .form_urlencoded_tuple("grant_type", "authorization_code")
                .form_urlencoded_tuple("client_id", "desktop-client")
                .form_urlencoded_tuple("code", "code-value")
                .form_urlencoded_tuple("redirect_uri", "dev.orchestrat.app://auth/callback")
                .form_urlencoded_tuple("code_verifier", "verifier-value");
            then.status(200).json_body_obj(&serde_json::json!({"access_token":"access-value","refresh_token":"refresh-one","expires_in":60,"token_type":"Bearer"}));
        });
        let refresh = server.mock(|when, then| {
            when.method(POST).path("/token")
                .form_urlencoded_tuple("grant_type", "refresh_token")
                .form_urlencoded_tuple("client_id", "desktop-client")
                .form_urlencoded_tuple("refresh_token", "refresh-one");
            then.status(200).json_body_obj(&serde_json::json!({"access_token":"access-value","refresh_token":"refresh-two","expires_in":120,"token_type":"bearer"}));
        });
        let revoke = server.mock(|when, then| {
            when.method(POST)
                .path("/revoke")
                .form_urlencoded_tuple("client_id", "desktop-client")
                .form_urlencoded_tuple("token", "refresh-two")
                .form_urlencoded_tuple("token_type_hint", "refresh_token");
            then.status(204);
        });
        let transport = ClerkOAuthTransport::new(config(&server));
        let exchanged = transport
            .exchange_code("code-value", "verifier-value")
            .await
            .unwrap();
        assert_eq!(exchanged.refresh_token.as_deref(), Some("refresh-one"));
        let refreshed = transport.refresh("refresh-one").await.unwrap();
        assert_eq!(refreshed.refresh_token.as_deref(), Some("refresh-two"));
        transport.revoke("refresh-two").await.unwrap();
        exchange.assert();
        refresh.assert();
        revoke.assert();
    }

    #[tokio::test]
    async fn does_not_follow_token_endpoint_redirects() {
        let server = MockServer::start();
        let redirect = server.mock(|when, then| {
            when.method(POST).path("/token");
            then.status(307)
                .header("location", server.url("/redirect-target"));
        });
        let target = server.mock(|when, then| {
            when.method(POST).path("/redirect-target");
            then.status(200).json_body_obj(&serde_json::json!({"access_token":"access-value","expires_in":60,"token_type":"Bearer"}));
        });
        let transport = ClerkOAuthTransport::new(config(&server));
        assert_eq!(
            transport.refresh("refresh").await.unwrap_err().code(),
            "token_exchange_error"
        );
        redirect.assert();
        target.assert_calls(0);
    }

    #[tokio::test]
    async fn maps_a_stalled_endpoint_to_token_exchange_error_with_a_bounded_deadline() {
        use std::time::Duration;

        let server = MockServer::start();
        let stalled = server.mock(|when, then| {
            when.method(POST).path("/token");
            then.status(200).delay(Duration::from_secs(1));
        });
        let transport =
            ClerkOAuthTransport::with_test_deadlines(config(&server), Duration::from_millis(100));
        assert_eq!(
            transport.refresh("refresh").await.unwrap_err().code(),
            "token_exchange_error"
        );
        stalled.assert_calls(1);
    }

    #[tokio::test]
    async fn maps_non_success_responses_to_token_exchange_error() {
        let server = MockServer::start();
        let rejected = server.mock(|when, then| {
            when.method(POST).path("/token");
            then.status(400).body("no");
        });
        let transport = ClerkOAuthTransport::new(config(&server));
        assert_eq!(
            transport.refresh("refresh").await.unwrap_err().code(),
            "token_exchange_error"
        );
        rejected.assert();
    }
}
