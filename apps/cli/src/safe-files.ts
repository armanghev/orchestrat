import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  writeFile,
  rm
} from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ConfigurableIntegration } from "./harnesses.js";

export async function readOptional(path: string) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
export async function atomicWrite(
  path: string,
  content: string,
  backup = true,
  afterBackup?: () => void
) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const existing = await readOptional(path);
  if (existing === content) return false;
  const directory = await mkdtemp(join(dirname(path), ".orchestrat-"));
  const temporary = join(directory, "config");
  try {
    if (existing !== undefined && backup) {
      const stagedBackup = join(directory, "backup");
      await writeFile(stagedBackup, existing, {
        encoding: "utf8",
        mode: 0o600
      });
      await rename(stagedBackup, `${path}.orchestrat-backup`);
    }
    afterBackup?.();
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  return true;
}

// Writes managed content, or deletes the file when the managed result is
// "absent" (undefined).
export async function writeManaged(
  path: string,
  next: string | undefined,
  backup = true
) {
  if (next !== undefined) return atomicWrite(path, next, backup);
  if ((await readOptional(path)) === undefined) return false;
  await rm(path, { force: true });
  return true;
}

// Reads small private state (hook state, locks). Symbolic links and oversized
// files read as absent so a planted link can never redirect or bloat a hook.
export async function readPrivateState(path: string, maxBytes = 256 * 1024) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.size > maxBytes) return undefined;
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

export async function writePrivateState(path: string, content: string) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const parent = await lstat(dirname(path));
  if (parent.isSymbolicLink() || !parent.isDirectory())
    throw new Error("Orchestrat state directory must not be a symbolic link");
  return atomicWrite(path, content, false);
}

// Stop continuation (spec §11.3) and Codex/Antigravity MCP budgets are opt-in
// per integration; these constants are the managed values setup writes.
export const WAIT_BUDGET_SECONDS = 600;
export const MCP_TOOL_TIMEOUT_SECONDS = 660;
export const REWAKE_TIMEOUT_SECONDS = 3600;
export const CURSOR_STOP_LOOP_LIMIT = 2;
export type StopHookOptions = { enabled: boolean; rewake?: boolean };
const quoted = (command: string) => `'${command.replaceAll("'", "'\\''")}'`;
const stopCommand = (command: string, integration: string, watch = false) =>
  `${quoted(command)} hook ${integration} --event Stop${watch ? " --watch" : ""}`;
function managedStopHandlers(
  command: string,
  integration: "codex" | "claude-code",
  stop: StopHookOptions
) {
  if (!stop.enabled) return [];
  return [
    { type: "command", command: stopCommand(command, integration) },
    ...(integration === "claude-code" && stop.rewake
      ? [
          {
            type: "command",
            command: stopCommand(command, integration, true),
            async: true,
            asyncRewake: true,
            timeout: REWAKE_TIMEOUT_SECONDS
          }
        ]
      : [])
  ];
}
const isStopHandler = (value: unknown, integration: string) => {
  if (!value || typeof value !== "object") return false;
  const item = value as { type?: unknown; command?: unknown };
  return (
    item.type === "command" &&
    typeof item.command === "string" &&
    new RegExp(
      `(?:^|/)orchestrat['"]? hook ${integration} --event Stop(?:\\s|$)`
    ).test(item.command)
  );
};

// Reconciles the managed Stop handlers without touching user handlers. An
// unexpected Orchestrat Stop command is a conflict, like the other events.
function reconcileStop(
  hooks: Record<string, unknown>,
  integration: "codex" | "claude-code",
  command: string,
  stop: StopHookOptions
) {
  const desired = managedStopHandlers(command, integration, stop);
  const allowed = new Set([
    stopCommand(command, integration),
    stopCommand(command, integration, true)
  ]);
  if (hooks.Stop !== undefined && !Array.isArray(hooks.Stop))
    throw new Error("Existing Stop hooks must be an array");
  const groups = (hooks.Stop ?? []) as Record<string, unknown>[];
  let ours = 0;
  for (const group of groups) {
    const handlers = Array.isArray(group?.hooks) ? group.hooks : [];
    for (const handler of handlers)
      if (isStopHandler(handler, integration)) {
        ours += 1;
        if (!allowed.has((handler as { command: string }).command))
          throw new Error("Existing Orchestrat Stop hook conflicts");
      }
  }
  const exact = groups.filter(
    (group) =>
      group &&
      group.matcher === undefined &&
      JSON.stringify(group.hooks) === JSON.stringify(desired)
  );
  if (desired.length && exact.length === 1 && ours === desired.length) return;
  if (!desired.length && !ours) return;
  const kept = groups.flatMap((group) => {
    if (!group || !Array.isArray(group.hooks)) return [group];
    const handlers = (group.hooks as unknown[]).filter(
      (handler) => !isStopHandler(handler, integration)
    );
    if (handlers.length === (group.hooks as unknown[]).length) return [group];
    return handlers.length ? [{ ...group, hooks: handlers }] : [];
  });
  if (desired.length) kept.push({ hooks: desired });
  if (kept.length) hooks.Stop = kept;
  else delete hooks.Stop;
}

export function mergeJson(
  text: string | undefined,
  integration: "claude-code",
  command: string,
  global = false
) {
  const value = text === undefined ? {} : JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Claude configuration must be a JSON object");
  const root = value as Record<string, unknown>;
  const servers =
    root.mcpServers &&
    typeof root.mcpServers === "object" &&
    !Array.isArray(root.mcpServers)
      ? (root.mcpServers as Record<string, unknown>)
      : {};
  const current = servers.orchestrat;
  if (
    current !== undefined &&
    JSON.stringify(current) !==
      JSON.stringify({
        command,
        args: [
          "mcp",
          "--integration",
          integration,
          ...(global ? ["--global"] : [])
        ]
      })
  )
    throw new Error("Existing Orchestrat MCP entry conflicts");
  servers.orchestrat = {
    command,
    args: ["mcp", "--integration", integration, ...(global ? ["--global"] : [])]
  };
  root.mcpServers = servers;
  return `${JSON.stringify(root, null, 2)}\n`;
}

const tomlArgsPattern = (
  integration: string,
  global: boolean,
  attention: boolean | "any"
) =>
  new RegExp(
    `args\\s*=\\s*\\[\\s*"mcp"\\s*,\\s*"--integration"\\s*,\\s*"${integration}"${global ? '\\s*,\\s*"--global"' : ""}${
      attention === "any"
        ? `(?:\\s*,\\s*"--wait-budget-seconds"\\s*,\\s*"${WAIT_BUDGET_SECONDS}")?`
        : attention
          ? `\\s*,\\s*"--wait-budget-seconds"\\s*,\\s*"${WAIT_BUDGET_SECONDS}"`
          : ""
    }\\s*\\]`
  );
const tomlArgs = (integration: string, global: boolean, attention: boolean) =>
  `args = ["mcp", "--integration", ${JSON.stringify(integration)}${global ? ', "--global"' : ""}${attention ? `, "--wait-budget-seconds", "${WAIT_BUDGET_SECONDS}"` : ""}]`;
function tomlSection(source: string) {
  const match = /^[ \t]*\[mcp_servers\.orchestrat\][ \t]*$/m.exec(source);
  if (!match) return undefined;
  const bodyStart = match.index + match[0].length;
  const next = /\n[ \t]*\[/m.exec(source.slice(bodyStart));
  const end = next ? bodyStart + next.index + 1 : source.length;
  return { start: match.index, end, section: source.slice(match.index, end) };
}

export function mergeToml(
  text: string | undefined,
  integration: "codex",
  command: string,
  global = false,
  attention = false
) {
  const source = text ?? "";
  const found = tomlSection(source);
  if (found) {
    let { section } = found;
    if (
      !section.includes(`command = ${JSON.stringify(command)}`) ||
      !tomlArgsPattern(integration, global, "any").test(section)
    )
      throw new Error("Existing Orchestrat MCP entry conflicts");
    // Only rewrite what the opt-in changes, so an unchanged entry keeps the
    // user's formatting byte for byte.
    if (!tomlArgsPattern(integration, global, attention).test(section))
      section = section.replace(
        /^([ \t]*)args\s*=\s*\[[^\]]*\]/m,
        (_, indent: string) =>
          `${indent}${tomlArgs(integration, global, attention)}`
      );
    const timeout = `tool_timeout_sec = ${MCP_TOOL_TIMEOUT_SECONDS}`;
    if (attention) {
      if (/^[ \t]*tool_timeout_sec\s*=/m.test(section))
        section = section.replace(
          /^([ \t]*)tool_timeout_sec\s*=[^\n]*/m,
          (line, indent: string) =>
            line.trim() === timeout ? line : `${indent}${timeout}`
        );
      else
        section = section.replace(
          /^([ \t]*)args\s*=\s*\[[^\]]*\]/m,
          (line, indent: string) => `${line}\n${indent}${timeout}`
        );
    } else
      section = section.replace(
        new RegExp(
          `^[ \\t]*tool_timeout_sec\\s*=\\s*${MCP_TOOL_TIMEOUT_SECONDS}[ \\t]*(?:\\n|$)`,
          "m"
        ),
        ""
      );
    return `${source.slice(0, found.start)}${section}${source.slice(found.end)}`;
  }
  return `${source}${source && !source.endsWith("\n") ? "\n" : ""}\n[mcp_servers.orchestrat]\ncommand = ${JSON.stringify(command)}\n${tomlArgs(integration, global, attention)}\n${attention ? `tool_timeout_sec = ${MCP_TOOL_TIMEOUT_SECONDS}\n` : ""}`;
}

export function mergeHooks(
  text: string | undefined,
  integration: "codex" | "claude-code",
  command: string,
  stop: StopHookOptions = { enabled: false }
) {
  const executable = `'${command.replaceAll("'", "'\\''")}'`;
  const value = text === undefined ? {} : JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Hook configuration must be a JSON object");
  const root = value as Record<string, unknown>;
  const hooks =
    root.hooks && typeof root.hooks === "object" && !Array.isArray(root.hooks)
      ? (root.hooks as Record<string, unknown>)
      : {};
  for (const event of integration === "codex"
    ? ["SessionStart", "SessionEnd"]
    : ["SessionStart", "SessionEnd", "StopFailure"]) {
    const managed = {
      ...(event === "SessionStart" ? { matcher: "startup|resume" } : {}),
      hooks: [{ type: "command", command: `${executable} hook ${integration}` }]
    };
    const groups = Array.isArray(hooks[event])
      ? (hooks[event] as unknown[])
      : [];
    const hasOrchestratHandler = (value: unknown): boolean => {
      if (Array.isArray(value)) return value.some(hasOrchestratHandler);
      if (!value || typeof value !== "object") return false;
      const item = value as { type?: unknown; command?: unknown };
      if (item.type === "command" && typeof item.command === "string")
        return /(?:^|\/)orchestrat['"]? hook (codex|claude-code)(\s|$)/.test(
          item.command
        );
      return Object.values(value).some(hasOrchestratHandler);
    };
    let managedPresent = false;
    for (const group of groups) {
      const handlers =
        group &&
        typeof group === "object" &&
        Array.isArray((group as { hooks?: unknown }).hooks)
          ? (group as { hooks: { type?: unknown; command?: unknown }[] }).hooks
          : [];
      const ours = handlers.filter((handler) => hasOrchestratHandler(handler));
      if (!ours.length) continue;
      const matcher = (group as { matcher?: unknown }).matcher;
      const expectedMatcher =
        event === "SessionStart" ? "startup|resume" : undefined;
      if (
        matcher !== expectedMatcher ||
        ours.some((handler) => handler.command !== managed.hooks[0].command)
      )
        throw new Error(`Existing Orchestrat ${event} hook conflicts`);
      managedPresent = true;
    }
    if (!managedPresent) groups.push(managed);
    hooks[event] = groups;
  }
  reconcileStop(hooks, integration, command, stop);
  root.hooks = hooks;
  return `${JSON.stringify(root, null, 2)}\n`;
}

export function removeToml(
  text: string | undefined,
  integration: "codex",
  command: string,
  global = false
) {
  if (text === undefined) return text;
  const header = /^[ \t]*\[mcp_servers\.orchestrat\][ \t]*$/m;
  const match = header.exec(text);
  if (!match) return text;
  const start = match.index;
  const next = /\n[ \t]*\[/m.exec(text.slice(start + match[0].length));
  const end = next ? start + match[0].length + next.index + 1 : text.length;
  const section = text.slice(start, end);
  if (
    !section.includes(`command = ${JSON.stringify(command)}`) ||
    !tomlArgsPattern(integration, global, "any").test(section)
  )
    throw new Error("Existing Orchestrat MCP entry conflicts");
  return `${text.slice(0, start)}${text.slice(end).replace(/^\n/, "")}`;
}

export function removeJson(
  text: string | undefined,
  integration: "claude-code",
  command: string,
  global = false
) {
  if (text === undefined) return text;
  const root = JSON.parse(text) as Record<string, unknown>;
  const servers = root.mcpServers as Record<string, unknown> | undefined;
  const current = servers?.orchestrat;
  if (current === undefined) return text;
  if (
    JSON.stringify(current) !==
    JSON.stringify({
      command,
      args: [
        "mcp",
        "--integration",
        integration,
        ...(global ? ["--global"] : [])
      ]
    })
  )
    throw new Error("Existing Orchestrat MCP entry conflicts");
  delete servers!.orchestrat;
  return `${JSON.stringify(root, null, 2)}\n`;
}

export function removeHooks(
  text: string | undefined,
  integration: "codex" | "claude-code",
  command: string
) {
  if (text === undefined) return text;
  const root = JSON.parse(text) as Record<string, unknown>;
  const hooks = root.hooks as Record<string, unknown> | undefined;
  if (!hooks) return text;
  const managed = `'${command.replaceAll("'", "'\\''")}' hook ${integration}`;
  let removed = false;
  for (const event of integration === "codex"
    ? ["SessionStart", "SessionEnd"]
    : ["SessionStart", "SessionEnd", "StopFailure"]) {
    const groups = Array.isArray(hooks[event])
      ? (hooks[event] as Record<string, unknown>[])
      : [];
    hooks[event] = groups.flatMap((group) => {
      const handlers = Array.isArray(group.hooks)
        ? (group.hooks as Record<string, unknown>[])
        : [];
      const kept = handlers.filter((h) => {
        const match = h.type === "command" && h.command === managed;
        if (match) removed = true;
        return !match;
      });
      return kept.length ? [{ ...group, hooks: kept }] : [];
    });
    if (!(hooks[event] as unknown[]).length) delete hooks[event];
  }
  if (Array.isArray(hooks.Stop)) {
    // Removal never fails on a foreign Stop handler; it drops only ours.
    const allowed = new Set([
      stopCommand(command, integration),
      stopCommand(command, integration, true)
    ]);
    const groups = hooks.Stop as Record<string, unknown>[];
    hooks.Stop = groups.flatMap((group) => {
      if (!group || !Array.isArray(group.hooks)) return [group];
      const handlers = group.hooks as Record<string, unknown>[];
      const kept = handlers.filter(
        (h) => !(h?.type === "command" && allowed.has(h.command as string))
      );
      if (kept.length === handlers.length) return [group];
      removed = true;
      return kept.length ? [{ ...group, hooks: kept }] : [];
    });
    if (!(hooks.Stop as unknown[]).length) delete hooks.Stop;
  }
  return removed ? `${JSON.stringify(root, null, 2)}\n` : text;
}

const commandArgs = (
  command: string,
  integration: string,
  cwd?: string,
  global = false
) => [
  command,
  "mcp",
  "--integration",
  integration,
  ...(global ? ["--global"] : cwd ? ["--cwd", cwd] : [])
];
const jsonObject = (text: string | undefined, message: string) => {
  const value = text === undefined ? {} : JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(message);
  return value as Record<string, any>;
};
const managedCommand = (command: string, integration: string, event?: string) =>
  `'${command.replaceAll("'", "'\\''")}' hook ${integration}${event ? ` --event ${event}` : ""}`;

const flatMcpEntry = (
  command: string,
  integration: string,
  cwd: string | undefined,
  global: boolean,
  attention: boolean
) => ({
  command,
  args: [
    ...commandArgs(command, integration, cwd, global).slice(1),
    ...(attention ? ["--wait-budget-seconds", String(WAIT_BUDGET_SECONDS)] : [])
  ],
  ...(attention ? { timeoutSeconds: MCP_TOOL_TIMEOUT_SECONDS } : {})
});

// `attention` (Codex and Antigravity only) raises the MCP tool timeout and
// passes the wait budget so `wait_for_update` can hold for ten minutes.
export function mergeHarnessMcp(
  text: string | undefined,
  integration: ConfigurableIntegration,
  command: string,
  cwd?: string,
  global = false,
  attention = false
) {
  if (integration === "codex")
    return mergeToml(text, integration, command, global, attention);
  if (integration === "claude-code")
    return mergeJson(text, integration, command, global);
  const root = jsonObject(text, "Harness configuration must be a JSON object");
  const mcp =
    root.mcpServers &&
    typeof root.mcpServers === "object" &&
    !Array.isArray(root.mcpServers)
      ? root.mcpServers
      : {};
  const budgeted = attention && integration === "antigravity";
  const expected = flatMcpEntry(command, integration, cwd, global, budgeted);
  const alternate = flatMcpEntry(
    command,
    integration,
    cwd,
    global,
    integration === "antigravity" && !budgeted
  );
  if (
    mcp.orchestrat !== undefined &&
    JSON.stringify(mcp.orchestrat) !== JSON.stringify(expected) &&
    JSON.stringify(mcp.orchestrat) !== JSON.stringify(alternate)
  )
    throw new Error("Existing Orchestrat MCP entry conflicts");
  mcp.orchestrat = expected;
  root.mcpServers = mcp;

  return `${JSON.stringify(root, null, 2)}\n`;
}

export function removeHarnessMcp(
  text: string | undefined,
  integration: ConfigurableIntegration,
  command: string,
  cwd?: string,
  global = false
) {
  if (text === undefined) return text;
  if (integration === "codex")
    return removeToml(text, integration, command, global);
  if (integration === "claude-code")
    return removeJson(text, integration, command, global);
  const root = jsonObject(text, "Harness configuration must be a JSON object");
  const parent = root.mcpServers;
  const expected: Record<string, unknown> = flatMcpEntry(
    command,
    integration,
    cwd,
    global,
    false
  );
  const budgeted = flatMcpEntry(command, integration, cwd, global, true);
  if (parent?.orchestrat === undefined) return text;
  if (
    JSON.stringify(parent.orchestrat) !== JSON.stringify(expected) &&
    (integration !== "antigravity" ||
      JSON.stringify(parent.orchestrat) !== JSON.stringify(budgeted))
  )
    throw new Error("Existing Orchestrat MCP entry conflicts");
  delete parent.orchestrat;
  return `${JSON.stringify(root, null, 2)}\n`;
}

export function mergeHarnessHooks(
  text: string | undefined,
  integration: ConfigurableIntegration,
  command: string,
  stop: StopHookOptions = { enabled: false }
) {
  if (integration === "codex" || integration === "claude-code")
    return mergeHooks(text, integration, command, stop);
  const root = jsonObject(text, "Hook configuration must be a JSON object");
  if (integration === "cursor") {
    if (root.version !== undefined && root.version !== 1)
      throw new Error("Existing Cursor hook version conflicts");
    const hooks =
      root.hooks && typeof root.hooks === "object" && !Array.isArray(root.hooks)
        ? root.hooks
        : {};
    for (const event of ["sessionStart", "sessionEnd", "postToolUseFailure"]) {
      const expected = { command: managedCommand(command, integration, event) };
      if (hooks[event] !== undefined && !Array.isArray(hooks[event]))
        throw new Error(`Cursor ${event} hooks must be an array`);
      const entries = (hooks[event] ?? []) as { command?: unknown }[];
      const managed = entries.filter(
        (entry) =>
          typeof entry.command === "string" &&
          /(?:^|\/)orchestrat['"]? hook cursor(?:\s|$)/.test(entry.command)
      );
      if (managed.some((entry) => entry.command !== expected.command))
        throw new Error(`Existing Orchestrat ${event} hook conflicts`);
      if (!managed.length) entries.push(expected);
      hooks[event] = entries;
    }
    reconcileCursorStop(hooks, command, stop.enabled);
    root.version = 1;
    root.hooks = hooks;
  } else {
    const existing = root.orchestrat;
    const expected = {
      PreInvocation: [
        { command: managedCommand(command, integration, "PreInvocation") }
      ],
      Stop: [{ command: managedCommand(command, integration, "Stop") }]
    };
    if (
      existing !== undefined &&
      JSON.stringify(existing) !== JSON.stringify(expected)
    )
      throw new Error("Existing Orchestrat hook entry conflicts");
    root.orchestrat = expected;
  }
  return `${JSON.stringify(root, null, 2)}\n`;
}

// Cursor's `stop` fires every turn. The managed entry keeps the lifecycle
// ingest and adds `followup_message`; `loop_limit` caps continuations.
function reconcileCursorStop(
  hooks: Record<string, unknown>,
  command: string,
  enabled: boolean
) {
  if (hooks.stop !== undefined && !Array.isArray(hooks.stop))
    throw new Error("Cursor stop hooks must be an array");
  const entries = (hooks.stop ?? []) as { command?: unknown }[];
  const expected = {
    command: managedCommand(command, "cursor", "stop"),
    loop_limit: CURSOR_STOP_LOOP_LIMIT
  };
  const managed = entries.filter(
    (entry) =>
      typeof entry?.command === "string" &&
      /(?:^|\/)orchestrat['"]? hook cursor(?:\s|$)/.test(entry.command)
  );
  if (managed.some((entry) => entry.command !== expected.command))
    throw new Error("Existing Orchestrat stop hook conflicts");
  if (
    enabled &&
    managed.length === 1 &&
    JSON.stringify(managed[0]) === JSON.stringify(expected)
  )
    return;
  if (!enabled && !managed.length) return;
  const kept = entries.filter((entry) => !managed.includes(entry));
  if (enabled) kept.push(expected);
  if (kept.length) hooks.stop = kept;
  else delete hooks.stop;
}

export function removeHarnessHooks(
  text: string | undefined,
  integration: ConfigurableIntegration,
  command: string
) {
  if (text === undefined) return text;
  if (integration === "codex" || integration === "claude-code")
    return removeHooks(text, integration, command);
  const root = jsonObject(text, "Hook configuration must be a JSON object");
  if (integration === "cursor") {
    const hooks = root.hooks;
    if (!hooks) return text;
    for (const event of ["sessionStart", "sessionEnd", "postToolUseFailure"]) {
      const expected = managedCommand(command, integration, event);
      if (hooks[event] === undefined) continue;
      if (!Array.isArray(hooks[event]))
        throw new Error(`Cursor ${event} hooks must be an array`);
      const entries = hooks[event] as { command?: unknown }[];
      const managed = entries.filter(
        (entry) =>
          typeof entry.command === "string" &&
          /(?:^|\/)orchestrat['"]? hook cursor(?:\s|$)/.test(entry.command)
      );
      if (managed.some((entry) => entry.command !== expected))
        throw new Error(`Existing Orchestrat ${event} hook conflicts`);
      const kept = entries.filter((entry) => entry.command !== expected);
      if (kept.length) hooks[event] = kept;
      else delete hooks[event];
    }
    if (Array.isArray(hooks.stop)) {
      const expected = managedCommand(command, integration, "stop");
      const kept = (hooks.stop as { command?: unknown }[]).filter(
        (entry) => entry?.command !== expected
      );
      if (kept.length) hooks.stop = kept;
      else delete hooks.stop;
    }
    if (!Object.keys(hooks).length) delete root.hooks;
  } else {
    const expected = {
      PreInvocation: [
        { command: managedCommand(command, integration, "PreInvocation") }
      ],
      Stop: [{ command: managedCommand(command, integration, "Stop") }]
    };
    if (root.orchestrat === undefined) return text;
    if (JSON.stringify(root.orchestrat) !== JSON.stringify(expected))
      throw new Error("Existing Orchestrat hook entry conflicts");
    delete root.orchestrat;
  }
  return `${JSON.stringify(root, null, 2)}\n`;
}
