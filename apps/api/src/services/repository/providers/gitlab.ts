import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { repositoryConnections, type Database } from "@orchestrat/db";
import type { RepositoryCandidate } from "@orchestrat/protocol";
import { eq } from "drizzle-orm";
import { aad, type SecretBox } from "../secrets.js";
import {
  ProviderAuthorizationError,
  type AttemptRow,
  type ConnectionRow,
  type Headers,
  type MergedChange,
  type PreparedConnection,
  type ProviderAdapter,
  type ProviderEvent,
  type RemoteBranch,
  type RemoteRepository
} from "../types.js";
import { json, ProviderHttpError, send, type HttpOptions } from "./http.js";

// The GitLab.com adapter (docs/project-branches.md §8.4). The connection acts
// with the connecting Maintainer's OAuth tokens; refresh tokens rotate, so
// refreshes are serialized on the connection row and persisted before use.

export type GitlabConfig = { clientId: string; clientSecret: string };
type Tokens = {
  access_token: string;
  refresh_token: string;
  expires_at: number;
};
type ProjectPayload = {
  id: number;
  path_with_namespace: string;
  web_url?: string;
  default_branch: string | null;
  archived?: boolean;
};
type MergeRequestPayload = {
  iid: number;
  source_branch: string;
  target_branch: string;
  source_project_id: number;
  target_project_id: number;
  merged_at?: string | null;
  updated_at?: string;
  merge_commit_sha?: string | null;
  squash_commit_sha?: string | null;
  sha?: string | null;
  web_url?: string;
};

const WEB = "https://gitlab.com";
const API = "https://gitlab.com/api/v4";
const ZERO_SHA = "0".repeat(40);
const WINDOW_MS = 5 * 60_000;
const header = (headers: Headers, name: string) => {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
};

export class GitlabAdapter implements ProviderAdapter {
  readonly provider = "gitlab" as const;
  readonly verifiesPerConnection = true;

  private database?: Database;

  constructor(
    private readonly config: GitlabConfig,
    private readonly secrets: SecretBox,
    private readonly publicApiUrl: string,
    private readonly http: HttpOptions & { now?: () => Date } = {}
  ) {}

  bind(context: { db: Database }) {
    this.database = context.db;
  }

  private get db() {
    if (!this.database) throw new Error("The GitLab adapter isn't bound.");
    return this.database;
  }

  private now() {
    return this.http.now?.() ?? new Date();
  }

  private async tokenRequest(body: Record<string, string>) {
    const response = await send(this.http, `${WEB}/oauth/token`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json"
      },
      body: JSON.stringify({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        ...body
      })
    });
    if (response.status === 400 || response.status === 401) {
      const error = (
        (await response.json().catch(() => ({}))) as { error?: string }
      ).error;
      if (error === "invalid_grant")
        throw new ProviderAuthorizationError(
          "GitLab access was revoked or expired."
        );
    }
    const tokens = await json<{
      access_token: string;
      refresh_token: string;
      expires_in?: number;
      created_at?: number;
    }>(response, "Exchanging a GitLab token");
    return {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at:
        (tokens.created_at ? tokens.created_at * 1000 : this.now().getTime()) +
        (tokens.expires_in ?? 7200) * 1000
    } satisfies Tokens;
  }

  private headers(token: string) {
    return { authorization: `Bearer ${token}`, accept: "application/json" };
  }

  private async get<T>(path: string, token: string, what: string) {
    return json<T>(
      await send(this.http, `${API}${path}`, { headers: this.headers(token) }),
      what
    );
  }

  /** Every page of a GitLab list (offset paging, `X-Next-Page`). */
  private async pages<T>(path: string, token: string, what: string) {
    const items: T[] = [];
    let page = "1";
    while (page) {
      const separator = path.includes("?") ? "&" : "?";
      const response = await send(
        this.http,
        `${API}${path}${separator}per_page=100&page=${page}`,
        {
          headers: this.headers(token)
        }
      );
      items.push(...(await json<T[]>(response, what)));
      page = response.headers.get("x-next-page") ?? "";
    }
    return items;
  }

  /**
   * A usable access token. Expiring tokens refresh under a row lock: a
   * concurrent caller waits, then finds the new pair instead of spending the
   * rotated refresh token again.
   */
  async accessToken(connection: ConnectionRow): Promise<string> {
    const open = (row: ConnectionRow, purpose: string, value: string | null) =>
      value
        ? this.secrets.open(
            value,
            aad("repository_connections", row.id, purpose)
          )
        : null;
    const fresh = (row: ConnectionRow) =>
      row.tokenExpiresAt &&
      row.tokenExpiresAt.getTime() - 60_000 > this.now().getTime();
    if (fresh(connection))
      return open(
        connection,
        "access_token",
        connection.accessTokenCiphertext
      )!;
    // The transaction answers "revoked" instead of throwing, so the status
    // written here isn't rolled back with it.
    const result = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(repositoryConnections)
        .where(eq(repositoryConnections.id, connection.id))
        .for("update");
      if (!row) return { revoked: true as const };
      if (fresh(row))
        return { token: open(row, "access_token", row.accessTokenCiphertext)! };
      const refresh = open(row, "refresh_token", row.refreshTokenCiphertext);
      if (!refresh) return { revoked: true as const };
      let tokens: Tokens;
      try {
        tokens = await this.tokenRequest({
          grant_type: "refresh_token",
          refresh_token: refresh
        });
      } catch (error) {
        if (error instanceof ProviderAuthorizationError)
          return { revoked: true as const };
        throw error;
      }
      await tx
        .update(repositoryConnections)
        .set({
          accessTokenCiphertext: this.secrets.seal(
            tokens.access_token,
            aad("repository_connections", row.id, "access_token")
          ),
          refreshTokenCiphertext: this.secrets.seal(
            tokens.refresh_token,
            aad("repository_connections", row.id, "refresh_token")
          ),
          tokenExpiresAt: new Date(tokens.expires_at),
          updatedAt: this.now()
        })
        .where(eq(repositoryConnections.id, row.id));
      return { token: tokens.access_token };
    });
    if (result.token) return result.token;
    await this.db
      .update(repositoryConnections)
      .set({
        status: "needs_reauthorization",
        statusReason: "Reconnect GitLab to restore access.",
        updatedAt: this.now()
      })
      .where(eq(repositoryConnections.id, connection.id));
    throw new ProviderAuthorizationError(
      "GitLab access was revoked or expired."
    );
  }

  authorizeUrl(input: {
    state: string;
    codeChallenge: string;
    redirectUri: string;
  }) {
    const url = new URL(`${WEB}/oauth/authorize`);
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("redirect_uri", input.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("state", input.state);
    url.searchParams.set("scope", "api");
    url.searchParams.set("code_challenge", input.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    return url.toString();
  }

  async completeAuthorization(input: {
    query: Record<string, string | undefined>;
    verifier: string | null;
    redirectUri: string;
  }) {
    if (!input.query.code || !input.verifier) throw new Error("Missing code.");
    const tokens = await this.tokenRequest({
      grant_type: "authorization_code",
      code: input.query.code,
      redirect_uri: input.redirectUri,
      code_verifier: input.verifier
    });
    // The token must belong to our application, not one minted elsewhere.
    const info = await json<{ application?: { uid?: string } }>(
      await send(this.http, `${WEB}/oauth/token/info`, {
        headers: this.headers(tokens.access_token)
      }),
      "Reading token info"
    );
    if (info.application?.uid !== this.config.clientId)
      throw new Error("The token belongs to another application.");
    const user = await this.get<{ id: number }>(
      "/user",
      tokens.access_token,
      "Reading the user"
    );
    return {
      providerUserId: String(user.id),
      userToken: JSON.stringify(tokens)
    };
  }

  private tokens(userToken: string | null): Tokens {
    if (!userToken) throw new ProviderAuthorizationError("Authorize again.");
    return JSON.parse(userToken) as Tokens;
  }

  async listCandidates(input: { userToken: string | null }) {
    const { access_token } = this.tokens(input.userToken);
    const projects = await this.pages<ProjectPayload>(
      "/projects?membership=true&min_access_level=40&simple=true",
      access_token,
      "Listing projects"
    );
    return projects.map((project): RepositoryCandidate => ({
      provider_repository_id: String(project.id),
      full_name: project.path_with_namespace,
      default_branch: project.default_branch,
      eligible: Boolean(project.default_branch),
      ineligible_reason: project.default_branch
        ? null
        : "The project has no branches yet."
    }));
  }

  async prepareConnection(input: {
    attempt: AttemptRow;
    userToken: string | null;
    providerRepositoryId: string;
    connectionId: string;
  }): Promise<PreparedConnection> {
    const tokens = this.tokens(input.userToken);
    const id = encodeURIComponent(input.providerRepositoryId);
    // Hooks need Maintainer; re-check it rather than trusting the picker.
    const member = await send(
      this.http,
      `${API}/projects/${id}/members/all/${encodeURIComponent(input.attempt.providerUserId ?? "")}`,
      { headers: this.headers(tokens.access_token) }
    );
    const access = member.ok
      ? (((await member.json()) as { access_level?: number }).access_level ?? 0)
      : 0;
    if (access < 40)
      throw new ProviderAuthorizationError(
        "Connecting needs the Maintainer role on that project."
      );
    const project = await this.get<ProjectPayload>(
      `/projects/${id}`,
      tokens.access_token,
      "Reading the project"
    );
    if (!project.default_branch)
      throw new ProviderAuthorizationError("The project has no branches yet.");
    const signingToken = `whsec_${randomBytes(32).toString("base64")}`;
    const hook = await json<{ id: number }>(
      await send(this.http, `${API}/projects/${id}/hooks`, {
        method: "POST",
        headers: {
          ...this.headers(tokens.access_token),
          "content-type": "application/json"
        },
        body: JSON.stringify({
          url: `${this.publicApiUrl}/api/v1/webhooks/gitlab/${input.connectionId}`,
          push_events: true,
          merge_requests_events: true,
          tag_push_events: false,
          branch_filter_strategy: "all_branches",
          enable_ssl_verification: true,
          signing_token: signingToken
        })
      }),
      "Creating the webhook"
    );
    return {
      repository: this.remote(project),
      installationId: null,
      providerAccountId: input.attempt.providerUserId ?? "",
      gitlabHookId: String(hook.id),
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      tokenExpiresAt: new Date(tokens.expires_at),
      webhookSecret: signingToken
    };
  }

  /** Best effort: delete the hook, then revoke both tokens. */
  async disconnect(connection: ConnectionRow) {
    const open = (purpose: string, value: string | null) =>
      value
        ? this.secrets.open(
            value,
            aad("repository_connections", connection.id, purpose)
          )
        : null;
    const access = await this.accessToken(connection).catch(() =>
      open("access_token", connection.accessTokenCiphertext)
    );
    if (access && connection.gitlabHookId)
      await send(
        this.http,
        `${API}/projects/${encodeURIComponent(connection.providerRepositoryId)}/hooks/${encodeURIComponent(connection.gitlabHookId)}`,
        { method: "DELETE", headers: this.headers(access) }
      ).catch(() => undefined);
    const refreshed = await this.db
      .select()
      .from(repositoryConnections)
      .where(eq(repositoryConnections.id, connection.id))
      .then(([row]) => row ?? connection);
    for (const [purpose, value] of [
      ["access_token", refreshed.accessTokenCiphertext],
      ["refresh_token", refreshed.refreshTokenCiphertext]
    ] as const) {
      const token = open(purpose, value);
      if (token)
        await send(this.http, `${WEB}/oauth/revoke`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            client_id: this.config.clientId,
            client_secret: this.config.clientSecret,
            token
          })
        }).catch(() => undefined);
    }
  }

  /**
   * Standard Webhooks v1: HMAC-SHA256 of `id.timestamp.body` keyed by the
   * decoded signing token, within 5 minutes, from gitlab.com only.
   */
  async verify(input: {
    headers: Headers;
    rawBody: Buffer;
    connection: ConnectionRow | null;
    now: Date;
  }) {
    const connection = input.connection;
    if (!connection?.webhookSecretCiphertext) return null;
    if (header(input.headers, "x-gitlab-instance") !== WEB) return null;
    const id =
      header(input.headers, "webhook-id") ??
      header(input.headers, "idempotency-key");
    const timestamp = header(input.headers, "webhook-timestamp");
    const signatures = header(input.headers, "webhook-signature") ?? "";
    if (!id || !timestamp || !/^\d+$/.test(timestamp)) return null;
    if (Math.abs(input.now.getTime() - Number(timestamp) * 1000) > WINDOW_MS)
      return null;
    const secret = this.secrets.open(
      connection.webhookSecretCiphertext,
      aad("repository_connections", connection.id, "webhook_secret")
    );
    const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
    const expected = createHmac("sha256", key)
      .update(`${id}.${timestamp}.`)
      .update(input.rawBody)
      .digest();
    const matched = signatures.split(" ").some((entry) => {
      const [version, value] = entry.split(",");
      if (version !== "v1" || !value) return false;
      const given = Buffer.from(value, "base64");
      return (
        given.length === expected.length && timingSafeEqual(given, expected)
      );
    });
    if (!matched) return null;
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(input.rawBody.toString("utf8"));
    } catch {
      return null;
    }
    const project =
      (payload.project as { id?: number } | undefined)?.id ??
      payload.project_id;
    return {
      deliveryId: id,
      eventType: header(input.headers, "x-gitlab-event") ?? "unknown",
      installationId: null,
      repositoryId: project === undefined ? null : String(project),
      payload
    };
  }

  parse(
    delivery: { eventType: string; payload: Record<string, unknown> },
    connection: ConnectionRow
  ): ProviderEvent[] {
    const payload = delivery.payload as Record<string, any>;
    const projectId = payload.project?.id ?? payload.project_id;
    if (String(projectId) !== connection.providerRepositoryId) return [];
    const events: ProviderEvent[] = [];
    // GitLab sends no event for a default-branch change; payloads carry it.
    const defaultBranch = payload.project?.default_branch;
    if (
      typeof defaultBranch === "string" &&
      defaultBranch !== connection.providerDefaultBranch
    )
      events.push({ type: "default_branch_changed", name: defaultBranch });
    if (delivery.eventType === "Push Hook") {
      const ref = String(payload.ref ?? "");
      if (ref.startsWith("refs/heads/")) {
        const name = ref.slice("refs/heads/".length);
        // Zero SHAs are hints; deletes are confirmed through the API.
        events.push(
          payload.after === ZERO_SHA
            ? { type: "ref_deleted", name, beforeSha: payload.before ?? null }
            : { type: "ref_pushed", name, sha: payload.after ?? null }
        );
      }
    }
    if (
      delivery.eventType === "Merge Request Hook" &&
      payload.object_attributes?.action === "merge"
    ) {
      const request = payload.object_attributes as MergeRequestPayload & {
        last_commit?: { id?: string };
        url?: string;
      };
      events.push({
        type: "change_merged",
        change: this.change({
          ...request,
          sha: request.last_commit?.id ?? request.sha ?? null,
          web_url: request.url ?? request.web_url
        })
      });
    }
    return events;
  }

  private change(request: MergeRequestPayload): MergedChange {
    return {
      number: String(request.iid),
      headRef: request.source_branch,
      headSha: request.sha ?? null,
      baseRef: request.target_branch,
      mergeSha: request.merge_commit_sha ?? request.squash_commit_sha ?? null,
      mergedAt:
        request.merged_at ?? request.updated_at ?? this.now().toISOString(),
      fromFork: request.source_project_id !== request.target_project_id,
      url: request.web_url ?? null
    };
  }

  private remote(project: ProjectPayload): RemoteRepository {
    return {
      id: String(project.id),
      fullName: project.path_with_namespace,
      url: project.web_url ?? null,
      defaultBranch: project.default_branch ?? "main"
    };
  }

  private path(connection: ConnectionRow) {
    return `/projects/${encodeURIComponent(connection.providerRepositoryId)}`;
  }

  async getRepository(connection: ConnectionRow) {
    return this.remote(
      await this.get<ProjectPayload>(
        this.path(connection),
        await this.accessToken(connection),
        "Reading the project"
      )
    );
  }

  async getBranch(
    connection: ConnectionRow,
    name: string
  ): Promise<RemoteBranch | null> {
    const response = await send(
      this.http,
      `${API}${this.path(connection)}/repository/branches/${encodeURIComponent(name)}`,
      { headers: this.headers(await this.accessToken(connection)) }
    );
    if (response.status === 404) return null;
    const branch = await json<{ name: string; commit: { id: string } }>(
      response,
      "Reading a branch"
    );
    return { name: branch.name, sha: branch.commit.id };
  }

  async listBranches(connection: ConnectionRow): Promise<RemoteBranch[]> {
    const token = await this.accessToken(connection);
    return (
      await this.pages<{ name: string; commit: { id: string } }>(
        `${this.path(connection)}/repository/branches`,
        token,
        "Listing branches"
      )
    ).map((branch) => ({ name: branch.name, sha: branch.commit.id }));
  }

  async listMergedChanges(connection: ConnectionRow, since: Date) {
    const requests = await this.pages<MergeRequestPayload>(
      `${this.path(connection)}/merge_requests?state=merged&merged_after=${encodeURIComponent(since.toISOString())}&order_by=merged_at&sort=asc`,
      await this.accessToken(connection),
      "Listing merge requests"
    );
    return requests.map((request) => this.change(request));
  }

  /** Hook health for the settings card (GitLab auto-disables failing hooks). */
  async maintain(connection: ConnectionRow): Promise<Partial<ConnectionRow>> {
    if (!connection.gitlabHookId) return {};
    const hook = await this.get<{
      alert_status?: string | null;
      disabled_until?: string | null;
    }>(
      `${this.path(connection)}/hooks/${encodeURIComponent(connection.gitlabHookId)}`,
      await this.accessToken(connection),
      "Reading the webhook"
    );
    return {
      hookHealth: {
        alert_status: hook.alert_status ?? null,
        disabled_until: hook.disabled_until ?? null
      }
    };
  }

  /** Settings → Re-enable: a test delivery wakes a disabled hook. */
  async reenable(connection: ConnectionRow) {
    if (!connection.gitlabHookId) return;
    const response = await send(
      this.http,
      `${API}${this.path(connection)}/hooks/${encodeURIComponent(connection.gitlabHookId)}/test/push_events`,
      {
        method: "POST",
        headers: this.headers(await this.accessToken(connection))
      }
    );
    if (!response.ok)
      throw new ProviderHttpError(response.status, "Testing the webhook");
  }
}
