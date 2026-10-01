import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
  type KeyObject
} from "node:crypto";
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
import { json, ProviderHttpError, send, type HttpOptions } from "./http.js";

// The Cursor Origin adapter (docs/project-branches.md §8.5). Origin signs
// receipts and webhooks with its own Ed25519 keys (JWKS); the app signs its
// JWTs with ours. Installation tokens are minted per repository and kept in
// memory only until they expire.

export type OriginConfig = {
  appId: string;
  privateKeyPem: string;
  apiBase: string;
};

const INSTALL = "https://cursor.com/codebase/apps/install";
const SCOPES = [
  "repository:metadata:read",
  "repository:contents:read",
  "repository:pull_requests:read"
];
const WINDOW_MS = 300_000;
const JWKS_TTL_MS = 600_000;
const REDELIVERY_EVERY_MS = 3_600_000;
const REDELIVERY_WINDOW_MS = 7 * 24 * 3_600_000;
const header = (headers: Headers, name: string) => {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
};
const b64url = (value: string | Buffer) =>
  Buffer.from(value).toString("base64url");
const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const branchName = (ref: string) =>
  ref.startsWith("refs/heads/")
    ? ref.slice("refs/heads/".length)
    : ref.startsWith("refs/")
      ? null
      : ref;

type OriginRepository = {
  id: string;
  fullName: string;
  url?: string | null;
  defaultBranch: string;
  mirror?: { source?: string; status?: string } | null;
};
type OriginPull = {
  number: string | number;
  url?: string | null;
  mergedAt?: string | null;
  updatedAt?: string;
  mergeCommitSha?: string | null;
  head: { ref: string; sha?: string | null; repositoryId?: string | null };
  base: { ref: string; repositoryId?: string | null };
};

export class OriginAdapter implements ProviderAdapter {
  readonly provider = "origin" as const;
  private keys: { at: number; keys: KeyObject[] } | null = null;
  private readonly tokens = new Map<
    string,
    { token: string; expiresAt: number }
  >();
  private readonly privateKey: KeyObject;
  private lastRedelivery = 0;
  readonly redelivered: string[] = [];

  constructor(
    private readonly config: OriginConfig,
    private readonly http: HttpOptions & { now?: () => Date } = {}
  ) {
    this.privateKey = createPrivateKey(config.privateKeyPem);
  }

  private now() {
    return this.http.now?.() ?? new Date();
  }

  /** EdDSA app JWT; `kid` is the app id (the docs disagree, see §8.10). */
  appJwt() {
    const seconds = Math.floor(this.now().getTime() / 1000);
    const head = b64url(
      JSON.stringify({ alg: "EdDSA", kid: this.config.appId, typ: "JWT" })
    );
    const body = b64url(
      JSON.stringify({
        iss: this.config.appId,
        aud: "origin-apps",
        iat: seconds,
        exp: seconds + 300
      })
    );
    return `${head}.${body}.${b64url(sign(null, Buffer.from(`${head}.${body}`), this.privateKey))}`;
  }

  private headers(token: string) {
    return { authorization: `Bearer ${token}`, accept: "application/json" };
  }

  /** Origin's signing keys, cached 600 s and refreshed when nothing verifies. */
  private async signingKeys(refresh = false) {
    if (
      !refresh &&
      this.keys &&
      this.now().getTime() - this.keys.at < JWKS_TTL_MS
    )
      return this.keys.keys;
    const { keys } = await json<{ keys: Record<string, unknown>[] }>(
      await send(this.http, `${this.config.apiBase}/keys`),
      "Reading Origin's keys"
    );
    this.keys = {
      at: this.now().getTime(),
      keys: keys
        .filter((key) => key.kty === "OKP" && key.crv === "Ed25519")
        .map((key) => createPublicKey({ key: key as never, format: "jwk" }))
    };
    return this.keys.keys;
  }

  private async verifiedBy(data: Buffer, signature: Buffer) {
    for (const refresh of [false, true]) {
      const keys = await this.signingKeys(refresh);
      if (keys.some((key) => verify(null, data, key, signature))) return true;
    }
    return false;
  }

  private async installationToken(
    installationId: string,
    repositoryId: string | null,
    scopes: string[]
  ) {
    const key = `${installationId}:${repositoryId}:${scopes.join(",")}`;
    const cached = this.tokens.get(key);
    if (cached && cached.expiresAt - 60_000 > this.now().getTime())
      return cached.token;
    const response = await send(
      this.http,
      `${this.config.apiBase}/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
      {
        method: "POST",
        headers: {
          ...this.headers(this.appJwt()),
          "content-type": "application/json"
        },
        body: JSON.stringify({
          ...(repositoryId ? { repositoryIds: [repositoryId] } : {}),
          scopes
        })
      }
    );
    if ([401, 403, 404].includes(response.status))
      throw new ProviderAuthorizationError(
        "The installation can't reach the repository."
      );
    const minted = await json<{ token: string; expiresAt?: string }>(
      response,
      "Minting a token"
    );
    this.tokens.set(key, {
      token: minted.token,
      expiresAt: minted.expiresAt
        ? Date.parse(minted.expiresAt)
        : this.now().getTime() + 15 * 60_000
    });
    return minted.token;
  }

  authorizeUrl(input: { state: string; redirectUri: string }) {
    const url = new URL(INSTALL);
    url.searchParams.set("client_id", this.config.appId);
    url.searchParams.set("scope", SCOPES.join(" "));
    url.searchParams.set("redirect_uri", input.redirectUri);
    url.searchParams.set("state", input.state);
    return url.toString();
  }

  /**
   * Verifies the installation receipt (EdDSA over Origin's JWKS, typ, iss,
   * aud, exp, the attempt's state), then checks the installation itself.
   */
  async completeAuthorization(input: {
    attempt: AttemptRow;
    query: Record<string, string | undefined>;
  }) {
    const receipt = input.query.installation_receipt ?? "";
    const [head, body, signature] = receipt.split(".");
    if (!head || !body || !signature) throw new Error("Malformed receipt.");
    const parsedHead = JSON.parse(
      Buffer.from(head, "base64url").toString()
    ) as Record<string, unknown>;
    if (
      parsedHead.alg !== "EdDSA" ||
      parsedHead.typ !== "origin-installation-receipt+jwt"
    )
      throw new Error("Unexpected receipt type.");
    if (
      !(await this.verifiedBy(
        Buffer.from(`${head}.${body}`),
        Buffer.from(signature, "base64url")
      ))
    )
      throw new Error("Receipt signature invalid.");
    const claims = JSON.parse(
      Buffer.from(body, "base64url").toString()
    ) as Record<string, unknown>;
    if (
      claims.iss !== this.config.apiBase ||
      claims.aud !== this.config.appId ||
      typeof claims.exp !== "number" ||
      claims.exp * 1000 <= this.now().getTime() ||
      typeof claims.state !== "string" ||
      sha256(claims.state) !== input.attempt.stateHash ||
      typeof claims.jti !== "string" ||
      typeof claims.sub !== "string"
    )
      throw new Error("Receipt claims invalid.");
    const installation = await json<{
      id: string;
      appId: string;
      target?: { id?: string };
      suspendedAt?: string | null;
      scopes?: string[];
    }>(
      await send(
        this.http,
        `${this.config.apiBase}/app/installations/${encodeURIComponent(claims.sub)}`,
        { headers: this.headers(this.appJwt()) }
      ),
      "Reading the installation"
    );
    if (
      installation.appId !== this.config.appId ||
      installation.target?.id !== claims.namespace_id ||
      installation.suspendedAt ||
      !SCOPES.every((scope) => installation.scopes?.includes(scope))
    )
      throw new Error("Installation doesn't match.");
    return {
      providerUserId: String(claims.user_id ?? claims.sub),
      installationId: claims.sub,
      receiptJti: claims.jti,
      userToken: null
    };
  }

  private repository(value: OriginRepository): RemoteRepository {
    // Origin doesn't announce pushes to GitHub mirrors; connect GitHub instead.
    const mirrored =
      value.mirror?.source === "github" && value.mirror.status === "inbound";
    return {
      id: value.id,
      fullName: value.fullName,
      url: value.url ?? null,
      defaultBranch: value.defaultBranch,
      ineligibleReason: mirrored
        ? "This repository mirrors GitHub. Connect the GitHub repository instead."
        : null
    };
  }

  async listCandidates(input: { attempt: AttemptRow }) {
    const token = await this.installationToken(
      input.attempt.installationId ?? "",
      null,
      ["repository:metadata:read"]
    );
    const { repos } = await json<{ repos: OriginRepository[] }>(
      await send(this.http, `${this.config.apiBase}/installation/repos`, {
        headers: this.headers(token)
      }),
      "Listing repositories"
    );
    return repos.map((value): RepositoryCandidate => {
      const repository = this.repository(value);
      return {
        provider_repository_id: repository.id,
        full_name: repository.fullName,
        default_branch: repository.defaultBranch,
        eligible: !repository.ineligibleReason,
        ineligible_reason: repository.ineligibleReason ?? null
      };
    });
  }

  async prepareConnection(input: {
    attempt: AttemptRow;
    providerRepositoryId: string;
  }): Promise<PreparedConnection> {
    const draft = {
      installationId: input.attempt.installationId,
      providerRepositoryId: input.providerRepositoryId
    } as ConnectionRow;
    return {
      repository: await this.getRepository(draft),
      installationId: input.attempt.installationId,
      providerAccountId: input.attempt.providerUserId ?? ""
    };
  }

  /**
   * `v1ed`: Ed25519 over the lowercase hex SHA-256 of `id.timestamp.body`,
   * against each of Origin's keys, within 300 s.
   */
  async verify(input: { headers: Headers; rawBody: Buffer; now: Date }) {
    const id = header(input.headers, "webhook-id");
    const timestamp = header(input.headers, "webhook-timestamp");
    if (!id || !timestamp || !/^\d+$/.test(timestamp)) return null;
    if (Math.abs(input.now.getTime() - Number(timestamp) * 1000) > WINDOW_MS)
      return null;
    const digest = Buffer.from(
      createHash("sha256")
        .update(`${id}.${timestamp}.`)
        .update(input.rawBody)
        .digest("hex")
    );
    const signatures = (header(input.headers, "webhook-signature") ?? "")
      .split(" ")
      .map((entry) => entry.split(","))
      .filter(([version, value]) => version === "v1ed" && value)
      .map(([, value]) => Buffer.from(value!, "base64"));
    let valid = false;
    for (const signature of signatures)
      if (await this.verifiedBy(digest, signature)) valid = true;
    if (!valid) return null;
    let payload: Record<string, any>;
    try {
      payload = JSON.parse(input.rawBody.toString("utf8"));
    } catch {
      return null;
    }
    const repository =
      payload.data?.repository?.id ?? payload.data?.repositoryId;
    return {
      deliveryId: id,
      eventType: String(payload.type ?? "unknown"),
      installationId:
        payload.installationId === undefined
          ? null
          : String(payload.installationId),
      repositoryId: repository === undefined ? null : String(repository),
      payload
    };
  }

  parse(
    delivery: { eventType: string; payload: Record<string, unknown> },
    connection: ConnectionRow
  ): ProviderEvent[] {
    const payload = delivery.payload as Record<string, any>;
    if (
      payload.installationId !== undefined &&
      String(payload.installationId) !== connection.installationId
    )
      return [];
    const data = payload.data ?? {};
    switch (delivery.eventType) {
      case "repository.pushed": {
        const events: ProviderEvent[] = [];
        for (const update of (data.refUpdates ?? []) as Record<string, any>[]) {
          const name = branchName(String(update.ref ?? ""));
          if (!name) continue;
          events.push(
            update.deleted
              ? { type: "ref_deleted", name, beforeSha: update.before ?? null }
              : { type: "ref_pushed", name, sha: update.after ?? null }
          );
        }
        // At most 100 updates ride along; the rest come through reconcile.
        if (Number(data.refUpdatesCount ?? 0) > (data.refUpdates ?? []).length)
          events.push({ type: "reconcile" });
        return events;
      }
      case "pull_request.merged":
        return data.pullRequest
          ? [
              {
                type: "change_merged",
                change: this.change(data.pullRequest as OriginPull)
              }
            ]
          : [];
      case "repository.metadata.updated":
        return typeof data.repository?.defaultBranch === "string" &&
          data.repository.defaultBranch !== connection.providerDefaultBranch
          ? [
              {
                type: "default_branch_changed",
                name: data.repository.defaultBranch
              }
            ]
          : [];
      case "repository.deleted":
      case "installation.deleted":
        return [{ type: "installation_deleted" }];
      case "installation.suspended":
        return [{ type: "installation_suspended" }];
      case "installation.unsuspended":
        return [{ type: "installation_unsuspended" }];
      default:
        return delivery.eventType.startsWith("installation.")
          ? [{ type: "reconcile" }]
          : [];
    }
  }

  private change(pull: OriginPull): MergedChange {
    return {
      number: String(pull.number),
      headRef: branchName(pull.head.ref) ?? pull.head.ref,
      headSha: pull.head.sha ?? null,
      baseRef: branchName(pull.base.ref) ?? pull.base.ref,
      mergeSha: pull.mergeCommitSha ?? null,
      mergedAt: pull.mergedAt ?? pull.updatedAt ?? this.now().toISOString(),
      fromFork:
        Boolean(pull.head.repositoryId && pull.base.repositoryId) &&
        pull.head.repositoryId !== pull.base.repositoryId,
      url: pull.url ?? null
    };
  }

  private repoPath(connection: ConnectionRow) {
    return `${this.config.apiBase}/repos/_/${encodeURIComponent(connection.providerRepositoryId)}`;
  }

  private token(connection: ConnectionRow, scope: string) {
    return this.installationToken(
      connection.installationId ?? "",
      connection.providerRepositoryId,
      [scope]
    );
  }

  async getRepository(connection: ConnectionRow) {
    return this.repository(
      await json<OriginRepository>(
        await send(this.http, this.repoPath(connection), {
          headers: this.headers(
            await this.token(connection, "repository:metadata:read")
          )
        }),
        "Reading the repository"
      )
    );
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
          await this.token(connection, "repository:contents:read")
        )
      }
    );
    if (response.status === 404) return null;
    const branch = await json<{
      name: string;
      sha?: string;
      commitSha?: string;
    }>(response, "Reading a branch");
    return { name: branch.name, sha: branch.sha ?? branch.commitSha ?? null };
  }

  async listBranches(connection: ConnectionRow): Promise<RemoteBranch[]> {
    const token = await this.token(connection, "repository:contents:read");
    const branches: RemoteBranch[] = [];
    let pageToken = "";
    do {
      const page = await json<{
        branches: { name: string; sha?: string; commitSha?: string }[];
        nextPageToken?: string | null;
      }>(
        await send(
          this.http,
          `${this.repoPath(connection)}/branches?pageSize=100${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`,
          { headers: this.headers(token) }
        ),
        "Listing branches"
      );
      for (const branch of page.branches)
        branches.push({
          name: branch.name,
          sha: branch.sha ?? branch.commitSha ?? null
        });
      pageToken = page.nextPageToken ?? "";
    } while (pageToken);
    return branches;
  }

  // `since` filters on creation time, so page by update time instead.
  async listMergedChanges(connection: ConnectionRow, since: Date) {
    const token = await this.token(connection, "repository:pull_requests:read");
    const changes: MergedChange[] = [];
    let pageToken = "";
    do {
      const page = await json<{
        pulls: OriginPull[];
        nextPageToken?: string | null;
      }>(
        await send(
          this.http,
          `${this.repoPath(connection)}/pulls?state=merged&sortBy=updated&direction=desc&pageSize=100${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`,
          { headers: this.headers(token) }
        ),
        "Listing pull requests"
      );
      for (const pull of page.pulls)
        if (pull.mergedAt && new Date(pull.mergedAt) >= since)
          changes.push(this.change(pull));
      const oldest = page.pulls.at(-1)?.updatedAt;
      pageToken =
        oldest && new Date(oldest) < since ? "" : (page.nextPageToken ?? "");
    } while (pageToken);
    return changes;
  }

  /** Hourly: redeliver undelivered webhooks from the last 7 days. */
  async maintain(): Promise<Partial<ConnectionRow>> {
    const now = this.now().getTime();
    if (now - this.lastRedelivery < REDELIVERY_EVERY_MS) return {};
    this.lastRedelivery = now;
    const jwt = this.appJwt();
    const { deliveries } = await json<{
      deliveries: { id: string; createdAt: string }[];
    }>(
      await send(
        this.http,
        `${this.config.apiBase}/app/webhook/deliveries?delivered=false`,
        {
          headers: this.headers(jwt)
        }
      ),
      "Listing deliveries"
    );
    const ids = deliveries
      .filter(
        (delivery) =>
          now - Date.parse(delivery.createdAt) <= REDELIVERY_WINDOW_MS
      )
      .map((delivery) => delivery.id);
    if (!ids.length) return {};
    const response = await send(
      this.http,
      `${this.config.apiBase}/app/webhook/deliveries:batchRedeliver`,
      {
        method: "POST",
        headers: { ...this.headers(jwt), "content-type": "application/json" },
        body: JSON.stringify({ ids })
      }
    );
    if (!response.ok)
      throw new ProviderHttpError(response.status, "Redelivering");
    this.redelivered.push(...ids);
    return {};
  }
}
