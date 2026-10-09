import { randomUUID } from "node:crypto";
import {
  organizationIntegrations,
  organizationRepositories,
  projects,
  repositoryConnectionAttempts,
  repositoryConnections,
  type Database
} from "@orchestrat/db";
import type {
  CreateIntegrationAuthorizationRequest,
  CreateOrganizationIntegrationRequest,
  OrganizationIntegration,
  OrganizationRepository,
  UpdateOrganizationIntegrationRequest
} from "@orchestrat/protocol";
import { and, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { ApiError } from "../api-error.js";
import { PermissionService } from "../permission-service.js";
import { provider, type RepositoryService } from "./connection-service.js";
import { aad } from "./secrets.js";
import {
  ProviderAuthorizationError,
  type IntegrationRow,
  type ProviderName
} from "./types.js";

// Organization Git integrations: a GitHub App installation or a GitLab
// account connected once to an organization (owners and admins only). The
// server caches the repositories each one reaches, so the dashboard can
// suggest new ones, and imports one as a project with its connection.

type RepositoryRow = typeof organizationRepositories.$inferSelect;
const INTEGRATION_PROVIDERS = ["github", "gitlab"] as const;
/** A repository seen this long after the integration connected is "new". */
const NEW_AFTER_MS = 5 * 60_000;

export class IntegrationService {
  private readonly permissions: PermissionService;
  private readonly requested = new Set<string>();

  constructor(
    private readonly db: Database,
    private readonly repositories: RepositoryService,
    private readonly options: {
      refreshIntervalSeconds: number;
      now?: () => Date;
    }
  ) {
    this.permissions = new PermissionService(db);
  }

  private now() {
    return this.options.now?.() ?? new Date();
  }

  private adapter(name: ProviderName) {
    return this.repositories.adapter(name);
  }

  private async integration(organizationId: string, integrationId: string) {
    const [row] = await this.db
      .select()
      .from(organizationIntegrations)
      .where(
        and(
          eq(organizationIntegrations.id, integrationId),
          eq(organizationIntegrations.organizationId, organizationId)
        )
      )
      .limit(1);
    if (!row) throw new ApiError(404, "NOT_FOUND", "Integration not found.");
    return row;
  }

  private async json(row: IntegrationRow): Promise<OrganizationIntegration> {
    const [reachable] = await this.db
      .select({ value: count() })
      .from(organizationRepositories)
      .where(
        and(
          eq(organizationRepositories.integrationId, row.id),
          isNull(organizationRepositories.removedAt)
        )
      );
    const adapter = this.repositories.adapters.get(row.provider);
    return {
      id: row.id,
      organization_id: row.organizationId,
      provider: row.provider,
      account_name: row.accountName,
      account_type: row.accountType,
      repository_selection: row.repositorySelection,
      selected_repository_ids:
        row.repositorySelection === "selected" ? row.selectedRepositoryIds : [],
      repository_count: Number(reachable?.value ?? 0),
      status: row.status,
      status_reason: row.statusReason,
      manage_url: adapter?.manageUrl?.(row) ?? null,
      connected_by_user_id: row.connectedByUserId,
      last_synced_at: row.lastSyncedAt?.toISOString() ?? null,
      created_at: row.createdAt.toISOString(),
      updated_at: row.updatedAt.toISOString()
    };
  }

  async list(userId: string, organizationId: string) {
    await this.permissions.organizationEditor(userId, organizationId);
    const rows = await this.db
      .select()
      .from(organizationIntegrations)
      .where(eq(organizationIntegrations.organizationId, organizationId))
      .orderBy(
        organizationIntegrations.provider,
        organizationIntegrations.createdAt
      );
    return {
      integrations: await Promise.all(rows.map((row) => this.json(row)))
    };
  }

  async authorize(
    userId: string,
    organizationId: string,
    input: CreateIntegrationAuthorizationRequest
  ) {
    await this.permissions.organizationEditor(userId, organizationId);
    return this.repositories.startAttempt({ organizationId }, userId, input);
  }

  /** After the provider redirect: what this person can connect. */
  async authorizationOptions(
    userId: string,
    organizationId: string,
    attemptId: string
  ) {
    await this.permissions.organizationEditor(userId, organizationId);
    const { attempt, adapter, userToken } =
      await this.repositories.authorizedAttempt(
        userId,
        { organizationId },
        attemptId
      );
    if (attempt.provider === "github") {
      const existing = await this.db
        .select({ installationId: organizationIntegrations.installationId })
        .from(organizationIntegrations)
        .where(
          and(
            eq(organizationIntegrations.organizationId, organizationId),
            eq(organizationIntegrations.provider, "github")
          )
        );
      const connected = new Set(existing.map((row) => row.installationId));
      const installations = await provider(() =>
        adapter.listInstallations!(userToken)
      );
      return {
        provider: "github" as const,
        installations: installations
          .filter((installation) => !installation.suspended)
          .map((installation) => ({
            installation_id: installation.installationId,
            account_name: installation.accountName,
            account_type: installation.accountType,
            repository_selection: installation.repositorySelection,
            connected: connected.has(installation.installationId)
          })),
        install_url: adapter.installUrl?.(attempt.id) ?? null,
        repositories: []
      };
    }
    if (attempt.provider !== "gitlab")
      throw new ApiError(400, "VALIDATION_ERROR", "Not an integration.");
    return {
      provider: "gitlab" as const,
      installations: [],
      install_url: null,
      repositories: await provider(() =>
        adapter.listCandidates({ attempt, userToken })
      )
    };
  }

  async create(
    userId: string,
    organizationId: string,
    input: CreateOrganizationIntegrationRequest
  ) {
    await this.permissions.organizationEditor(userId, organizationId);
    const { attempt, adapter, secrets, userToken } =
      await this.repositories.authorizedAttempt(
        userId,
        { organizationId },
        input.authorization_id
      );
    if (attempt.provider !== input.provider)
      throw new ApiError(
        400,
        "VALIDATION_ERROR",
        "The authorization is for another provider."
      );
    const now = this.now();
    let row: IntegrationRow;
    if (input.provider === "github") {
      // The Setup URL's installation id is untrusted: it counts only when the
      // person's own token lists it (§8.3).
      const confirmed = await provider(() =>
        adapter.confirmInstallation!({
          attempt,
          userToken,
          installationId: input.installation_id
        })
      );
      if ("authorizeUrl" in confirmed)
        throw new ApiError(
          409,
          "REPOSITORY_AUTHORIZATION_INVALID",
          "Authorize GitHub again to connect this installation."
        );
      const installation = await provider(() =>
        adapter.getInstallation!(input.installation_id)
      );
      row = await this.upsert({
        organizationId,
        provider: "github",
        providerAccountId: installation.accountId,
        values: {
          accountName: installation.accountName,
          accountType: installation.accountType,
          installationId: installation.installationId,
          repositorySelection: installation.repositorySelection,
          selectedRepositoryIds: [],
          accessTokenCiphertext: null,
          refreshTokenCiphertext: null,
          tokenExpiresAt: null,
          status: installation.suspended ? "suspended" : "active",
          statusReason: installation.suspended
            ? "The app is suspended for that account."
            : null,
          connectedByUserId: userId,
          updatedAt: now
        }
      });
    } else {
      const account = await provider(() => adapter.accountForToken!(userToken));
      const [existing] = await this.db
        .select({ id: organizationIntegrations.id })
        .from(organizationIntegrations)
        .where(
          and(
            eq(organizationIntegrations.organizationId, organizationId),
            eq(organizationIntegrations.provider, "gitlab"),
            eq(organizationIntegrations.providerAccountId, account.id)
          )
        )
        .limit(1);
      // Secrets are sealed to the row, so the id comes first.
      const id = existing?.id ?? randomUUID();
      const seal = (value: string, purpose: string) =>
        secrets.seal(value, aad("organization_integrations", id, purpose));
      row = await this.upsert({
        organizationId,
        provider: "gitlab",
        providerAccountId: account.id,
        id,
        values: {
          accountName: account.name,
          accountType: "User",
          installationId: null,
          repositorySelection: input.repository_selection,
          selectedRepositoryIds:
            input.repository_selection === "selected"
              ? [...new Set(input.selected_repository_ids)]
              : [],
          accessTokenCiphertext: seal(
            account.tokens.access_token,
            "access_token"
          ),
          refreshTokenCiphertext: seal(
            account.tokens.refresh_token,
            "refresh_token"
          ),
          tokenExpiresAt: new Date(account.tokens.expires_at),
          status: "active",
          statusReason: null,
          connectedByUserId: userId,
          updatedAt: now
        }
      });
    }
    await this.db
      .update(repositoryConnectionAttempts)
      .set({ status: "consumed", consumedAt: now, userTokenCiphertext: null })
      .where(eq(repositoryConnectionAttempts.id, attempt.id));
    await this.refresh(row.id).catch(() => undefined);
    return { integration: await this.json(await this.byId(row.id)) };
  }

  private async byId(id: string) {
    const [row] = await this.db
      .select()
      .from(organizationIntegrations)
      .where(eq(organizationIntegrations.id, id));
    if (!row) throw new ApiError(404, "NOT_FOUND", "Integration not found.");
    return row;
  }

  /** One integration per account per organization: reconnecting updates it. */
  private async upsert(input: {
    organizationId: string;
    provider: "github" | "gitlab";
    providerAccountId: string;
    id?: string;
    values: Omit<
      typeof organizationIntegrations.$inferInsert,
      "id" | "organizationId" | "provider" | "providerAccountId"
    >;
  }) {
    const [row] = await this.db
      .insert(organizationIntegrations)
      .values({
        id: input.id ?? randomUUID(),
        organizationId: input.organizationId,
        provider: input.provider,
        providerAccountId: input.providerAccountId,
        createdAt: this.now(),
        ...input.values
      })
      .onConflictDoUpdate({
        target: [
          organizationIntegrations.organizationId,
          organizationIntegrations.provider,
          organizationIntegrations.providerAccountId
        ],
        set: input.values
      })
      .returning();
    return row!;
  }

  /** GitLab only: GitHub's repository selection changes on GitHub. */
  async update(
    userId: string,
    organizationId: string,
    integrationId: string,
    input: UpdateOrganizationIntegrationRequest
  ) {
    await this.permissions.organizationEditor(userId, organizationId);
    const row = await this.integration(organizationId, integrationId);
    if (row.provider !== "gitlab")
      throw new ApiError(
        400,
        "VALIDATION_ERROR",
        "Change a GitHub installation's repositories on GitHub."
      );
    await this.db
      .update(organizationIntegrations)
      .set({
        repositorySelection: input.repository_selection,
        selectedRepositoryIds:
          input.repository_selection === "selected"
            ? [...new Set(input.selected_repository_ids)]
            : [],
        updatedAt: this.now()
      })
      .where(eq(organizationIntegrations.id, row.id));
    await this.refresh(row.id).catch(() => undefined);
    return { integration: await this.json(await this.byId(row.id)) };
  }

  async remove(userId: string, organizationId: string, integrationId: string) {
    await this.permissions.organizationEditor(userId, organizationId);
    const row = await this.integration(organizationId, integrationId);
    // GitLab connections read the integration's tokens; GitHub ones only
    // share its installation id and keep working.
    if (row.provider === "gitlab") {
      const [using] = await this.db
        .select({ value: count() })
        .from(repositoryConnections)
        .where(
          and(
            eq(repositoryConnections.integrationId, row.id),
            isNull(repositoryConnections.disconnectedAt)
          )
        );
      const inUse = Number(using?.value ?? 0);
      if (inUse)
        throw new ApiError(
          409,
          "INTEGRATION_IN_USE",
          `${inUse === 1 ? "1 project uses" : `${inUse} projects use`} this GitLab integration. Disconnect their repositories first.`,
          { projects: inUse }
        );
    }
    await this.db
      .delete(organizationIntegrations)
      .where(eq(organizationIntegrations.id, row.id));
  }

  async refreshNow(
    userId: string,
    organizationId: string,
    integrationId: string
  ) {
    await this.permissions.organizationEditor(userId, organizationId);
    const row = await this.integration(organizationId, integrationId);
    await this.refresh(row.id);
    return { integration: await this.json(await this.byId(row.id)) };
  }

  /**
   * Re-reads what the integration reaches: new repositories are added (and
   * show as new), vanished ones are marked removed. Provider refusals mark
   * the integration instead of throwing from background refreshes.
   */
  async refresh(integrationId: string) {
    const row = await this.byId(integrationId);
    const { adapter } = this.adapter(row.provider);
    const now = this.now();
    try {
      let current = row;
      if (row.provider === "github") {
        const installation = await adapter.getInstallation!(
          row.installationId ?? ""
        );
        [current] = await this.db
          .update(organizationIntegrations)
          .set({
            accountName: installation.accountName,
            accountType: installation.accountType,
            repositorySelection: installation.repositorySelection,
            status: installation.suspended ? "suspended" : "active",
            statusReason: installation.suspended
              ? "The app is suspended for that account."
              : null
          })
          .where(eq(organizationIntegrations.id, row.id))
          .returning();
        if (installation.suspended) return;
      }
      const reachable = await adapter.listIntegrationRepositories!(current!);
      const visible =
        current!.provider === "gitlab" &&
        current!.repositorySelection === "selected"
          ? reachable.filter((repository) =>
              current!.selectedRepositoryIds.includes(repository.id)
            )
          : reachable;
      const seen = new Set<string>();
      for (const repository of visible) {
        seen.add(repository.id);
        await this.db
          .insert(organizationRepositories)
          .values({
            organizationId: row.organizationId,
            integrationId: row.id,
            provider: row.provider,
            providerRepositoryId: repository.id,
            fullName: repository.fullName,
            url: repository.url,
            defaultBranch: repository.defaultBranch,
            pushedAt: repository.pushedAt,
            firstSeenAt: now,
            lastSeenAt: now
          })
          .onConflictDoUpdate({
            target: [
              organizationRepositories.integrationId,
              organizationRepositories.providerRepositoryId
            ],
            set: {
              fullName: repository.fullName,
              url: repository.url,
              defaultBranch: repository.defaultBranch,
              pushedAt: repository.pushedAt,
              lastSeenAt: now,
              removedAt: null
            }
          });
      }
      const known = await this.db
        .select({
          id: organizationRepositories.id,
          providerRepositoryId: organizationRepositories.providerRepositoryId
        })
        .from(organizationRepositories)
        .where(
          and(
            eq(organizationRepositories.integrationId, row.id),
            isNull(organizationRepositories.removedAt)
          )
        );
      const gone = known
        .filter((repository) => !seen.has(repository.providerRepositoryId))
        .map((repository) => repository.id);
      if (gone.length)
        await this.db
          .update(organizationRepositories)
          .set({ removedAt: now })
          .where(inArray(organizationRepositories.id, gone));
      await this.db
        .update(organizationIntegrations)
        .set({
          lastSyncedAt: now,
          ...(row.provider === "gitlab"
            ? { status: "active" as const, statusReason: null }
            : {}),
          updatedAt: now
        })
        .where(eq(organizationIntegrations.id, row.id));
    } catch (error) {
      if (!(error instanceof ProviderAuthorizationError)) throw error;
      await this.db
        .update(organizationIntegrations)
        .set({
          status: "needs_reauthorization",
          statusReason: error.message,
          lastSyncedAt: now,
          updatedAt: now
        })
        .where(eq(organizationIntegrations.id, row.id));
    }
  }

  /** GitHub installation events: refresh every integration of it soon. */
  async requestRefreshByInstallation(
    providerName: string,
    installationId: string
  ) {
    const rows = await this.db
      .select({ id: organizationIntegrations.id })
      .from(organizationIntegrations)
      .where(
        and(
          eq(organizationIntegrations.provider, providerName as "github"),
          eq(organizationIntegrations.installationId, installationId)
        )
      );
    for (const row of rows) this.requested.add(row.id);
  }

  /** Worker tick: refresh requested and stale integrations. */
  async refreshDue() {
    const rows = await this.db.select().from(organizationIntegrations);
    const interval = this.options.refreshIntervalSeconds * 1000;
    for (const row of rows) {
      const due =
        this.requested.has(row.id) ||
        !row.lastSyncedAt ||
        this.now().getTime() - row.lastSyncedAt.getTime() >= interval;
      if (!due || row.status === "suspended") continue;
      this.requested.delete(row.id);
      await this.refresh(row.id).catch((error: unknown) =>
        console.error(
          "[integrations] refresh failed:",
          error instanceof Error ? error.message : String(error)
        )
      );
    }
  }

  async listRepositories(
    userId: string,
    organizationId: string,
    filter: "importable" | "all"
  ) {
    await this.permissions.organizationEditor(userId, organizationId);
    const rows = await this.db
      .select({
        repository: organizationRepositories,
        integrationCreatedAt: organizationIntegrations.createdAt,
        connectedProjectId: repositoryConnections.projectId,
        connectedOrganizationId: projects.organizationId
      })
      .from(organizationRepositories)
      .innerJoin(
        organizationIntegrations,
        eq(organizationIntegrations.id, organizationRepositories.integrationId)
      )
      .leftJoin(
        repositoryConnections,
        and(
          eq(repositoryConnections.provider, organizationRepositories.provider),
          eq(
            repositoryConnections.providerRepositoryId,
            organizationRepositories.providerRepositoryId
          ),
          isNull(repositoryConnections.disconnectedAt)
        )
      )
      .leftJoin(projects, eq(projects.id, repositoryConnections.projectId))
      .where(
        and(
          eq(organizationRepositories.organizationId, organizationId),
          isNull(organizationRepositories.removedAt)
        )
      )
      .orderBy(
        sql`${organizationRepositories.pushedAt} desc nulls last`,
        desc(organizationRepositories.firstSeenAt)
      );
    const repositories: OrganizationRepository[] = [];
    const listed = new Set<string>();
    for (const row of rows) {
      const repository = row.repository;
      // Two integrations can reach one repository; list it once.
      const key = `${repository.provider}:${repository.providerRepositoryId}`;
      if (listed.has(key)) continue;
      listed.add(key);
      const connected = row.connectedProjectId !== null;
      // A project in another organization isn't named here.
      const projectId =
        row.connectedOrganizationId === organizationId
          ? row.connectedProjectId
          : null;
      if (filter === "importable" && (connected || repository.dismissedAt))
        continue;
      repositories.push(
        this.repositoryJson(repository, row.integrationCreatedAt, projectId)
      );
    }
    return { repositories };
  }

  private repositoryJson(
    repository: RepositoryRow,
    integrationCreatedAt: Date,
    projectId: string | null
  ): OrganizationRepository {
    return {
      id: repository.id,
      integration_id: repository.integrationId,
      provider: repository.provider,
      provider_repository_id: repository.providerRepositoryId,
      full_name: repository.fullName,
      url: repository.url,
      default_branch: repository.defaultBranch,
      pushed_at: repository.pushedAt?.toISOString() ?? null,
      first_seen_at: repository.firstSeenAt.toISOString(),
      is_new:
        repository.firstSeenAt.getTime() - integrationCreatedAt.getTime() >
        NEW_AFTER_MS,
      project_id: projectId,
      dismissed: Boolean(repository.dismissedAt)
    };
  }

  private async repository(organizationId: string, repositoryId: string) {
    const [row] = await this.db
      .select({
        repository: organizationRepositories,
        integration: organizationIntegrations
      })
      .from(organizationRepositories)
      .innerJoin(
        organizationIntegrations,
        eq(organizationIntegrations.id, organizationRepositories.integrationId)
      )
      .where(
        and(
          eq(organizationRepositories.id, repositoryId),
          eq(organizationRepositories.organizationId, organizationId),
          isNull(organizationRepositories.removedAt)
        )
      )
      .limit(1);
    if (!row) throw new ApiError(404, "NOT_FOUND", "Repository not found.");
    return row;
  }

  async dismiss(userId: string, organizationId: string, repositoryId: string) {
    await this.permissions.organizationEditor(userId, organizationId);
    const { repository, integration } = await this.repository(
      organizationId,
      repositoryId
    );
    const [row] = await this.db
      .update(organizationRepositories)
      .set({ dismissedAt: this.now(), dismissedByUserId: userId })
      .where(eq(organizationRepositories.id, repository.id))
      .returning();
    return {
      repository: this.repositoryJson(row!, integration.createdAt, null)
    };
  }

  /**
   * Connects a project to an organization repository. Owners and admins of
   * the organization only, and only for a project of that organization.
   */
  async connectProject(
    userId: string,
    projectId: string,
    repositoryId: string
  ) {
    const { project } = await this.permissions.projectEditor(userId, projectId);
    await this.permissions.organizationEditor(userId, project.organizationId);
    const { repository, integration } = await this.repository(
      project.organizationId,
      repositoryId
    );
    if (integration.status !== "active")
      throw new ApiError(
        409,
        "REPOSITORY_AUTHORIZATION_INVALID",
        integration.statusReason ?? "Reconnect this integration first."
      );
    const { adapter } = this.adapter(integration.provider);
    const connectionId = randomUUID();
    const prepared = await provider(() =>
      adapter.prepareFromIntegration!({
        integration,
        providerRepositoryId: repository.providerRepositoryId,
        connectionId
      })
    );
    const draft = this.repositories.draftConnection({
      connectionId,
      projectId,
      provider: integration.provider,
      prepared,
      userId,
      integrationId: integration.id
    });
    const connection = await this.repositories.finishConnection({
      userId,
      draft,
      mapping: { mode: "rename_default" },
      createExistingBranches: false
    });
    return { repository: await this.repositories.connectionJson(connection) };
  }

  /** Removes a project created for an import that then failed. */
  async discardProject(projectId: string) {
    await this.db.delete(projects).where(eq(projects.id, projectId));
  }

  static readonly providers = INTEGRATION_PROVIDERS;
}
