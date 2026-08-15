use super::{config::SupabaseConfig, AuthError};
use async_trait::async_trait;
use reqwest::{
    header::{AUTHORIZATION, CONTENT_TYPE},
    StatusCode,
};
use serde::{Deserialize, Serialize};
use std::time::Duration;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const READ_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_BODY: usize = 64 * 1024;

#[derive(Clone, Debug)]
pub struct TokenGrant {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_in: u64,
}
#[async_trait]
pub trait AuthTransport: Send + Sync {
    async fn send_magic_link(
        &self,
        email: &str,
        redirect_to: &str,
        challenge: &str,
    ) -> Result<(), AuthError>;
    async fn exchange_code(&self, code: &str, verifier: &str) -> Result<TokenGrant, AuthError>;
    async fn refresh(&self, refresh_token: &str) -> Result<TokenGrant, AuthError>;
    async fn logout(&self, access_token: &str) -> Result<(), AuthError>;
}
pub struct SupabaseAuthTransport {
    client: reqwest::Client,
    config: SupabaseConfig,
}
#[derive(Serialize)]
struct OtpRequest<'a> {
    email: &'a str,
    data: serde_json::Value,
    create_user: bool,
    code_challenge: &'a str,
    code_challenge_method: &'static str,
}
#[derive(Serialize)]
struct ExchangeRequest<'a> {
    auth_code: &'a str,
    code_verifier: &'a str,
}
#[derive(Serialize)]
struct RefreshRequest<'a> {
    refresh_token: &'a str,
}
#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: u64,
    token_type: String,
}

impl SupabaseAuthTransport {
    pub fn new(config: SupabaseConfig) -> Self {
        Self::with_deadlines(config, CONNECT_TIMEOUT, REQUEST_TIMEOUT, READ_TIMEOUT)
    }
    fn with_deadlines(
        config: SupabaseConfig,
        connect: Duration,
        request: Duration,
        read: Duration,
    ) -> Self {
        Self {
            client: reqwest::Client::builder()
                .connect_timeout(connect)
                .timeout(request)
                .read_timeout(read)
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("valid HTTP client configuration"),
            config,
        }
    }
    #[cfg(test)]
    fn with_test_deadline(config: SupabaseConfig, timeout: Duration) -> Self {
        Self::with_deadlines(config, timeout, timeout, timeout)
    }
    fn public_headers(&self, request: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        request
            .header("apikey", &self.config.publishable_key)
            .header(
                AUTHORIZATION,
                format!("Bearer {}", self.config.publishable_key),
            )
            .header(CONTENT_TYPE, "application/json")
    }
    async fn body(mut response: reqwest::Response) -> Result<(StatusCode, Vec<u8>), AuthError> {
        let status = response.status();
        let mut body = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| AuthError::ProviderTransient)?
        {
            if body.len().saturating_add(chunk.len()) > MAX_BODY {
                return Err(AuthError::InvalidProviderResponse);
            }
            body.extend_from_slice(&chunk);
        }
        Ok((status, body))
    }
    fn status_error(status: StatusCode) -> AuthError {
        if status == StatusCode::REQUEST_TIMEOUT
            || status == StatusCode::TOO_MANY_REQUESTS
            || status.is_server_error()
        {
            AuthError::ProviderTransient
        } else {
            AuthError::ProviderRejected
        }
    }
    async fn token<T: Serialize + Sync>(
        &self,
        mut url: url::Url,
        grant_type: &str,
        body: &T,
    ) -> Result<TokenGrant, AuthError> {
        url.query_pairs_mut().append_pair("grant_type", grant_type);
        let response = self
            .public_headers(self.client.post(url))
            .json(body)
            .send()
            .await
            .map_err(|_| AuthError::ProviderTransient)?;
        let (status, bytes) = Self::body(response).await?;
        if !status.is_success() {
            return Err(Self::status_error(status));
        }
        let token: TokenResponse =
            serde_json::from_slice(&bytes).map_err(|_| AuthError::InvalidProviderResponse)?;
        let refresh = token
            .refresh_token
            .filter(|v| !v.is_empty() && v.len() <= 16384)
            .ok_or(AuthError::InvalidProviderResponse)?;
        if token.access_token.is_empty()
            || token.access_token.len() > 16384
            || !token.token_type.eq_ignore_ascii_case("bearer")
            || token.expires_in == 0
        {
            return Err(AuthError::InvalidProviderResponse);
        }
        Ok(TokenGrant {
            access_token: token.access_token,
            refresh_token: refresh,
            expires_in: token.expires_in,
        })
    }
}
#[async_trait]
impl AuthTransport for SupabaseAuthTransport {
    async fn send_magic_link(
        &self,
        email: &str,
        redirect_to: &str,
        challenge: &str,
    ) -> Result<(), AuthError> {
        let mut url = self.config.otp_url();
        url.query_pairs_mut()
            .append_pair("redirect_to", redirect_to);
        let request = OtpRequest {
            email,
            data: serde_json::json!({}),
            create_user: true,
            code_challenge: challenge,
            code_challenge_method: "s256",
        };
        let response = self
            .public_headers(self.client.post(url))
            .json(&request)
            .send()
            .await
            .map_err(|_| AuthError::ProviderTransient)?;
        let (status, _) = Self::body(response).await?;
        if status.is_success() {
            Ok(())
        } else {
            Err(Self::status_error(status))
        }
    }
    async fn exchange_code(&self, code: &str, verifier: &str) -> Result<TokenGrant, AuthError> {
        self.token(
            self.config.token_url(),
            "pkce",
            &ExchangeRequest {
                auth_code: code,
                code_verifier: verifier,
            },
        )
        .await
    }
    async fn refresh(&self, refresh_token: &str) -> Result<TokenGrant, AuthError> {
        self.token(
            self.config.token_url(),
            "refresh_token",
            &RefreshRequest { refresh_token },
        )
        .await
    }
    async fn logout(&self, access_token: &str) -> Result<(), AuthError> {
        let mut url = self.config.logout_url();
        url.query_pairs_mut().append_pair("scope", "local");
        let response = self
            .client
            .post(url)
            .header("apikey", &self.config.publishable_key)
            .header(AUTHORIZATION, format!("Bearer {access_token}"))
            .send()
            .await
            .map_err(|_| AuthError::ProviderTransient)?;
        let (status, _) = Self::body(response).await?;
        if status.is_success()
            || matches!(
                status,
                StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN | StatusCode::NOT_FOUND
            )
        {
            Ok(())
        } else {
            Err(Self::status_error(status))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use httpmock::prelude::*;
    use url::Url;
    fn config(server: &MockServer) -> SupabaseConfig {
        SupabaseConfig {
            base_url: Url::parse(&server.base_url()).unwrap(),
            publishable_key: "sb_publishable_abcdefghijklmnopqrstuvwxyz".into(),
            environment: "test".into(),
            redirect_uri: Url::parse("dev.orchestrat.app://auth/callback").unwrap(),
        }
    }
    #[tokio::test]
    async fn exact_otp_exchange_refresh_and_logout_contract() {
        let s = MockServer::start();
        let headers = |when: httpmock::When| {
            when.header("apikey", "sb_publishable_abcdefghijklmnopqrstuvwxyz")
                .header(
                    "authorization",
                    "Bearer sb_publishable_abcdefghijklmnopqrstuvwxyz",
                )
                .header("content-type", "application/json")
        };
        let otp = s.mock(|when, then| {
            headers(when.method(POST).path("/auth/v1/otp").query_param(
                "redirect_to",
                "dev.orchestrat.app://auth/callback?sb_flow_id=flow_identifier_123",
            ))
            .json_body_obj(&serde_json::json!({
                "email": "person@example.com", "data": {}, "create_user": true,
                "code_challenge": "challenge", "code_challenge_method": "s256"
            }));
            then.status(200).body("{}");
        });
        let exchange = s.mock(|when, then| {
            headers(
                when.method(POST)
                    .path("/auth/v1/token")
                    .query_param("grant_type", "pkce"),
            )
            .json_body_obj(
                &serde_json::json!({"auth_code": "auth-code", "code_verifier": "verifier"}),
            );
            then.status(200).json_body_obj(&serde_json::json!({
                "access_token": "access-one", "refresh_token": "refresh-one",
                "expires_in": 60, "token_type": "bearer"
            }));
        });
        let refresh = s.mock(|when, then| {
            headers(
                when.method(POST)
                    .path("/auth/v1/token")
                    .query_param("grant_type", "refresh_token"),
            )
            .json_body_obj(&serde_json::json!({"refresh_token": "refresh-one"}));
            then.status(200).json_body_obj(&serde_json::json!({
                "access_token": "access-two", "refresh_token": "refresh-two",
                "expires_in": 60, "token_type": "bearer"
            }));
        });
        let logout = s.mock(|when, then| {
            when.method(POST)
                .path("/auth/v1/logout")
                .query_param("scope", "local")
                .header("apikey", "sb_publishable_abcdefghijklmnopqrstuvwxyz")
                .header("authorization", "Bearer access-two");
            then.status(204);
        });
        let t = SupabaseAuthTransport::new(config(&s));
        t.send_magic_link(
            "person@example.com",
            "dev.orchestrat.app://auth/callback?sb_flow_id=flow_identifier_123",
            "challenge",
        )
        .await
        .unwrap();
        t.exchange_code("auth-code", "verifier").await.unwrap();
        t.refresh("refresh-one").await.unwrap();
        t.logout("access-two").await.unwrap();
        otp.assert();
        exchange.assert();
        refresh.assert();
        logout.assert();
    }
    #[tokio::test]
    async fn no_redirects_deadline_and_body_bound() {
        let s = MockServer::start();
        let redirect = s.mock(|when, then| {
            when.method(POST).path("/auth/v1/token");
            then.status(307).header("location", s.url("/target"));
        });
        let target = s.mock(|when, then| {
            when.path("/target");
            then.status(200);
        });
        let t = SupabaseAuthTransport::new(config(&s));
        assert!(matches!(
            t.refresh("x").await,
            Err(AuthError::ProviderRejected)
        ));
        redirect.assert();
        target.assert_calls(0);
        let s2 = MockServer::start();
        let huge = s2.mock(|when, then| {
            when.path("/auth/v1/token");
            then.status(200).body("x".repeat(MAX_BODY + 1));
        });
        let t2 = SupabaseAuthTransport::new(config(&s2));
        assert!(matches!(
            t2.refresh("x").await,
            Err(AuthError::InvalidProviderResponse)
        ));
        huge.assert();
        let s3 = MockServer::start();
        let slow = s3.mock(|when, then| {
            when.path("/auth/v1/token");
            then.status(200).delay(Duration::from_secs(1));
        });
        let t3 = SupabaseAuthTransport::with_test_deadline(config(&s3), Duration::from_millis(50));
        assert!(matches!(
            t3.refresh("x").await,
            Err(AuthError::ProviderTransient)
        ));
        slow.assert();
    }
    #[tokio::test]
    async fn missing_rotated_refresh_is_terminal_invalid_response() {
        let s = MockServer::start();
        let m = s.mock(|when, then| {
            when.path("/auth/v1/token");
            then.status(200).json_body_obj(
                &serde_json::json!({"access_token":"a","expires_in":60,"token_type":"bearer"}),
            );
        });
        let t = SupabaseAuthTransport::new(config(&s));
        assert!(matches!(
            t.refresh("old").await,
            Err(AuthError::InvalidProviderResponse)
        ));
        m.assert();
    }

    #[tokio::test]
    async fn classifies_credential_rejections_as_terminal_and_rate_limits_as_transient() {
        for (status, terminal) in [
            (400, true),
            (401, true),
            (422, true),
            (429, false),
            (500, false),
        ] {
            let server = MockServer::start();
            let rejection = server.mock(|when, then| {
                when.path("/auth/v1/token");
                then.status(status);
            });
            let result = SupabaseAuthTransport::new(config(&server))
                .refresh("refresh")
                .await;
            assert_eq!(matches!(result, Err(AuthError::ProviderRejected)), terminal);
            rejection.assert();
        }
    }

    #[tokio::test]
    async fn already_invalid_remote_logout_is_locally_safe() {
        for status in [401, 403, 404] {
            let server = MockServer::start();
            let logout = server.mock(|when, then| {
                when.method(POST)
                    .path("/auth/v1/logout")
                    .query_param("scope", "local");
                then.status(status);
            });
            SupabaseAuthTransport::new(config(&server))
                .logout("access")
                .await
                .unwrap();
            logout.assert();
        }
    }
}
