import { readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const INTEGRATIONS = ["codex", "claude-code"] as const;
export type Integration = (typeof INTEGRATIONS)[number];

export type IntegrationMapping = { agentId: string };
export type ProjectMapping = {
  projectId: string;
  integrations: Partial<Record<Integration, IntegrationMapping>>;
};
export type OrchestratConfig = {
  version: 1;
  projects: Record<string, ProjectMapping>;
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
    projects[canonicalizeCwd(cwd)] = {
      projectId: project.projectId,
      integrations
    };
  }
  return { version: 1, projects };
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
