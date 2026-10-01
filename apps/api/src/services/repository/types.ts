import type {
  Database,
  repositoryConnectionAttempts,
  repositoryConnections
} from "@orchestrat/db";
import type { RepositoryCandidate } from "@orchestrat/protocol";

// The provider-agnostic contract between the repository core and each
// provider adapter (docs/project-branches.md §8.1). Adapters do the HTTP and
// the signature checks; the core owns state, ordering and the database.

export type ProviderName = "github" | "gitlab" | "origin";
export type ConnectionRow = typeof repositoryConnections.$inferSelect;
export type AttemptRow = typeof repositoryConnectionAttempts.$inferSelect;
export type Headers = Record<string, string | string[] | undefined>;

export type RemoteRepository = {
  id: string;
  fullName: string;
  url: string | null;
  defaultBranch: string;
  /** Forks and mirrors can't be connected (Origin rejects GitHub mirrors). */
  ineligibleReason?: string | null;
};
export type RemoteBranch = { name: string; sha: string | null };
export type MergedChange = {
  number: string;
  headRef: string;
  headSha: string | null;
  baseRef: string;
  mergeSha: string | null;
  mergedAt: string;
  fromFork: boolean;
  url: string | null;
};

/** Normalized provider events. They are hints: anything order-sensitive is
 * confirmed through the provider API before it changes state (§8.2). */
export type ProviderEvent =
  | { type: "ref_pushed"; name: string; sha: string | null }
  | { type: "ref_deleted"; name: string; beforeSha: string | null }
  | { type: "default_branch_changed"; name: string }
  | { type: "repository_renamed"; fullName: string; url: string | null }
  | { type: "change_merged"; change: MergedChange }
  | { type: "installation_deleted" }
  | { type: "authorization_revoked" }
  | { type: "installation_suspended" }
  | { type: "installation_unsuspended" }
  /** Overflow or anything uncertain: re-read everything. */
  | { type: "reconcile" };

export type VerifiedDelivery = {
  deliveryId: string;
  eventType: string;
  installationId: string | null;
  repositoryId: string | null;
  payload: Record<string, unknown>;
};

/** What an authorized attempt carries forward to the repository picker. */
export type Authorization = {
  providerUserId: string;
  installationId?: string | null;
  /** Kept encrypted on the attempt only until the connection exists. */
  userToken?: string | null;
  receiptJti?: string | null;
};

/** The provider side of a new connection. */
export type PreparedConnection = {
  repository: RemoteRepository;
  installationId: string | null;
  providerAccountId: string;
  gitlabHookId?: string | null;
  accessToken?: string | null;
  refreshToken?: string | null;
  tokenExpiresAt?: Date | null;
  webhookSecret?: string | null;
};

export interface ProviderAdapter {
  readonly provider: ProviderName;
  /** Called once by buildApp with the database the app uses. */
  bind?(context: { db: Database }): void;
  /** GitLab verifies with a per-connection secret named in the URL. */
  readonly verifiesPerConnection?: boolean;

  authorizeUrl(input: {
    state: string;
    codeChallenge: string;
    redirectUri: string;
  }): string;
  completeAuthorization(input: {
    attempt: AttemptRow;
    query: Record<string, string | undefined>;
    verifier: string | null;
    redirectUri: string;
  }): Promise<Authorization>;
  /** GitHub only: checks the untrusted Setup URL installation id. */
  confirmInstallation?(input: {
    attempt: AttemptRow;
    userToken: string | null;
    installationId: string;
  }): Promise<{ installationId: string } | { authorizeUrl: string }>;
  listCandidates(input: {
    attempt: AttemptRow;
    userToken: string | null;
  }): Promise<RepositoryCandidate[]>;
  prepareConnection(input: {
    attempt: AttemptRow;
    userToken: string | null;
    providerRepositoryId: string;
    connectionId: string;
  }): Promise<PreparedConnection>;
  disconnect?(connection: ConnectionRow): Promise<void>;

  verify(input: {
    headers: Headers;
    rawBody: Buffer;
    connection: ConnectionRow | null;
    now: Date;
  }): Promise<VerifiedDelivery | null>;
  parse(
    delivery: { eventType: string; payload: Record<string, unknown> },
    connection: ConnectionRow
  ): ProviderEvent[];

  getRepository(connection: ConnectionRow): Promise<RemoteRepository>;
  getBranch(
    connection: ConnectionRow,
    name: string
  ): Promise<RemoteBranch | null>;
  listBranches(connection: ConnectionRow): Promise<RemoteBranch[]>;
  listMergedChanges(
    connection: ConnectionRow,
    since: Date
  ): Promise<MergedChange[]>;
  /** Provider-side redelivery and hook health, during reconcile. */
  maintain?(connection: ConnectionRow): Promise<Partial<ConnectionRow>>;
  /** Settings → Re-enable: wakes a webhook the provider disabled. */
  reenableHook?(connection: ConnectionRow): Promise<void>;
}

/** A provider answered that the connection's authorization is gone. */
export class ProviderAuthorizationError extends Error {}
