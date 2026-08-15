mod callback;
pub(crate) mod commands;
mod config;
mod keychain;
mod pkce;
mod service;
mod transport;
pub use config::SupabaseConfig;
pub use keychain::KeychainStore;
use serde::Serialize;
pub use service::AuthService;
use thiserror::Error;
pub use transport::SupabaseAuthTransport;
#[derive(Debug, Error)]
pub enum AuthError {
    #[error("Desktop authentication is not configured.")]
    Configuration,
    #[error("The authentication callback is invalid.")]
    InvalidCallback,
    #[error("The authentication request expired.")]
    CallbackExpired,
    #[error("The authentication callback does not match the pending flow.")]
    FlowMismatch,
    #[error("Authentication was denied.")]
    AccessDenied,
    #[error("The secure credential store is unavailable.")]
    CredentialStore,
    #[error("The authentication provider is temporarily unavailable.")]
    ProviderTransient,
    #[error("The authentication provider rejected the request.")]
    ProviderRejected,
    #[error("The authentication provider returned an invalid response.")]
    InvalidProviderResponse,
    #[error("The system browser could not be opened.")]
    BrowserOpen,
    #[error("No desktop session is available.")]
    NoSession,
    #[error("Enter a valid email address.")]
    InvalidEmail,
}
impl AuthError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Configuration => "configuration_error",
            Self::InvalidCallback => "invalid_callback",
            Self::CallbackExpired => "callback_expired",
            Self::FlowMismatch => "flow_mismatch",
            Self::AccessDenied => "access_denied",
            Self::CredentialStore => "credential_store_error",
            Self::ProviderTransient => "provider_unavailable",
            Self::ProviderRejected => "provider_rejected",
            Self::InvalidProviderResponse => "invalid_provider_response",
            Self::BrowserOpen => "browser_open_error",
            Self::NoSession => "no_session",
            Self::InvalidEmail => "invalid_email",
        }
    }
    pub fn is_terminal_session(&self) -> bool {
        matches!(self, Self::ProviderRejected | Self::InvalidProviderResponse)
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
#[cfg(test)]
mod migration_tests;
