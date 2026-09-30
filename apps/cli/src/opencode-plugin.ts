import { join } from "node:path";

// OpenCode has no blocking stop hook, so continuation (spec §11.3) is a
// plugin: on `session.status` idle it asks `orchestrat hook opencode --event
// idle` whether directed attention is pending and, if so, prompts the session
// with the fixed reason template. The plugin keeps its own per-session budget
// (3 prompts per 30 minutes) on top of the CLI's dedupe and budget.
export const OPENCODE_PLUGIN_MARKER = "// orchestrat-managed-plugin v1";

// OpenCode 2 replaced this plugin API with `{ id, setup | effect }` modules
// whose public context has no session events or prompting, so the idle
// continuation cannot be built there yet. Unknown versions keep the plugin.
export const opencodeSupportsIdlePlugin = (version: string | undefined) => {
  const major = /(\d+)\.\d+/.exec(version ?? "")?.[1];
  return major === undefined || Number(major) < 2;
};

export const OPENCODE_V2_NOTE =
  "OpenCode: version 2 changed its plugin system and has no hook for idle sessions yet, so the OpenCode wake-up plugin was skipped. Orchestrat's MCP tools (attention, wait_for_update, handoff) still work in OpenCode.";

export const opencodePluginPath = (home: string) =>
  join(home, ".config", "opencode", "plugins", "orchestrat.ts");

export function opencodePluginContent(command: string) {
  return `${OPENCODE_PLUGIN_MARKER}
// Installed by \`orchestrat setup --auto-continue\`; removed by
// \`orchestrat disconnect opencode\`. Local edits are overwritten.
import { spawn } from "node:child_process";

const COMMAND = ${JSON.stringify(command)};
const LIMIT = 3;
const WINDOW_MS = 30 * 60 * 1000;
const HOOK_TIMEOUT_MS = 5000;

function askOrchestrat(payload: Record<string, unknown>): Promise<string | undefined> {
  return new Promise((resolve) => {
    let output = "";
    let child: any;
    try {
      child = spawn(COMMAND, ["hook", "opencode", "--event", "idle"], {
        stdio: ["pipe", "pipe", "ignore"]
      });
    } catch {
      resolve(undefined);
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      resolve(undefined);
    }, HOOK_TIMEOUT_MS);
    child.stdout.on("data", (chunk: unknown) => {
      if (output.length < 16384) output += String(chunk);
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      if (code !== 0) return resolve(undefined);
      try {
        const value = JSON.parse(output);
        resolve(
          value && value.continue === true && typeof value.reason === "string"
            ? value.reason
            : undefined
        );
      } catch {
        resolve(undefined);
      }
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(JSON.stringify(payload));
  });
}

export const OrchestratAttention = async ({ client, directory }: any) => {
  const prompted = new Map<string, number[]>();
  const running = new Set<string>();
  return {
    event: async ({ event }: any) => {
      const idle =
        (event?.type === "session.status" &&
          event.properties?.status?.type === "idle") ||
        event?.type === "session.idle";
      const sessionID = event?.properties?.sessionID;
      if (!idle || typeof sessionID !== "string" || running.has(sessionID))
        return;
      const now = Date.now();
      const recent = (prompted.get(sessionID) ?? []).filter(
        (time) => now - time < WINDOW_MS
      );
      prompted.set(sessionID, recent);
      if (recent.length >= LIMIT) return;
      running.add(sessionID);
      try {
        const reason = await askOrchestrat({
          hook_event_name: "idle",
          session_id: sessionID,
          cwd: directory
        });
        if (!reason) return;
        recent.push(Date.now());
        await client.session.promptAsync({
          path: { id: sessionID },
          body: { parts: [{ type: "text", text: reason }] }
        });
      } catch {
        // Fail open: a broken Orchestrat never traps the session.
      } finally {
        running.delete(sessionID);
      }
    }
  };
};
`;
}

const managed = (text: string) => text.startsWith(OPENCODE_PLUGIN_MARKER);

// Returns the desired file content, or undefined when the file should not
// exist. A foreign file at the managed path is a conflict when installing and
// is left alone when not.
export function mergeOpencodePlugin(
  text: string | undefined,
  command: string,
  enabled: boolean
) {
  if (text !== undefined && !managed(text)) {
    if (enabled) throw new Error("Existing OpenCode plugin file conflicts");
    return text;
  }
  return enabled ? opencodePluginContent(command) : undefined;
}

export function removeOpencodePlugin(text: string | undefined) {
  if (text === undefined || managed(text)) return undefined;
  return text;
}
