import { lstatSync } from "node:fs";
import { dirname, join } from "node:path";
import type { McpScope } from "./config.js";
import type { ConfigurableIntegration } from "./harnesses.js";
import { harness } from "./harnesses.js";
import {
  mergeHarnessHooks,
  mergeHarnessMcp,
  readOptional,
  removeHarnessHooks,
  removeHarnessMcp
} from "./safe-files.js";

// Opt-in attention wiring for one integration. The default is off, which
// reproduces the pre-attention configuration exactly.
export type AttentionPlanOptions = { autoContinue?: boolean; rewake?: boolean };

export function attentionPlanOptions(
  attention:
    { continue_on_stop?: readonly string[]; rewake?: boolean } | undefined,
  integration: ConfigurableIntegration
): AttentionPlanOptions {
  const autoContinue =
    attention?.continue_on_stop?.includes(integration) ?? false;
  return {
    autoContinue,
    rewake:
      autoContinue &&
      integration === "claude-code" &&
      attention?.rewake === true
  };
}

export type HarnessConfigPlan = {
  integration: ConfigurableIntegration;
  supportsMcp: boolean;
  supportsHooks: boolean;
  mcp?: {
    path: string;
    entries: string[];
    merge: (text: string | undefined) => string;
    remove: (text: string | undefined) => string | undefined;
  };
  hooks?: {
    path: string;
    entries: string[];
    merge: (text: string | undefined) => string;
    remove: (text: string | undefined) => string | undefined;
  };
};

export function harnessConfigPlan(
  home: string,
  integration: ConfigurableIntegration,
  command: string,
  projectRoot = home,
  mcpScope: McpScope = "project",
  attention: AttentionPlanOptions = {}
): HarnessConfigPlan {
  const item = harness(integration)!;
  const autoContinue = attention.autoContinue === true;
  const budgeted =
    autoContinue && (integration === "codex" || integration === "antigravity");
  const mcpPath = (
    {
      codex: join(home, ".codex", "config.toml"),
      "claude-code": join(home, ".claude.json"),
      cursor: join(
        mcpScope === "global" ? home : projectRoot,
        ".cursor",
        "mcp.json"
      ),
      antigravity: join(home, ".gemini", "config", "mcp_config.json")
    } as Record<ConfigurableIntegration, string>
  )[integration];
  if (integration === "cursor" && mcpScope === "project") {
    // Repository-supplied links must not redirect setup or disconnect outside the project.
    for (const path of [dirname(mcpPath), mcpPath]) {
      try {
        if (lstatSync(path).isSymbolicLink())
          throw new Error(
            "Cursor project configuration must not use symbolic links"
          );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
  const hookPath = (
    {
      codex: join(home, ".codex", "hooks.json"),
      "claude-code": join(home, ".claude", "settings.json"),
      cursor: join(home, ".cursor", "hooks.json"),
      antigravity: join(home, ".gemini", "config", "hooks.json")
    } as Partial<Record<ConfigurableIntegration, string>>
  )[integration];
  const plan: HarnessConfigPlan = {
    integration,
    supportsMcp: item.supportsMcp,
    supportsHooks: item.supportsHooks
  };
  if (item.supportsMcp && mcpPath)
    plan.mcp = {
      path: mcpPath,
      entries: [
        integration === "codex"
          ? "mcp_servers.orchestrat"
          : "mcpServers.orchestrat",
        ...(budgeted
          ? [integration === "codex" ? "tool_timeout_sec" : "timeoutSeconds"]
          : [])
      ],
      merge: (text) =>
        mergeHarnessMcp(
          text,
          integration,
          command,
          undefined,
          mcpScope === "global",
          budgeted
        ),
      remove: (text) =>
        removeHarnessMcp(
          text,
          integration,
          command,
          undefined,
          mcpScope === "global"
        )
    };
  if (item.supportsHooks && hookPath)
    plan.hooks = {
      path: hookPath,
      entries: [
        ...(integration === "antigravity"
          ? ["orchestrat.PreInvocation", "orchestrat.Stop"]
          : integration === "cursor"
            ? ["sessionStart", "sessionEnd", "postToolUseFailure"]
            : integration === "claude-code"
              ? ["SessionStart", "SessionEnd", "StopFailure"]
              : ["SessionStart", "SessionEnd"]),
        ...(autoContinue && integration === "cursor" ? ["stop"] : []),
        ...(autoContinue &&
        (integration === "claude-code" || integration === "codex")
          ? ["Stop"]
          : []),
        ...(attention.rewake && integration === "claude-code"
          ? ["Stop (rewake)"]
          : [])
      ],
      merge: (text) =>
        mergeHarnessHooks(text, integration, command, {
          enabled: autoContinue,
          rewake: attention.rewake === true
        }),
      remove: (text) => removeHarnessHooks(text, integration, command)
    };
  return plan;
}

export async function previewHarnessConfig(
  home: string,
  integration: ConfigurableIntegration,
  command: string,
  projectRoot = home,
  mcpScope: McpScope = "project",
  attention: AttentionPlanOptions = {}
) {
  const plan = harnessConfigPlan(
    home,
    integration,
    command,
    projectRoot,
    mcpScope,
    attention
  );
  const previews = [] as {
    integration: ConfigurableIntegration;
    path: string;
    changed: boolean;
    entries: string[];
    capability: "mcp" | "hooks";
  }[];
  for (const [capability, item] of [
    ["mcp", plan.mcp],
    ["hooks", plan.hooks]
  ] as const) {
    if (!item) continue;
    const source = await readOptional(item.path);
    previews.push({
      integration,
      path: item.path,
      changed: source !== item.merge(source),
      entries: item.entries,
      capability
    });
  }
  return previews;
}
