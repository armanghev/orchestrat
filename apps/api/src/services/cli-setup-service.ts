import { createHash } from "node:crypto";
import { cliCredentials, type Database } from "@orchestrat/db";
import { and, eq, isNull } from "drizzle-orm";
import { ApiError } from "./api-error.js";
import { AgentService, type Transaction } from "./agent-service.js";
import { PermissionService } from "./permission-service.js";
import type { CliSetupIntegration } from "@orchestrat/protocol";

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export class CliSetupService {
  private readonly agents: AgentService;
  private readonly permissions: PermissionService;
  constructor(private readonly db: Database) {
    this.agents = new AgentService(db);
    this.permissions = new PermissionService(db);
  }
  private async credential(token: string) {
    if (!/^orch_cli_[A-Za-z0-9_-]{32,}$/.test(token))
      throw new ApiError(401, "UNAUTHENTICATED", "CLI credential is invalid.");
    const [credential] = await this.db
      .select()
      .from(cliCredentials)
      .where(
        and(
          eq(cliCredentials.tokenHash, hash(token)),
          isNull(cliCredentials.revokedAt)
        )
      )
      .limit(1);
    if (!credential)
      throw new ApiError(401, "UNAUTHENTICATED", "CLI credential is invalid.");
    return credential;
  }
  async project(token: string) {
    const credential = await this.credential(token);
    if (credential.projectId)
      await this.permissions.projectAccess(
        credential.userId,
        credential.projectId
      );
    return { project_id: credential.projectId };
  }
  async projects(token: string) {
    const credential = await this.credential(token);
    if (credential.projectId) {
      const project = await this.permissions.project(
        credential.userId,
        credential.projectId
      );
      const record = (await this.permissions.projects(credential.userId)).find(
        (candidate) => candidate.id === credential.projectId
      );
      const organizationName = record?.organizationName;
      if (!organizationName)
        throw new ApiError(
          403,
          "PERMISSION_DENIED",
          "CLI credential is not authorized for this project."
        );
      return {
        projects: [
          {
            id: project.id,
            name: project.name,
            organization_name: organizationName
          }
        ]
      };
    }
    const projects = await this.permissions.projects(credential.userId);
    return {
      projects: projects.map((project) => ({
        id: project.id,
        name: project.name,
        organization_name: project.organizationName
      }))
    };
  }
  private async authorizeProject(
    credential: Awaited<ReturnType<CliSetupService["credential"]>>,
    projectId: string
  ) {
    if (credential.projectId && credential.projectId !== projectId)
      throw new ApiError(
        403,
        "PERMISSION_DENIED",
        "CLI credential is not authorized for this project."
      );
    await this.permissions.projectAccess(credential.userId, projectId);
  }
  async setup(
    token: string,
    projectId: string,
    integration: CliSetupIntegration
  ) {
    const credential = await this.credential(token);
    await this.authorizeProject(credential, projectId);
    const agent = await this.agents.createAgent(credential.userId, projectId, {
      name: integration
    });
    return {
      project_id: projectId,
      integration,
      agent,
      credential: await this.agents.issueCredential(
        credential.userId,
        projectId,
        agent.id
      )
    };
  }
  async disconnect(
    token: string,
    projectId: string,
    agentIds: string[],
    revokeCli: boolean
  ) {
    const credential = await this.credential(token);
    await this.authorizeProject(credential, projectId);
    const uniqueAgentIds = [...new Set(agentIds)];
    await this.db.transaction(async (tx: Transaction) => {
      await this.agents.revokeAgents(
        credential.userId,
        projectId,
        uniqueAgentIds,
        tx
      );
      if (revokeCli)
        await tx
          .update(cliCredentials)
          .set({ revokedAt: new Date() })
          .where(eq(cliCredentials.id, credential.id));
    });
    return {
      project_id: projectId,
      revoked_agent_ids: uniqueAgentIds,
      cli_revoked: revokeCli
    };
  }
}
