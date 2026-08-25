import {
  copyFile,
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
  if (existing !== undefined && backup)
    await copyFile(path, `${path}.orchestrat-backup`);
  afterBackup?.();
  const directory = await mkdtemp(join(dirname(path), ".orchestrat-"));
  const temporary = join(directory, "config");
  try {
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  return true;
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
        args: ["mcp", "--integration", integration, ...(global ? ["--global"] : [])]
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

export function mergeToml(
  text: string | undefined,
  integration: "codex",
  command: string,
  global = false
) {
  const source = text ?? "";
  if (/^[ \t]*\[mcp_servers\.orchestrat\][ \t]*$/m.test(source)) {
    const start = source.search(/^[ \t]*\[mcp_servers\.orchestrat\][ \t]*$/m);
    const rest = source.slice(start);
    const section = rest.slice(
      0,
      rest.search(/\n[ \t]*\[/) >= 0 ? rest.search(/\n[ \t]*\[/) : rest.length
    );
    const expectedArgs = new RegExp(
      `args\\s*=\\s*\\[\\s*"mcp"\\s*,\\s*"--integration"\\s*,\\s*"${integration}"${global ? '\\s*,\\s*"--global"' : ""}\\s*\\]`
    );
    if (
      !section.includes(`command = ${JSON.stringify(command)}`) ||
      !expectedArgs.test(section)
    )
      throw new Error("Existing Orchestrat MCP entry conflicts");
    return source;
  }
  return `${source}${source && !source.endsWith("\n") ? "\n" : ""}\n[mcp_servers.orchestrat]\ncommand = ${JSON.stringify(command)}\nargs = ["mcp", "--integration", ${JSON.stringify(integration)}${global ? ', "--global"' : ""}]\n`;
}

export function mergeHooks(
  text: string | undefined,
  integration: "codex" | "claude-code",
  command: string
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
  const args = new RegExp(
    `args\\s*=\\s*\\[\\s*"mcp"\\s*,\\s*"--integration"\\s*,\\s*"${integration}"${global ? '\\s*,\\s*"--global"' : ""}\\s*\\]`
  );
  if (
    !section.includes(`command = ${JSON.stringify(command)}`) ||
    !args.test(section)
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
      args: ["mcp", "--integration", integration, ...(global ? ["--global"] : [])]
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

export function mergeHarnessMcp(
  text: string | undefined,
  integration: ConfigurableIntegration,
  command: string,
  cwd?: string,
  global = false
) {
  if (integration === "codex")
    return mergeToml(text, integration, command, global);
  if (integration === "claude-code")
    return mergeJson(text, integration, command, global);
  const root = jsonObject(text, "Harness configuration must be a JSON object");
  if (integration === "opencode") {
    const mcp =
      root.mcp && typeof root.mcp === "object" && !Array.isArray(root.mcp)
        ? root.mcp
        : {};
    const servers =
      mcp.servers &&
      typeof mcp.servers === "object" &&
      !Array.isArray(mcp.servers)
        ? mcp.servers
        : {};
    const expected = {
      type: "local",
      command: commandArgs(command, integration, cwd, global)
    };
    if (
      servers.orchestrat !== undefined &&
      JSON.stringify(servers.orchestrat) !== JSON.stringify(expected)
    )
      throw new Error("Existing Orchestrat MCP entry conflicts");
    servers.orchestrat = expected;
    root.mcp = { ...mcp, servers };
  } else {
    const mcp =
      root.mcpServers &&
      typeof root.mcpServers === "object" &&
      !Array.isArray(root.mcpServers)
        ? root.mcpServers
        : {};
    const expected = {
      command,
      args: commandArgs(command, integration, cwd, global).slice(1)
    };
    if (
      mcp.orchestrat !== undefined &&
      JSON.stringify(mcp.orchestrat) !== JSON.stringify(expected)
    )
      throw new Error("Existing Orchestrat MCP entry conflicts");
    mcp.orchestrat = expected;
    root.mcpServers = mcp;
  }
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
  const parent =
    integration === "opencode" ? root.mcp?.servers : root.mcpServers;
  const expected =
    integration === "opencode"
      ? { type: "local", command: commandArgs(command, integration, cwd, global) }
      : {
          command,
          args: commandArgs(command, integration, cwd, global).slice(1)
        };
  if (parent?.orchestrat === undefined) return text;
  if (JSON.stringify(parent.orchestrat) !== JSON.stringify(expected))
    throw new Error("Existing Orchestrat MCP entry conflicts");
  delete parent.orchestrat;
  return `${JSON.stringify(root, null, 2)}\n`;
}

export function mergeHarnessHooks(
  text: string | undefined,
  integration: ConfigurableIntegration,
  command: string
) {
  if (integration === "codex" || integration === "claude-code")
    return mergeHooks(text, integration, command);
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
