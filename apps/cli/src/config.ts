import { readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  CONFIGURABLE_INTEGRATIONS,
  type ConfigurableIntegration
} from "./harnesses.js";

export const INTEGRATIONS = CONFIGURABLE_INTEGRATIONS;
export const DEFAULT_API_URL = "https://api.orchestrat.dev";
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
export type OrchestratConfig = {
  version: 1;
  projects: Record<string, ProjectMapping>;
  globalProjects?: Partial<Record<Integration, Record<string, GlobalProject>>>;
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
  return {
    version: 1,
    projects,
    ...(Object.keys(globalProjects).length ? { globalProjects } : {})
  };
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
