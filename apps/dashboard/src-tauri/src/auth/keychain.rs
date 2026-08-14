#[cfg(test)]
use std::collections::HashMap;

use super::AuthError;

pub const SERVICE: &str = "dev.orchestrat.app";
pub const PENDING_ACCOUNT: &str = "oauth-pending";
pub const REFRESH_ACCOUNT: &str = "oauth-refresh";

pub trait CredentialStore: Send + Sync {
    fn get(&self, account: &str) -> Result<Option<String>, AuthError>;
    fn set(&self, account: &str, value: &str) -> Result<(), AuthError>;
    fn delete(&self, account: &str) -> Result<(), AuthError>;
}

pub struct KeychainStore;

impl CredentialStore for KeychainStore {
    fn get(&self, account: &str) -> Result<Option<String>, AuthError> {
        let entry =
            keyring::Entry::new(SERVICE, account).map_err(|_| AuthError::CredentialStore)?;
        match entry.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(AuthError::CredentialStore),
        }
    }

    fn set(&self, account: &str, value: &str) -> Result<(), AuthError> {
        let entry =
            keyring::Entry::new(SERVICE, account).map_err(|_| AuthError::CredentialStore)?;
        entry
            .set_password(value)
            .map_err(|_| AuthError::CredentialStore)
    }

    fn delete(&self, account: &str) -> Result<(), AuthError> {
        let entry =
            keyring::Entry::new(SERVICE, account).map_err(|_| AuthError::CredentialStore)?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(AuthError::CredentialStore),
        }
    }
}

#[cfg(test)]
pub struct MemoryStore(std::sync::Mutex<HashMap<String, String>>);

#[cfg(test)]
impl MemoryStore {
    pub fn new() -> Self {
        Self(std::sync::Mutex::new(HashMap::new()))
    }
}

#[cfg(test)]
impl CredentialStore for MemoryStore {
    fn get(&self, account: &str) -> Result<Option<String>, AuthError> {
        Ok(self
            .0
            .lock()
            .map_err(|_| AuthError::CredentialStore)?
            .get(account)
            .cloned())
    }
    fn set(&self, account: &str, value: &str) -> Result<(), AuthError> {
        self.0
            .lock()
            .map_err(|_| AuthError::CredentialStore)?
            .insert(account.into(), value.into());
        Ok(())
    }
    fn delete(&self, account: &str) -> Result<(), AuthError> {
        self.0
            .lock()
            .map_err(|_| AuthError::CredentialStore)?
            .remove(account);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn memory_store_set_get_delete_contract() {
        let store = MemoryStore::new();
        store.set("account", "secret").unwrap();
        assert_eq!(store.get("account").unwrap().as_deref(), Some("secret"));
        store.delete("account").unwrap();
        assert_eq!(store.get("account").unwrap(), None);
    }
}
