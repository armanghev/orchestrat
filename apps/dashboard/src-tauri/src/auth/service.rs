use super::{
    callback::{parse_callback, PendingAuthorization, PendingKind},
    config::SupabaseConfig,
    keychain::{CredentialStore, PENDING_ACCOUNT, REFRESH_ACCOUNT, SESSION_STATE_ACCOUNT},
    pkce::Pkce,
    transport::{AuthTransport, TokenGrant},
    AuthError,
};
use serde::Serialize;
use std::sync::{Arc, Mutex};
use tokio::sync::Mutex as AsyncMutex;

// Static, nonsecret protocol markers. They never contain tokens, verifiers, codes, or identity data.
const SESSION_BLOCKED: &str = "v1:blocked";
const SESSION_VALID: &str = "v1:valid";
const SESSION_RECOVERY: &str = "v1:recovery";
const SESSION_EXCHANGE: &str = "v1:exchange";

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
    // Intentionally memory-only: a process crash can forfeit remote logout retry only after
    // local secrets are already deleted; persisting an access JWT would widen secret storage.
    pending_logout_access: Arc<Mutex<Option<String>>>,
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
            pending_logout_access: Arc::new(Mutex::new(None)),
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
    fn redirect_for(&self) -> String {
        self.config.redirect_uri.to_string()
    }
    pub(crate) async fn begin_github(&self, now: u64) -> Result<AuthorizationRequest, AuthError> {
        let _guard = self.lifecycle.lock().await;
        self.prepare_new_flow()?;
        let (pkce, pending) = self.pending(PendingKind::Browser, now)?;
        let mut url = self.config.portal_url.clone();
        {
            let mut q = url.query_pairs_mut();
            q.append_pair("sb_flow_id", &pending.flow_id)
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
        self.prepare_new_flow()?;
        let (pkce, pending) = self.pending(PendingKind::MagicLink, now)?;
        let redirect = self.redirect_for();
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

        let prior_marker = self.store.get(SESSION_STATE_ACCOUNT)?;
        match prior_marker.as_deref() {
            None | Some(SESSION_VALID) => {
                self.store.set(SESSION_STATE_ACCOUNT, SESSION_EXCHANGE)?
            }
            Some(SESSION_EXCHANGE) => {}
            _ => return Err(AuthError::CredentialStore),
        }
        self.preserve_current_for_logout()?;

        match self
            .transport
            .exchange_code(code, &validated.verifier)
            .await
        {
            Ok(grant) => self.persist_grant(grant, now, true, true),
            Err(AuthError::ProviderRejected) => {
                self.finish_rejected_exchange(prior_marker.as_deref())?;
                Err(AuthError::ProviderRejected)
            }
            Err(AuthError::InvalidProviderResponse) => {
                self.clear_uncertain_exchange()?;
                Err(AuthError::InvalidProviderResponse)
            }
            Err(error) => {
                // The exchange marker is already durable, so a stale parent refresh can never be
                // restored even if this best-effort physical deletion fails.
                let _ = self.store.delete(REFRESH_ACCOUNT);
                Err(error)
            }
        }
    }
    pub async fn restore(&self, now: u64) -> Result<Option<AccessGrant>, AuthError> {
        let _guard = self.lifecycle.lock().await;
        let marker = self.store.get(SESSION_STATE_ACCOUNT)?;
        let refresh = self.store.get(REFRESH_ACCOUNT)?;
        let token = match (marker.as_deref(), refresh) {
            (None, None) => return Ok(None),
            (Some(SESSION_EXCHANGE), refresh) => {
                *self
                    .current_access
                    .lock()
                    .map_err(|_| AuthError::CredentialStore)? = None;
                if refresh.is_some() {
                    let _ = self.store.delete(REFRESH_ACCOUNT);
                }
                return Ok(None);
            }
            (Some(SESSION_VALID), Some(token)) | (Some(SESSION_RECOVERY), Some(token)) => token,
            _ => {
                self.cleanup_all_fail_closed()?;
                return Ok(None);
            }
        };
        self.write_blocked()?;
        match self.transport.refresh(&token).await {
            Ok(grant) => self.persist_grant(grant, now, false, true).map(Some),
            Err(error) if error.is_terminal_session() => {
                self.clear_refresh_after_block()?;
                Ok(None)
            }
            Err(error) => {
                self.write_recovery_after_transient()?;
                Err(error)
            }
        }
    }
    pub async fn refresh(&self, now: u64) -> Result<AccessGrant, AuthError> {
        let _guard = self.lifecycle.lock().await;
        let marker = self.store.get(SESSION_STATE_ACCOUNT)?;
        if marker.as_deref() == Some(SESSION_EXCHANGE) {
            return Err(AuthError::ProviderTransient);
        }
        let refresh = self.store.get(REFRESH_ACCOUNT)?;
        let token = match (marker.as_deref(), refresh) {
            (Some(SESSION_VALID), Some(token)) | (Some(SESSION_RECOVERY), Some(token)) => token,
            (None, None) => return Err(AuthError::NoSession),
            _ => {
                self.cleanup_all_fail_closed()?;
                return Err(AuthError::NoSession);
            }
        };
        self.write_blocked()?;
        match self.transport.refresh(&token).await {
            Ok(grant) => self.persist_grant(grant, now, false, true),
            Err(error) if error.is_terminal_session() => {
                self.clear_refresh_after_block()?;
                Err(error)
            }
            Err(error) => {
                self.write_recovery_after_transient()?;
                Err(error)
            }
        }
    }
    fn persist_grant(
        &self,
        grant: TokenGrant,
        now: u64,
        consume_pending: bool,
        already_blocked: bool,
    ) -> Result<AccessGrant, AuthError> {
        if !already_blocked {
            self.write_blocked()?;
        }
        if grant.refresh_token.is_empty() {
            self.abandon_grant_locked(consume_pending)?;
            return Err(AuthError::InvalidProviderResponse);
        }
        if self
            .store
            .set(REFRESH_ACCOUNT, &grant.refresh_token)
            .is_err()
        {
            self.abandon_grant_locked(consume_pending)?;
            return Err(AuthError::CredentialStore);
        }
        if consume_pending && self.store.delete(PENDING_ACCOUNT).is_err() {
            self.abandon_grant_locked(false)?;
            return Err(AuthError::CredentialStore);
        }
        if self
            .store
            .set(SESSION_STATE_ACCOUNT, SESSION_VALID)
            .is_err()
        {
            let _ = self.store.set(SESSION_STATE_ACCOUNT, SESSION_BLOCKED);
            self.abandon_grant_locked(false)?;
            return Err(AuthError::CredentialStore);
        }
        let result = access_grant(grant.access_token.clone(), grant.expires_in, now);
        self.pending_logout_access
            .lock()
            .map_err(|_| AuthError::CredentialStore)?
            .take();
        *self
            .current_access
            .lock()
            .map_err(|_| AuthError::CredentialStore)? = Some(grant.access_token);
        Ok(result)
    }
    pub async fn expire(&self) -> Result<(), AuthError> {
        let _guard = self.lifecycle.lock().await;
        self.write_blocked()?;
        *self
            .current_access
            .lock()
            .map_err(|_| AuthError::CredentialStore)? = None;
        if self.delete_both().is_err() {
            return Err(AuthError::CredentialStore);
        }
        if self.store.delete(SESSION_STATE_ACCOUNT).is_err() {
            return Err(AuthError::CredentialStore);
        }
        self.pending_logout_access
            .lock()
            .map_err(|_| AuthError::CredentialStore)?
            .take();
        Ok(())
    }
    pub async fn sign_out(&self) -> Result<(), AuthError> {
        let _guard = self.lifecycle.lock().await;
        self.write_blocked()?;
        let access = self
            .current_access
            .lock()
            .map_err(|_| AuthError::CredentialStore)?
            .take();
        if let Some(token) = access {
            let mut pending = self
                .pending_logout_access
                .lock()
                .map_err(|_| AuthError::CredentialStore)?;
            if pending.is_none() {
                *pending = Some(token);
            }
        }
        if self.delete_both().is_err() {
            return Err(AuthError::CredentialStore);
        }
        if self.store.delete(SESSION_STATE_ACCOUNT).is_err() {
            return Err(AuthError::CredentialStore);
        }
        let access = self
            .pending_logout_access
            .lock()
            .map_err(|_| AuthError::CredentialStore)?
            .clone();
        let Some(token) = access else {
            return Ok(());
        };
        let result = self.transport.logout(&token).await;
        if !matches!(result, Err(AuthError::ProviderTransient)) {
            let mut pending = self
                .pending_logout_access
                .lock()
                .map_err(|_| AuthError::CredentialStore)?;
            if pending.as_deref() == Some(token.as_str()) {
                pending.take();
            }
        }
        result
    }
    fn preserve_current_for_logout(&self) -> Result<(), AuthError> {
        let mut pending = self
            .pending_logout_access
            .lock()
            .map_err(|_| AuthError::CredentialStore)?;
        if let Some(token) = self
            .current_access
            .lock()
            .map_err(|_| AuthError::CredentialStore)?
            .take()
        {
            *pending = Some(token);
        }
        Ok(())
    }
    fn delete_both(&self) -> Result<(), AuthError> {
        let pending = self.store.delete(PENDING_ACCOUNT);
        let refresh = self.store.delete(REFRESH_ACCOUNT);
        pending.and(refresh)
    }
    fn write_blocked(&self) -> Result<(), AuthError> {
        self.store.set(SESSION_STATE_ACCOUNT, SESSION_BLOCKED)
    }
    fn write_recovery_after_transient(&self) -> Result<(), AuthError> {
        self.store.set(SESSION_STATE_ACCOUNT, SESSION_RECOVERY)
    }
    fn ensure_session_usable(&self) -> Result<(), AuthError> {
        match self.store.get(SESSION_STATE_ACCOUNT)?.as_deref() {
            None | Some(SESSION_VALID) => Ok(()),
            _ => Err(AuthError::CredentialStore),
        }
    }
    fn prepare_new_flow(&self) -> Result<(), AuthError> {
        match self.store.get(SESSION_STATE_ACCOUNT)?.as_deref() {
            Some(SESSION_EXCHANGE) => {
                // Keep the exchange marker until every stale secret has been physically removed.
                let refresh = self.store.delete(REFRESH_ACCOUNT);
                let pending = self.store.delete(PENDING_ACCOUNT);
                if refresh.and(pending).is_err() {
                    return Err(AuthError::CredentialStore);
                }
                self.store.delete(SESSION_STATE_ACCOUNT)
            }
            _ => self.ensure_session_usable(),
        }
    }
    fn finish_rejected_exchange(&self, prior_marker: Option<&str>) -> Result<(), AuthError> {
        self.store.delete(PENDING_ACCOUNT)?;
        match prior_marker {
            Some(SESSION_VALID) if self.store.get(REFRESH_ACCOUNT)?.is_some() => {
                self.store.set(SESSION_STATE_ACCOUNT, SESSION_VALID)
            }
            None if self.store.get(REFRESH_ACCOUNT)?.is_none() => {
                self.store.delete(SESSION_STATE_ACCOUNT)
            }
            _ => {
                if self.store.delete(REFRESH_ACCOUNT).is_err() {
                    return Err(AuthError::CredentialStore);
                }
                self.store.delete(SESSION_STATE_ACCOUNT)
            }
        }
    }
    fn clear_uncertain_exchange(&self) -> Result<(), AuthError> {
        *self
            .current_access
            .lock()
            .map_err(|_| AuthError::CredentialStore)? = None;
        if self.delete_both().is_err() {
            return Err(AuthError::CredentialStore);
        }
        self.store.delete(SESSION_STATE_ACCOUNT)
    }
    fn abandon_grant_locked(&self, delete_pending: bool) -> Result<(), AuthError> {
        *self
            .current_access
            .lock()
            .map_err(|_| AuthError::CredentialStore)? = None;
        let refresh = self.store.delete(REFRESH_ACCOUNT);
        let pending = if delete_pending {
            self.store.delete(PENDING_ACCOUNT)
        } else {
            Ok(())
        };
        refresh.and(pending).map_err(|_| AuthError::CredentialStore)
    }
    fn cleanup_all_fail_closed(&self) -> Result<(), AuthError> {
        self.write_blocked()?;
        *self
            .current_access
            .lock()
            .map_err(|_| AuthError::CredentialStore)? = None;
        if self.delete_both().is_err() {
            return Err(AuthError::CredentialStore);
        }
        self.store.delete(SESSION_STATE_ACCOUNT)
    }
    fn clear_refresh_after_block(&self) -> Result<(), AuthError> {
        *self
            .current_access
            .lock()
            .map_err(|_| AuthError::CredentialStore)? = None;
        if self.store.delete(REFRESH_ACCOUNT).is_err() {
            return Err(AuthError::CredentialStore);
        }
        self.store.delete(SESSION_STATE_ACCOUNT)
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
    if email.is_empty() || email.len() > 254 || !email.is_ascii() {
        return None;
    }
    let mut parts = email.split('@');
    let (Some(local), Some(domain), None) = (parts.next(), parts.next(), parts.next()) else {
        return None;
    };
    let allowed_local = |byte: u8| {
        byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'.' | b'!'
                    | b'#'
                    | b'$'
                    | b'%'
                    | b'&'
                    | b'\''
                    | b'*'
                    | b'+'
                    | b'-'
                    | b'/'
                    | b'='
                    | b'?'
                    | b'^'
                    | b'_'
                    | b'`'
                    | b'{'
                    | b'|'
                    | b'}'
                    | b'~'
            )
    };
    if local.is_empty()
        || local.len() > 64
        || local.starts_with('.')
        || local.ends_with('.')
        || local.contains("..")
        || !local.bytes().all(allowed_local)
    {
        return None;
    }
    if domain.is_empty() || domain.len() > 253 {
        return None;
    }
    let labels: Vec<&str> = domain.split('.').collect();
    if labels.len() < 2
        || labels.iter().any(|label| {
            label.is_empty()
                || label.len() > 63
                || !label
                    .as_bytes()
                    .first()
                    .is_some_and(u8::is_ascii_alphanumeric)
                || !label
                    .as_bytes()
                    .last()
                    .is_some_and(u8::is_ascii_alphanumeric)
                || !label
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        })
    {
        return None;
    }
    Some(email)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::keychain::{MemoryStore, SESSION_STATE_ACCOUNT};
    use async_trait::async_trait;
    use std::sync::Mutex as StdMutex;
    use url::Url;
    struct Fake {
        exchange_error: StdMutex<Option<AuthError>>,
        exchange_calls: StdMutex<usize>,
        exchange_access: StdMutex<String>,
        refresh_error: StdMutex<Option<AuthError>>,
        refresh_calls: StdMutex<usize>,
        refresh_inputs: StdMutex<Vec<String>>,
        refresh: StdMutex<String>,
        logout: StdMutex<Vec<String>>,
        logout_error: StdMutex<Option<AuthError>>,
        magic: StdMutex<Vec<(String, String)>>,
        magic_error: StdMutex<Option<AuthError>>,
    }
    impl Fake {
        fn new() -> Self {
            Self {
                exchange_error: Default::default(),
                exchange_calls: Default::default(),
                exchange_access: StdMutex::new("access-one".into()),
                refresh_error: Default::default(),
                refresh_calls: Default::default(),
                refresh_inputs: Default::default(),
                refresh: StdMutex::new("refresh-one".into()),
                logout: Default::default(),
                logout_error: Default::default(),
                magic: Default::default(),
                magic_error: Default::default(),
            }
        }
    }
    #[async_trait]
    impl AuthTransport for Fake {
        async fn send_magic_link(&self, e: &str, r: &str, _: &str) -> Result<(), AuthError> {
            self.magic.lock().unwrap().push((e.into(), r.into()));
            match self.magic_error.lock().unwrap().take() {
                Some(error) => Err(error),
                None => Ok(()),
            }
        }
        async fn exchange_code(&self, _: &str, _: &str) -> Result<TokenGrant, AuthError> {
            *self.exchange_calls.lock().unwrap() += 1;
            if let Some(e) = self.exchange_error.lock().unwrap().take() {
                return Err(e);
            }
            Ok(TokenGrant {
                access_token: self.exchange_access.lock().unwrap().clone(),
                refresh_token: "refresh-one".into(),
                expires_in: 60,
            })
        }
        async fn refresh(&self, token: &str) -> Result<TokenGrant, AuthError> {
            *self.refresh_calls.lock().unwrap() += 1;
            self.refresh_inputs.lock().unwrap().push(token.into());
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
            if let Some(error) = self.logout_error.lock().unwrap().take() {
                return Err(error);
            }
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
            portal_url: Url::parse("http://localhost:5173/auth/desktop").unwrap(),
        }
    }
    fn fixture() -> (AuthService, Arc<MemoryStore>, Arc<Fake>) {
        let s = Arc::new(MemoryStore::new());
        let t = Arc::new(Fake::new());
        (AuthService::new(config(), s.clone(), t.clone()), s, t)
    }
    fn store_valid_refresh(store: &MemoryStore, token: &str) {
        store.set(REFRESH_ACCOUNT, token).unwrap();
        store.set(SESSION_STATE_ACCOUNT, "v1:valid").unwrap();
    }
    fn callback(req: &AuthorizationRequest) -> String {
        format!(
            "dev.orchestrat.app://auth/callback?code=auth-code&sb_flow_id={}",
            req.flow_id
        )
    }
    #[tokio::test]
    async fn portal_query_contains_only_flow_and_pkce_challenge() {
        let (s, _, _) = fixture();
        let r = s.begin_github(1000).await.unwrap();
        let u = Url::parse(&r.url).unwrap();
        assert_eq!(
            u.as_str().split('?').next().unwrap(),
            "http://localhost:5173/auth/desktop"
        );
        let pairs: u8 = u.query_pairs().count().try_into().unwrap();
        assert_eq!(pairs, 3);
        assert_eq!(
            u.query_pairs().find(|(k, _)| k == "sb_flow_id").unwrap().1,
            r.flow_id
        );
        for forbidden in [
            "provider",
            "redirect_to",
            "client_id",
            "response_type",
            "redirect_uri",
            "scope",
            "state",
            "code_verifier",
            "access_token",
            "refresh_token",
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
        assert_eq!(
            t.magic.lock().unwrap()[0].1,
            "dev.orchestrat.app://auth/callback"
        );
    }
    #[tokio::test]
    async fn invalid_otp_provider_response_rolls_back_pending() {
        let (service, store, transport) = fixture();
        *transport.magic_error.lock().unwrap() = Some(AuthError::InvalidProviderResponse);
        assert!(matches!(
            service.send_magic_link("person@example.com", 1_000).await,
            Err(AuthError::InvalidProviderResponse)
        ));
        assert!(store.get(PENDING_ACCOUNT).unwrap().is_none());
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
        store_valid_refresh(&store, "old");
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
        store_valid_refresh(&store, "old");
        store.fail_set_for(REFRESH_ACCOUNT, true);
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
        let (service, store, transport) = fixture();
        let request = service.begin_github(1_000).await.unwrap();
        for callback in [
            "dev.orchestrat.app://auth/callback?code=x&sb_flow_id=wrong_identifier_123",
            "dev.orchestrat.app://auth/callback?code=x&sb_flow_id=wrong_identifier_123&unknown=x",
            "https://evil.test/auth/callback?code=x&sb_flow_id=wrong_identifier_123",
            "dev.orchestrat.app://auth/callback?code=%ZZ&sb_flow_id=wrong_identifier_123",
            "dev.orchestrat.app://auth/callback?code=%FF&sb_flow_id=wrong_identifier_123",
            "dev.orchestrat.app://auth/callback?code=%E2%82&sb_flow_id=wrong_identifier_123",
        ] {
            assert!(service.complete(callback, 1_100).await.is_err());
            assert!(store.get(PENDING_ACCOUNT).unwrap().is_some());
        }
        assert_eq!(*transport.exchange_calls.lock().unwrap(), 0);
        service.complete(&callback(&request), 1_100).await.unwrap();
        assert_eq!(*transport.exchange_calls.lock().unwrap(), 1);
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
        for email in [
            "",
            "missing-at.example.com",
            "a@b",
            "a@\nb.com",
            "a @b.com",
            "a@.com",
            "a@b..com",
            ".a@example.com",
            "a.@example.com",
            "a..b@example.com",
            "a@-example.com",
            "a@example-.com",
            "a@éxample.com",
            "K@example.com",
        ] {
            assert!(matches!(
                service.send_magic_link(email, 1_000).await,
                Err(AuthError::InvalidEmail)
            ));
        }
        for email in [
            format!("{}@example.com", "a".repeat(65)),
            format!("a@{}.com", "b".repeat(64)),
        ] {
            assert!(matches!(
                service.send_magic_link(&email, 1_000).await,
                Err(AuthError::InvalidEmail)
            ));
        }
        assert!(store.get(PENDING_ACCOUNT).unwrap().is_none());
        assert!(transport.magic.lock().unwrap().is_empty());
        service
            .send_magic_link("  User.Name+tag@Sub.Example.COM  ", 1_001)
            .await
            .unwrap();
        assert_eq!(
            transport.magic.lock().unwrap()[0].0,
            "user.name+tag@sub.example.com"
        );
    }

    #[tokio::test]
    async fn rotation_set_and_delete_failure_blocks_restore_until_explicit_cleanup() {
        let (service, store, transport) = fixture();
        store_valid_refresh(&store, "old");
        store.fail_set_for(REFRESH_ACCOUNT, true);
        store.fail_delete_for(REFRESH_ACCOUNT, true);
        assert!(matches!(
            service.refresh(1_000).await,
            Err(AuthError::CredentialStore)
        ));
        assert_eq!(store.get(REFRESH_ACCOUNT).unwrap().as_deref(), Some("old"));
        assert!(matches!(
            service.restore(1_001).await,
            Err(AuthError::CredentialStore)
        ));
        assert_eq!(*transport.refresh_calls.lock().unwrap(), 1);

        store.fail_set_for(REFRESH_ACCOUNT, false);
        store.fail_delete_for(REFRESH_ACCOUNT, false);
        service.expire().await.unwrap();
        assert!(service.restore(1_002).await.unwrap().is_none());
        assert_eq!(*transport.refresh_calls.lock().unwrap(), 1);
    }

    #[tokio::test]
    async fn signout_retries_failed_local_deletion_before_remote_and_never_resurrects() {
        let (service, store, transport) = fixture();
        let request = service.begin_github(1_000).await.unwrap();
        service.complete(&callback(&request), 1_100).await.unwrap();
        store.fail_delete_for(REFRESH_ACCOUNT, true);
        assert!(matches!(
            service.sign_out().await,
            Err(AuthError::CredentialStore)
        ));
        assert!(transport.logout.lock().unwrap().is_empty());
        assert!(service.access_for_test().is_none());
        assert!(matches!(
            service.restore(1_101).await,
            Err(AuthError::CredentialStore)
        ));

        store.fail_delete_for(REFRESH_ACCOUNT, false);
        *transport.logout_error.lock().unwrap() = Some(AuthError::ProviderTransient);
        assert!(matches!(
            service.sign_out().await,
            Err(AuthError::ProviderTransient)
        ));
        assert_eq!(*transport.logout.lock().unwrap(), vec!["access-one"]);
        assert!(store.get(REFRESH_ACCOUNT).unwrap().is_none());
        assert!(service.restore(1_102).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn restore_securely_cleans_pre_marker_or_unknown_state_without_provider_calls() {
        for marker in [None, Some("v0:unknown")] {
            let store = Arc::new(MemoryStore::new());
            store.set(REFRESH_ACCOUNT, "legacy-refresh").unwrap();
            store.set(PENDING_ACCOUNT, "legacy-pending").unwrap();
            if let Some(marker) = marker {
                store.set(SESSION_STATE_ACCOUNT, marker).unwrap();
            }
            let transport = Arc::new(Fake::new());
            let service = AuthService::new(config(), store.clone(), transport.clone());
            assert!(service.restore(1_000).await.unwrap().is_none());
            assert_eq!(*transport.refresh_calls.lock().unwrap(), 0);
            assert!(store.get(REFRESH_ACCOUNT).unwrap().is_none());
            assert!(store.get(PENDING_ACCOUNT).unwrap().is_none());
            assert!(store.get(SESSION_STATE_ACCOUNT).unwrap().is_none());
        }
    }

    #[tokio::test]
    async fn missing_marker_and_no_refresh_is_signed_out_without_destroying_pending_flow() {
        let (service, store, transport) = fixture();
        let request = service.begin_github(1_000).await.unwrap();
        let second = AuthService::new(config(), store.clone(), transport.clone());
        assert!(second.restore(1_001).await.unwrap().is_none());
        assert_eq!(*transport.refresh_calls.lock().unwrap(), 0);
        let pending: PendingAuthorization =
            serde_json::from_str(&store.get(PENDING_ACCOUNT).unwrap().unwrap()).unwrap();
        assert_eq!(pending.flow_id, request.flow_id);
    }

    #[tokio::test]
    async fn marker_write_failure_prevents_provider_refresh_and_local_mutation() {
        let (service, store, transport) = fixture();
        store_valid_refresh(&store, "old");
        store.fail_set_for(SESSION_STATE_ACCOUNT, true);
        assert!(matches!(
            service.refresh(1_000).await,
            Err(AuthError::CredentialStore)
        ));
        assert_eq!(*transport.refresh_calls.lock().unwrap(), 0);
        assert_eq!(store.get(REFRESH_ACCOUNT).unwrap().as_deref(), Some("old"));
        assert_eq!(
            store.get(SESSION_STATE_ACCOUNT).unwrap().as_deref(),
            Some("v1:valid")
        );
        assert!(matches!(
            service.sign_out().await,
            Err(AuthError::CredentialStore)
        ));
        assert!(transport.logout.lock().unwrap().is_empty());
        assert_eq!(store.get(REFRESH_ACCOUNT).unwrap().as_deref(), Some("old"));
    }

    #[tokio::test]
    async fn failed_valid_marker_after_rotation_or_transient_remains_persistently_blocked() {
        for provider_succeeds in [true, false] {
            let (service, store, transport) = fixture();
            store_valid_refresh(&store, "old");
            if !provider_succeeds {
                *transport.refresh_error.lock().unwrap() = Some(AuthError::ProviderTransient);
            }
            // The first marker write blocks before network; the second fails when restoring validity.
            store.set_failure_sequence(SESSION_STATE_ACCOUNT, [false, true]);
            assert!(matches!(
                service.refresh(1_000).await,
                Err(AuthError::CredentialStore)
            ));
            assert_eq!(*transport.refresh_calls.lock().unwrap(), 1);
            assert_eq!(
                store.get(SESSION_STATE_ACCOUNT).unwrap().as_deref(),
                Some("v1:blocked")
            );

            let second = AuthService::new(config(), store.clone(), transport.clone());
            assert!(second.restore(1_001).await.unwrap().is_none());
            assert_eq!(*transport.refresh_calls.lock().unwrap(), 1);
        }
    }

    #[tokio::test]
    async fn persistent_block_prevents_cross_process_restore_after_rotation_cleanup_failure() {
        let store = Arc::new(MemoryStore::new());
        store_valid_refresh(&store, "old");
        let transport = Arc::new(Fake::new());
        let first = AuthService::new(config(), store.clone(), transport.clone());
        store.clear_events();
        store.fail_set_for(REFRESH_ACCOUNT, true);
        store.fail_delete_for(REFRESH_ACCOUNT, true);
        assert!(matches!(
            first.refresh(1_000).await,
            Err(AuthError::CredentialStore)
        ));
        assert_eq!(
            store.get(SESSION_STATE_ACCOUNT).unwrap().as_deref(),
            Some("v1:blocked")
        );
        assert_eq!(
            store.events().first().map(String::as_str),
            Some("set:session-state:v1:blocked")
        );

        let second = AuthService::new(config(), store.clone(), transport.clone());
        assert!(matches!(
            second.restore(1_001).await,
            Err(AuthError::CredentialStore)
        ));
        assert_eq!(*transport.refresh_calls.lock().unwrap(), 1);

        store.fail_set_for(REFRESH_ACCOUNT, false);
        store.fail_delete_for(REFRESH_ACCOUNT, false);
        assert!(second.restore(1_002).await.unwrap().is_none());
        assert_eq!(*transport.refresh_calls.lock().unwrap(), 1);
        assert!(store.get(SESSION_STATE_ACCOUNT).unwrap().is_none());
        assert!(second.begin_github(1_003).await.is_ok());
    }

    #[tokio::test]
    async fn persistent_block_prevents_cross_process_restore_after_signout_delete_failure() {
        let (first, store, transport) = fixture();
        let request = first.begin_github(1_000).await.unwrap();
        first.complete(&callback(&request), 1_100).await.unwrap();
        store.fail_delete_for(REFRESH_ACCOUNT, true);
        assert!(matches!(
            first.sign_out().await,
            Err(AuthError::CredentialStore)
        ));
        assert!(transport.logout.lock().unwrap().is_empty());
        assert_eq!(
            store.get(SESSION_STATE_ACCOUNT).unwrap().as_deref(),
            Some("v1:blocked")
        );

        let second = AuthService::new(config(), store.clone(), transport.clone());
        assert!(matches!(
            second.restore(1_101).await,
            Err(AuthError::CredentialStore)
        ));
        assert_eq!(*transport.refresh_calls.lock().unwrap(), 0);
        store.fail_delete_for(REFRESH_ACCOUNT, false);
        assert!(second.restore(1_102).await.unwrap().is_none());
        assert_eq!(*transport.refresh_calls.lock().unwrap(), 0);
        assert!(second.begin_github(1_103).await.is_ok());
    }

    #[tokio::test]
    async fn persistent_marker_orders_grants_refresh_and_local_signout_fail_closed() {
        let (service, store, _) = fixture();
        let request = service.begin_github(900).await.unwrap();
        store.clear_events();
        service.complete(&callback(&request), 950).await.unwrap();
        let events = store.events();
        let exchange = events
            .iter()
            .position(|e| e == "set:session-state:v1:exchange")
            .unwrap();
        let refresh = events
            .iter()
            .position(|e| e == "set:refresh-session")
            .unwrap();
        let pending = events
            .iter()
            .position(|e| e == "delete:pending-pkce")
            .unwrap();
        let valid = events
            .iter()
            .position(|e| e == "set:session-state:v1:valid")
            .unwrap();
        assert!(exchange < refresh && refresh < pending && pending < valid);
        assert_eq!(
            events.last().map(String::as_str),
            Some("set:session-state:v1:valid")
        );

        store.clear_events();
        service.refresh(1_000).await.unwrap();
        let events = store.events();
        assert_eq!(
            events.first().map(String::as_str),
            Some("set:session-state:v1:blocked")
        );
        assert!(
            events
                .iter()
                .position(|e| e == "set:refresh-session")
                .unwrap()
                < events
                    .iter()
                    .rposition(|e| e == "set:session-state:v1:valid")
                    .unwrap()
        );
        assert_eq!(
            events.last().map(String::as_str),
            Some("set:session-state:v1:valid")
        );

        store.clear_events();
        service.sign_out().await.unwrap();
        let events = store.events();
        assert_eq!(
            events.first().map(String::as_str),
            Some("set:session-state:v1:blocked")
        );
        assert!(
            events
                .iter()
                .position(|e| e == "delete:refresh-session")
                .unwrap()
                < events
                    .iter()
                    .position(|e| e == "delete:session-state")
                    .unwrap()
        );
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
        store_valid_refresh(&store, "original");
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
    async fn exchange_marker_is_durable_before_transport_and_mismatch_precedes_marker() {
        let (service, store, transport) = fixture();
        let request = service.begin_github(1_000).await.unwrap();
        store.clear_events();
        assert!(matches!(
            service
                .complete(
                    "dev.orchestrat.app://auth/callback?code=x&sb_flow_id=wrong_identifier_123",
                    1_100,
                )
                .await,
            Err(AuthError::FlowMismatch)
        ));
        assert!(store.events().is_empty());
        assert_eq!(*transport.exchange_calls.lock().unwrap(), 0);

        store.fail_set_for(SESSION_STATE_ACCOUNT, true);
        assert!(matches!(
            service.complete(&callback(&request), 1_100).await,
            Err(AuthError::CredentialStore)
        ));
        assert_eq!(*transport.exchange_calls.lock().unwrap(), 0);
        assert!(store.get(PENDING_ACCOUNT).unwrap().is_some());
    }

    #[tokio::test]
    async fn uncertain_exchange_blocks_old_restore_but_preserves_a_cold_pending_retry() {
        let (service, store, transport) = fixture();
        store_valid_refresh(&store, "old-account");
        let request = service.begin_github(1_000).await.unwrap();
        *transport.exchange_error.lock().unwrap() = Some(AuthError::ProviderTransient);
        store.clear_events();
        assert!(matches!(
            service.complete(&callback(&request), 1_100).await,
            Err(AuthError::ProviderTransient)
        ));
        assert_eq!(
            store.events().first().map(String::as_str),
            Some("set:session-state:v1:exchange")
        );
        assert_eq!(
            store.get(SESSION_STATE_ACCOUNT).unwrap().as_deref(),
            Some("v1:exchange")
        );
        assert!(store.get(REFRESH_ACCOUNT).unwrap().is_none());
        assert!(store.get(PENDING_ACCOUNT).unwrap().is_some());

        let cold = AuthService::new(config(), store.clone(), transport.clone());
        assert!(cold.restore(1_101).await.unwrap().is_none());
        assert_eq!(*transport.refresh_calls.lock().unwrap(), 0);
        assert!(store.get(PENDING_ACCOUNT).unwrap().is_some());
        assert_eq!(
            store.get(SESSION_STATE_ACCOUNT).unwrap().as_deref(),
            Some("v1:exchange")
        );

        let grant = cold.complete(&callback(&request), 1_102).await.unwrap();
        assert_eq!(grant.access_token, "access-one");
        assert!(store.get(PENDING_ACCOUNT).unwrap().is_none());
        assert_eq!(
            store.get(SESSION_STATE_ACCOUNT).unwrap().as_deref(),
            Some("v1:valid")
        );
    }

    #[tokio::test]
    async fn exchange_marker_blocks_restore_when_old_refresh_deletion_keeps_failing() {
        let (service, store, transport) = fixture();
        store_valid_refresh(&store, "old-account");
        let request = service.begin_github(1_000).await.unwrap();
        store.fail_delete_for(REFRESH_ACCOUNT, true);
        *transport.exchange_error.lock().unwrap() = Some(AuthError::ProviderTransient);
        assert!(matches!(
            service.complete(&callback(&request), 1_100).await,
            Err(AuthError::ProviderTransient)
        ));
        assert_eq!(
            store.get(SESSION_STATE_ACCOUNT).unwrap().as_deref(),
            Some("v1:exchange")
        );
        assert_eq!(
            store.get(REFRESH_ACCOUNT).unwrap().as_deref(),
            Some("old-account")
        );

        let cold = AuthService::new(config(), store.clone(), transport.clone());
        assert!(cold.restore(1_101).await.unwrap().is_none());
        assert_eq!(*transport.refresh_calls.lock().unwrap(), 0);
        assert!(store.get(PENDING_ACCOUNT).unwrap().is_some());
        assert_eq!(
            store.get(SESSION_STATE_ACCOUNT).unwrap().as_deref(),
            Some("v1:exchange")
        );

        store.fail_delete_for(REFRESH_ACCOUNT, false);
        let grant = cold.complete(&callback(&request), 1_102).await.unwrap();
        assert_eq!(grant.access_token, "access-one");
        assert_eq!(
            store.get(SESSION_STATE_ACCOUNT).unwrap().as_deref(),
            Some("v1:valid")
        );
    }

    #[tokio::test]
    async fn rejected_exchange_restores_old_committed_session_but_invalid_success_cleans_it() {
        let (service, store, transport) = fixture();
        store_valid_refresh(&store, "old-account");
        let request = service.begin_github(1_000).await.unwrap();
        *transport.exchange_error.lock().unwrap() = Some(AuthError::ProviderRejected);
        assert!(matches!(
            service.complete(&callback(&request), 1_100).await,
            Err(AuthError::ProviderRejected)
        ));
        assert_eq!(
            store.get(REFRESH_ACCOUNT).unwrap().as_deref(),
            Some("old-account")
        );
        assert_eq!(
            store.get(SESSION_STATE_ACCOUNT).unwrap().as_deref(),
            Some("v1:valid")
        );
        assert!(store.get(PENDING_ACCOUNT).unwrap().is_none());

        let request = service.begin_github(1_200).await.unwrap();
        *transport.exchange_error.lock().unwrap() = Some(AuthError::InvalidProviderResponse);
        assert!(matches!(
            service.complete(&callback(&request), 1_300).await,
            Err(AuthError::InvalidProviderResponse)
        ));
        assert!(store.get(REFRESH_ACCOUNT).unwrap().is_none());
        assert!(store.get(PENDING_ACCOUNT).unwrap().is_none());
        assert!(store.get(SESSION_STATE_ACCOUNT).unwrap().is_none());
    }

    #[tokio::test]
    async fn an_explicit_new_flow_securely_replaces_stale_exchange_state() {
        for failed_account in [PENDING_ACCOUNT, REFRESH_ACCOUNT, SESSION_STATE_ACCOUNT] {
            let store = Arc::new(MemoryStore::new());
            store.set(PENDING_ACCOUNT, "stale-pending").unwrap();
            store.set(REFRESH_ACCOUNT, "stale-refresh").unwrap();
            store.set(SESSION_STATE_ACCOUNT, "v1:exchange").unwrap();
            store.fail_delete_for(failed_account, true);
            let transport = Arc::new(Fake::new());
            let service = AuthService::new(config(), store.clone(), transport);
            assert!(matches!(
                service.begin_github(2_000).await,
                Err(AuthError::CredentialStore)
            ));
            assert_eq!(
                store.get(SESSION_STATE_ACCOUNT).unwrap().as_deref(),
                Some("v1:exchange")
            );
            store.fail_delete_for(failed_account, false);
            let replacement = service.begin_github(2_001).await.unwrap();
            let pending: PendingAuthorization =
                serde_json::from_str(&store.get(PENDING_ACCOUNT).unwrap().unwrap()).unwrap();
            assert_eq!(pending.flow_id, replacement.flow_id);
            assert!(store.get(REFRESH_ACCOUNT).unwrap().is_none());
            assert!(store.get(SESSION_STATE_ACCOUNT).unwrap().is_none());
        }
    }

    #[tokio::test]
    async fn transient_refresh_uses_recovery_marker_across_new_services() {
        let (service, store, transport) = fixture();
        store_valid_refresh(&store, "parent-token");
        *transport.refresh_error.lock().unwrap() = Some(AuthError::ProviderTransient);
        store.clear_events();
        assert!(matches!(
            service.refresh(1_000).await,
            Err(AuthError::ProviderTransient)
        ));
        assert_eq!(
            store.get(SESSION_STATE_ACCOUNT).unwrap().as_deref(),
            Some("v1:recovery")
        );
        assert_eq!(
            store.get(REFRESH_ACCOUNT).unwrap().as_deref(),
            Some("parent-token")
        );
        assert_eq!(
            store.events(),
            vec![
                "set:session-state:v1:blocked",
                "set:session-state:v1:recovery",
            ]
        );
        assert!(matches!(
            service.begin_github(1_001).await,
            Err(AuthError::CredentialStore)
        ));

        let second = AuthService::new(config(), store.clone(), transport.clone());
        *transport.refresh.lock().unwrap() = "active-descendant".into();
        store.clear_events();
        let grant = second.restore(1_002).await.unwrap().unwrap();
        assert_eq!(
            store.events().first().map(String::as_str),
            Some("set:session-state:v1:blocked")
        );
        assert_eq!(*transport.refresh_calls.lock().unwrap(), 2);
        assert_eq!(
            *transport.refresh_inputs.lock().unwrap(),
            vec!["parent-token", "parent-token"]
        );
        assert_eq!(grant.access_token, "access-two");
        assert_eq!(
            store.get(REFRESH_ACCOUNT).unwrap().as_deref(),
            Some("active-descendant")
        );
        assert_eq!(
            store.get(SESSION_STATE_ACCOUNT).unwrap().as_deref(),
            Some("v1:valid")
        );
    }

    #[tokio::test]
    async fn repeated_transient_refresh_remains_recovery_not_committed_valid() {
        let (service, store, transport) = fixture();
        store.set(REFRESH_ACCOUNT, "parent-token").unwrap();
        store.set(SESSION_STATE_ACCOUNT, "v1:recovery").unwrap();
        *transport.refresh_error.lock().unwrap() = Some(AuthError::ProviderTransient);
        assert!(matches!(
            service.restore(1_001).await,
            Err(AuthError::ProviderTransient)
        ));
        assert_eq!(
            store.get(SESSION_STATE_ACCOUNT).unwrap().as_deref(),
            Some("v1:recovery")
        );
        assert_eq!(
            store.get(REFRESH_ACCOUNT).unwrap().as_deref(),
            Some("parent-token")
        );
    }

    #[tokio::test]
    async fn terminal_refresh_from_recovery_clears_the_session() {
        let (service, store, transport) = fixture();
        store.set(REFRESH_ACCOUNT, "parent-token").unwrap();
        store.set(SESSION_STATE_ACCOUNT, "v1:recovery").unwrap();
        *transport.refresh_error.lock().unwrap() = Some(AuthError::ProviderRejected);
        assert!(matches!(
            service.refresh(1_000).await,
            Err(AuthError::ProviderRejected)
        ));
        assert!(store.get(REFRESH_ACCOUNT).unwrap().is_none());
        assert!(store.get(SESSION_STATE_ACCOUNT).unwrap().is_none());
    }

    #[tokio::test]
    async fn failure_to_write_refresh_recovery_remains_blocked() {
        let (service, store, transport) = fixture();
        store_valid_refresh(&store, "parent-token");
        *transport.refresh_error.lock().unwrap() = Some(AuthError::ProviderTransient);
        store.set_failure_sequence(SESSION_STATE_ACCOUNT, [false, true]);
        assert!(matches!(
            service.refresh(1_000).await,
            Err(AuthError::CredentialStore)
        ));
        assert_eq!(
            store.get(SESSION_STATE_ACCOUNT).unwrap().as_deref(),
            Some("v1:blocked")
        );
        assert_eq!(
            store.get(REFRESH_ACCOUNT).unwrap().as_deref(),
            Some("parent-token")
        );
        let cold = AuthService::new(config(), store.clone(), transport.clone());
        assert!(cold.restore(1_001).await.unwrap().is_none());
        assert_eq!(*transport.refresh_calls.lock().unwrap(), 1);
    }

    #[tokio::test]
    async fn transient_remote_logout_is_retried_with_the_same_access_token() {
        let (service, _, transport) = fixture();
        let request = service.begin_github(1_000).await.unwrap();
        service.complete(&callback(&request), 1_100).await.unwrap();
        *transport.logout_error.lock().unwrap() = Some(AuthError::ProviderTransient);
        assert!(matches!(
            service.sign_out().await,
            Err(AuthError::ProviderTransient)
        ));
        assert_eq!(*transport.logout.lock().unwrap(), vec!["access-one"]);
        service.sign_out().await.unwrap();
        assert_eq!(
            *transport.logout.lock().unwrap(),
            vec!["access-one", "access-one"]
        );
    }

    #[tokio::test]
    async fn refresh_during_exchange_preserves_pending_marker_and_never_calls_provider() {
        let (service, store, transport) = fixture();
        let request = service.begin_github(1_000).await.unwrap();
        store.set(REFRESH_ACCOUNT, "old-account").unwrap();
        store.set(SESSION_STATE_ACCOUNT, "v1:exchange").unwrap();
        let pending_before = store.get(PENDING_ACCOUNT).unwrap().unwrap();
        store.clear_events();

        assert!(matches!(
            service.refresh(1_100).await,
            Err(AuthError::ProviderTransient)
        ));
        assert_eq!(*transport.refresh_calls.lock().unwrap(), 0);
        assert_eq!(
            store.get(PENDING_ACCOUNT).unwrap().as_deref(),
            Some(pending_before.as_str())
        );
        assert_eq!(
            store.get(SESSION_STATE_ACCOUNT).unwrap().as_deref(),
            Some("v1:exchange")
        );
        assert_eq!(
            store.get(REFRESH_ACCOUNT).unwrap().as_deref(),
            Some("old-account")
        );
        assert!(store.events().is_empty());
        service.complete(&callback(&request), 1_101).await.unwrap();
    }

    #[tokio::test]
    async fn transient_exchange_preserves_old_access_for_explicit_logout() {
        let (service, _, transport) = fixture();
        let account_a = service.begin_github(1_000).await.unwrap();
        service
            .complete(&callback(&account_a), 1_100)
            .await
            .unwrap();
        let account_b = service.begin_github(1_200).await.unwrap();
        *transport.exchange_error.lock().unwrap() = Some(AuthError::ProviderTransient);
        assert!(matches!(
            service.complete(&callback(&account_b), 1_300).await,
            Err(AuthError::ProviderTransient)
        ));

        service.sign_out().await.unwrap();
        assert_eq!(*transport.logout.lock().unwrap(), vec!["access-one"]);
    }

    #[tokio::test]
    async fn invalid_provider_exchange_preserves_old_access_for_logout() {
        let (service, _, transport) = fixture();
        let account_a = service.begin_github(1_000).await.unwrap();
        service
            .complete(&callback(&account_a), 1_100)
            .await
            .unwrap();
        let account_b = service.begin_github(1_200).await.unwrap();
        *transport.exchange_error.lock().unwrap() = Some(AuthError::InvalidProviderResponse);

        assert!(matches!(
            service.complete(&callback(&account_b), 1_300).await,
            Err(AuthError::InvalidProviderResponse)
        ));
        service.sign_out().await.unwrap();
        assert_eq!(*transport.logout.lock().unwrap(), vec!["access-one"]);
    }

    #[tokio::test]
    async fn rejected_exchange_restores_old_session_and_logout_access() {
        let (service, store, transport) = fixture();
        let account_a = service.begin_github(1_000).await.unwrap();
        service
            .complete(&callback(&account_a), 1_100)
            .await
            .unwrap();
        let account_b = service.begin_github(1_200).await.unwrap();
        *transport.exchange_error.lock().unwrap() = Some(AuthError::ProviderRejected);

        assert!(matches!(
            service.complete(&callback(&account_b), 1_300).await,
            Err(AuthError::ProviderRejected)
        ));
        assert_eq!(
            store.get(SESSION_STATE_ACCOUNT).unwrap().as_deref(),
            Some(SESSION_VALID)
        );
        assert_eq!(service.access_for_test(), None);
        service.sign_out().await.unwrap();
        assert_eq!(*transport.logout.lock().unwrap(), vec!["access-one"]);
    }

    #[tokio::test]
    async fn exchange_refresh_write_failure_retains_old_access_for_logout_retry() {
        let (service, store, transport) = fixture();
        let account_a = service.begin_github(1_000).await.unwrap();
        service
            .complete(&callback(&account_a), 1_100)
            .await
            .unwrap();
        let account_b = service.begin_github(1_200).await.unwrap();
        store.fail_set_for(REFRESH_ACCOUNT, true);

        assert!(matches!(
            service.complete(&callback(&account_b), 1_300).await,
            Err(AuthError::CredentialStore)
        ));
        store.fail_set_for(REFRESH_ACCOUNT, false);
        *transport.logout_error.lock().unwrap() = Some(AuthError::ProviderTransient);
        assert!(matches!(
            service.sign_out().await,
            Err(AuthError::ProviderTransient)
        ));
        service.sign_out().await.unwrap();
        assert_eq!(
            *transport.logout.lock().unwrap(),
            vec!["access-one", "access-one"]
        );
    }

    #[tokio::test]
    async fn exchange_pending_delete_failure_retains_old_access_for_logout() {
        let (service, store, transport) = fixture();
        let account_a = service.begin_github(1_000).await.unwrap();
        service
            .complete(&callback(&account_a), 1_100)
            .await
            .unwrap();
        let account_b = service.begin_github(1_200).await.unwrap();
        store.fail_delete_for(PENDING_ACCOUNT, true);

        assert!(matches!(
            service.complete(&callback(&account_b), 1_300).await,
            Err(AuthError::CredentialStore)
        ));
        store.fail_delete_for(PENDING_ACCOUNT, false);
        service.sign_out().await.unwrap();
        assert_eq!(*transport.logout.lock().unwrap(), vec!["access-one"]);
    }

    #[tokio::test]
    async fn exchange_valid_marker_failure_retains_old_access_for_logout() {
        let (service, store, transport) = fixture();
        let account_a = service.begin_github(1_000).await.unwrap();
        service
            .complete(&callback(&account_a), 1_100)
            .await
            .unwrap();
        let account_b = service.begin_github(1_200).await.unwrap();
        store.set_failure_sequence(SESSION_STATE_ACCOUNT, [false, true, false]);

        assert!(matches!(
            service.complete(&callback(&account_b), 1_300).await,
            Err(AuthError::CredentialStore)
        ));
        service.sign_out().await.unwrap();
        assert_eq!(*transport.logout.lock().unwrap(), vec!["access-one"]);
    }

    #[tokio::test]
    async fn successful_exchange_retry_replaces_stale_logout_access() {
        let (service, _, transport) = fixture();
        let account_a = service.begin_github(1_000).await.unwrap();
        service
            .complete(&callback(&account_a), 1_100)
            .await
            .unwrap();
        let account_b = service.begin_github(1_200).await.unwrap();
        *transport.exchange_error.lock().unwrap() = Some(AuthError::ProviderTransient);
        assert!(matches!(
            service.complete(&callback(&account_b), 1_300).await,
            Err(AuthError::ProviderTransient)
        ));

        *transport.exchange_access.lock().unwrap() = "access-two".into();
        service
            .complete(&callback(&account_b), 1_301)
            .await
            .unwrap();
        service.sign_out().await.unwrap();
        assert_eq!(*transport.logout.lock().unwrap(), vec!["access-two"]);
    }

    #[tokio::test]
    async fn invalid_magic_email_does_not_mutate_stale_exchange_state() {
        let (service, store, transport) = fixture();
        let request = service.begin_github(1_000).await.unwrap();
        store.set(REFRESH_ACCOUNT, "old-refresh").unwrap();
        store.set(SESSION_STATE_ACCOUNT, "v1:exchange").unwrap();
        let pending_before = store.get(PENDING_ACCOUNT).unwrap().unwrap();
        store.clear_events();

        assert!(matches!(
            service.send_magic_link("not-an-email", 1_100).await,
            Err(AuthError::InvalidEmail)
        ));
        assert_eq!(
            store.get(PENDING_ACCOUNT).unwrap().as_deref(),
            Some(pending_before.as_str())
        );
        assert_eq!(
            store.get(REFRESH_ACCOUNT).unwrap().as_deref(),
            Some("old-refresh")
        );
        assert_eq!(
            store.get(SESSION_STATE_ACCOUNT).unwrap().as_deref(),
            Some("v1:exchange")
        );
        assert!(store.events().is_empty());
        assert!(transport.magic.lock().unwrap().is_empty());
        assert!(!request.flow_id.is_empty());
    }

    #[tokio::test]
    async fn signout_after_inflight_refresh_cannot_resurrect_rotation() {
        let store = Arc::new(MemoryStore::new());
        store_valid_refresh(&store, "original");
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
