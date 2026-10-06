import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import test from "node:test";
import { repositoryConnections } from "@orchestrat/db";
import { repositoryWorkerOf } from "../app.js";
import { workspace } from "../test/workspace.js";
import { OriginAdapter } from "./repository/providers/origin.js";
import { SecretBox } from "./repository/secrets.js";
import { FakeOrigin } from "./repository/testing/fake-origin.js";
import type { ConnectionRow } from "./repository/types.js";

const appKeys = generateKeyPairSync("ed25519");
const APP = "app_orchestrat";

async function setup() {
  const clock = new Date("2026-10-01T00:00:00.000Z");
  const now = () => clock;
  const origin = new FakeOrigin(APP, now);
  origin.installations.set("inst_1", {
    appId: APP,
    target: "ns_1",
    suspended: false,
    scopes: [
      "repository:metadata:read",
      "repository:contents:read",
      "repository:pull_requests:read"
    ],
    repos: ["repo_1", "repo_mirror"]
  });
  origin.repositories.set("repo_1", {
    id: "repo_1",
    fullName: "acme/app",
    defaultBranch: "main",
    mirror: null,
    branches: new Map([
      ["main", "sha-main"],
      ["feat/a", "sha-a"],
      ["feat/b", "sha-b"]
    ]),
    pulls: []
  });
  origin.repositories.set("repo_mirror", {
    id: "repo_mirror",
    fullName: "acme/mirror",
    defaultBranch: "main",
    mirror: { source: "github", status: "inbound" },
    branches: new Map([["main", "m"]]),
    pulls: []
  });
  const adapter = new OriginAdapter(
    {
      appId: APP,
      privateKeyPem: appKeys.privateKey
        .export({ type: "pkcs8", format: "pem" })
        .toString(),
      apiBase: origin.apiBase
    },
    { fetch: origin.fetch, sleep: async () => undefined, now }
  );
  const s = await workspace({
    repository: {
      adapters: [adapter],
      secrets: new SecretBox({ id: "test", key: Buffer.alloc(32, 8) }),
      config: {
        publicApiUrl: "https://api.example.test",
        dashboardUrl: "https://app.example.test"
      },
      now
    }
  });
  const base = `/projects/${s.project.id}`;
  const start = async () => {
    const authorization = (
      await s.alice("POST", `${base}/repository/authorizations`, {
        provider: "origin"
      })
    ).json();
    const state = new URL(authorization.authorize_url).searchParams.get(
      "state"
    )!;
    return { authorization, state };
  };
  const callback = (receipt: string, state: string) =>
    s.app.inject({
      method: "GET",
      url: `/api/v1/repository/callback/origin?installation_receipt=${receipt}&state=${state}`
    });
  const send = (payload: Record<string, unknown>, options = {}) => {
    const signed = origin.webhook(payload, options);
    return s.app.inject({
      method: "POST",
      url: "/api/v1/webhooks/origin",
      headers: signed.headers,
      payload: signed.body
    });
  };
  return {
    ...s,
    origin,
    adapter,
    base,
    start,
    callback,
    send,
    worker: repositoryWorkerOf(s.app)!
  };
}

test("app JWTs are EdDSA with the app id as issuer and kid", () => {
  const origin = new FakeOrigin(APP, () => new Date());
  const adapter = new OriginAdapter({
    appId: APP,
    privateKeyPem: appKeys.privateKey
      .export({ type: "pkcs8", format: "pem" })
      .toString(),
    apiBase: origin.apiBase
  });
  const [head, body, signature] = adapter.appJwt().split(".");
  assert.deepEqual(JSON.parse(Buffer.from(head!, "base64url").toString()), {
    alg: "EdDSA",
    kid: APP,
    typ: "JWT"
  });
  const claims = JSON.parse(Buffer.from(body!, "base64url").toString());
  assert.equal(claims.iss, APP);
  assert.equal(claims.aud, "origin-apps");
  assert.equal(claims.exp - claims.iat, 300);
  assert.ok(
    verify(
      null,
      Buffer.from(`${head}.${body}`),
      appKeys.publicKey,
      Buffer.from(signature!, "base64url")
    )
  );
});

test("receipts must be Origin-signed, fresh, ours, single-use and for this state", async (t) => {
  const s = await setup();
  t.after(() => s.app.close());
  const good = { sub: "inst_1", namespace_id: "ns_1", user_id: "u_1" };
  const forger = generateKeyPairSync("ed25519");
  const cases: [string, (state: string) => string][] = [
    [
      "a forged signature",
      (state) =>
        s.origin.receipt({ ...good, state }, { key: forger.privateKey })
    ],
    [
      "another state",
      () => s.origin.receipt({ ...good, state: "not-this-attempt" })
    ],
    [
      "another app",
      (state) => s.origin.receipt({ ...good, state, aud: "app_other" })
    ],
    ["expired", (state) => s.origin.receipt({ ...good, state, exp: 1 })],
    [
      "the wrong type",
      (state) => s.origin.receipt({ ...good, state }, { typ: "JWT" })
    ],
    [
      "another namespace",
      (state) => s.origin.receipt({ ...good, state, namespace_id: "ns_2" })
    ]
  ];
  for (const [name, receipt] of cases) {
    const { state } = await s.start();
    const response = await s.callback(receipt(state), state);
    assert.match(
      response.headers.location as string,
      /repository_error=/,
      name
    );
  }
  assert.ok(s.origin.keyFetches >= 1, "keys come from the JWKS");

  const first = await s.start();
  const receipt = s.origin.receipt({
    ...good,
    state: first.state,
    jti: "jti-once"
  });
  assert.match(
    (await s.callback(receipt, first.state)).headers.location as string,
    /repository_authorization=/
  );
  const second = await s.start();
  const replayed = s.origin.receipt({
    ...good,
    state: second.state,
    jti: "jti-once"
  });
  assert.match(
    (await s.callback(replayed, second.state)).headers.location as string,
    /repository_error=/,
    "a jti works once"
  );
});

test("GitHub mirrors can't connect; real repositories do, with narrow tokens", async (t) => {
  const s = await setup();
  t.after(() => s.app.close());
  const { authorization, state } = await s.start();
  await s.callback(
    s.origin.receipt({ sub: "inst_1", namespace_id: "ns_1", state }),
    state
  );
  const candidates = (
    await s.alice(
      "GET",
      `${s.base}/repository/authorizations/${authorization.authorization_id}/repositories`
    )
  ).json().repositories;
  const mirror = candidates.find(
    (candidate: { provider_repository_id: string }) =>
      candidate.provider_repository_id === "repo_mirror"
  );
  assert.equal(mirror.eligible, false);
  assert.match(mirror.ineligible_reason, /GitHub/);
  const refused = await s.alice("POST", `${s.base}/repository`, {
    authorization_id: authorization.authorization_id,
    provider_repository_id: "repo_mirror"
  });
  assert.equal(refused.statusCode, 409);
  const connected = await s.alice("POST", `${s.base}/repository`, {
    authorization_id: authorization.authorization_id,
    provider_repository_id: "repo_1"
  });
  assert.equal(connected.statusCode, 201, connected.body);
  // After the picker, every token reaches one repository with one scope.
  for (const minted of s.origin.minted.slice(1)) {
    assert.equal((minted.repositoryIds as string[]).length, 1);
    assert.equal((minted.scopes as string[]).length, 1);
  }
  const [row] = await s.db.select().from(repositoryConnections);
  assert.equal(row!.installationId, "inst_1");
  assert.equal(row!.accessTokenCiphertext, null, "no Origin token is stored");
});

test("signed pushes apply; overflow, bad signatures and stale timestamps don't slip", async (t) => {
  const s = await setup();
  t.after(() => s.app.close());
  await s.db.insert(repositoryConnections).values({
    projectId: s.project.id,
    provider: "origin",
    providerRepositoryId: "repo_1",
    repositoryFullName: "acme/app",
    providerDefaultBranch: "main",
    installationId: "inst_1",
    lastReconciledAt: new Date("2026-10-01T00:00:00Z")
  });
  const remote = s.origin.repositories.get("repo_1")!.branches;
  remote.set("feat/new", "sha-new");
  const push = {
    type: "repository.pushed",
    installationId: "inst_1",
    data: {
      repository: { id: "repo_1" },
      refUpdatesCount: 2,
      refUpdates: [
        {
          ref: "refs/heads/feat/new",
          created: true,
          before: "0".repeat(40),
          after: "sha-new"
        },
        { ref: "refs/tags/v1", created: true, after: "t" }
      ]
    }
  };
  assert.equal((await s.send(push)).statusCode, 202);
  const forger = generateKeyPairSync("ed25519");
  assert.equal(
    (await s.send(push, { key: forger.privateKey })).statusCode,
    401
  );
  assert.equal(
    (
      await s.send(push, {
        timestamp: Math.floor(Date.parse("2026-10-01T00:00:00Z") / 1000) - 400
      })
    ).statusCode,
    401
  );
  await s.worker.tick();
  const names = async () =>
    (await s.alice("GET", `${s.base}/branches`))
      .json()
      .branches.map((branch: { name: string }) => branch.name);
  assert.ok((await names()).includes("feat/new"));
  assert.ok(!(await names()).includes("v1"), "tags are filtered");

  // 150 updates but only 100 attached: the rest come from a reconcile.
  remote.set("feat/hidden", "sha-hidden");
  await s.send({
    type: "repository.pushed",
    installationId: "inst_1",
    data: { repository: { id: "repo_1" }, refUpdatesCount: 150, refUpdates: [] }
  });
  await s.worker.tick();
  assert.ok((await names()).includes("feat/hidden"));
});

test("merged pull requests, default changes and redelivery", async () => {
  const origin = new FakeOrigin(APP, () => new Date("2026-10-01T00:00:00Z"));
  const adapter = new OriginAdapter(
    {
      appId: APP,
      privateKeyPem: appKeys.privateKey
        .export({ type: "pkcs8", format: "pem" })
        .toString(),
      apiBase: origin.apiBase
    },
    { fetch: origin.fetch, now: () => new Date("2026-10-01T00:00:00Z") }
  );
  const connection = {
    installationId: "inst_1",
    providerRepositoryId: "repo_1",
    providerDefaultBranch: "main"
  } as ConnectionRow;
  const [merged] = adapter.parse(
    {
      eventType: "pull_request.merged",
      payload: {
        installationId: "inst_1",
        data: {
          pullRequest: {
            number: "12",
            mergedAt: "2026-10-01T00:00:00Z",
            mergeCommitSha: "m1",
            head: { ref: "refs/heads/feat/x", sha: "s1" },
            base: { ref: "main" }
          }
        }
      }
    },
    connection
  );
  assert.ok(merged?.type === "change_merged");
  assert.equal(merged.change.headRef, "feat/x", "refs are normalized");
  assert.equal(merged.change.baseRef, "main");
  assert.equal(merged.change.number, "12");
  assert.deepEqual(
    adapter.parse(
      {
        eventType: "repository.metadata.updated",
        payload: {
          installationId: "inst_1",
          data: { repository: { defaultBranch: "trunk" } }
        }
      },
      connection
    ),
    [{ type: "default_branch_changed", name: "trunk" }]
  );
  assert.deepEqual(
    adapter.parse(
      {
        eventType: "repository.pushed",
        payload: { installationId: "inst_other", data: {} }
      },
      connection
    ),
    [],
    "other installations are ignored"
  );
  origin.undelivered.push(
    { id: "d1", createdAt: "2026-09-30T00:00:00Z" },
    { id: "old", createdAt: "2026-09-01T00:00:00Z" }
  );
  await adapter.maintain();
  assert.deepEqual(origin.redelivered, [["d1"]]);
});
