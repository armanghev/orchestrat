import {
  findMapping,
  findProject,
  type Integration,
  type OrchestratConfig,
  type ResolvedMapping
} from "./config.js";
import type { CredentialReader } from "./keychain.js";

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
  const credential = await input.credentials.read(input.integration);
  if (!credential)
    throw new Error(`No ${input.integration} credential found in Keychain`);
  return { mapping, credential, public: publicMapping(mapping) };
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
