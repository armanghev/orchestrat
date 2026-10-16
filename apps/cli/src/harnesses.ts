export const CONFIGURABLE_INTEGRATIONS = [
  "codex",
  "claude-code",
  "cursor",
  "antigravity"
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
  // How opt-in stop continuation is delivered.
  continuation?: "stop-hook";
  // Shown when a detected harness is not offered by setup.
  unsupportedReason?: string;
};

export const HARNESSES: readonly HarnessRecord[] = [
  {
    id: "codex",
    label: "Codex",
    command: "codex",
    applications: ["Codex.app"],
    configurable: true,
    supportsMcp: true,
    supportsHooks: true,
    continuation: "stop-hook"
  },
  {
    id: "claude-code",
    label: "Claude Code",
    command: "claude",
    configurable: true,
    supportsMcp: true,
    supportsHooks: true,
    continuation: "stop-hook"
  },
  {
    id: "cursor",
    label: "Cursor",
    command: "cursor-agent",
    commands: ["cursor-agent", "agent"],
    applications: ["Cursor.app"],
    configurable: true,
    supportsMcp: true,
    supportsHooks: true,
    continuation: "stop-hook"
  },
  {
    id: "antigravity",
    label: "Antigravity",
    command: "agy",
    applications: ["Antigravity.app", "Antigravity IDE.app"],
    configurable: true,
    supportsMcp: true,
    supportsHooks: true,
    continuation: "stop-hook"
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
