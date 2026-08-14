mod callback;
pub(crate) mod commands;
mod config;
mod keychain;
mod pkce;
mod service;
mod transport;

#[allow(unused_imports)]
pub use commands::{oauth_begin, oauth_complete, oauth_refresh, oauth_restore, oauth_sign_out};
pub use config::OAuthConfig;
pub use keychain::KeychainStore;
pub use service::OAuthService;
pub use transport::ClerkOAuthTransport;

use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AuthError {
    #[error("Desktop authentication is not configured.")]
    Configuration,
    #[error("The authentication callback is invalid.")]
    InvalidCallback,
    #[error("The authentication request expired.")]
    CallbackExpired,
    #[error("The authentication callback state does not match.")]
    StateMismatch,
    #[error("Authentication was denied.")]
    AccessDenied,
    #[error("The secure credential store is unavailable.")]
    CredentialStore,
    #[error("Clerk rejected the authentication request.")]
    TokenExchange,
    #[error("The system browser could not be opened.")]
    BrowserOpen,
    #[error("No desktop session is available.")]
    NoSession,
}

impl AuthError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Configuration => "configuration_error",
            Self::InvalidCallback => "invalid_callback",
            Self::CallbackExpired => "callback_expired",
            Self::StateMismatch => "state_mismatch",
            Self::AccessDenied => "access_denied",
            Self::CredentialStore => "credential_store_error",
            Self::TokenExchange => "token_exchange_error",
            Self::BrowserOpen => "browser_open_error",
            Self::NoSession => "no_session",
        }
    }
}

#[derive(Debug, Serialize)]
pub struct CommandError {
    code: &'static str,
    message: String,
}

impl From<AuthError> for CommandError {
    fn from(value: AuthError) -> Self {
        Self {
            code: value.code(),
            message: value.to_string(),
        }
    }
}
