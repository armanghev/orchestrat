use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

#[derive(Debug, Serialize)]
pub(crate) struct IntegrationStatus {
    pub mapped: bool,
    pub mcp: bool,
    pub hooks: bool,
    pub credential: bool,
}

#[derive(Debug, Serialize)]
pub(crate) struct LocalIntegrationStatus {
    pub supported: bool,
    pub cli_exists: bool,
    pub project_mapping: bool,
    pub integrations: BTreeMap<String, IntegrationStatus>,
    pub error: Option<String>,
}

fn json_mcp_valid(text: &str, command: &str, integration: &str, global: bool) -> bool {
    let mut expected = vec!["mcp", "--integration", integration];
    if global {
        expected.push("--global");
    }
    serde_json::from_str::<Value>(text)
        .ok()
        .and_then(|root| root.get("mcpServers")?.get("orchestrat").cloned())
        .map(|entry| {
            entry.get("command").and_then(Value::as_str) == Some(command)
                && entry
                    .get("args")
                    .and_then(Value::as_array)
                    .map(|args| {
                        args.iter()
                            .map(Value::as_str)
                            .eq(expected.iter().map(|arg| Some(*arg)))
                    })
                    .unwrap_or(false)
        })
        .unwrap_or(false)
}

fn codex_mcp_valid(text: &str, command: &str, global: bool) -> bool {
    let mut expected = vec!["mcp", "--integration", "codex"];
    if global {
        expected.push("--global");
    }
    text.parse::<toml::Table>()
        .ok()
        .and_then(|root| root.get("mcp_servers")?.get("orchestrat").cloned())
        .map(|entry| {
            entry.get("command").and_then(toml::Value::as_str) == Some(command)
                && entry
                    .get("args")
                    .and_then(toml::Value::as_array)
                    .map(|args| {
                        args.iter()
                            .map(toml::Value::as_str)
                            .eq(expected.iter().map(|arg| Some(*arg)))
                    })
                    .unwrap_or(false)
        })
        .unwrap_or(false)
}

fn hooks_valid(text: &str, integration: &str, command: &str) -> bool {
    let events = if integration == "codex" {
        &["SessionStart", "SessionEnd"][..]
    } else {
        &["SessionStart", "SessionEnd", "StopFailure"][..]
    };
    let root = match serde_json::from_str::<Value>(text) {
        Ok(value) => value,
        Err(_) => return false,
    };
    events.iter().all(|event| {
        root.get("hooks")
            .and_then(|hooks| hooks.get(*event))
            .and_then(Value::as_array)
            .map(|groups| {
                groups.iter().any(|group| {
                    group
                        .get("hooks")
                        .and_then(Value::as_array)
                        .map(|handlers| {
                            handlers.iter().any(|handler| {
                                handler.get("type").and_then(Value::as_str) == Some("command")
                                    && handler
                                        .get("command")
                                        .and_then(Value::as_str)
                                        .map(|value| {
                                            value
                                                == format!(
                                                    "{} hook {integration}",
                                                    shell_quote(command)
                                                )
                                        })
                                        .unwrap_or(false)
                            })
                        })
                        .unwrap_or(false)
                })
            })
            .unwrap_or(false)
    })
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

pub(crate) fn inspect_local(
    home: &Path,
    project_id: &str,
    credential: impl Fn(&str) -> bool,
) -> LocalIntegrationStatus {
    let config_path = home.join(".orchestrat/config.json");
    let config = fs::read_to_string(&config_path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok());
    let valid_version = config
        .as_ref()
        .and_then(|value| value.get("version"))
        .and_then(Value::as_u64)
        == Some(1);
    let project = config
        .as_ref()
        .and_then(|value| value.get("projects"))
        .and_then(Value::as_object)
        .and_then(|projects| {
            projects.values().find(|project| {
                project.get("projectId").and_then(Value::as_str) == Some(project_id)
                    && project
                        .get("integrations")
                        .and_then(Value::as_object)
                        .is_some()
            })
        });
    let mapping = |integration: &str| {
        let local = project.and_then(|value| value.get("integrations")?.get(integration));
        let global = config.as_ref().and_then(|value| {
            value
                .get("globalProjects")?
                .get(integration)?
                .get(project_id)
        });
        let valid = |value: Option<&Value>| {
            value
                .and_then(|value| value.get("agentId"))
                .and_then(Value::as_str)
                .is_some_and(|value| !value.is_empty())
        };
        let global_scope = project
            .and_then(|value| value.get("mcpScopes")?.get(integration))
            .and_then(Value::as_str)
            == Some("global")
            || (!valid(local) && valid(global));
        (
            valid_version && (valid(local) || valid(global)),
            global_scope,
        )
    };
    let (mapped_codex, global_codex) = mapping("codex");
    let (mapped_claude, global_claude) = mapping("claude-code");
    let mapped = mapped_codex || mapped_claude;
    let has_credential = |integration: &str, global: bool| {
        let mapping = if global {
            config
                .as_ref()
                .and_then(|value| {
                    value
                        .get("globalProjects")?
                        .get(integration)?
                        .get(project_id)
                })
                .or(project)
        } else {
            project
        };
        let api = mapping
            .and_then(|value| value.get("apiUrl"))
            .and_then(Value::as_str)
            .unwrap_or("https://api.orchestrat.dev");
        url::Url::parse(api)
            .ok()
            .filter(|url| matches!(url.scheme(), "http" | "https"))
            .is_some_and(|url| {
                credential(&format!(
                    "agent:{project_id}:{integration}:{}",
                    url.origin().ascii_serialization()
                ))
            })
    };
    let cli_exists = home.join(".local/bin/orchestrat").exists();
    let command = home
        .join(".local/bin/orchestrat")
        .to_string_lossy()
        .to_string();
    let codex_mcp = fs::read_to_string(home.join(".codex/config.toml"))
        .ok()
        .map(|text| codex_mcp_valid(&text, &command, global_codex))
        .unwrap_or(false);
    let codex_hooks = fs::read_to_string(home.join(".codex/hooks.json"))
        .ok()
        .map(|text| hooks_valid(&text, "codex", &command))
        .unwrap_or(false);
    let claude_mcp = fs::read_to_string(home.join(".claude.json"))
        .ok()
        .map(|text| json_mcp_valid(&text, &command, "claude-code", global_claude))
        .unwrap_or(false);
    let claude_hooks = fs::read_to_string(home.join(".claude/settings.json"))
        .ok()
        .map(|text| hooks_valid(&text, "claude-code", &command))
        .unwrap_or(false);
    let integrations = BTreeMap::from([
        (
            "codex".into(),
            IntegrationStatus {
                mapped: mapped_codex,
                mcp: mapped_codex && codex_mcp,
                hooks: mapped_codex && codex_hooks,
                credential: mapped_codex && has_credential("codex", global_codex),
            },
        ),
        (
            "claude-code".into(),
            IntegrationStatus {
                mapped: mapped_claude,
                mcp: mapped_claude && claude_mcp,
                hooks: mapped_claude && claude_hooks,
                credential: mapped_claude && has_credential("claude-code", global_claude),
            },
        ),
    ]);
    LocalIntegrationStatus {
        supported: true,
        cli_exists,
        project_mapping: mapped,
        integrations,
        error: if !valid_version || config.is_none() {
            Some("Local configuration is missing or malformed.".into())
        } else {
            None
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{create_dir_all, write};
    #[test]
    fn returns_safe_booleans_without_credentials() {
        let home = std::env::temp_dir().join(format!(
            "orchestrat-status-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = fs::remove_dir_all(&home);
        create_dir_all(home.join(".orchestrat")).unwrap();
        create_dir_all(home.join(".codex")).unwrap();
        create_dir_all(home.join(".claude")).unwrap();
        let command = home.join(".local/bin/orchestrat");
        create_dir_all(command.parent().unwrap()).unwrap();
        write(&command, "#!/bin/sh\n").unwrap();
        write(home.join(".orchestrat/config.json"), r#"{"version":1,"projects":{"/tmp":{"projectId":"p1","integrations":{"codex":{"agentId":"a1"}}}}}"#).unwrap();
        write(home.join(".codex/config.toml"), format!("[mcp_servers.orchestrat]\ncommand = \"{}\"\nargs = [\"mcp\", \"--integration\", \"codex\"]\n", command.display())).unwrap();
        write(home.join(".codex/hooks.json"), format!(r#"{{"hooks":{{"SessionStart":[{{"hooks":[{{"type":"command","command":"'{0}' hook codex"}}]}}],"SessionEnd":[{{"hooks":[{{"type":"command","command":"'{0}' hook codex"}}]}}]}}}}"#, command.display())).unwrap();
        let fake_secret = "orch_agent_unique_fake_secret";
        let status = inspect_local(&home, "p1", |account| {
            account == "agent:p1:codex:https://api.orchestrat.dev" || account == fake_secret
        });
        assert!(status.project_mapping);
        let codex = status.integrations.get("codex").unwrap();
        let claude = status.integrations.get("claude-code").unwrap();
        assert!(codex.mapped && codex.credential && codex.mcp && codex.hooks);
        assert!(!claude.mapped && !claude.credential);
        assert!(!serde_json::to_string(&status)
            .unwrap()
            .contains(fake_secret));
        write(
            home.join(".codex/config.toml"),
            format!(
                "[mcp_servers.other]\ncommand = \"{}\"\nargs = [\"mcp\", \"--integration\", \"codex\"]\n",
                command.display()
            ),
        )
        .unwrap();
        assert!(!inspect_local(&home, "p1", |_| true).integrations["codex"].mcp);
        write(
            home.join(".codex/config.toml"),
            "[mcp_servers.orchestrat]\ncommand = \"wrong\"\nargs = [\"bad\"]\n",
        )
        .unwrap();
        assert!(!inspect_local(&home, "p1", |_| true).integrations["codex"].mcp);
        write(home.join(".codex/hooks.json"), r#"{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"/bin/foo hook codex"}]}],"SessionEnd":[{"hooks":[{"type":"command","command":"/bin/foo hook codex"}]}]}}"#).unwrap();
        assert!(!inspect_local(&home, "p1", |_| true).integrations["codex"].hooks);
        assert!(
            inspect_local(&home, "p1", |account| account
                == "agent:p1:codex:https://api.orchestrat.dev")
            .integrations["codex"]
                .credential
        );
        write(home.join(".orchestrat/config.json"), r#"{"version":1,"projects":{},"globalProjects":{"codex":{"p1":{"agentId":"a1"}},"claude-code":{"p1":{"agentId":"a2"}}}}"#).unwrap();
        write(home.join(".codex/config.toml"), format!("[mcp_servers.orchestrat]\ncommand=\"{}\" # installed launcher\nargs = [\n  \"mcp\", \"--integration\", \"codex\", \"--global\",\n]\n", command.display())).unwrap();
        write(home.join(".claude.json"), serde_json::json!({"mcpServers":{"orchestrat":{"command":command.to_string_lossy(),"args":["mcp","--integration","claude-code","--global"]}}}).to_string()).unwrap();
        let global = inspect_local(&home, "p1", |account| {
            matches!(
                account,
                "agent:p1:codex:https://api.orchestrat.dev"
                    | "agent:p1:claude-code:https://api.orchestrat.dev"
            )
        });
        assert!(global.project_mapping);
        assert!(global
            .integrations
            .values()
            .all(|item| item.mapped && item.mcp && item.credential));
        assert!(!inspect_local(&home, "p2", |_| true).project_mapping);
        assert!(
            !inspect_local(&home, "p1", |account| account == "agent:codex").integrations["codex"]
                .credential
        );
        for global in [false, true] {
            let mapping = if global {
                serde_json::json!({"version": 1, "projects": {}, "globalProjects": {"codex": {"p1": {"agentId": "a1", "apiUrl": "https://API.TEST:443/path"}}}})
            } else {
                serde_json::json!({"version": 1, "projects": {"/tmp": {"projectId": "p1", "apiUrl": "https://API.TEST:443/path", "integrations": {"codex": {"agentId": "a1"}}}}})
            };
            write(home.join(".orchestrat/config.json"), mapping.to_string()).unwrap();
            assert!(
                inspect_local(&home, "p1", |account| account
                    == "agent:p1:codex:https://api.test")
                .integrations["codex"]
                    .credential
            );
            assert!(
                !inspect_local(&home, "p1", |account| matches!(
                    account,
                    "agent:p1:codex"
                        | "agent:codex"
                        | "codex"
                        | "agent:p1:codex:https://other.test"
                ))
                .integrations["codex"]
                    .credential
            );
        }
        write(home.join(".orchestrat/config.json"), "not json").unwrap();
        let malformed = inspect_local(&home, "p1", |_| true);
        assert!(!malformed.project_mapping);
        assert!(!malformed.integrations["codex"].mapped);
        write(
            home.join(".orchestrat/config.json"),
            r#"{"version":2,"projects":{"/tmp":{"projectId":"p1","integrations":{"codex":{"agentId":"a1"},"claude-code":{"agentId":"a2"}}}}}"#,
        )
        .unwrap();
        let unsupported = inspect_local(&home, "p1", |_| true);
        assert!(!unsupported.project_mapping);
        assert!(!unsupported.integrations["codex"].mapped);
        assert!(!unsupported.integrations["codex"].credential);
        assert!(!unsupported.integrations["claude-code"].mapped);
        assert!(!unsupported.integrations["claude-code"].credential);
        let _ = fs::remove_dir_all(home);
    }
}
