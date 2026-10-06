import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { RepositoryCandidate } from "@orchestrat/protocol";
import type {
  ConnectionRow,
  Headers,
  MergedChange,
  PreparedConnection,
  ProviderAdapter,
  ProviderEvent,
  ProviderName,
  RemoteBranch,
  RemoteRepository
} from "../types.js";

// A generic in-memory provider for scenario tests (docs/project-branches.md
// §13.3). Repositories are mutable maps; webhooks are HMAC-signed JSON; the
// connect flow is a plain code exchange.

export type FakeRepository = {
  id: string;
  fullName: string;
  defaultBranch: string;
  branches: Map<string, string>;
  merged: MergedChange[];
  installation: string;
  ineligibleReason?: string;
};

const header = (headers: Headers, name: string) => {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
};

export class FakeProvider implements ProviderAdapter {
  readonly repositories = new Map<string, FakeRepository>();
  readonly calls: string[] = [];
  secret = "fake-webhook-secret-for-tests-only";
  /** Names getBranch should fail for, to test retries. */
  readonly failing = new Set<string>();

  constructor(readonly provider: ProviderName = "github") {}

  repository(value: Partial<FakeRepository> & { fullName: string }) {
    const repository: FakeRepository = {
      id: value.id ?? randomUUID(),
      fullName: value.fullName,
      defaultBranch: value.defaultBranch ?? "main",
      branches:
        value.branches ??
        new Map([[value.defaultBranch ?? "main", "sha-main-1"]]),
      merged: value.merged ?? [],
      installation: value.installation ?? "installation-1",
      ineligibleReason: value.ineligibleReason
    };
    this.repositories.set(repository.id, repository);
    return repository;
  }

  private of(connection: ConnectionRow) {
    const repository = this.repositories.get(connection.providerRepositoryId);
    if (!repository) throw new Error("The repository is gone.");
    return repository;
  }

  authorizeUrl(input: {
    state: string;
    codeChallenge: string;
    redirectUri: string;
  }) {
    const url = new URL("https://fake.provider.test/authorize");
    url.searchParams.set("state", input.state);
    url.searchParams.set("code_challenge", input.codeChallenge);
    url.searchParams.set("redirect_uri", input.redirectUri);
    return url.toString();
  }

  async completeAuthorization(input: {
    query: Record<string, string | undefined>;
    verifier: string | null;
  }) {
    if (input.query.code !== "good-code" || !input.verifier)
      throw new Error("bad code");
    return {
      providerUserId: "fake-user",
      installationId: input.query.installation_id ?? "installation-1",
      userToken: `user-token-for-${input.verifier.slice(0, 4)}`
    };
  }

  async listCandidates(input: { attempt: { installationId: string | null } }) {
    return [...this.repositories.values()]
      .filter(
        (repository) => repository.installation === input.attempt.installationId
      )
      .map((repository): RepositoryCandidate => ({
        provider_repository_id: repository.id,
        full_name: repository.fullName,
        default_branch: repository.defaultBranch,
        eligible: !repository.ineligibleReason,
        ineligible_reason: repository.ineligibleReason ?? null
      }));
  }

  async prepareConnection(input: {
    attempt: { installationId: string | null; providerUserId: string | null };
    providerRepositoryId: string;
  }): Promise<PreparedConnection> {
    const repository = this.repositories.get(input.providerRepositoryId);
    // Only repositories the authorized installation reaches can connect.
    if (!repository || repository.installation !== input.attempt.installationId)
      throw new Error("Repository not reachable.");
    return {
      repository: this.remote(repository),
      installationId: repository.installation,
      providerAccountId: input.attempt.providerUserId ?? "fake-user"
    };
  }

  async disconnect(connection: ConnectionRow) {
    this.calls.push(`disconnect:${connection.providerRepositoryId}`);
  }

  /** Builds a signed delivery as the provider would send it. */
  sign(
    eventType: string,
    payload: Record<string, unknown>,
    deliveryId: string = randomUUID()
  ) {
    const body = Buffer.from(JSON.stringify(payload));
    return {
      body,
      headers: {
        "content-type": "application/json",
        "x-fake-event": eventType,
        "x-fake-delivery": deliveryId,
        "x-fake-signature": createHmac("sha256", this.secret)
          .update(body)
          .digest("hex")
      }
    };
  }

  async verify(input: { headers: Headers; rawBody: Buffer }) {
    const signature = header(input.headers, "x-fake-signature") ?? "";
    const expected = createHmac("sha256", this.secret)
      .update(input.rawBody)
      .digest("hex");
    if (
      signature.length !== expected.length ||
      !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
    )
      return null;
    try {
      const payload = JSON.parse(input.rawBody.toString("utf8")) as Record<
        string,
        unknown
      >;
      return {
        deliveryId: header(input.headers, "x-fake-delivery") ?? randomUUID(),
        eventType: header(input.headers, "x-fake-event") ?? "unknown",
        installationId: (payload.installation as string | undefined) ?? null,
        repositoryId: (payload.repository as string | undefined) ?? null,
        payload
      };
    } catch {
      return null;
    }
  }

  parse(delivery: {
    eventType: string;
    payload: Record<string, unknown>;
  }): ProviderEvent[] {
    const payload = delivery.payload;
    switch (delivery.eventType) {
      case "push": {
        const ref = String(payload.ref ?? "");
        if (!ref.startsWith("refs/heads/")) return [];
        const name = ref.slice("refs/heads/".length);
        return payload.deleted
          ? [
              {
                type: "ref_deleted",
                name,
                beforeSha: (payload.before as string) ?? null
              }
            ]
          : [
              {
                type: "ref_pushed",
                name,
                sha: (payload.after as string) ?? null
              }
            ];
      }
      case "default":
        return [{ type: "default_branch_changed", name: String(payload.name) }];
      case "merged":
        return [
          { type: "change_merged", change: payload.change as MergedChange }
        ];
      case "suspend":
        return [{ type: "installation_suspended" }];
      case "unsuspend":
        return [{ type: "installation_unsuspended" }];
      case "uninstall":
        return [{ type: "installation_deleted" }];
      case "revoke":
        return [{ type: "authorization_revoked" }];
      case "overflow":
        return [{ type: "reconcile" }];
      default:
        return [];
    }
  }

  private remote(repository: FakeRepository): RemoteRepository {
    return {
      id: repository.id,
      fullName: repository.fullName,
      url: `https://fake.provider.test/${repository.fullName}`,
      defaultBranch: repository.defaultBranch,
      ineligibleReason: repository.ineligibleReason ?? null
    };
  }

  async getRepository(connection: ConnectionRow) {
    return this.remote(this.of(connection));
  }

  async getBranch(
    connection: ConnectionRow,
    name: string
  ): Promise<RemoteBranch | null> {
    this.calls.push(`getBranch:${name}`);
    if (this.failing.has(name)) throw new Error("provider unavailable");
    const sha = this.of(connection).branches.get(name);
    return sha === undefined ? null : { name, sha };
  }

  async listBranches(connection: ConnectionRow): Promise<RemoteBranch[]> {
    return [...this.of(connection).branches].map(([name, sha]) => ({
      name,
      sha
    }));
  }

  async listMergedChanges(connection: ConnectionRow, since: Date) {
    return this.of(connection).merged.filter(
      (change) => new Date(change.mergedAt) >= since
    );
  }
}
