use super::{
    callback::{parse_callback, PendingAuthorization, PendingKind},
    config::SupabaseConfig,
    pkce::Pkce,
};

fn pending(kind: PendingKind) -> PendingAuthorization {
    PendingAuthorization {
        version: 1,
        kind,
        flow_id: "flow_identifier_123".into(),
        verifier: "a".repeat(43),
        created_at_ms: 1_000,
    }
}

#[test]
fn derives_token_endpoint_from_a_clean_origin_and_validates_public_configuration() {
    let config = SupabaseConfig::parse(
        "https://project.supabase.co",
        "sb_publishable_abcdefghijklmnopqrstuvwxyz123456",
        "staging",
        "dev.orchestrat.app://auth/callback",
        "http://localhost:5173/auth/desktop",
    )
    .unwrap();
    assert_eq!(
        config.token_url().as_str(),
        "https://project.supabase.co/auth/v1/token"
    );
    assert_eq!(config.keychain_service(), "dev.orchestrat.app.auth.staging");
    for invalid in [
        "eyJhbGciOiJIUzI1NiJ9.payload.signature",
        "service_role_secret",
        "anon",
        "sb_secret_abc",
        "sb_publishable_short",
    ] {
        assert!(SupabaseConfig::parse(
            "https://project.supabase.co",
            invalid,
            "staging",
            "dev.orchestrat.app://auth/callback",
            "http://localhost:5173/auth/desktop"
        )
        .is_err());
    }
    for invalid in [
        "http://project.supabase.co",
        "https://user@project.supabase.co",
        "https://project.supabase.co/path",
        "https://project.supabase.co?x=1",
    ] {
        assert!(SupabaseConfig::parse(
            invalid,
            "sb_publishable_abcdefghijklmnopqrstuvwxyz123456",
            "staging",
            "dev.orchestrat.app://auth/callback",
            "http://localhost:5173/auth/desktop"
        )
        .is_err());
    }
}

#[test]
fn pkce_and_callback_use_a_separate_correlated_flow_id_and_kind_ttl() {
    let first = Pkce::generate();
    let second = Pkce::generate();
    assert_ne!(first.flow_id, second.flow_id);
    assert_eq!(first.challenge_method, "s256");
    let parsed = parse_callback(
        "dev.orchestrat.app://auth/callback?code=abc&sb_flow_id=flow_identifier_123",
        &pending(PendingKind::Github),
        1_100,
    )
    .unwrap();
    assert_eq!(parsed.code.as_deref(), Some("abc"));
    assert!(parse_callback(
        "dev.orchestrat.app://auth/callback?code=abc&sb_flow_id=wrong",
        &pending(PendingKind::Github),
        1_100
    )
    .is_err());
    assert!(parse_callback(
        "dev.orchestrat.app://auth/callback?code=abc&code=dup&sb_flow_id=flow_identifier_123",
        &pending(PendingKind::Github),
        1_100
    )
    .is_err());
    assert!(parse_callback(
        "dev.orchestrat.app://auth/callback?code=abc&sb_flow_id=flow_identifier_123&unknown=x",
        &pending(PendingKind::Github),
        1_100
    )
    .is_err());
    assert!(parse_callback(
        "dev.orchestrat.app://auth/callback?code=abc&sb_flow_id=flow_identifier_123",
        &pending(PendingKind::Github),
        1_000 + 10 * 60_000 + 1
    )
    .is_err());
    assert!(parse_callback(
        "dev.orchestrat.app://auth/callback?code=abc&sb_flow_id=flow_identifier_123",
        &pending(PendingKind::MagicLink),
        1_000 + 10 * 60_000 + 1
    )
    .is_ok());
}

#[test]
fn single_instance_is_first_and_forwards_only_validated_macos_callbacks() {
    let source = include_str!("../lib.rs");
    let single = source.find("tauri_plugin_single_instance::init").unwrap();
    let deep_link = source.find("tauri_plugin_deep_link::init").unwrap();
    assert!(single < deep_link);
    assert!(source.contains("auth_callback_urls(&args)"));
    assert!(source.contains("deep-link://new-url"));
    assert!(!source.contains("println!"));
}

#[test]
fn clean_checkout_documents_safe_native_test_configuration_without_legacy_provider() {
    let package: serde_json::Value =
        serde_json::from_str(include_str!("../../../package.json")).unwrap();
    let script = package["scripts"]["test:native"].as_str().unwrap();
    for setting in [
        "ORCHESTRAT_SUPABASE_URL=https://example.supabase.co",
        "ORCHESTRAT_SUPABASE_PUBLISHABLE_KEY=sb_publishable_abcdefghijklmnopqrstuvwxyz123456",
        "ORCHESTRAT_AUTH_ENVIRONMENT=test",
        "ORCHESTRAT_DESKTOP_AUTH_REDIRECT_URI=dev.orchestrat.app://auth/callback",
        "ORCHESTRAT_DESKTOP_AUTH_PORTAL_URL=http://localhost:5173/auth/desktop",
        "cargo test --manifest-path src-tauri/Cargo.toml",
    ] {
        assert!(script.contains(setting));
    }

    let example = include_str!("../../../.env.example");
    for setting in [
        "VITE_SUPABASE_URL=https://example.supabase.co",
        "VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_abcdefghijklmnopqrstuvwxyz123456",
        "VITE_WEB_AUTH_CALLBACK_URL=http://localhost:5173/auth/callback",
        "ORCHESTRAT_SUPABASE_URL=https://example.supabase.co",
        "ORCHESTRAT_SUPABASE_PUBLISHABLE_KEY=sb_publishable_abcdefghijklmnopqrstuvwxyz123456",
        "ORCHESTRAT_AUTH_ENVIRONMENT=development",
        "ORCHESTRAT_DESKTOP_AUTH_REDIRECT_URI=dev.orchestrat.app://auth/callback",
        "ORCHESTRAT_DESKTOP_AUTH_PORTAL_URL=http://localhost:5173/auth/desktop",
    ] {
        assert!(example.contains(setting));
    }
    assert!(!example.to_ascii_lowercase().contains(concat!("cl", "erk")));
}
