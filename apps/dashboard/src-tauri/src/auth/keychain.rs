use super::AuthError;
#[cfg(test)]
use std::collections::HashMap;
pub const PENDING_ACCOUNT: &str = "pending-pkce";
pub const REFRESH_ACCOUNT: &str = "refresh-session";
pub const SESSION_STATE_ACCOUNT: &str = "session-state";

pub trait CredentialStore: Send + Sync {
    fn get(&self, account: &str) -> Result<Option<String>, AuthError>;
    fn set(&self, account: &str, value: &str) -> Result<(), AuthError>;
    fn delete(&self, account: &str) -> Result<(), AuthError>;
}
pub struct KeychainStore {
    service: String,
}
impl KeychainStore {
    pub fn new(service: String) -> Self {
        Self { service }
    }
    #[cfg(test)]
    pub fn service(&self) -> &str {
        &self.service
    }
}
impl CredentialStore for KeychainStore {
    fn get(&self, account: &str) -> Result<Option<String>, AuthError> {
        let e =
            keyring::Entry::new(&self.service, account).map_err(|_| AuthError::CredentialStore)?;
        match e.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(AuthError::CredentialStore),
        }
    }
    fn set(&self, account: &str, value: &str) -> Result<(), AuthError> {
        keyring::Entry::new(&self.service, account)
            .map_err(|_| AuthError::CredentialStore)?
            .set_password(value)
            .map_err(|_| AuthError::CredentialStore)
    }
    fn delete(&self, account: &str) -> Result<(), AuthError> {
        let e =
            keyring::Entry::new(&self.service, account).map_err(|_| AuthError::CredentialStore)?;
        match e.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(AuthError::CredentialStore),
        }
    }
}
#[cfg(test)]
pub struct MemoryStore {
    values: std::sync::Mutex<HashMap<String, String>>,
    fail_set_accounts: std::sync::Mutex<std::collections::HashSet<String>>,
    fail_delete_accounts: std::sync::Mutex<std::collections::HashSet<String>>,
    set_failure_sequences: std::sync::Mutex<HashMap<String, std::collections::VecDeque<bool>>>,
    events: std::sync::Mutex<Vec<String>>,
}
#[cfg(test)]
impl MemoryStore {
    pub fn new() -> Self {
        Self {
            values: Default::default(),
            fail_set_accounts: Default::default(),
            fail_delete_accounts: Default::default(),
            set_failure_sequences: Default::default(),
            events: Default::default(),
        }
    }
    pub fn fail_set_for(&self, account: &str, value: bool) {
        let mut accounts = self.fail_set_accounts.lock().unwrap();
        if value {
            accounts.insert(account.into());
        } else {
            accounts.remove(account);
        }
    }
    pub fn set_failure_sequence(&self, account: &str, failures: impl IntoIterator<Item = bool>) {
        self.set_failure_sequences
            .lock()
            .unwrap()
            .insert(account.into(), failures.into_iter().collect());
    }
    pub fn fail_delete_for(&self, account: &str, value: bool) {
        let mut accounts = self.fail_delete_accounts.lock().unwrap();
        if value {
            accounts.insert(account.into());
        } else {
            accounts.remove(account);
        }
    }
    pub fn events(&self) -> Vec<String> {
        self.events.lock().unwrap().clone()
    }
    pub fn clear_events(&self) {
        self.events.lock().unwrap().clear();
    }
}
#[cfg(test)]
impl CredentialStore for MemoryStore {
    fn get(&self, a: &str) -> Result<Option<String>, AuthError> {
        Ok(self
            .values
            .lock()
            .map_err(|_| AuthError::CredentialStore)?
            .get(a)
            .cloned())
    }
    fn set(&self, a: &str, v: &str) -> Result<(), AuthError> {
        let event = if a == SESSION_STATE_ACCOUNT {
            format!("set:{a}:{v}")
        } else {
            format!("set:{a}")
        };
        self.events.lock().unwrap().push(event);
        let sequence_failure = self
            .set_failure_sequences
            .lock()
            .unwrap()
            .get_mut(a)
            .and_then(std::collections::VecDeque::pop_front)
            .unwrap_or(false);
        if sequence_failure || self.fail_set_accounts.lock().unwrap().contains(a) {
            return Err(AuthError::CredentialStore);
        }
        self.values.lock().unwrap().insert(a.into(), v.into());
        Ok(())
    }
    fn delete(&self, a: &str) -> Result<(), AuthError> {
        self.events.lock().unwrap().push(format!("delete:{a}"));
        if self.fail_delete_accounts.lock().unwrap().contains(a) {
            return Err(AuthError::CredentialStore);
        }
        self.values.lock().unwrap().remove(a);
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn namespace_and_memory_contract() {
        let k = KeychainStore::new("dev.orchestrat.app.auth.staging".into());
        assert_eq!(k.service(), "dev.orchestrat.app.auth.staging");
        let s = MemoryStore::new();
        s.set(REFRESH_ACCOUNT, "secret").unwrap();
        assert_eq!(s.get(REFRESH_ACCOUNT).unwrap().as_deref(), Some("secret"));
        s.delete(REFRESH_ACCOUNT).unwrap();
        assert!(s.get(REFRESH_ACCOUNT).unwrap().is_none());
    }
}
