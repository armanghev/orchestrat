import { readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  CONFIGURABLE_INTEGRATIONS,
  type ConfigurableIntegration
} from "./harnesses.js";

export const INTEGRATIONS = CONFIGURABLE_INTEGRATIONS;
// Integrations removed from the product. Old configs may still name them;
// their entries are dropped on read (and so on the next write).
const RETIRED_INTEGRATIONS: ReadonlySet<string> = new Set(["opencode"]);
// Only ever shown as a suggestion; there is no default server.
export const SUGGESTED_SERVER_URL = "http://localhost:8801";
export const MISSING_SERVER_MESSAGE = `No Orchestrat server URL. Run orchestrat setup --server <url> (for example --server ${SUGGESTED_SERVER_URL}) or set ORCHESTRAT_API_URL.`;
export type Integration = ConfigurableIntegration;

export type IntegrationMapping = { agentId: string };
export type McpScope = "project" | "global";
export type GlobalProject = {
  name: string;
  organizationName: string;
  apiUrl?: string;
  agentId: string;
};
export type ProjectMapping = {
  projectId: string;
  apiUrl?: string;
  mcpScopes?: Partial<Record<Integration, McpScope>>;
  integrations: Partial<Record<Integration, IntegrationMapping>>;
};
// Opt-in intrusive wake-ups (spec §11.3, §19.1). Absent means off.
export type AttentionConfig = {
  continue_on_stop?: ConfigurableIntegration[];
  rewake?: boolean;
};
export type OrchestratConfig = {
  version: 1;
  projects: Record<string, ProjectMapping>;
  globalProjects?: Partial<Record<Integration, Record<string, GlobalProject>>>;
  attention?: AttentionConfig;
  // Validated by waker.ts; preserved verbatim here so other commands keep it.
  waker?: Record<string, unknown>;
};
export type ResolvedMapping = ProjectMapping & {
  cwd: string;
  integration: Integration;
  agentId: string;
};
export type ResolvedProject = ProjectMapping & { cwd: string };

export const configPath = (home = homedir()) =>
  join(home, ".orchestrat", "config.json");

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function validateApiUrl(value: unknown): string | undefined {
  if (!nonEmpty(value)) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid API URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error("Invalid API URL");
  return url.origin;
}

export function apiOrigin(value: string): string {
  const origin = validateApiUrl(value);
  if (!origin) throw new Error("API URL is required");
  return origin;
}

// The server is never implied: --server, then ORCHESTRAT_API_URL, then the
// project's saved apiUrl. Undefined means the caller must ask or fail.
export function resolveServerUrl(input: {
  flag?: string;
  env?: string;
  projectApiUrl?: string;
}): string | undefined {
  if (input.flag !== undefined) {
    try {
      const origin = validateApiUrl(input.flag);
      if (origin) return origin;
    } catch {
      // Reported below with the flag's name.
    }
    throw new Error("Invalid --server URL; use an http(s) URL");
  }
  let env: string | undefined;
  try {
    env = validateApiUrl(input.env);
  } catch {
    throw new Error("Invalid ORCHESTRAT_API_URL; use an http(s) URL");
  }
  return env ?? validateApiUrl(input.projectApiUrl);
}

export function parseConfig(value: unknown): OrchestratConfig {
  if (!value || typeof value !== "object")
    throw new Error("Invalid Orchestrat config");
  const input = value as Record<string, unknown>;
  if (
    input.version !== 1 ||
    !input.projects ||
    typeof input.projects !== "object"
  ) {
    throw new Error("Unsupported Orchestrat config version");
  }
  const projects: Record<string, ProjectMapping> = {};
  for (const [cwd, rawProject] of Object.entries(
    input.projects as Record<string, unknown>
  )) {
    if (!nonEmpty(cwd) || !rawProject || typeof rawProject !== "object")
      throw new Error("Invalid project mapping");
    const project = rawProject as Record<string, unknown>;
    if (
      !nonEmpty(project.projectId) ||
      !project.integrations ||
      typeof project.integrations !== "object"
    ) {
      throw new Error("Invalid project mapping");
    }
    const integrations: Partial<Record<Integration, IntegrationMapping>> = {};
    for (const [integration, rawAgent] of Object.entries(
      project.integrations as Record<string, unknown>
    )) {
      if (RETIRED_INTEGRATIONS.has(integration)) continue;
      if (
        !(INTEGRATIONS as readonly string[]).includes(integration) ||
        !rawAgent ||
        typeof rawAgent !== "object"
      ) {
        throw new Error("Invalid integration mapping");
      }
      const agent = rawAgent as Record<string, unknown>;
      if (!nonEmpty(agent.agentId))
        throw new Error("Invalid integration mapping");
      integrations[integration as Integration] = { agentId: agent.agentId };
    }
    const mcpScopes: Partial<Record<Integration, McpScope>> = {};
    if (project.mcpScopes !== undefined) {
      if (!project.mcpScopes || typeof project.mcpScopes !== "object")
        throw new Error("Invalid project mapping");
      for (const [integration, scope] of Object.entries(
        project.mcpScopes as Record<string, unknown>
      )) {
        if (RETIRED_INTEGRATIONS.has(integration)) continue;
        if (
          !(INTEGRATIONS as readonly string[]).includes(integration) ||
          (scope !== "project" && scope !== "global")
        )
          throw new Error("Invalid project mapping");
        mcpScopes[integration as Integration] = scope;
      }
    }
    if (project.cursorMcpScope !== undefined) {
      if (
        project.cursorMcpScope !== "project" &&
        project.cursorMcpScope !== "global"
      )
        throw new Error("Invalid project mapping");
      if (
        mcpScopes.cursor !== undefined &&
        mcpScopes.cursor !== project.cursorMcpScope
      )
        throw new Error("Invalid project mapping");
      mcpScopes.cursor = project.cursorMcpScope;
    }
    projects[canonicalizeCwd(cwd)] = {
      projectId: project.projectId,
      ...(project.apiUrl === undefined
        ? {}
        : { apiUrl: validateApiUrl(project.apiUrl) }),
      ...(Object.keys(mcpScopes).length ? { mcpScopes } : {}),
      integrations
    };
  }
  const globalProjects: Partial<
    Record<Integration, Record<string, GlobalProject>>
  > = {};
  const parseGlobalProjects = (
    projectsInput: unknown,
    integration: Integration
  ) => {
    if (!projectsInput || typeof projectsInput !== "object")
      throw new Error("Invalid global MCP mapping");
    const mapped: Record<string, GlobalProject> = {};
    for (const [projectId, rawProject] of Object.entries(
      projectsInput as Record<string, unknown>
    )) {
      if (!nonEmpty(projectId) || !rawProject || typeof rawProject !== "object")
        throw new Error("Invalid global MCP mapping");
      const project = rawProject as Record<string, unknown>;
      if (
        !nonEmpty(project.name) ||
        !nonEmpty(project.organizationName) ||
        !nonEmpty(project.agentId)
      )
        throw new Error("Invalid global MCP mapping");
      mapped[projectId] = {
        name: project.name,
        organizationName: project.organizationName,
        agentId: project.agentId,
        ...(project.apiUrl === undefined
          ? {}
          : { apiUrl: validateApiUrl(project.apiUrl) })
      };
    }
    globalProjects[integration] = mapped;
  };
  if (input.globalProjects !== undefined) {
    if (!input.globalProjects || typeof input.globalProjects !== "object")
      throw new Error("Invalid global MCP mapping");
    for (const [integration, projects] of Object.entries(
      input.globalProjects as Record<string, unknown>
    )) {
      if (RETIRED_INTEGRATIONS.has(integration)) continue;
      if (!(INTEGRATIONS as readonly string[]).includes(integration))
        throw new Error("Invalid global MCP mapping");
      parseGlobalProjects(projects, integration as Integration);
    }
  }
  if (input.globalCursorProjects !== undefined) {
    if (globalProjects.cursor !== undefined)
      throw new Error("Invalid global MCP mapping");
    parseGlobalProjects(input.globalCursorProjects, "cursor");
  }
  const attention = parseAttention(input.attention);
  if (
    input.waker !== undefined &&
    (!input.waker ||
      typeof input.waker !== "object" ||
      Array.isArray(input.waker))
  )
    throw new Error("Invalid waker config");
  return {
    version: 1,
    projects,
    ...(Object.keys(globalProjects).length ? { globalProjects } : {}),
    ...(attention ? { attention } : {}),
    ...(input.waker === undefined
      ? {}
      : { waker: input.waker as Record<string, unknown> })
  };
}

function parseAttention(value: unknown): AttentionConfig | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid attention config");
  const input = value as Record<string, unknown>;
  const attention: AttentionConfig = {};
  if (input.continue_on_stop !== undefined) {
    if (Array.isArray(input.continue_on_stop))
      input.continue_on_stop = input.continue_on_stop.filter(
        (item) => typeof item !== "string" || !RETIRED_INTEGRATIONS.has(item)
      );
    if (
      !Array.isArray(input.continue_on_stop) ||
      input.continue_on_stop.some(
        (item) =>
          typeof item !== "string" ||
          !(INTEGRATIONS as readonly string[]).includes(item)
      )
    )
      throw new Error("Invalid attention config");
    attention.continue_on_stop = [
      ...new Set(input.continue_on_stop as ConfigurableIntegration[])
    ];
  }
  if (input.rewake !== undefined) {
    if (typeof input.rewake !== "boolean")
      throw new Error("Invalid attention config");
    attention.rewake = input.rewake;
  }
  return attention;
}

export function continuesOnStop(
  config: OrchestratConfig,
  integration: Integration
) {
  return config.attention?.continue_on_stop?.includes(integration) ?? false;
}

export function rewakeEnabled(config: OrchestratConfig) {
  return (
    continuesOnStop(config, "claude-code") && config.attention?.rewake === true
  );
}

export async function readConfig(home = homedir()): Promise<OrchestratConfig> {
  try {
    return parseConfig(JSON.parse(await readFile(configPath(home), "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { version: 1, projects: {} };
    throw error;
  }
}

export function canonicalizeCwd(cwd: string): string {
  const absolute = resolve(cwd);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

export function findProject(
  config: OrchestratConfig,
  cwd: string
): ResolvedProject | undefined {
  let current = canonicalizeCwd(cwd);
  while (true) {
    const project = config.projects[current];
    if (project) return { ...project, cwd: current };
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export function findMapping(
  config: OrchestratConfig,
  cwd: string,
  integration: Integration
): ResolvedMapping | undefined {
  const project = findProject(config, cwd);
  const agent = project?.integrations[integration];
  return project && agent
    ? { ...project, integration, agentId: agent.agentId }
    : undefined;
}
