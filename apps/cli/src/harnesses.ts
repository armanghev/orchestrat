export const CONFIGURABLE_INTEGRATIONS = [
  "codex",
  "claude-code",
  "cursor",
  "antigravity",
  "opencode"
] as const;

export type ConfigurableIntegration =
  (typeof CONFIGURABLE_INTEGRATIONS)[number];
export type HarnessId = ConfigurableIntegration | "pi";

export type HarnessRecord = {
  id: HarnessId;
  label: string;
  command: string;
  commands?: readonly string[];
  applications?: readonly string[];
  configurable: boolean;
  supportsMcp: boolean;
  supportsHooks: boolean;
};

export const HARNESSES: readonly HarnessRecord[] = [
  {
    id: "codex",
    label: "Codex",
    command: "codex",
    applications: ["Codex.app"],
    configurable: true,
    supportsMcp: true,
    supportsHooks: true
  },
  {
    id: "claude-code",
    label: "Claude Code",
    command: "claude",
    configurable: true,
    supportsMcp: true,
    supportsHooks: true
  },
  {
    id: "cursor",
    label: "Cursor",
    command: "cursor-agent",
    commands: ["cursor-agent", "agent"],
    applications: ["Cursor.app"],
    configurable: true,
    supportsMcp: true,
    supportsHooks: true
  },
  {
    id: "antigravity",
    label: "Antigravity",
    command: "agy",
    applications: ["Antigravity.app", "Antigravity IDE.app"],
    configurable: true,
    supportsMcp: true,
    supportsHooks: true
  },
  {
    id: "opencode",
    label: "OpenCode",
    command: "opencode",
    applications: ["OpenCode.app"],
    configurable: true,
    supportsMcp: true,
    supportsHooks: false
  },
  {
    id: "pi",
    label: "Pi",
    command: "pi",
    configurable: false,
    supportsMcp: false,
    supportsHooks: true
  }
];

export function harness(id: string) {
  return HARNESSES.find((item) => item.id === id);
}

export function isConfigurableIntegration(
  value: string
): value is ConfigurableIntegration {
  return CONFIGURABLE_INTEGRATIONS.includes(value as ConfigurableIntegration);
}
