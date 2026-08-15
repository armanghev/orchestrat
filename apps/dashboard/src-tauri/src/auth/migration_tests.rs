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
fn derives_supabase_endpoints_from_a_clean_origin_and_validates_public_configuration() {
    let config = SupabaseConfig::parse(
        "https://project.supabase.co",
        "sb_publishable_abcdefghijklmnopqrstuvwxyz123456",
        "staging",
        "dev.orchestrat.app://auth/callback",
    )
    .unwrap();
    assert_eq!(
        config.authorize_url().as_str(),
        "https://project.supabase.co/auth/v1/authorize"
    );
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
            "dev.orchestrat.app://auth/callback"
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
            "dev.orchestrat.app://auth/callback"
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
fn single_instance_is_first_and_does_not_log_or_parse_arguments() {
    let source = include_str!("../lib.rs");
    let single = source.find("tauri_plugin_single_instance::init").unwrap();
    let deep_link = source.find("tauri_plugin_deep_link::init").unwrap();
    assert!(single < deep_link);
    assert!(source.contains("second-instance argv is intentionally ignored and never logged"));
    assert!(source.contains("|app, _args, _cwd|"));
}
