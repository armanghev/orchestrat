use super::{
    callback::{parse_callback, PendingAuthorization, PendingKind},
    config::SupabaseConfig,
    keychain::{CredentialStore, PENDING_ACCOUNT, REFRESH_ACCOUNT},
    pkce::Pkce,
    transport::{AuthTransport, TokenGrant},
    AuthError,
};
use serde::Serialize;
use std::sync::{Arc, Mutex};
use tokio::sync::Mutex as AsyncMutex;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccessGrant {
    pub access_token: String,
    pub expires_at_ms: u64,
}
pub(crate) struct AuthorizationRequest {
    pub(crate) url: String,
    pub(crate) flow_id: String,
}
#[derive(Clone)]
pub struct AuthService {
    config: SupabaseConfig,
    store: Arc<dyn CredentialStore>,
    transport: Arc<dyn AuthTransport>,
    lifecycle: Arc<AsyncMutex<()>>,
    current_access: Arc<Mutex<Option<String>>>,
}
impl AuthService {
    pub fn new(
        config: SupabaseConfig,
        store: Arc<dyn CredentialStore>,
        transport: Arc<dyn AuthTransport>,
    ) -> Self {
        Self {
            config,
            store,
            transport,
            lifecycle: Arc::new(AsyncMutex::new(())),
            current_access: Arc::new(Mutex::new(None)),
        }
    }
    fn pending(
        &self,
        kind: PendingKind,
        now: u64,
    ) -> Result<(Pkce, PendingAuthorization), AuthError> {
        let pkce = Pkce::generate();
        let pending = PendingAuthorization {
            version: 1,
            kind,
            flow_id: pkce.flow_id.clone(),
            verifier: pkce.verifier.clone(),
            created_at_ms: now,
        };
        self.store.set(
            PENDING_ACCOUNT,
            &serde_json::to_string(&pending).map_err(|_| AuthError::CredentialStore)?,
        )?;
        Ok((pkce, pending))
    }
    fn redirect_for(&self, flow: &str) -> String {
        let mut url = self.config.redirect_uri.clone();
        url.query_pairs_mut().append_pair("sb_flow_id", flow);
        url.into()
    }
    pub(crate) async fn begin_github(&self, now: u64) -> Result<AuthorizationRequest, AuthError> {
        let _guard = self.lifecycle.lock().await;
        let (pkce, pending) = self.pending(PendingKind::Github, now)?;
        let redirect = self.redirect_for(&pending.flow_id);
        let mut url = self.config.authorize_url();
        {
            let mut q = url.query_pairs_mut();
            q.append_pair("provider", "github")
                .append_pair("redirect_to", &redirect)
                .append_pair("code_challenge", &pkce.challenge)
                .append_pair("code_challenge_method", pkce.challenge_method);
        }
        Ok(AuthorizationRequest {
            url: url.into(),
            flow_id: pending.flow_id,
        })
    }
    pub async fn send_magic_link(&self, value: &str, now: u64) -> Result<(), AuthError> {
        let _guard = self.lifecycle.lock().await;
        let email = normalize_email(value).ok_or(AuthError::InvalidEmail)?;
        let (pkce, pending) = self.pending(PendingKind::MagicLink, now)?;
        let redirect = self.redirect_for(&pending.flow_id);
        let result = self
            .transport
            .send_magic_link(&email, &redirect, &pkce.challenge)
            .await;
        if result.is_err() {
            self.rollback_locked(&pending.flow_id)?;
        }
        result
    }
    pub(crate) async fn rollback_pending_if_matches(&self, flow: &str) -> Result<(), AuthError> {
        let _guard = self.lifecycle.lock().await;
        self.rollback_locked(flow)
    }
    fn rollback_locked(&self, flow: &str) -> Result<(), AuthError> {
        let Some(raw) = self.store.get(PENDING_ACCOUNT)? else {
            return Ok(());
        };
        let pending: PendingAuthorization =
            serde_json::from_str(&raw).map_err(|_| AuthError::CredentialStore)?;
        if pending.flow_id == flow {
            self.store.delete(PENDING_ACCOUNT)?;
        }
        Ok(())
    }
    pub async fn complete(&self, callback: &str, now: u64) -> Result<AccessGrant, AuthError> {
        let _guard = self.lifecycle.lock().await;
        let raw = self
            .store
            .get(PENDING_ACCOUNT)?
            .ok_or(AuthError::InvalidCallback)?;
        let pending: PendingAuthorization =
            serde_json::from_str(&raw).map_err(|_| AuthError::InvalidCallback)?;
        let validated = match parse_callback(callback, &pending, now) {
            Ok(v) => v,
            Err(error @ (AuthError::AccessDenied | AuthError::CallbackExpired)) => {
                self.store.delete(PENDING_ACCOUNT)?;
                return Err(error);
            }
            Err(error) => return Err(error),
        };
        let code = validated
            .code
            .as_deref()
            .ok_or(AuthError::InvalidCallback)?;
        let grant = match self
            .transport
            .exchange_code(code, &validated.verifier)
            .await
        {
            Ok(g) => g,
            Err(error @ (AuthError::ProviderRejected | AuthError::InvalidProviderResponse)) => {
                self.store.delete(PENDING_ACCOUNT)?;
                return Err(error);
            }
            Err(error) => return Err(error),
        };
        self.persist_grant(grant, now, true)
    }
    pub async fn restore(&self, now: u64) -> Result<Option<AccessGrant>, AuthError> {
        let _guard = self.lifecycle.lock().await;
        let Some(token) = self.store.get(REFRESH_ACCOUNT)? else {
            return Ok(None);
        };
        match self.transport.refresh(&token).await {
            Ok(grant) => self.persist_grant(grant, now, false).map(Some),
            Err(error) if error.is_terminal_session() => {
                self.clear_session_locked()?;
                Ok(None)
            }
            Err(error) => Err(error),
        }
    }
    pub async fn refresh(&self, now: u64) -> Result<AccessGrant, AuthError> {
        let _guard = self.lifecycle.lock().await;
        let token = self
            .store
            .get(REFRESH_ACCOUNT)?
            .ok_or(AuthError::NoSession)?;
        match self.transport.refresh(&token).await {
            Ok(grant) => self.persist_grant(grant, now, false),
            Err(error) if error.is_terminal_session() => {
                self.clear_session_locked()?;
                Err(error)
            }
            Err(error) => Err(error),
        }
    }
    fn persist_grant(
        &self,
        grant: TokenGrant,
        now: u64,
        consume_pending: bool,
    ) -> Result<AccessGrant, AuthError> {
        if grant.refresh_token.is_empty() {
            self.clear_session_locked()?;
            return Err(AuthError::InvalidProviderResponse);
        }
        if let Err(error) = self.store.set(REFRESH_ACCOUNT, &grant.refresh_token) {
            let _ = self.store.delete(REFRESH_ACCOUNT);
            *self
                .current_access
                .lock()
                .map_err(|_| AuthError::CredentialStore)? = None;
            return Err(error);
        }
        if consume_pending {
            self.store.delete(PENDING_ACCOUNT)?;
        }
        let result = access_grant(grant.access_token.clone(), grant.expires_in, now);
        *self
            .current_access
            .lock()
            .map_err(|_| AuthError::CredentialStore)? = Some(grant.access_token);
        Ok(result)
    }
    pub async fn expire(&self) -> Result<(), AuthError> {
        let _guard = self.lifecycle.lock().await;
        self.clear_all_locked()
    }
    pub async fn sign_out(&self) -> Result<(), AuthError> {
        let _guard = self.lifecycle.lock().await;
        let access = self
            .current_access
            .lock()
            .map_err(|_| AuthError::CredentialStore)?
            .take();
        let local = self.delete_both();
        let remote = match access {
            Some(token) => self.transport.logout(&token).await,
            None => Ok(()),
        };
        local.and(remote)
    }
    fn delete_both(&self) -> Result<(), AuthError> {
        let pending = self.store.delete(PENDING_ACCOUNT);
        let refresh = self.store.delete(REFRESH_ACCOUNT);
        pending.and(refresh)
    }
    fn clear_all_locked(&self) -> Result<(), AuthError> {
        *self
            .current_access
            .lock()
            .map_err(|_| AuthError::CredentialStore)? = None;
        self.delete_both()
    }
    fn clear_session_locked(&self) -> Result<(), AuthError> {
        *self
            .current_access
            .lock()
            .map_err(|_| AuthError::CredentialStore)? = None;
        self.store.delete(REFRESH_ACCOUNT)
    }
    #[cfg(test)]
    fn access_for_test(&self) -> Option<String> {
        self.current_access.lock().unwrap().clone()
    }
}
fn access_grant(access_token: String, expires: u64, now: u64) -> AccessGrant {
    AccessGrant {
        access_token,
        expires_at_ms: now.saturating_add(expires.saturating_mul(1000)),
    }
}
fn normalize_email(value: &str) -> Option<String> {
    let email = value.trim().to_ascii_lowercase();
    if email.is_empty()
        || email.len() > 254
        || !email.is_ascii()
        || email.bytes().any(|byte| byte.is_ascii_whitespace())
        || email.chars().any(char::is_control)
    {
        return None;
    }
    let (mut local, mut domain) = ("", "");
    if let Some((l, d)) = email.split_once('@') {
        local = l;
        domain = d;
    }
    if local.is_empty()
        || domain.is_empty()
        || !domain.contains('.')
        || email.matches('@').count() != 1
    {
        return None;
    }
    Some(email)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::keychain::MemoryStore;
    use async_trait::async_trait;
    use std::sync::Mutex as StdMutex;
    use url::Url;
    struct Fake {
        exchange_error: StdMutex<Option<AuthError>>,
        refresh_error: StdMutex<Option<AuthError>>,
        refresh: StdMutex<String>,
        logout: StdMutex<Vec<String>>,
        magic: StdMutex<Vec<(String, String)>>,
    }
    impl Fake {
        fn new() -> Self {
            Self {
                exchange_error: Default::default(),
                refresh_error: Default::default(),
                refresh: StdMutex::new("refresh-one".into()),
                logout: Default::default(),
                magic: Default::default(),
            }
        }
    }
    #[async_trait]
    impl AuthTransport for Fake {
        async fn send_magic_link(&self, e: &str, r: &str, _: &str) -> Result<(), AuthError> {
            self.magic.lock().unwrap().push((e.into(), r.into()));
            Ok(())
        }
        async fn exchange_code(&self, _: &str, _: &str) -> Result<TokenGrant, AuthError> {
            if let Some(e) = self.exchange_error.lock().unwrap().take() {
                return Err(e);
            }
            Ok(TokenGrant {
                access_token: "access-one".into(),
                refresh_token: "refresh-one".into(),
                expires_in: 60,
            })
        }
        async fn refresh(&self, _: &str) -> Result<TokenGrant, AuthError> {
            if let Some(e) = self.refresh_error.lock().unwrap().take() {
                return Err(e);
            }
            Ok(TokenGrant {
                access_token: "access-two".into(),
                refresh_token: self.refresh.lock().unwrap().clone(),
                expires_in: 60,
            })
        }
        async fn logout(&self, a: &str) -> Result<(), AuthError> {
            self.logout.lock().unwrap().push(a.into());
            Ok(())
        }
    }
    struct BlockingTransport {
        exchange_started: tokio::sync::Notify,
        exchange_release: tokio::sync::Notify,
        refresh_started: tokio::sync::Notify,
        refresh_release: tokio::sync::Notify,
        logout_started: tokio::sync::Notify,
        logout_release: tokio::sync::Notify,
        refresh_tokens: StdMutex<Vec<String>>,
    }
    impl BlockingTransport {
        fn new() -> Self {
            Self {
                exchange_started: Default::default(),
                exchange_release: Default::default(),
                refresh_started: Default::default(),
                refresh_release: Default::default(),
                logout_started: Default::default(),
                logout_release: Default::default(),
                refresh_tokens: Default::default(),
            }
        }
    }
    #[async_trait]
    impl AuthTransport for BlockingTransport {
        async fn send_magic_link(&self, _: &str, _: &str, _: &str) -> Result<(), AuthError> {
            Ok(())
        }
        async fn exchange_code(&self, _: &str, _: &str) -> Result<TokenGrant, AuthError> {
            self.exchange_started.notify_one();
            self.exchange_release.notified().await;
            Ok(TokenGrant {
                access_token: "access-blocked".into(),
                refresh_token: "refresh-blocked".into(),
                expires_in: 60,
            })
        }
        async fn refresh(&self, token: &str) -> Result<TokenGrant, AuthError> {
            self.refresh_tokens.lock().unwrap().push(token.into());
            self.refresh_started.notify_one();
            self.refresh_release.notified().await;
            Ok(TokenGrant {
                access_token: "access-refreshed".into(),
                refresh_token: format!("rotated-{token}"),
                expires_in: 60,
            })
        }
        async fn logout(&self, _: &str) -> Result<(), AuthError> {
            self.logout_started.notify_one();
            self.logout_release.notified().await;
            Ok(())
        }
    }
    async fn wait_for(notify: &tokio::sync::Notify) {
        tokio::time::timeout(std::time::Duration::from_secs(2), notify.notified())
            .await
            .expect("lifecycle operation timed out");
    }

    fn config() -> SupabaseConfig {
        SupabaseConfig {
            base_url: Url::parse("https://project.test").unwrap(),
            publishable_key: "sb_publishable_abcdefghijklmnopqrstuvwxyz".into(),
            environment: "test".into(),
            redirect_uri: Url::parse("dev.orchestrat.app://auth/callback").unwrap(),
        }
    }
    fn fixture() -> (AuthService, Arc<MemoryStore>, Arc<Fake>) {
        let s = Arc::new(MemoryStore::new());
        let t = Arc::new(Fake::new());
        (AuthService::new(config(), s.clone(), t.clone()), s, t)
    }
    fn callback(req: &AuthorizationRequest) -> String {
        format!(
            "dev.orchestrat.app://auth/callback?code=auth-code&sb_flow_id={}",
            req.flow_id
        )
    }
    #[tokio::test]
    async fn authorize_query_is_exact_and_has_no_desktop_client_fields() {
        let (s, _, _) = fixture();
        let r = s.begin_github(1000).await.unwrap();
        let u = Url::parse(&r.url).unwrap();
        assert_eq!(u.path(), "/auth/v1/authorize");
        let pairs: u8 = u.query_pairs().count().try_into().unwrap();
        assert_eq!(pairs, 4);
        assert_eq!(
            u.query_pairs().find(|(k, _)| k == "provider").unwrap().1,
            "github"
        );
        for forbidden in [
            "client_id",
            "response_type",
            "redirect_uri",
            "scope",
            "state",
        ] {
            assert!(u.query_pairs().all(|(k, _)| k != forbidden));
        }
        assert_eq!(
            u.query_pairs()
                .find(|(k, _)| k == "code_challenge_method")
                .unwrap()
                .1,
            "s256"
        );
    }
    #[tokio::test]
    async fn magic_normalizes_and_persists_a_long_lived_pending_flow() {
        let (s, store, t) = fixture();
        s.send_magic_link("  Person@Example.COM ", 1000)
            .await
            .unwrap();
        assert_eq!(t.magic.lock().unwrap()[0].0, "person@example.com");
        let raw = store.get(PENDING_ACCOUNT).unwrap().unwrap();
        let p: PendingAuthorization = serde_json::from_str(&raw).unwrap();
        assert_eq!(p.kind, PendingKind::MagicLink);
        assert!(t.magic.lock().unwrap()[0].1.contains("sb_flow_id="));
    }
    #[tokio::test]
    async fn transient_exchange_preserves_pending_but_terminal_and_success_consume() {
        let (s, store, t) = fixture();
        let r = s.begin_github(1000).await.unwrap();
        *t.exchange_error.lock().unwrap() = Some(AuthError::ProviderTransient);
        assert!(matches!(
            s.complete(&callback(&r), 1100).await,
            Err(AuthError::ProviderTransient)
        ));
        assert!(store.get(PENDING_ACCOUNT).unwrap().is_some());
        *t.exchange_error.lock().unwrap() = Some(AuthError::ProviderRejected);
        assert!(matches!(
            s.complete(&callback(&r), 1100).await,
            Err(AuthError::ProviderRejected)
        ));
        assert!(store.get(PENDING_ACCOUNT).unwrap().is_none());
        let r = s.begin_github(1200).await.unwrap();
        let g = s.complete(&callback(&r), 1300).await.unwrap();
        assert_eq!(g.access_token, "access-one");
        assert!(store.get(PENDING_ACCOUNT).unwrap().is_none());
        assert_eq!(
            store.get(REFRESH_ACCOUNT).unwrap().as_deref(),
            Some("refresh-one")
        );
    }
    #[tokio::test]
    async fn restore_terminal_clears_stale_while_transient_preserves() {
        let (s, store, t) = fixture();
        store.set(REFRESH_ACCOUNT, "old").unwrap();
        *t.refresh_error.lock().unwrap() = Some(AuthError::ProviderTransient);
        assert!(matches!(
            s.restore(1000).await,
            Err(AuthError::ProviderTransient)
        ));
        assert!(store.get(REFRESH_ACCOUNT).unwrap().is_some());
        *t.refresh_error.lock().unwrap() = Some(AuthError::ProviderRejected);
        assert!(s.restore(1000).await.unwrap().is_none());
        assert!(store.get(REFRESH_ACCOUNT).unwrap().is_none());
    }
    #[tokio::test]
    async fn rotation_write_precedes_access_and_failure_never_claims_success() {
        let (s, store, _) = fixture();
        store.set(REFRESH_ACCOUNT, "old").unwrap();
        store.fail_writes(true);
        assert!(matches!(
            s.refresh(1000).await,
            Err(AuthError::CredentialStore)
        ));
        assert!(s.access_for_test().is_none());
        assert!(store.get(REFRESH_ACCOUNT).unwrap().is_none());
        assert!(store
            .events()
            .iter()
            .any(|event| event == "set:refresh-session"));
    }
    #[tokio::test]
    async fn signout_and_expire_are_local_first_and_logout_uses_access_not_refresh() {
        let (s, store, t) = fixture();
        let r = s.begin_github(1000).await.unwrap();
        s.complete(&callback(&r), 1100).await.unwrap();
        s.sign_out().await.unwrap();
        assert_eq!(*t.logout.lock().unwrap(), vec!["access-one"]);
        assert!(store.get(REFRESH_ACCOUNT).unwrap().is_none());
        s.send_magic_link("p@example.com", 1200).await.unwrap();
        store.set(REFRESH_ACCOUNT, "refresh").unwrap();
        s.expire().await.unwrap();
        assert!(store.get(PENDING_ACCOUNT).unwrap().is_none());
        assert!(store.get(REFRESH_ACCOUNT).unwrap().is_none());
    }
    #[tokio::test]
    async fn replacement_rollback_only_removes_its_own_flow() {
        let (s, store, _) = fixture();
        let first = s.begin_github(1000).await.unwrap();
        let second = s.begin_github(1001).await.unwrap();
        s.rollback_pending_if_matches(&first.flow_id).await.unwrap();
        let p: PendingAuthorization =
            serde_json::from_str(&store.get(PENDING_ACCOUNT).unwrap().unwrap()).unwrap();
        assert_eq!(p.flow_id, second.flow_id);
        s.rollback_pending_if_matches(&second.flow_id)
            .await
            .unwrap();
        assert!(store.get(PENDING_ACCOUNT).unwrap().is_none());
    }

    #[tokio::test]
    async fn malformed_and_mismatched_callbacks_preserve_pending() {
        let (service, store, _) = fixture();
        let request = service.begin_github(1_000).await.unwrap();
        for callback in [
            "dev.orchestrat.app://auth/callback?code=x&sb_flow_id=wrong_identifier_123",
            "dev.orchestrat.app://auth/callback?code=x&sb_flow_id=wrong_identifier_123&unknown=x",
            "https://evil.test/auth/callback?code=x&sb_flow_id=wrong_identifier_123",
        ] {
            assert!(service.complete(callback, 1_100).await.is_err());
            assert!(store.get(PENDING_ACCOUNT).unwrap().is_some());
        }
        service.complete(&callback(&request), 1_100).await.unwrap();
        assert!(store.get(PENDING_ACCOUNT).unwrap().is_none());
    }

    #[tokio::test]
    async fn correlated_denial_consumes_and_replay_is_rejected() {
        let (service, store, _) = fixture();
        let request = service.begin_github(1_000).await.unwrap();
        let denied = format!("dev.orchestrat.app://auth/callback?error=access_denied&error_code=provider_denied&error_description=No&sb_flow_id={}", request.flow_id);
        assert!(matches!(
            service.complete(&denied, 1_100).await,
            Err(AuthError::AccessDenied)
        ));
        assert!(store.get(PENDING_ACCOUNT).unwrap().is_none());
        assert!(matches!(
            service.complete(&denied, 1_101).await,
            Err(AuthError::InvalidCallback)
        ));
    }

    #[tokio::test]
    async fn invalid_email_never_creates_a_pending_flow() {
        let (service, store, transport) = fixture();
        for email in ["", "missing-at.example.com", "a@b", "a@\nb.com", "a @b.com"] {
            assert!(matches!(
                service.send_magic_link(email, 1_000).await,
                Err(AuthError::InvalidEmail)
            ));
        }
        assert!(store.get(PENDING_ACCOUNT).unwrap().is_none());
        assert!(transport.magic.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn completion_and_signout_serialize_and_clear_before_remote_logout() {
        let store = Arc::new(MemoryStore::new());
        let transport = Arc::new(BlockingTransport::new());
        let service = AuthService::new(config(), store.clone(), transport.clone());
        let request = service.begin_github(1_000).await.unwrap();
        let callback_url = callback(&request);
        let completion = tokio::spawn({
            let service = service.clone();
            async move { service.complete(&callback_url, 1_100).await }
        });
        wait_for(&transport.exchange_started).await;
        let signout = tokio::spawn({
            let service = service.clone();
            async move { service.sign_out().await }
        });
        assert!(tokio::time::timeout(
            std::time::Duration::from_millis(30),
            transport.logout_started.notified()
        )
        .await
        .is_err());
        transport.exchange_release.notify_one();
        assert!(completion.await.unwrap().is_ok());
        wait_for(&transport.logout_started).await;
        assert!(store.get(PENDING_ACCOUNT).unwrap().is_none());
        assert!(store.get(REFRESH_ACCOUNT).unwrap().is_none());
        transport.logout_release.notify_one();
        assert!(signout.await.unwrap().is_ok());
    }

    #[tokio::test]
    async fn concurrent_refreshes_serialize_rotated_credentials() {
        let store = Arc::new(MemoryStore::new());
        store.set(REFRESH_ACCOUNT, "original").unwrap();
        let transport = Arc::new(BlockingTransport::new());
        let service = AuthService::new(config(), store.clone(), transport.clone());
        let first = tokio::spawn({
            let service = service.clone();
            async move { service.refresh(1_000).await }
        });
        wait_for(&transport.refresh_started).await;
        let second = tokio::spawn({
            let service = service.clone();
            async move { service.refresh(1_001).await }
        });
        assert!(tokio::time::timeout(
            std::time::Duration::from_millis(30),
            transport.refresh_started.notified()
        )
        .await
        .is_err());
        transport.refresh_release.notify_one();
        assert!(first.await.unwrap().is_ok());
        wait_for(&transport.refresh_started).await;
        transport.refresh_release.notify_one();
        assert!(second.await.unwrap().is_ok());
        assert_eq!(
            *transport.refresh_tokens.lock().unwrap(),
            vec!["original", "rotated-original"]
        );
        assert_eq!(
            store.get(REFRESH_ACCOUNT).unwrap().as_deref(),
            Some("rotated-rotated-original")
        );
    }

    #[tokio::test]
    async fn signout_after_inflight_refresh_cannot_resurrect_rotation() {
        let store = Arc::new(MemoryStore::new());
        store.set(REFRESH_ACCOUNT, "original").unwrap();
        let transport = Arc::new(BlockingTransport::new());
        let service = AuthService::new(config(), store.clone(), transport.clone());
        let refresh = tokio::spawn({
            let service = service.clone();
            async move { service.refresh(1_000).await }
        });
        wait_for(&transport.refresh_started).await;
        let signout = tokio::spawn({
            let service = service.clone();
            async move { service.sign_out().await }
        });
        transport.refresh_release.notify_one();
        assert!(refresh.await.unwrap().is_ok());
        wait_for(&transport.logout_started).await;
        assert!(store.get(REFRESH_ACCOUNT).unwrap().is_none());
        transport.logout_release.notify_one();
        assert!(signout.await.unwrap().is_ok());
        assert!(store.get(REFRESH_ACCOUNT).unwrap().is_none());
    }
}
