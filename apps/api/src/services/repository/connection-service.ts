import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  projectBranches,
  repositoryConnectionAttempts,
  repositoryConnections,
  repositoryRefs,
  repositoryWebhookDeliveries,
  type Database
} from "@orchestrat/db";
import type { RepositoryConfig } from "@orchestrat/config";
import type {
  ConnectRepositoryRequest,
  CreateRepositoryAuthorizationRequest,
  RepositoryConnection,
  RepositoryDelivery
} from "@orchestrat/protocol";
import { and, count, desc, eq, gt, isNull } from "drizzle-orm";
import { insertProjectEvent } from "../agent-service.js";
import { ApiError } from "../api-error.js";
import { defaultBranch } from "../branch-context.js";
import type { BranchService } from "../branch-service.js";
import { PermissionService } from "../permission-service.js";
import type { BranchSync } from "./branch-sync.js";
import { aad, type SecretBox } from "./secrets.js";
import {
  ProviderAuthorizationError,
  type AttemptRow,
  type ConnectionRow,
  type ProviderAdapter,
  type ProviderName
} from "./types.js";

/** Provider calls on behalf of a person: lost access is a 409, the rest 502. */
async function provider<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof ProviderAuthorizationError)
      throw new ApiError(
        409,
        "REPOSITORY_AUTHORIZATION_INVALID",
        error.message
      );
    throw new ApiError(
      502,
      "INTERNAL_ERROR",
      "The provider didn't answer. Try again."
    );
  }
}

// Connecting a project to one repository (docs/project-branches.md §6.7,
// §8.7, §12): single-use authorization attempts, a repository picker, the
// default-branch mapping, and disconnect. Provider specifics live in the
// adapters.

const ATTEMPT_TTL_MS = 15 * 60_000;
const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const PROVIDERS: ProviderName[] = ["github", "gitlab", "origin"];

export function connectionJson(
  row: ConnectionRow,
  failedDeliveries = 0
): RepositoryConnection {
  return {
    id: row.id,
    project_id: row.projectId,
    provider: row.provider,
    provider_repository_id: row.providerRepositoryId,
    full_name: row.repositoryFullName,
    url: row.repositoryUrl,
    provider_default_branch: row.providerDefaultBranch,
    status: row.status,
    status_reason: row.statusReason,
    last_event_at: row.lastEventAt?.toISOString() ?? null,
    last_reconciled_at: row.lastReconciledAt?.toISOString() ?? null,
    connected_by_user_id: row.connectedByUserId,
    hook_health: row.hookHealth
      ? {
          alert_status: row.hookHealth.alert_status,
          disabled_until: row.hookHealth.disabled_until
        }
      : null,
    failed_delivery_count: failedDeliveries,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString()
  };
}

const deliveryJson = (
  row: typeof repositoryWebhookDeliveries.$inferSelect
): RepositoryDelivery => ({
  id: row.id,
  provider: row.provider,
  event_type: row.eventType,
  status: row.status,
  attempts: row.attempts,
  last_error: row.lastError,
  received_at: row.receivedAt.toISOString(),
  processed_at: row.processedAt?.toISOString() ?? null
});

export class RepositoryService {
  private readonly permissions: PermissionService;
  constructor(
    private readonly db: Database,
    private readonly branches: BranchService,
    private readonly sync: BranchSync,
    private readonly adapters: Map<ProviderName, ProviderAdapter>,
    private readonly config: Pick<
      RepositoryConfig,
      "publicApiUrl" | "dashboardUrl" | "unavailable" | "hidden"
    >,
    private readonly secrets: SecretBox | null,
    private readonly requestReconcile: (connectionId: string) => void = () =>
      undefined,
    private readonly now: () => Date = () => new Date()
  ) {
    this.permissions = new PermissionService(db);
  }

  private adapter(provider: ProviderName) {
    const adapter = this.adapters.get(provider);
    if (!adapter || !this.secrets)
      throw new ApiError(
        400,
        "REPOSITORY_NOT_CONFIGURED",
        "This provider isn't set up on this server.",
        { provider, reason: this.config.unavailable[provider] }
      );
    return { adapter, secrets: this.secrets };
  }

  private callbackUrl(provider: ProviderName) {
    return `${this.config.publicApiUrl ?? ""}/api/v1/repository/callback/${provider}`;
  }

  private async active(projectId: string) {
    const [row] = await this.db
      .select()
      .from(repositoryConnections)
      .where(
        and(
          eq(repositoryConnections.projectId, projectId),
          isNull(repositoryConnections.disconnectedAt)
        )
      )
      .limit(1);
    return row ?? null;
  }

  private async json(row: ConnectionRow) {
    const [failed] = await this.db
      .select({ value: count() })
      .from(repositoryWebhookDeliveries)
      .where(
        and(
          eq(repositoryWebhookDeliveries.connectionId, row.id),
          eq(repositoryWebhookDeliveries.status, "failed")
        )
      );
    return connectionJson(row, Number(failed?.value ?? 0));
  }

  async get(userId: string, projectId: string) {
    await this.permissions.projectAccess(userId, projectId);
    const row = await this.active(projectId);
    return {
      repository: row ? await this.json(row) : null,
      providers: PROVIDERS.filter(
        (provider) => !this.config.hidden.includes(provider)
      ).map((provider) => {
        const configured = this.adapters.has(provider) && Boolean(this.secrets);
        return {
          provider,
          configured,
          unavailable_reason: configured
            ? null
            : (this.config.unavailable[provider] ??
              "This provider isn't set up on this server.")
        };
      })
    };
  }

  async authorize(
    userId: string,
    projectId: string,
    input: CreateRepositoryAuthorizationRequest
  ) {
    await this.permissions.projectEditor(userId, projectId);
    const { adapter, secrets } = this.adapter(input.provider);
    if (await this.active(projectId))
      throw new ApiError(
        409,
        "REPOSITORY_CONNECTION_EXISTS",
        "Disconnect the current repository first."
      );
    const id = `ra_${randomBytes(24).toString("base64url")}`;
    const state = randomBytes(32).toString("base64url");
    const verifier = randomBytes(32).toString("base64url");
    const expiresAt = new Date(this.now().getTime() + ATTEMPT_TTL_MS);
    await this.db.insert(repositoryConnectionAttempts).values({
      id,
      projectId,
      userId,
      provider: input.provider,
      stateHash: sha256(state),
      pkceVerifierCiphertext: secrets.seal(
        verifier,
        aad("repository_connection_attempts", id, "pkce_verifier")
      ),
      returnPath: input.return_path ?? null,
      expiresAt
    });
    return {
      authorization_id: id,
      authorize_url: adapter.authorizeUrl({
        state,
        codeChallenge: createHash("sha256")
          .update(verifier)
          .digest("base64url"),
        redirectUri: this.callbackUrl(input.provider)
      }),
      expires_at: expiresAt.toISOString()
    };
  }

  /**
   * The provider's redirect back. It always ends in a redirect to the
   * dashboard: on success with the authorization id, otherwise with an
   * error code.
   */
  async callback(
    provider: ProviderName,
    query: Record<string, string | undefined>
  ): Promise<string> {
    const dashboard = this.config.dashboardUrl ?? "";
    const fail = (code: string, attempt?: AttemptRow) =>
      `${dashboard}${this.returnTo(attempt)}${attempt?.returnPath?.includes("?") ? "&" : "?"}repository_error=${code}`;
    const state = query.state;
    if (!state) return fail("invalid_state");
    const [attempt] = await this.db
      .select()
      .from(repositoryConnectionAttempts)
      .where(eq(repositoryConnectionAttempts.stateHash, sha256(state)))
      .limit(1);
    if (
      !attempt ||
      attempt.provider !== provider ||
      attempt.status !== "pending"
    )
      return fail("invalid_state");
    if (attempt.expiresAt <= this.now()) {
      await this.mark(attempt.id, { status: "expired" });
      return fail("expired", attempt);
    }
    try {
      const { adapter, secrets } = this.adapter(provider);
      const verifier = attempt.pkceVerifierCiphertext
        ? secrets.open(
            attempt.pkceVerifierCiphertext,
            aad("repository_connection_attempts", attempt.id, "pkce_verifier")
          )
        : null;
      const authorization = await adapter.completeAuthorization({
        attempt,
        query,
        verifier,
        redirectUri: this.callbackUrl(provider)
      });
      // A replayed receipt (Origin) collides on its unique jti.
      if (authorization.receiptJti) {
        const [seen] = await this.db
          .select({ id: repositoryConnectionAttempts.id })
          .from(repositoryConnectionAttempts)
          .where(
            eq(
              repositoryConnectionAttempts.receiptJti,
              authorization.receiptJti
            )
          )
          .limit(1);
        if (seen) throw new Error("replayed receipt");
      }
      await this.mark(attempt.id, {
        status: "authorized",
        providerUserId: authorization.providerUserId,
        installationId: authorization.installationId ?? null,
        receiptJti: authorization.receiptJti ?? null,
        userTokenCiphertext: authorization.userToken
          ? secrets.seal(
              authorization.userToken,
              aad("repository_connection_attempts", attempt.id, "user_token")
            )
          : null
      });
      return `${dashboard}${this.returnTo(attempt)}${attempt.returnPath?.includes("?") ? "&" : "?"}repository_authorization=${attempt.id}`;
    } catch {
      await this.mark(attempt.id, {
        status: "failed",
        errorCode: "authorization_failed"
      });
      return fail("authorization_failed", attempt);
    }
  }

  private returnTo(attempt?: AttemptRow) {
    if (!attempt) return "/";
    return attempt.returnPath ?? `/projects/${attempt.projectId}/settings`;
  }

  private async mark(
    id: string,
    values: Partial<typeof repositoryConnectionAttempts.$inferInsert>
  ) {
    await this.db
      .update(repositoryConnectionAttempts)
      .set(values)
      .where(eq(repositoryConnectionAttempts.id, id));
  }

  /** An authorized attempt of this user and project, still fresh. */
  private async attempt(userId: string, projectId: string, attemptId: string) {
    const [attempt] = await this.db
      .select()
      .from(repositoryConnectionAttempts)
      .where(eq(repositoryConnectionAttempts.id, attemptId))
      .limit(1);
    if (
      !attempt ||
      attempt.userId !== userId ||
      attempt.projectId !== projectId ||
      attempt.status !== "authorized" ||
      attempt.expiresAt <= this.now()
    )
      throw new ApiError(
        409,
        "REPOSITORY_AUTHORIZATION_INVALID",
        "This authorization is missing, used or expired. Start again."
      );
    const { adapter, secrets } = this.adapter(attempt.provider);
    const userToken = attempt.userTokenCiphertext
      ? secrets.open(
          attempt.userTokenCiphertext,
          aad("repository_connection_attempts", attempt.id, "user_token")
        )
      : null;
    return { attempt, adapter, secrets, userToken };
  }

  async githubInstallation(
    userId: string,
    projectId: string,
    attemptId: string,
    installationId: string
  ) {
    await this.permissions.projectEditor(userId, projectId);
    const { attempt, adapter, userToken } = await this.attempt(
      userId,
      projectId,
      attemptId
    );
    if (!adapter.confirmInstallation)
      throw new ApiError(
        400,
        "VALIDATION_ERROR",
        "Not a GitHub authorization."
      );
    const result = await provider(() =>
      adapter.confirmInstallation!({ attempt, userToken, installationId })
    );
    if ("authorizeUrl" in result)
      return { next: "authorize" as const, authorize_url: result.authorizeUrl };
    await this.mark(attempt.id, { installationId: result.installationId });
    return { next: "pick_repository" as const };
  }

  async candidates(userId: string, projectId: string, attemptId: string) {
    await this.permissions.projectEditor(userId, projectId);
    const { attempt, adapter, userToken } = await this.attempt(
      userId,
      projectId,
      attemptId
    );
    return {
      repositories: await provider(() =>
        adapter.listCandidates({ attempt, userToken })
      ),
      // GitHub only lists installed repositories; the attempt id is a
      // harmless state for the Setup URL (§8.3).
      install_url: adapter.installUrl?.(attempt.id) ?? null
    };
  }

  /**
   * The person's newest authorized attempt for a provider, for GitHub's
   * Setup URL, which can open in a browser that didn't start the flow.
   */
  async pending(userId: string, provider: ProviderName) {
    const [attempt] = await this.db
      .select()
      .from(repositoryConnectionAttempts)
      .where(
        and(
          eq(repositoryConnectionAttempts.userId, userId),
          eq(repositoryConnectionAttempts.provider, provider),
          eq(repositoryConnectionAttempts.status, "authorized"),
          gt(repositoryConnectionAttempts.expiresAt, this.now())
        )
      )
      .orderBy(desc(repositoryConnectionAttempts.createdAt))
      .limit(1);
    if (!attempt)
      throw new ApiError(
        404,
        "NOT_FOUND",
        "No connection in progress. Start again from the project’s settings."
      );
    await this.permissions.projectEditor(userId, attempt.projectId);
    return {
      authorization_id: attempt.id,
      project_id: attempt.projectId,
      provider: attempt.provider,
      expires_at: attempt.expiresAt.toISOString()
    };
  }

  async connect(
    userId: string,
    projectId: string,
    input: ConnectRepositoryRequest
  ) {
    await this.permissions.projectEditor(userId, projectId);
    const { attempt, adapter, secrets, userToken } = await this.attempt(
      userId,
      projectId,
      input.authorization_id
    );
    const connectionId = randomUUID();
    const prepared = await provider(() =>
      adapter.prepareConnection({
        attempt,
        userToken,
        providerRepositoryId: input.provider_repository_id,
        connectionId
      })
    );
    if (prepared.repository.ineligibleReason)
      throw new ApiError(
        409,
        "REPOSITORY_AUTHORIZATION_INVALID",
        prepared.repository.ineligibleReason
      );
    const seal = (value: string | null | undefined, purpose: string) =>
      value
        ? secrets.seal(
            value,
            aad("repository_connections", connectionId, purpose)
          )
        : null;
    const now = this.now();
    const draft: ConnectionRow = {
      id: connectionId,
      projectId,
      provider: attempt.provider,
      providerRepositoryId: prepared.repository.id,
      repositoryFullName: prepared.repository.fullName,
      repositoryUrl: prepared.repository.url,
      providerDefaultBranch: prepared.repository.defaultBranch,
      installationId: prepared.installationId,
      gitlabHookId: prepared.gitlabHookId ?? null,
      accessTokenCiphertext: seal(prepared.accessToken, "access_token"),
      refreshTokenCiphertext: seal(prepared.refreshToken, "refresh_token"),
      tokenExpiresAt: prepared.tokenExpiresAt ?? null,
      webhookSecretCiphertext: seal(prepared.webhookSecret, "webhook_secret"),
      connectedByUserId: userId,
      providerAccountId: prepared.providerAccountId,
      status: "active",
      statusReason: null,
      hookHealth: null,
      lastEventAt: null,
      lastReconciledAt: null,
      reconcileState: { merged_since: now.toISOString() },
      createdAt: now,
      updatedAt: now,
      disconnectedAt: null
    };
    // Snapshot the provider's branches before the transaction (§8.7).
    const remote = await provider(() => adapter.listBranches(draft));
    const connection = await this.db.transaction(async (tx) => {
      await this.branches.lockActiveProject(tx, projectId);
      const [taken] = await tx
        .select({ projectId: repositoryConnections.projectId })
        .from(repositoryConnections)
        .where(
          and(
            isNull(repositoryConnections.disconnectedAt),
            eq(repositoryConnections.provider, draft.provider),
            eq(
              repositoryConnections.providerRepositoryId,
              draft.providerRepositoryId
            )
          )
        )
        .limit(1);
      const [existing] = await tx
        .select({ id: repositoryConnections.id })
        .from(repositoryConnections)
        .where(
          and(
            eq(repositoryConnections.projectId, projectId),
            isNull(repositoryConnections.disconnectedAt)
          )
        )
        .limit(1);
      if (taken || existing)
        throw new ApiError(
          409,
          "REPOSITORY_CONNECTION_EXISTS",
          taken
            ? "That repository is already connected to a project."
            : "Disconnect the current repository first."
        );
      const [row] = await tx
        .insert(repositoryConnections)
        .values(draft)
        .returning();
      await this.mapDefault(
        tx,
        row!,
        input.default_branch_mapping,
        userId,
        remote.find((branch) => branch.name === row!.providerDefaultBranch)
          ?.sha ?? null
      );
      for (const branch of remote) {
        if (branch.name === row!.providerDefaultBranch) continue;
        const [ref] = await tx
          .insert(repositoryRefs)
          .values({
            projectId,
            connectionId: row!.id,
            name: branch.name,
            headSha: branch.sha,
            firstSeenSha: branch.sha,
            createdSignal: "connect_snapshot"
          })
          .returning();
        if (input.create_existing_branches)
          await this.sync.linkOrCreate(tx, row!, ref!);
      }
      await tx
        .update(repositoryConnectionAttempts)
        .set({ status: "consumed", consumedAt: now, userTokenCiphertext: null })
        .where(eq(repositoryConnectionAttempts.id, attempt.id));
      await insertProjectEvent(tx, {
        projectId,
        actorUserId: userId,
        entityId: row!.id,
        type: "repository.connected",
        payload: { provider: row!.provider, full_name: row!.repositoryFullName }
      });
      return row!;
    });
    this.requestReconcile(connection.id);
    return { repository: await this.json(connection) };
  }

  /**
   * Links the default branch to the provider default `D` (§8.7): the
   * default is already `D`; or it's renamed to `D`; or another active `D`
   * branch is archived as replaced; or (use_existing) that `D` branch
   * becomes the default and the old default stays an ordinary branch.
   */
  private async mapDefault(
    tx: Parameters<Parameters<Database["transaction"]>[0]>[0],
    connection: ConnectionRow,
    mapping: ConnectRepositoryRequest["default_branch_mapping"],
    userId: string,
    headSha: string | null
  ) {
    const name = connection.providerDefaultBranch;
    let current = await defaultBranch(tx, connection.projectId);
    if (current.name !== name) {
      const [other] = await tx
        .select()
        .from(projectBranches)
        .where(
          and(
            eq(projectBranches.projectId, connection.projectId),
            eq(projectBranches.name, name),
            isNull(projectBranches.archivedAt)
          )
        )
        .limit(1);
      if (other && mapping.mode === "use_existing") {
        if (mapping.branch_id !== other.id)
          throw new ApiError(
            400,
            "VALIDATION_ERROR",
            `Choose the branch named ${name}.`
          );
        await this.sync.moveDefault(tx, connection.projectId, current, other);
        current = other;
      } else {
        if (other)
          await this.branches.archiveInTransaction(tx, other, {
            reason: "replaced_on_connect",
            userId
          });
        await tx
          .update(projectBranches)
          .set({ name, nameSource: "provider", updatedAt: new Date() })
          .where(eq(projectBranches.id, current.id));
        await insertProjectEvent(tx, {
          projectId: connection.projectId,
          actorUserId: userId,
          entityId: current.id,
          type: "branch.renamed",
          payload: { from: current.name, name }
        });
      }
    }
    await tx.insert(repositoryRefs).values({
      projectId: connection.projectId,
      connectionId: connection.id,
      name,
      headSha,
      firstSeenSha: headSha,
      branchId: current.id,
      createdSignal: "connect_snapshot"
    });
  }

  async requestSync(userId: string, projectId: string) {
    await this.permissions.projectEditor(userId, projectId);
    const connection = await this.active(projectId);
    if (!connection)
      throw new ApiError(404, "NOT_FOUND", "No repository is connected.");
    this.requestReconcile(connection.id);
    return { queued: true as const };
  }

  /** Re-enables a webhook the provider disabled (GitLab), then refreshes its
   * health with a reconcile. */
  async reenableHook(userId: string, projectId: string) {
    await this.permissions.projectEditor(userId, projectId);
    const connection = await this.active(projectId);
    if (!connection)
      throw new ApiError(404, "NOT_FOUND", "No repository is connected.");
    const adapter = this.adapters.get(connection.provider);
    if (!adapter?.reenableHook)
      throw new ApiError(
        409,
        "CONFLICT",
        "This provider has no webhook to re-enable.",
        { reason: "no_hook" }
      );
    await provider(() => adapter.reenableHook!(connection));
    this.requestReconcile(connection.id);
    return { queued: true as const };
  }

  async deliveries(userId: string, projectId: string, status?: string) {
    await this.permissions.projectEditor(userId, projectId);
    const connection = await this.active(projectId);
    if (!connection) return { deliveries: [] };
    const rows = await this.db
      .select()
      .from(repositoryWebhookDeliveries)
      .where(
        and(
          eq(repositoryWebhookDeliveries.connectionId, connection.id),
          status
            ? eq(
                repositoryWebhookDeliveries.status,
                status as RepositoryDelivery["status"]
              )
            : undefined
        )
      )
      .orderBy(desc(repositoryWebhookDeliveries.receivedAt))
      .limit(100);
    return { deliveries: rows.map(deliveryJson) };
  }

  async retry(userId: string, projectId: string, deliveryId: string) {
    await this.permissions.projectEditor(userId, projectId);
    const connection = await this.active(projectId);
    const [row] = connection
      ? await this.db
          .update(repositoryWebhookDeliveries)
          .set({
            status: "pending",
            attempts: 0,
            nextAttemptAt: this.now(),
            lastError: null
          })
          .where(
            and(
              eq(repositoryWebhookDeliveries.id, deliveryId),
              eq(repositoryWebhookDeliveries.connectionId, connection.id),
              eq(repositoryWebhookDeliveries.status, "failed")
            )
          )
          .returning()
      : [];
    if (!row)
      throw new ApiError(404, "NOT_FOUND", "No failed delivery with that id.");
    return { delivery: deliveryJson(row) };
  }

  /** Branches and their work stay; only the link to the provider ends. */
  async disconnect(userId: string, projectId: string) {
    await this.permissions.projectEditor(userId, projectId);
    const connection = await this.active(projectId);
    if (!connection)
      throw new ApiError(404, "NOT_FOUND", "No repository is connected.");
    await this.adapters
      .get(connection.provider)
      ?.disconnect?.(connection)
      .catch(() => undefined);
    await this.db.transaction(async (tx) => {
      await this.branches.lockActiveProject(tx, projectId);
      await tx
        .update(repositoryConnections)
        .set({
          status: "disconnected",
          statusReason: null,
          disconnectedAt: this.now(),
          accessTokenCiphertext: null,
          refreshTokenCiphertext: null,
          webhookSecretCiphertext: null,
          updatedAt: this.now()
        })
        .where(eq(repositoryConnections.id, connection.id));
      await insertProjectEvent(tx, {
        projectId,
        actorUserId: userId,
        entityId: connection.id,
        type: "repository.disconnected",
        payload: { provider: connection.provider }
      });
    });
  }
}
