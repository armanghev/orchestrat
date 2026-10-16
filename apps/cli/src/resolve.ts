import {
  apiOrigin,
  findMapping,
  findProject,
  type Integration,
  type OrchestratConfig,
  type ResolvedMapping
} from "./config.js";
import { agentAccount, type CredentialReader } from "./keychain.js";

export type Invocation = {
  cwd: string;
  api?: string;
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
  const server = input.api ?? mapping.apiUrl;
  if (!server)
    throw new Error(
      `No Orchestrat server URL for ${mapping.cwd}; run orchestrat setup --server <url> there or set ORCHESTRAT_API_URL`
    );
  const api = apiOrigin(server);
  const credential = await input.credentials.read(
    agentAccount(mapping.projectId, input.integration, api)
  );
  if (!credential)
    throw new Error(
      `No ${input.integration} credential found for this API; run orchestrat setup`
    );
  return { mapping, credential, api, public: publicMapping(mapping) };
}

export async function resolveGlobalInvocation(input: {
  api?: string;
  integration: Integration;
  read: (home?: string) => Promise<OrchestratConfig>;
  credentials: CredentialReader;
  home?: string;
  warn?: (message: string) => void;
}) {
  const config = await input.read(input.home);
  const configured = Object.entries(
    config.globalProjects?.[input.integration] ?? {}
  );
  if (!configured.length)
    throw new Error(`No global ${input.integration} projects are configured`);
  const resolved = await Promise.all(
    configured.map(async ([projectId, project]) => {
      const server = project.apiUrl ?? input.api;
      const apiUrl = server === undefined ? undefined : apiOrigin(server);
      const credential =
        apiUrl === undefined
          ? undefined
          : await input.credentials.read(
              agentAccount(projectId, input.integration, apiUrl)
            );
      return { projectId, ...project, apiUrl, credential };
    })
  );
  // One stale project (credential removed or never issued, or no known
  // server) must not take the whole global connection down; skip it and say
  // so on stderr.
  const projects = resolved.flatMap(({ credential, apiUrl, ...project }) =>
    credential && apiUrl ? [{ ...project, apiUrl, credential }] : []
  );
  const missing = resolved.filter(
    (project) => !project.credential || !project.apiUrl
  );
  const reason = (project: (typeof missing)[number]) =>
    project.apiUrl
      ? `no ${input.integration} credential on this API`
      : "no server URL";
  if (!projects.length) {
    const [first] = missing;
    throw new Error(
      first!.apiUrl
        ? `No ${input.integration} credential found for ${first!.organizationName} / ${first!.name} on this API; run orchestrat setup`
        : `No Orchestrat server URL for ${first!.organizationName} / ${first!.name}; run orchestrat setup --server <url> or set ORCHESTRAT_API_URL`
    );
  }
  for (const project of missing)
    input.warn?.(
      `orchestrat: skipping ${project.organizationName} / ${project.name}: ${reason(project)}; run orchestrat setup to reconnect it\n`
    );
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
