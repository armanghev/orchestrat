import { createHmac, createSign, timingSafeEqual } from "node:crypto";
import type { RepositoryCandidate } from "@orchestrat/protocol";
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
import {
  json,
  nextLink,
  ProviderHttpError,
  send,
  type HttpOptions
} from "./http.js";

// The GitHub App adapter (docs/project-branches.md §8.3). Installation tokens
// are minted per call for one repository with the narrowest permission and
// kept in memory only; the app never reads file contents or writes.

export type GithubConfig = {
  appId: string;
  clientId: string;
  clientSecret: string;
  slug: string;
  privateKeyPem: string;
  webhookSecret: string;
};

type Permission = "metadata" | "pull_requests";
type RepositoryPayload = {
  id: number;
  full_name: string;
  html_url?: string;
  default_branch: string;
  fork?: boolean;
};
type PullPayload = {
  number: number;
  html_url?: string;
  merged_at: string | null;
  updated_at?: string;
  merge_commit_sha?: string | null;
  head: { ref: string; sha: string; repo?: { id: number } | null };
  base: { ref: string; repo?: { id: number } | null };
};

const API = "https://api.github.com";
const WEB = "https://github.com";
const header = (headers: Headers, name: string) => {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
};
const b64url = (value: string | Buffer) =>
  Buffer.from(value).toString("base64url");
const REDELIVERY_EVERY_MS = 3_600_000;
const REDELIVERY_WINDOW_MS = 3 * 24 * 3_600_000;

/** `X-Hub-Signature-256`: sha256= + HMAC-SHA256 of the raw body, in constant time. */
export function githubSignatureMatches(
  secret: string,
  rawBody: Buffer,
  signature: string
) {
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  return (
    signature.length === expected.length &&
    timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  );
}

export class GithubAdapter implements ProviderAdapter {
  readonly provider = "github" as const;
  private readonly tokens = new Map<
    string,
    { token: string; expiresAt: number }
  >();
  private lastRedelivery = 0;
  readonly redelivered: string[] = [];

  constructor(
    private readonly config: GithubConfig,
    private readonly http: HttpOptions & { now?: () => Date } = {}
  ) {}

  private now() {
    return this.http.now?.() ?? new Date();
  }

  /** RS256 app JWT: iat 60 s in the past, exp under 10 min, iss = client id. */
  appJwt() {
    const seconds = Math.floor(this.now().getTime() / 1000);
    const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const body = b64url(
      JSON.stringify({
        iat: seconds - 60,
        exp: seconds + 540,
        iss: this.config.clientId
      })
    );
    const signature = createSign("RSA-SHA256")
      .update(`${head}.${body}`)
      .sign(this.config.privateKeyPem);
    return `${head}.${body}.${b64url(signature)}`;
  }

  private headers(token: string, scheme = "Bearer") {
    return {
      accept: "application/vnd.github+json",
      authorization: `${scheme} ${token}`,
      "x-github-api-version": "2026-03-10",
      "user-agent": "orchestrat"
    };
  }

  private async get<T>(url: string, token: string, what: string) {
    return json<T>(
      await send(this.http, url, { headers: this.headers(token) }),
      what
    );
  }

  /**
   * An installation token for one repository and one permission, cached in
   * memory for at most 55 minutes.
   */
  private async installationToken(
    connection: ConnectionRow,
    permission: Permission
  ) {
    const key = `${connection.installationId}:${connection.providerRepositoryId}:${permission}`;
    const cached = this.tokens.get(key);
    if (cached && cached.expiresAt > this.now().getTime()) return cached.token;
    const response = await send(
      this.http,
      `${API}/app/installations/${encodeURIComponent(connection.installationId ?? "")}/access_tokens`,
      {
        method: "POST",
        headers: {
          ...this.headers(this.appJwt()),
          "content-type": "application/json"
        },
        body: JSON.stringify({
          repository_ids: [Number(connection.providerRepositoryId)],
          permissions: { [permission]: "read" }
        })
      }
    );
    if ([401, 403, 404, 422].includes(response.status))
      throw new ProviderAuthorizationError(
        "The installation can't reach the repository."
      );
    const { token } = await json<{ token: string }>(
      response,
      "Minting a token"
    );
    this.tokens.set(key, {
      token,
      expiresAt: this.now().getTime() + 55 * 60_000
    });
    return token;
  }

  authorizeUrl(input: {
    state: string;
    codeChallenge: string;
    redirectUri: string;
  }) {
    const url = new URL(`${WEB}/login/oauth/authorize`);
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("redirect_uri", input.redirectUri);
    url.searchParams.set("state", input.state);
    url.searchParams.set("code_challenge", input.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    return url.toString();
  }

  /** Where people install the app when their repository isn't listed. */
  installUrl(state: string) {
    return `${WEB}/apps/${encodeURIComponent(this.config.slug)}/installations/new?state=${encodeURIComponent(state)}`;
  }

  async completeAuthorization(input: {
    query: Record<string, string | undefined>;
    verifier: string | null;
    redirectUri: string;
  }) {
    if (!input.query.code || !input.verifier) throw new Error("Missing code.");
    const exchanged = await json<{ access_token?: string }>(
      await send(this.http, `${WEB}/login/oauth/access_token`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json"
        },
        body: JSON.stringify({
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
          code: input.query.code,
          redirect_uri: input.redirectUri,
          code_verifier: input.verifier
        })
      }),
      "Exchanging the code"
    );
    if (!exchanged.access_token) throw new Error("No user token.");
    const user = await this.get<{ id: number }>(
      `${API}/user`,
      exchanged.access_token,
      "Reading the user"
    );
    return {
      providerUserId: String(user.id),
      userToken: exchanged.access_token,
      installationId: input.query.installation_id ?? null
    };
  }

  private async userInstallations(userToken: string) {
    const page = await this.get<{ installations: { id: number }[] }>(
      `${API}/user/installations?per_page=100`,
      userToken,
      "Listing installations"
    );
    return page.installations.map((installation) => String(installation.id));
  }

  /**
   * The Setup URL's installation id is untrusted: it counts only when the
   * user's own token lists it.
   */
  async confirmInstallation(input: {
    userToken: string | null;
    installationId: string;
  }) {
    if (!input.userToken)
      throw new ProviderAuthorizationError("Authorize again.");
    const installations = await this.userInstallations(input.userToken);
    if (!installations.includes(input.installationId))
      throw new ProviderAuthorizationError("That installation isn't yours.");
    return { installationId: input.installationId };
  }

  private async userRepositories(userToken: string, installationId: string) {
    const repositories: RepositoryPayload[] = [];
    let url: string | null =
      `${API}/user/installations/${encodeURIComponent(installationId)}/repositories?per_page=100`;
    while (url) {
      const response = await send(this.http, url, {
        headers: this.headers(userToken)
      });
      repositories.push(
        ...(
          await json<{ repositories: RepositoryPayload[] }>(
            response,
            "Listing repositories"
          )
        ).repositories
      );
      url = nextLink(response);
    }
    return repositories;
  }

  async listCandidates(input: {
    attempt: AttemptRow;
    userToken: string | null;
  }) {
    if (!input.userToken)
      throw new ProviderAuthorizationError("Authorize again.");
    const installations = input.attempt.installationId
      ? [input.attempt.installationId]
      : await this.userInstallations(input.userToken);
    const candidates: RepositoryCandidate[] = [];
    for (const installation of installations)
      for (const repository of await this.userRepositories(
        input.userToken,
        installation
      ))
        candidates.push({
          provider_repository_id: String(repository.id),
          full_name: repository.full_name,
          default_branch: repository.default_branch,
          eligible: true,
          ineligible_reason: null
        });
    return candidates;
  }

  async prepareConnection(input: {
    attempt: AttemptRow;
    userToken: string | null;
    providerRepositoryId: string;
  }): Promise<PreparedConnection> {
    if (!input.userToken)
      throw new ProviderAuthorizationError("Authorize again.");
    // The repository must be listed for this user under an installation of
    // theirs; then the app checks that installation isn't suspended.
    let installationId: string | null = null;
    for (const installation of await this.userInstallations(input.userToken))
      if (
        (await this.userRepositories(input.userToken, installation)).some(
          (repository) => String(repository.id) === input.providerRepositoryId
        )
      ) {
        installationId = installation;
        break;
      }
    if (!installationId)
      throw new ProviderAuthorizationError(
        "The app can't reach that repository."
      );
    const installation = await this.get<{ suspended_at: string | null }>(
      `${API}/app/installations/${encodeURIComponent(installationId)}`,
      this.appJwt(),
      "Reading the installation"
    );
    if (installation.suspended_at)
      throw new ProviderAuthorizationError(
        "The app is suspended for that account."
      );
    const draft = {
      installationId,
      providerRepositoryId: input.providerRepositoryId
    } as ConnectionRow;
    return {
      repository: await this.getRepository(draft),
      installationId,
      providerAccountId: input.attempt.providerUserId ?? ""
    };
  }

  async verify(input: { headers: Headers; rawBody: Buffer }) {
    if (
      !githubSignatureMatches(
        this.config.webhookSecret,
        input.rawBody,
        header(input.headers, "x-hub-signature-256") ?? ""
      )
    )
      return null;
    const deliveryId = header(input.headers, "x-github-delivery");
    const eventType = header(input.headers, "x-github-event");
    if (!deliveryId || !eventType) return null;
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(input.rawBody.toString("utf8"));
    } catch {
      return null;
    }
    const installation = (payload.installation as { id?: number } | undefined)
      ?.id;
    const repository = (payload.repository as { id?: number } | undefined)?.id;
    return {
      deliveryId,
      eventType,
      installationId: installation === undefined ? null : String(installation),
      repositoryId: repository === undefined ? null : String(repository),
      payload
    };
  }

  parse(
    delivery: { eventType: string; payload: Record<string, unknown> },
    connection: ConnectionRow
  ): ProviderEvent[] {
    const payload = delivery.payload as Record<string, any>;
    // Only this connection's installation speaks for it.
    if (
      payload.installation?.id !== undefined &&
      String(payload.installation.id) !== connection.installationId
    )
      return [];
    const branchOf = (ref: unknown) =>
      typeof ref === "string" && ref.startsWith("refs/heads/")
        ? ref.slice("refs/heads/".length)
        : null;
    switch (delivery.eventType) {
      case "push": {
        const name = branchOf(payload.ref);
        if (!name) return [];
        return payload.deleted
          ? [{ type: "ref_deleted", name, beforeSha: payload.before ?? null }]
          : [{ type: "ref_pushed", name, sha: payload.after ?? null }];
      }
      // No SHA here: treat as a reason to look at that branch again.
      case "create":
        return payload.ref_type === "branch"
          ? [{ type: "ref_pushed", name: String(payload.ref), sha: null }]
          : [];
      case "delete":
        return payload.ref_type === "branch"
          ? [
              {
                type: "ref_deleted",
                name: String(payload.ref),
                beforeSha: null
              }
            ]
          : [];
      case "pull_request": {
        const pull = payload.pull_request as PullPayload | undefined;
        if (payload.action !== "closed" || !pull?.merged_at) return [];
        return [{ type: "change_merged", change: this.change(pull) }];
      }
      case "repository":
        if (payload.action === "edited" && payload.changes?.default_branch)
          return [
            {
              type: "default_branch_changed",
              name: payload.repository.default_branch
            }
          ];
        if (payload.action === "renamed" || payload.action === "transferred")
          return [
            {
              type: "repository_renamed",
              fullName: payload.repository.full_name,
              url: payload.repository.html_url ?? null
            }
          ];
        if (payload.action === "deleted")
          return [{ type: "installation_deleted" }];
        return [];
      case "installation":
        if (payload.action === "deleted")
          return [{ type: "installation_deleted" }];
        if (payload.action === "suspend")
          return [{ type: "installation_suspended" }];
        if (payload.action === "unsuspend")
          return [{ type: "installation_unsuspended" }];
        return [{ type: "reconcile" }];
      case "installation_repositories":
        return (
          payload.repositories_removed as { id: number }[] | undefined
        )?.some(
          (repository) =>
            String(repository.id) === connection.providerRepositoryId
        )
          ? [{ type: "authorization_revoked" }]
          : [];
      default:
        return [];
    }
  }

  private change(pull: PullPayload): MergedChange {
    return {
      number: String(pull.number),
      headRef: pull.head.ref,
      headSha: pull.head.sha,
      baseRef: pull.base.ref,
      // Recorded when present, never relied on (removed in 2026-03-10).
      mergeSha: pull.merge_commit_sha ?? null,
      mergedAt: pull.merged_at!,
      fromFork:
        pull.head.repo?.id !== undefined &&
        pull.base.repo?.id !== undefined &&
        pull.head.repo.id !== pull.base.repo.id,
      url: pull.html_url ?? null
    };
  }

  async getRepository(connection: ConnectionRow): Promise<RemoteRepository> {
    const repository = await this.get<RepositoryPayload>(
      `${API}/repositories/${encodeURIComponent(connection.providerRepositoryId)}`,
      await this.installationToken(connection, "metadata"),
      "Reading the repository"
    );
    return {
      id: String(repository.id),
      fullName: repository.full_name,
      url: repository.html_url ?? null,
      defaultBranch: repository.default_branch
    };
  }

  private repoPath(connection: ConnectionRow) {
    return `${API}/repositories/${encodeURIComponent(connection.providerRepositoryId)}`;
  }

  async getBranch(
    connection: ConnectionRow,
    name: string
  ): Promise<RemoteBranch | null> {
    const response = await send(
      this.http,
      `${this.repoPath(connection)}/branches/${encodeURIComponent(name)}`,
      {
        headers: this.headers(
          await this.installationToken(connection, "metadata")
        )
      }
    );
    if (response.status === 404) return null;
    const branch = await json<{ name: string; commit: { sha: string } }>(
      response,
      "Reading a branch"
    );
    return { name: branch.name, sha: branch.commit.sha };
  }

  async listBranches(connection: ConnectionRow): Promise<RemoteBranch[]> {
    const token = await this.installationToken(connection, "metadata");
    const branches: RemoteBranch[] = [];
    let url: string | null =
      `${this.repoPath(connection)}/branches?per_page=100`;
    while (url) {
      const response = await send(this.http, url, {
        headers: this.headers(token)
      });
      for (const branch of await json<
        { name: string; commit: { sha: string } }[]
      >(response, "Listing branches"))
        branches.push({ name: branch.name, sha: branch.commit.sha });
      url = nextLink(response);
    }
    return branches;
  }

  async listMergedChanges(connection: ConnectionRow, since: Date) {
    const token = await this.installationToken(connection, "pull_requests");
    const changes: MergedChange[] = [];
    let url: string | null =
      `${this.repoPath(connection)}/pulls?state=closed&sort=updated&direction=desc&per_page=100`;
    while (url) {
      const response = await send(this.http, url, {
        headers: this.headers(token)
      });
      const pulls = await json<PullPayload[]>(
        response,
        "Listing pull requests"
      );
      for (const pull of pulls)
        if (pull.merged_at && new Date(pull.merged_at) >= since)
          changes.push(this.change(pull));
      // Sorted by update time: older pages can't hold newer merges.
      const oldest = pulls.at(-1)?.updated_at;
      url = oldest && new Date(oldest) < since ? null : nextLink(response);
    }
    return changes;
  }

  /**
   * Once an hour, redeliver app webhook deliveries from the last 3 days that
   * never succeeded (GitHub doesn't retry on its own).
   */
  async maintain(): Promise<Partial<ConnectionRow>> {
    const now = this.now().getTime();
    if (now - this.lastRedelivery < REDELIVERY_EVERY_MS) return {};
    this.lastRedelivery = now;
    const jwt = this.appJwt();
    const attempts = new Map<
      string,
      { id: number; ok: boolean; at: number }[]
    >();
    let url: string | null = `${API}/app/hook/deliveries?per_page=100`;
    while (url) {
      const response = await send(this.http, url, {
        headers: this.headers(jwt)
      });
      const page = await json<
        {
          id: number;
          guid: string;
          status_code: number;
          delivered_at: string;
        }[]
      >(response, "Listing deliveries");
      for (const delivery of page)
        attempts.set(delivery.guid, [
          ...(attempts.get(delivery.guid) ?? []),
          {
            id: delivery.id,
            ok: delivery.status_code >= 200 && delivery.status_code < 300,
            at: new Date(delivery.delivered_at).getTime()
          }
        ]);
      const oldest = page.at(-1)?.delivered_at;
      url =
        oldest && now - new Date(oldest).getTime() > REDELIVERY_WINDOW_MS
          ? null
          : nextLink(response);
    }
    for (const [guid, tries] of attempts) {
      if (tries.some((attempt) => attempt.ok)) continue;
      const latest = tries.reduce((left, right) =>
        right.at > left.at ? right : left
      );
      if (now - latest.at > REDELIVERY_WINDOW_MS) continue;
      const response = await send(
        this.http,
        `${API}/app/hook/deliveries/${latest.id}/attempts`,
        { method: "POST", headers: this.headers(jwt) }
      );
      if (!response.ok && response.status !== 202)
        throw new ProviderHttpError(response.status, "Redelivering");
      this.redelivered.push(guid);
    }
    return {};
  }
}
