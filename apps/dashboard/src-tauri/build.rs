use std::{env, path::PathBuf};

const PUBLIC_OAUTH_KEYS: [&str; 5] = [
    "ORCHESTRAT_CLERK_OAUTH_CLIENT_ID",
    "ORCHESTRAT_CLERK_OAUTH_AUTHORIZATION_URL",
    "ORCHESTRAT_CLERK_OAUTH_TOKEN_URL",
    "ORCHESTRAT_CLERK_OAUTH_REVOCATION_URL",
    "ORCHESTRAT_CLERK_OAUTH_REDIRECT_URI",
];

fn main() {
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("manifest dir"));
    let env_path = manifest.join("../.env");
    let file_values = dotenvy::from_path_iter(&env_path)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .collect::<std::collections::HashMap<_, _>>();

    println!("cargo:rerun-if-changed={}", env_path.display());
    for key in PUBLIC_OAUTH_KEYS {
        println!("cargo:rerun-if-env-changed={key}");
        if let Ok(value) = env::var(key) {
            println!("cargo:rustc-env={key}={value}");
        } else if let Some(value) = file_values.get(key) {
            println!("cargo:rustc-env={key}={value}");
        }
    }

    tauri_build::build();
}
