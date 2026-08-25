import {
  findMapping,
  findProject,
  type Integration,
  type OrchestratConfig,
  type ResolvedMapping
} from "./config.js";
import {
  agentAccount,
  legacyAgentAccount,
  type CredentialReader
} from "./keychain.js";

export type Invocation = {
  cwd: string;
  integration?: Integration;
  read: (home?: string) => Promise<OrchestratConfig>;
  credentials?: CredentialReader;
  home?: string;
};

export async function resolveInvocation(input: Invocation) {
  const config = await input.read(input.home);
  if (!input.integration) {
    const project = findProject(config, input.cwd);
    return {
      public: project
        ? {
            configured: true,
            ...project,
            integrations: Object.keys(project.integrations)
          }
        : { configured: false, cwd: input.cwd, integrations: [] }
    };
  }
  const mapping = findMapping(config, input.cwd, input.integration);
  if (!mapping)
    throw new Error(
      `No ${input.integration} project mapping found for ${input.cwd}`
    );
  if (!input.credentials) throw new Error("Credential reader is unavailable");
  const credential =
    (await input.credentials.read(
      agentAccount(mapping.projectId, input.integration)
    )) ??
    (await input.credentials.read(legacyAgentAccount(input.integration))) ??
    (await input.credentials.read(input.integration));
  if (!credential)
    throw new Error(`No ${input.integration} credential found in Keychain`);
  return { mapping, credential, public: publicMapping(mapping) };
}

export async function resolveGlobalInvocation(input: {
  integration: Integration;
  read: (home?: string) => Promise<OrchestratConfig>;
  credentials: CredentialReader;
  home?: string;
}) {
  const config = await input.read(input.home);
  const projects = await Promise.all(
    Object.entries(config.globalProjects?.[input.integration] ?? {}).map(
      async ([projectId, project]) => {
        const credential = await input.credentials.read(
          agentAccount(projectId, input.integration)
        );
        if (!credential)
          throw new Error(
            `No ${input.integration} credential found in Keychain for ${project.organizationName} / ${project.name}`
          );
        return { projectId, ...project, credential };
      }
    )
  );
  if (!projects.length)
    throw new Error(`No global ${input.integration} projects are configured`);
  return projects;
}

function publicMapping(mapping: ResolvedMapping) {
  return {
    configured: true,
    cwd: mapping.cwd,
    projectId: mapping.projectId,
    integration: mapping.integration,
    agentId: mapping.agentId
  };
}
