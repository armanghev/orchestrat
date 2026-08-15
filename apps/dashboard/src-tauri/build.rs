use std::{collections::HashMap, env, path::PathBuf};
use url::Url;
const PUBLIC_AUTH_KEYS: [&str; 4] = [
    "ORCHESTRAT_SUPABASE_URL",
    "ORCHESTRAT_SUPABASE_PUBLISHABLE_KEY",
    "ORCHESTRAT_AUTH_ENVIRONMENT",
    "ORCHESTRAT_DESKTOP_AUTH_REDIRECT_URI",
];
fn valid_key(value: &str) -> bool {
    let Some(suffix) = value.strip_prefix("sb_publishable_") else {
        return false;
    };
    (20..=128).contains(&suffix.len())
        && suffix
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
}
fn valid_env(value: &str) -> bool {
    (1..=32).contains(&value.len())
        && !value.starts_with('-')
        && !value.ends_with('-')
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}
fn valid_base(value: &str) -> bool {
    Url::parse(value).is_ok_and(|u| {
        value.trim_end_matches('/') == u.origin().ascii_serialization()
            && u.scheme() == "https"
            && u.host_str().is_some()
            && u.port().is_none()
            && u.username().is_empty()
            && u.password().is_none()
            && u.path() == "/"
            && u.query().is_none()
            && u.fragment().is_none()
    })
}
fn validate(key: &str, value: &str) -> bool {
    match key {
        "ORCHESTRAT_SUPABASE_URL" => valid_base(value),
        "ORCHESTRAT_SUPABASE_PUBLISHABLE_KEY" => valid_key(value),
        "ORCHESTRAT_AUTH_ENVIRONMENT" => valid_env(value),
        "ORCHESTRAT_DESKTOP_AUTH_REDIRECT_URI" => value == "dev.orchestrat.app://auth/callback",
        _ => false,
    }
}
fn main() {
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("manifest dir"));
    let env_path = manifest.join("../.env");
    let file_values = dotenvy::from_path_iter(&env_path)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .collect::<HashMap<_, _>>();
    println!("cargo:rerun-if-changed={}", env_path.display());
    let mut values = Vec::new();
    let mut missing = Vec::new();
    for key in PUBLIC_AUTH_KEYS {
        println!("cargo:rerun-if-env-changed={key}");
        match env::var(key).or_else(|_| {
            file_values
                .get(key)
                .cloned()
                .ok_or(env::VarError::NotPresent)
        }) {
            Ok(value) => {
                if !validate(key, &value) {
                    panic!("invalid public desktop authentication build setting: {key}");
                }
                values.push((key, value));
            }
            Err(_) => missing.push(key),
        }
    }
    if !missing.is_empty() {
        panic!(
            "missing required public desktop authentication build setting(s): {}",
            missing.join(", ")
        );
    }
    for (key, value) in values {
        println!("cargo:rustc-env={key}={value}");
    }
    tauri_build::build();
}
