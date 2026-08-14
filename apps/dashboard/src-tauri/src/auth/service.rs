use std::sync::{Arc, Mutex};

use tokio::sync::Mutex as AsyncMutex;

use super::{
    callback::{parse_callback, PendingAuthorization},
    config::OAuthConfig,
    keychain::{CredentialStore, PENDING_ACCOUNT, REFRESH_ACCOUNT},
    pkce::Pkce,
    transport::OAuthTransport,
    AuthError,
};
use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccessGrant {
    pub access_token: String,
    pub expires_at_ms: u64,
}

pub(crate) struct AuthorizationRequest {
    pub(crate) url: String,
    pub(crate) state: String,
}

#[derive(Clone)]
pub struct OAuthService {
    config: OAuthConfig,
    store: Arc<dyn CredentialStore>,
    transport: Arc<dyn OAuthTransport>,
    // This lock covers every session-changing async lifecycle operation, including
    // its remote request.  It is a Tokio mutex specifically so it may span await
    // points without blocking a runtime worker or holding a std mutex over await.
    lifecycle_lock: Arc<AsyncMutex<()>>,
    // begin/cancel are synchronous command helpers.  They only protect their
    // synchronous pending-record access and are always dropped before an await.
    pending_lock: Arc<Mutex<()>>,
}

impl OAuthService {
    pub fn new(
        config: OAuthConfig,
        store: Arc<dyn CredentialStore>,
        transport: Arc<dyn OAuthTransport>,
    ) -> Self {
        Self {
            config,
            store,
            transport,
            lifecycle_lock: Arc::new(AsyncMutex::new(())),
            pending_lock: Arc::new(Mutex::new(())),
        }
    }

    pub(crate) fn begin(&self, now_ms: u64) -> Result<AuthorizationRequest, AuthError> {
        let _guard = self
            .pending_lock
            .lock()
            .map_err(|_| AuthError::CredentialStore)?;
        let pkce = Pkce::generate();
        let state = pkce.state.clone();
        let pending = PendingAuthorization {
            state: state.clone(),
            verifier: pkce.verifier,
            created_at_ms: now_ms,
        };
        let pending = serde_json::to_string(&pending).map_err(|_| AuthError::CredentialStore)?;
        self.store.set(PENDING_ACCOUNT, &pending)?;
        let mut url = self.config.authorization_url.clone();
        {
            let mut query = url.query_pairs_mut();
            query.append_pair("response_type", "code");
            query.append_pair("client_id", &self.config.client_id);
            query.append_pair("redirect_uri", &self.config.redirect_uri);
            query.append_pair("scope", "profile email");
            query.append_pair("state", &state);
            query.append_pair("code_challenge", &pkce.challenge);
            query.append_pair("code_challenge_method", pkce.challenge_method);
        }
        Ok(AuthorizationRequest {
            url: url.into(),
            state,
        })
    }

    pub async fn restore(&self, now_ms: u64) -> Result<Option<AccessGrant>, AuthError> {
        let _lifecycle = self.lifecycle_lock.lock().await;
        let Some(refresh_token) = self.store.get(REFRESH_ACCOUNT)? else {
            return Ok(None);
        };
        self.refresh_with_token(&refresh_token, now_ms)
            .await
            .map(Some)
    }

    pub async fn complete(
        &self,
        callback_url: &str,
        now_ms: u64,
    ) -> Result<AccessGrant, AuthError> {
        let _lifecycle = self.lifecycle_lock.lock().await;
        let validated = {
            let _pending = self
                .pending_lock
                .lock()
                .map_err(|_| AuthError::CredentialStore)?;
            let serialized = self
                .store
                .get(PENDING_ACCOUNT)?
                .ok_or(AuthError::InvalidCallback)?;
            let pending: PendingAuthorization =
                serde_json::from_str(&serialized).map_err(|_| AuthError::InvalidCallback)?;
            if !Pkce::is_valid_verifier(&pending.verifier) {
                return Err(AuthError::InvalidCallback);
            }

            // Do not consume a pending authorization until the URL and state are
            // validated. A provider denial with a valid state is terminal and is
            // intentionally consumed; malformed or mismatched callbacks are not.
            match parse_callback(callback_url, &pending, now_ms) {
                Ok(validated) => {
                    self.store.delete(PENDING_ACCOUNT)?;
                    validated
                }
                Err(AuthError::AccessDenied) => {
                    self.store.delete(PENDING_ACCOUNT)?;
                    return Err(AuthError::AccessDenied);
                }
                Err(error) => return Err(error),
            }
        };
        let grant = self
            .transport
            .exchange_code(&validated.code, &validated.verifier)
            .await?;
        let refresh_token = grant
            .refresh_token
            .filter(|token| !token.is_empty())
            .ok_or(AuthError::TokenExchange)?;
        self.store.set(REFRESH_ACCOUNT, &refresh_token)?;
        Ok(access_grant(grant.access_token, grant.expires_in, now_ms))
    }

    pub async fn refresh(&self, now_ms: u64) -> Result<AccessGrant, AuthError> {
        let _lifecycle = self.lifecycle_lock.lock().await;
        let refresh_token = self
            .store
            .get(REFRESH_ACCOUNT)?
            .ok_or(AuthError::NoSession)?;
        self.refresh_with_token(&refresh_token, now_ms).await
    }

    async fn refresh_with_token(
        &self,
        refresh_token: &str,
        now_ms: u64,
    ) -> Result<AccessGrant, AuthError> {
        let grant = self.transport.refresh(refresh_token).await?;
        if let Some(rotated) = grant.refresh_token.filter(|token| !token.is_empty()) {
            self.store.set(REFRESH_ACCOUNT, &rotated)?;
        }
        Ok(access_grant(grant.access_token, grant.expires_in, now_ms))
    }

    pub(crate) fn cancel_pending_if_matches(&self, state: &str) -> Result<(), AuthError> {
        let _guard = self
            .pending_lock
            .lock()
            .map_err(|_| AuthError::CredentialStore)?;
        let Some(serialized) = self.store.get(PENDING_ACCOUNT)? else {
            return Ok(());
        };
        let pending: PendingAuthorization =
            serde_json::from_str(&serialized).map_err(|_| AuthError::CredentialStore)?;
        if pending.state == state {
            self.store.delete(PENDING_ACCOUNT)?;
        }
        Ok(())
    }

    pub async fn sign_out(&self) -> Result<(), AuthError> {
        let refresh = {
            let _lifecycle = self.lifecycle_lock.lock().await;
            let refresh = self.store.get(REFRESH_ACCOUNT);
            let pending_result = {
                let _pending = self
                    .pending_lock
                    .lock()
                    .map_err(|_| AuthError::CredentialStore)?;
                self.store.delete(PENDING_ACCOUNT)
            };
            let refresh_result = self.store.delete(REFRESH_ACCOUNT);
            let local_result = pending_result.and(refresh_result);
            (refresh, local_result)
        };

        // Revocation uses the snapshot after local state is gone. It is bounded by
        // the transport client, and cannot retain or resurrect this local session.
        let remote_result = match refresh.0 {
            Ok(Some(token)) => self.transport.revoke(&token).await,
            Ok(None) => Ok(()),
            Err(error) => Err(error),
        };
        remote_result.and(refresh.1)
    }
}

fn access_grant(access_token: String, expires_in: u64, now_ms: u64) -> AccessGrant {
    AccessGrant {
        access_token,
        expires_at_ms: now_ms.saturating_add(expires_in.saturating_mul(1_000)),
    }
}

#[cfg(test)]
mod tests {
    use std::{
        sync::{Arc, Mutex},
        time::Duration,
    };

    use async_trait::async_trait;
    use tokio::{sync::Notify, time::timeout};
    use url::Url;

    use super::*;
    use crate::auth::{
        config::OAuthConfig,
        keychain::{CredentialStore, MemoryStore, PENDING_ACCOUNT, REFRESH_ACCOUNT},
        transport::{OAuthTransport, TokenGrant},
        AuthError,
    };

    const TEST_WAIT: Duration = Duration::from_secs(2);

    async fn notified(notify: &Notify) {
        timeout(TEST_WAIT, notify.notified())
            .await
            .expect("test transport did not reach expected lifecycle point");
    }

    async fn joined<T>(handle: tokio::task::JoinHandle<T>) -> T {
        timeout(TEST_WAIT, handle)
            .await
            .expect("lifecycle task deadlocked")
            .expect("lifecycle task panicked")
    }

    struct FakeTransport {
        fail_refresh: Mutex<bool>,
        revoke_count: Mutex<u8>,
    }

    #[async_trait]
    impl OAuthTransport for FakeTransport {
        async fn exchange_code(&self, _: &str, _: &str) -> Result<TokenGrant, AuthError> {
            Ok(TokenGrant {
                access_token: "access-from-code".into(),
                refresh_token: Some("refresh-one".into()),
                expires_in: 60,
            })
        }

        async fn refresh(&self, _: &str) -> Result<TokenGrant, AuthError> {
            if *self.fail_refresh.lock().expect("lock") {
                return Err(AuthError::TokenExchange);
            }
            Ok(TokenGrant {
                access_token: "access-from-refresh".into(),
                refresh_token: Some("refresh-two".into()),
                expires_in: 60,
            })
        }

        async fn revoke(&self, _: &str) -> Result<(), AuthError> {
            *self.revoke_count.lock().expect("lock") += 1;
            Ok(())
        }
    }

    struct BlockingTransport {
        exchange_started: Notify,
        exchange_release: Notify,
        refresh_started: Notify,
        refresh_release: Notify,
        revoke_started: Notify,
        revoke_release: Notify,
        refresh_tokens: Mutex<Vec<String>>,
        reject_revoke: bool,
    }

    impl BlockingTransport {
        fn new(reject_revoke: bool) -> Self {
            Self {
                exchange_started: Notify::new(),
                exchange_release: Notify::new(),
                refresh_started: Notify::new(),
                refresh_release: Notify::new(),
                revoke_started: Notify::new(),
                revoke_release: Notify::new(),
                refresh_tokens: Mutex::new(Vec::new()),
                reject_revoke,
            }
        }
    }

    #[async_trait]
    impl OAuthTransport for BlockingTransport {
        async fn exchange_code(&self, _: &str, _: &str) -> Result<TokenGrant, AuthError> {
            self.exchange_started.notify_one();
            self.exchange_release.notified().await;
            Ok(TokenGrant {
                access_token: "access-after-wait".into(),
                refresh_token: Some("refresh-after-wait".into()),
                expires_in: 60,
            })
        }

        async fn refresh(&self, refresh_token: &str) -> Result<TokenGrant, AuthError> {
            self.refresh_tokens
                .lock()
                .expect("lock")
                .push(refresh_token.into());
            self.refresh_started.notify_one();
            self.refresh_release.notified().await;
            Ok(TokenGrant {
                access_token: "access-after-refresh".into(),
                refresh_token: Some("rotated-refresh".into()),
                expires_in: 60,
            })
        }

        async fn revoke(&self, _: &str) -> Result<(), AuthError> {
            self.revoke_started.notify_one();
            self.revoke_release.notified().await;
            if self.reject_revoke {
                Err(AuthError::TokenExchange)
            } else {
                Ok(())
            }
        }
    }

    fn service_config() -> OAuthConfig {
        OAuthConfig {
            client_id: "client".into(),
            authorization_url: Url::parse("https://issuer.test/authorize").expect("url"),
            token_url: Url::parse("https://issuer.test/token").expect("url"),
            revocation_url: Url::parse("https://issuer.test/revoke").expect("url"),
            redirect_uri: "dev.orchestrat.app://auth/callback".into(),
        }
    }

    fn blocking_service() -> (OAuthService, Arc<MemoryStore>, Arc<BlockingTransport>) {
        let store = Arc::new(MemoryStore::new());
        let transport = Arc::new(BlockingTransport::new(false));
        (
            OAuthService::new(service_config(), store.clone(), transport.clone()),
            store,
            transport,
        )
    }

    struct ServiceFixture {
        service: OAuthService,
        store: Arc<MemoryStore>,
        transport: Arc<FakeTransport>,
    }

    impl ServiceFixture {
        fn new() -> Self {
            let store = Arc::new(MemoryStore::new());
            let transport = Arc::new(FakeTransport {
                fail_refresh: Mutex::new(false),
                revoke_count: Mutex::new(0),
            });
            Self {
                service: OAuthService::new(service_config(), store.clone(), transport.clone()),
                store,
                transport,
            }
        }
    }

    fn callback_from_authorization(authorization_request: &AuthorizationRequest) -> String {
        let state = Url::parse(&authorization_request.url)
            .expect("authorization URL")
            .query_pairs()
            .find(|(key, _)| key == "state")
            .expect("state")
            .1
            .into_owned();
        format!("dev.orchestrat.app://auth/callback?code=code-123&state={state}")
    }

    #[test]
    fn rollback_only_removes_the_pending_authorization_it_started() {
        let fixture = ServiceFixture::new();
        let first = fixture.service.begin(1_000).expect("first begin");
        let first_pending: PendingAuthorization = serde_json::from_str(
            &fixture
                .store
                .get(PENDING_ACCOUNT)
                .expect("store")
                .expect("first pending authorization"),
        )
        .expect("pending authorization");
        assert_eq!(first_pending.state, first.state);

        let second = fixture.service.begin(1_001).expect("second begin");
        assert_ne!(first.state, second.state);
        fixture
            .service
            .cancel_pending_if_matches(&first.state)
            .expect("first rollback");
        let pending: PendingAuthorization = serde_json::from_str(
            &fixture
                .store
                .get(PENDING_ACCOUNT)
                .expect("store")
                .expect("second pending authorization"),
        )
        .expect("pending authorization");
        assert_eq!(pending.state, second.state);

        fixture
            .service
            .cancel_pending_if_matches(&second.state)
            .expect("second rollback");
        assert!(fixture.store.get(PENDING_ACCOUNT).expect("store").is_none());
    }

    #[tokio::test]
    async fn begin_complete_restore_refresh_and_sign_out_are_single_use() {
        let fixture = ServiceFixture::new();
        let callback = callback_from_authorization(&fixture.service.begin(1_000).expect("begin"));
        let completed = fixture
            .service
            .complete(&callback, 1_100)
            .await
            .expect("complete");
        assert_eq!(completed.access_token, "access-from-code");
        assert!(fixture.store.get(REFRESH_ACCOUNT).expect("store").is_some());
        assert_eq!(
            fixture
                .service
                .complete(&callback, 1_101)
                .await
                .unwrap_err()
                .code(),
            "invalid_callback"
        );
        let restored = fixture
            .service
            .restore(2_000)
            .await
            .expect("restore")
            .expect("grant");
        assert_eq!(restored.access_token, "access-from-refresh");
        fixture.service.sign_out().await.expect("sign out");
        assert!(fixture.store.get(REFRESH_ACCOUNT).expect("store").is_none());
        assert_eq!(*fixture.transport.revoke_count.lock().expect("lock"), 1);
    }

    #[tokio::test]
    async fn denial_missing_refresh_and_failed_refresh_are_rejected() {
        let fixture = ServiceFixture::new();
        let authorization_url = fixture.service.begin(1_000).expect("begin");
        let state = Url::parse(&authorization_url.url)
            .expect("url")
            .query_pairs()
            .find(|(key, _)| key == "state")
            .expect("state")
            .1
            .into_owned();
        assert_eq!(
            fixture
                .service
                .complete(
                    &format!(
                        "dev.orchestrat.app://auth/callback?error=access_denied&state={state}"
                    ),
                    1_100,
                )
                .await
                .unwrap_err()
                .code(),
            "access_denied"
        );
        assert!(fixture.store.get(PENDING_ACCOUNT).expect("store").is_none());
        assert_eq!(
            fixture.service.refresh(1_100).await.unwrap_err().code(),
            "no_session"
        );
        fixture
            .store
            .set(REFRESH_ACCOUNT, "refresh")
            .expect("store");
        *fixture.transport.fail_refresh.lock().expect("lock") = true;
        assert_eq!(
            fixture.service.refresh(1_100).await.unwrap_err().code(),
            "token_exchange_error"
        );
    }

    #[tokio::test]
    async fn invalid_callbacks_preserve_the_pending_login_until_a_valid_callback_consumes_it() {
        let fixture = ServiceFixture::new();
        let authorization_url = fixture.service.begin(1_000).expect("begin");
        let callback = callback_from_authorization(&authorization_url);
        assert_eq!(
            fixture
                .service
                .complete("evil.app://auth/callback?code=x&state=wrong", 1_100)
                .await
                .unwrap_err()
                .code(),
            "invalid_callback"
        );
        assert!(fixture.store.get(PENDING_ACCOUNT).expect("store").is_some());
        assert_eq!(
            fixture
                .service
                .complete(&callback.replacen("code=code-123&", "", 1), 1_100)
                .await
                .unwrap_err()
                .code(),
            "invalid_callback"
        );
        assert!(fixture.store.get(PENDING_ACCOUNT).expect("store").is_some());
        assert_eq!(
            fixture
                .service
                .complete(
                    "dev.orchestrat.app://auth/callback?code=x&state=wrong",
                    1_100
                )
                .await
                .unwrap_err()
                .code(),
            "state_mismatch"
        );
        assert!(fixture.store.get(PENDING_ACCOUNT).expect("store").is_some());
        fixture
            .service
            .complete(&callback, 1_100)
            .await
            .expect("complete");
        assert!(fixture.store.get(PENDING_ACCOUNT).expect("store").is_none());
    }

    #[tokio::test]
    async fn sign_out_after_inflight_completion_cannot_leave_a_refresh_token() {
        let (service, store, transport) = blocking_service();
        let callback = callback_from_authorization(&service.begin(1_000).expect("begin"));
        let completion = tokio::spawn({
            let service = service.clone();
            async move { service.complete(&callback, 1_100).await }
        });
        notified(&transport.exchange_started).await;
        let sign_out = tokio::spawn({
            let service = service.clone();
            async move { service.sign_out().await }
        });
        transport.exchange_release.notify_one();
        assert!(joined(completion).await.is_ok());
        notified(&transport.revoke_started).await;
        transport.revoke_release.notify_one();
        assert!(joined(sign_out).await.is_ok());
        assert!(store.get(REFRESH_ACCOUNT).expect("store").is_none());
    }

    #[tokio::test]
    async fn sign_out_after_inflight_refresh_cannot_restore_a_rotated_token() {
        let (service, store, transport) = blocking_service();
        store
            .set(REFRESH_ACCOUNT, "existing-refresh")
            .expect("store");
        let refresh = tokio::spawn({
            let service = service.clone();
            async move { service.refresh(1_100).await }
        });
        notified(&transport.refresh_started).await;
        let sign_out = tokio::spawn({
            let service = service.clone();
            async move { service.sign_out().await }
        });
        transport.refresh_release.notify_one();
        assert!(joined(refresh).await.is_ok());
        notified(&transport.revoke_started).await;
        transport.revoke_release.notify_one();
        assert!(joined(sign_out).await.is_ok());
        assert!(store.get(REFRESH_ACCOUNT).expect("store").is_none());
    }

    #[tokio::test]
    async fn concurrent_refreshes_serialize_rotation() {
        let (service, store, transport) = blocking_service();
        store
            .set(REFRESH_ACCOUNT, "existing-refresh")
            .expect("store");
        let first = tokio::spawn({
            let service = service.clone();
            async move { service.refresh(1_100).await }
        });
        notified(&transport.refresh_started).await;
        let second = tokio::spawn({
            let service = service.clone();
            async move { service.refresh(1_101).await }
        });
        assert!(timeout(
            Duration::from_millis(50),
            transport.refresh_started.notified()
        )
        .await
        .is_err());
        transport.refresh_release.notify_one();
        assert!(joined(first).await.is_ok());
        notified(&transport.refresh_started).await;
        transport.refresh_release.notify_one();
        assert!(joined(second).await.is_ok());
        assert_eq!(
            *transport.refresh_tokens.lock().expect("lock"),
            vec!["existing-refresh", "rotated-refresh"]
        );
    }

    #[tokio::test]
    async fn sign_out_clears_local_credentials_before_a_stalled_rejected_revoke() {
        let store = Arc::new(MemoryStore::new());
        let transport = Arc::new(BlockingTransport::new(true));
        let service = OAuthService::new(service_config(), store.clone(), transport.clone());
        service.begin(1_000).expect("begin");
        store
            .set(REFRESH_ACCOUNT, "existing-refresh")
            .expect("store");
        let sign_out = tokio::spawn(async move { service.sign_out().await });
        notified(&transport.revoke_started).await;
        assert!(store.get(PENDING_ACCOUNT).expect("store").is_none());
        assert!(store.get(REFRESH_ACCOUNT).expect("store").is_none());
        transport.revoke_release.notify_one();
        assert_eq!(
            joined(sign_out).await.unwrap_err().code(),
            "token_exchange_error"
        );
    }
}
