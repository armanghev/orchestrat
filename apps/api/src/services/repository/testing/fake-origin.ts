import {
  createHash,
  generateKeyPairSync,
  randomUUID,
  sign,
  type KeyObject
} from "node:crypto";

// The Cursor Origin endpoints the adapter uses, in memory, behind an injected
// fetch (docs/project-branches.md §13.3). Origin's own Ed25519 key signs
// receipts and webhooks and is served as a JWKS.

type Repository = {
  id: string;
  fullName: string;
  defaultBranch: string;
  mirror?: { source: string; status: string } | null;
  branches: Map<string, string>;
  pulls: Record<string, unknown>[];
};

const b64url = (value: string | Buffer) =>
  Buffer.from(value).toString("base64url");
const reply = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });

export class FakeOrigin {
  readonly apiBase = "https://api.origin.test/v1/origin";
  readonly signing = generateKeyPairSync("ed25519");
  readonly installations = new Map<
    string,
    {
      appId: string;
      target: string;
      suspended: boolean;
      scopes: string[];
      repos: string[];
    }
  >();
  readonly repositories = new Map<string, Repository>();
  readonly minted: Record<string, unknown>[] = [];
  private readonly tokens = new Map<string, string>();
  readonly undelivered: { id: string; createdAt: string }[] = [];
  readonly redelivered: string[][] = [];
  keyFetches = 0;

  constructor(
    readonly appId: string,
    private readonly now: () => Date
  ) {}

  /** A repository as the API shows it, without the fake's own state. */
  private summary(id: string) {
    const repository = this.repositories.get(id)!;
    return {
      id: repository.id,
      fullName: repository.fullName,
      defaultBranch: repository.defaultBranch,
      mirror: repository.mirror ?? null
    };
  }

  private jwk(key: KeyObject) {
    return {
      ...key.export({ format: "jwk" }),
      kid: "origin-key-1",
      use: "sig"
    };
  }

  /** An installation receipt as Origin's redirect would carry it. */
  receipt(
    claims: Record<string, unknown>,
    options: { key?: KeyObject; typ?: string } = {}
  ) {
    const seconds = Math.floor(this.now().getTime() / 1000);
    const head = b64url(
      JSON.stringify({
        alg: "EdDSA",
        typ: options.typ ?? "origin-installation-receipt+jwt"
      })
    );
    const body = b64url(
      JSON.stringify({
        iss: this.apiBase,
        aud: this.appId,
        exp: seconds + 300,
        jti: randomUUID(),
        ...claims
      })
    );
    const signature = sign(
      null,
      Buffer.from(`${head}.${body}`),
      options.key ?? this.signing.privateKey
    );
    return `${head}.${body}.${b64url(signature)}`;
  }

  /** A signed webhook delivery (v1ed over the hex digest). */
  webhook(
    payload: Record<string, unknown>,
    options: { timestamp?: number; key?: KeyObject } = {}
  ) {
    const body = Buffer.from(JSON.stringify(payload));
    const id = randomUUID();
    const timestamp = String(
      options.timestamp ?? Math.floor(this.now().getTime() / 1000)
    );
    const digest = createHash("sha256")
      .update(`${id}.${timestamp}.`)
      .update(body)
      .digest("hex");
    const signature = sign(
      null,
      Buffer.from(digest),
      options.key ?? this.signing.privateKey
    );
    return {
      body,
      headers: {
        "content-type": "application/json",
        "webhook-id": id,
        "webhook-timestamp": timestamp,
        "webhook-signature": `v1ed,${signature.toString("base64")}`
      }
    };
  }

  readonly fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (!url.href.startsWith(this.apiBase)) return reply(404);
    const path = url.pathname.slice(new URL(this.apiBase).pathname.length);
    const method = init?.method ?? "GET";
    const token = (
      new Headers(init?.headers).get("authorization") ?? ""
    ).replace(/^Bearer /, "");
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (path === "/keys") {
      this.keyFetches += 1;
      return reply(200, { keys: [this.jwk(this.signing.publicKey)] });
    }
    let match = path.match(/^\/app\/installations\/([^/]+)$/);
    if (match) {
      const installation = this.installations.get(match[1]!);
      if (!installation || token.split(".").length !== 3) return reply(404);
      return reply(200, {
        id: match[1],
        appId: installation.appId,
        target: { id: installation.target },
        suspendedAt: installation.suspended ? "2026-09-01T00:00:00Z" : null,
        scopes: installation.scopes
      });
    }
    match = path.match(/^\/app\/installations\/([^/]+)\/access_tokens$/);
    if (match && method === "POST") {
      const installation = this.installations.get(match[1]!);
      if (!installation || installation.suspended) return reply(403);
      this.minted.push({ installation: match[1], ...body });
      const minted = `oit_${randomUUID()}`;
      this.tokens.set(minted, match[1]!);
      return reply(201, {
        token: minted,
        expiresAt: new Date(this.now().getTime() + 15 * 60_000).toISOString()
      });
    }
    if (path === "/app/webhook/deliveries")
      return reply(200, { deliveries: this.undelivered });
    if (
      path === "/app/webhook/deliveries:batchRedeliver" &&
      method === "POST"
    ) {
      this.redelivered.push(body.ids);
      return reply(202, {});
    }
    const installationId = this.tokens.get(token) ?? null;
    const installation = installationId
      ? this.installations.get(installationId)
      : null;
    if (!installation) return reply(401);
    if (path === "/installation/repos")
      return reply(200, {
        repos: installation.repos.map((id) => this.summary(id))
      });
    match = path.match(/^\/repos\/_\/([^/]+)(\/.*)?$/);
    if (!match || !installation.repos.includes(match[1]!)) return reply(404);
    const repository = this.repositories.get(match[1]!)!;
    const rest = match[2] ?? "";
    if (!rest) return reply(200, this.summary(repository.id));
    if (rest === "/branches") {
      const all = [...repository.branches].map(([name, sha]) => ({
        name,
        sha
      }));
      const start = Number(url.searchParams.get("pageToken") ?? "0");
      return reply(200, {
        branches: all.slice(start, start + 2),
        nextPageToken: start + 2 < all.length ? String(start + 2) : null
      });
    }
    match = rest.match(/^\/branches\/(.+)$/);
    if (match) {
      const name = decodeURIComponent(match[1]!);
      const sha = repository.branches.get(name);
      return sha === undefined ? reply(404) : reply(200, { name, sha });
    }
    if (rest === "/pulls")
      return reply(200, { pulls: repository.pulls, nextPageToken: null });
    return reply(404);
  };
}
