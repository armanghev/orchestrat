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

fn json_mcp_valid(text: &str, command: &str, integration: &str) -> bool {
    serde_json::from_str::<Value>(text)
        .ok()
        .and_then(|root| root.get("mcpServers")?.get("orchestrat").cloned())
        .map(|entry| {
            entry.get("command").and_then(Value::as_str) == Some(command)
                && entry
                    .get("args")
                    .and_then(Value::as_array)
                    .map(|args| {
                        args == &[
                            Value::String("mcp".into()),
                            Value::String("--integration".into()),
                            Value::String(integration.into()),
                        ]
                    })
                    .unwrap_or(false)
        })
        .unwrap_or(false)
}

fn codex_mcp_valid(text: &str, command: &str) -> bool {
    let mut section = None;
    for (index, line) in text.lines().enumerate() {
        if line.trim() == "[mcp_servers.orchestrat]" {
            section = Some(index);
            break;
        }
    }
    let Some(start) = section else { return false };
    let lines: Vec<&str> = text.lines().collect();
    let end = lines
        .iter()
        .enumerate()
        .skip(start + 1)
        .find(|(_, line)| {
            let trimmed = line.trim();
            trimmed.starts_with('[') && trimmed.ends_with(']')
        })
        .map(|(index, _)| index)
        .unwrap_or(lines.len());
    let body = lines[start + 1..end].join("\n");
    body.lines()
        .any(|line| line.trim() == format!("command = \"{command}\""))
        && body
            .lines()
            .any(|line| line.trim() == "args = [\"mcp\", \"--integration\", \"codex\"]")
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
    let mapped_codex = project
        .filter(|_| valid_version)
        .and_then(|value| value.get("integrations"))
        .and_then(|value| value.get("codex"))
        .and_then(Value::as_object)
        .and_then(|value| value.get("agentId"))
        .and_then(Value::as_str)
        .is_some_and(|value| !value.is_empty());
    let mapped_claude = project
        .filter(|_| valid_version)
        .and_then(|value| value.get("integrations"))
        .and_then(|value| value.get("claude-code"))
        .and_then(Value::as_object)
        .and_then(|value| value.get("agentId"))
        .and_then(Value::as_str)
        .is_some_and(|value| !value.is_empty());
    let mapped = valid_version && project.is_some();
    let cli_exists = home.join(".local/bin/orchestrat").exists();
    let command = home
        .join(".local/bin/orchestrat")
        .to_string_lossy()
        .to_string();
    let codex_mcp = fs::read_to_string(home.join(".codex/config.toml"))
        .ok()
        .map(|text| codex_mcp_valid(&text, &command))
        .unwrap_or(false);
    let codex_hooks = fs::read_to_string(home.join(".codex/hooks.json"))
        .ok()
        .map(|text| hooks_valid(&text, "codex", &command))
        .unwrap_or(false);
    let claude_mcp = fs::read_to_string(home.join(".claude.json"))
        .ok()
        .map(|text| json_mcp_valid(&text, &command, "claude-code"))
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
                credential: mapped_codex && credential("agent:codex"),
            },
        ),
        (
            "claude-code".into(),
            IntegrationStatus {
                mapped: mapped_claude,
                mcp: mapped_claude && claude_mcp,
                hooks: mapped_claude && claude_hooks,
                credential: mapped_claude && credential("agent:claude-code"),
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
            account == "agent:codex" || account == fake_secret
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
