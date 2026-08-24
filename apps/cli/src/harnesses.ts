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
  configurable: boolean;
  supportsMcp: boolean;
};

export const HARNESSES: readonly HarnessRecord[] = [
  { id: "codex", label: "Codex", command: "codex", configurable: true, supportsMcp: true },
  { id: "claude-code", label: "Claude Code", command: "claude", configurable: true, supportsMcp: true },
  {
    id: "cursor",
    label: "Cursor",
    command: "cursor-agent",
    commands: ["cursor-agent", "agent"],
    configurable: true,
    supportsMcp: true
  },
  { id: "antigravity", label: "Antigravity", command: "agy", configurable: true, supportsMcp: true },
  { id: "opencode", label: "OpenCode", command: "opencode", configurable: true, supportsMcp: true },
  { id: "pi", label: "Pi", command: "pi", configurable: false, supportsMcp: false }
];

export function harness(id: string) {
  return HARNESSES.find((item) => item.id === id);
}

export function isConfigurableIntegration(
  value: string
): value is ConfigurableIntegration {
  return CONFIGURABLE_INTEGRATIONS.includes(value as ConfigurableIntegration);
}
