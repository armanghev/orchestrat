import assert from "node:assert/strict";
import test from "node:test";
import {
  repositoryConnectionAttempts,
  repositoryRefs,
  repositoryWebhookDeliveries
} from "@orchestrat/db";
import { asc, eq } from "drizzle-orm";
import { repositoryWorkerOf } from "../app.js";
import { SecretBox, aad } from "../services/repository/secrets.js";
import { FakeProvider } from "../services/repository/testing/fake-provider.js";
import { workspace } from "../test/workspace.js";

type Branch = {
  id: string;
  name: string;
  is_default: boolean;
  archived_at: string | null;
  archived_reason: string | null;
  created_via: string;
  provider: { state: string } | null;
};

async function connected(
  options: { createExisting?: boolean; mapping?: object } = {}
) {
  const fake = new FakeProvider("github");
  const repo = fake.repository({
    fullName: "acme/app",
    defaultBranch: "trunk",
    branches: new Map([
      ["trunk", "sha-trunk-1"],
      ["feat/old", "sha-old-1"]
    ])
  });
  let clock = new Date("2026-10-01T00:00:00.000Z");
  const s = await workspace({
    repository: {
      adapters: [fake],
      secrets: new SecretBox({ id: "test", key: Buffer.alloc(32, 9) }),
      config: {
        publicApiUrl: "https://api.example.test",
        dashboardUrl: "https://app.example.test"
      },
      now: () => clock
    }
  });
  const worker = repositoryWorkerOf(s.app)!;
  const base = `/projects/${s.project.id}`;
  const authorization = (
    await s.alice("POST", `${base}/repository/authorizations`, {
      provider: "github"
    })
  ).json();
  const state = new URL(authorization.authorize_url).searchParams.get("state")!;
  const callback = await s.app.inject({
    method: "GET",
    url: `/api/v1/repository/callback/github?code=good-code&state=${state}`
  });
  assert.equal(callback.statusCode, 302, callback.body);
  assert.equal(
    callback.headers.location,
    `https://app.example.test/projects/${s.project.id}/settings?repository_authorization=${authorization.authorization_id}`
  );
  const candidates = (
    await s.alice(
      "GET",
      `${base}/repository/authorizations/${authorization.authorization_id}/repositories`
    )
  ).json().repositories;
  assert.deepEqual(
    candidates.map((candidate: { full_name: string }) => candidate.full_name),
    ["acme/app"]
  );
  const connection = await s.alice("POST", `${base}/repository`, {
    authorization_id: authorization.authorization_id,
    provider_repository_id: repo.id,
    create_existing_branches: options.createExisting ?? false,
    ...(options.mapping ? { default_branch_mapping: options.mapping } : {})
  });
  assert.equal(connection.statusCode, 201, connection.body);
  await worker.tick();
  const webhook = (
    event: string,
    payload: Record<string, unknown>,
    id?: string
  ) => {
    const signed = fake.sign(
      event,
      { repository: repo.id, installation: repo.installation, ...payload },
      id
    );
    return s.app.inject({
      method: "POST",
      url: "/api/v1/webhooks/github",
      headers: signed.headers,
      payload: signed.body
    });
  };
  const deliver = async (
    event: string,
    payload: Record<string, unknown>,
    id?: string
  ) => {
    const response = await webhook(event, payload, id);
    assert.equal(response.statusCode, 202, response.body);
    await worker.tick();
  };
  const branches = async () =>
    (await s.alice("GET", `${base}/branches?include_archived=true`)).json()
      .branches as Branch[];
  const named = async (name: string) =>
    (await branches()).filter((branch) => branch.name === name);
  return {
    ...s,
    fake,
    repo,
    worker,
    base,
    state,
    authorization,
    connection: connection.json().repository,
    webhook,
    deliver,
    branches,
    named,
    advance: (ms: number) => {
      clock = new Date(clock.getTime() + ms);
    }
  };
}

test("connecting authorizes once, links the default and snapshots branches", async (t) => {
  const s = await connected();
  t.after(() => s.app.close());
  const replay = await s.app.inject({
    method: "GET",
    url: `/api/v1/repository/callback/github?code=good-code&state=${s.state}`
  });
  assert.match(
    replay.headers.location as string,
    /repository_error=invalid_state/
  );
  const [main] = await s.named("trunk");
  assert.ok(
    main!.is_default,
    "the default was renamed to the provider default"
  );
  assert.equal(main!.provider?.state, "tracked");
  assert.deepEqual(
    await s.named("feat/old"),
    [],
    "existing branches are only snapshotted"
  );
  const refs = await s.db
    .select()
    .from(repositoryRefs)
    .orderBy(asc(repositoryRefs.name));
  assert.deepEqual(
    refs.map((ref) => [ref.name, ref.createdSignal, Boolean(ref.branchId)]),
    [
      ["feat/old", "connect_snapshot", false],
      ["trunk", "connect_snapshot", true]
    ]
  );
  const [attempt] = await s.db.select().from(repositoryConnectionAttempts);
  assert.equal(attempt!.status, "consumed");
  assert.equal(attempt!.userTokenCiphertext, null, "the user token is wiped");
  const status = (await s.alice("GET", `${s.base}/repository`)).json();
  assert.equal(status.repository.full_name, "acme/app");
  assert.ok(status.repository.last_reconciled_at, "connect queues a reconcile");
  assert.deepEqual(
    status.providers.map(
      (provider: { provider: string; configured: boolean }) => [
        provider.provider,
        provider.configured
      ]
    ),
    [
      ["github", true],
      ["gitlab", false],
      ["origin", false]
    ]
  );
  const again = await s.alice("POST", `${s.base}/repository/authorizations`, {
    provider: "github"
  });
  assert.equal(again.json().error.code, "REPOSITORY_CONNECTION_EXISTS");
  assert.equal(
    (await s.bob("POST", `${s.base}/repository/sync`, {})).statusCode,
    403,
    "members can't sync or connect"
  );

  // The first push to a snapshotted branch creates its Orchestrat branch.
  s.fake.repositories.get(s.repo.id)!.branches.set("feat/old", "sha-old-2");
  await s.deliver("push", { ref: "refs/heads/feat/old", after: "sha-old-2" });
  assert.equal((await s.named("feat/old")).length, 1);
});

test("pushes create branches; confirmed deletes archive them, never the default", async (t) => {
  const s = await connected();
  t.after(() => s.app.close());
  const remote = s.fake.repositories.get(s.repo.id)!.branches;
  remote.set("feat/a", "sha-a-1");
  await s.deliver("push", { ref: "refs/heads/feat/a", after: "sha-a-1" });
  const [created] = await s.named("feat/a");
  assert.equal(created!.created_via, "provider");
  await s.deliver("push", { ref: "refs/tags/v1", after: "sha-tag" });
  assert.deepEqual(await s.named("v1"), [], "tags are ignored");

  // An event alone archives nothing: the provider still has the branch.
  await s.deliver("push", {
    ref: "refs/heads/feat/a",
    deleted: true,
    before: "sha-other"
  });
  assert.equal((await s.named("feat/a"))[0]!.archived_at, null);
  remote.delete("feat/a");
  await s.deliver("push", {
    ref: "refs/heads/feat/a",
    deleted: true,
    before: "sha-a-1"
  });
  const [archived] = await s.named("feat/a");
  assert.equal(archived!.archived_reason, "provider_deleted");

  remote.delete("trunk");
  await s.deliver("push", {
    ref: "refs/heads/trunk",
    deleted: true,
    before: "sha-trunk-1"
  });
  const [main] = await s.named("trunk");
  assert.equal(main!.archived_at, null, "the default is never archived");
  assert.equal(main!.provider?.state, "missing");
});

test("deleting and recreating a name starts a new generation; a stale delete is ignored", async (t) => {
  const s = await connected();
  t.after(() => s.app.close());
  const remote = s.fake.repositories.get(s.repo.id)!.branches;
  remote.set("feat/b", "sha-b-1");
  await s.deliver("push", { ref: "refs/heads/feat/b", after: "sha-b-1" });
  const [first] = await s.named("feat/b");
  remote.set("feat/b", "sha-b-2");
  await s.deliver("push", {
    ref: "refs/heads/feat/b",
    deleted: true,
    before: "sha-b-1"
  });
  const generations = await s.named("feat/b");
  assert.equal(generations.length, 2);
  assert.equal(
    generations.find((branch) => branch.id === first!.id)!.archived_reason,
    "provider_deleted"
  );
  const second = generations.find((branch) => branch.id !== first!.id)!;
  assert.equal(second.archived_at, null);

  // A late delete for the first generation leaves the second alone.
  await s.deliver("push", {
    ref: "refs/heads/feat/b",
    deleted: true,
    before: "sha-b-1"
  });
  assert.equal(
    (await s.named("feat/b")).find((branch) => branch.id === second.id)!
      .archived_at,
    null
  );

  // A force push is the same generation.
  remote.set("feat/b", "sha-b-forced");
  await s.deliver("push", { ref: "refs/heads/feat/b", after: "sha-b-forced" });
  assert.equal((await s.named("feat/b")).length, 2);
});

test("the default follows the provider: moved, or renamed in place", async (t) => {
  const s = await connected();
  t.after(() => s.app.close());
  const repository = s.fake.repositories.get(s.repo.id)!;
  repository.branches.set("release", "sha-r-1");
  await s.deliver("push", { ref: "refs/heads/release", after: "sha-r-1" });
  repository.defaultBranch = "release";
  await s.deliver("default", { name: "release" });
  const moved = await s.branches();
  assert.equal(moved.find((branch) => branch.is_default)!.name, "release");

  // Renamed: the old name is gone and the new one has the same head.
  const [release] = await s.named("release");
  repository.branches.delete("release");
  repository.branches.set("stable", "sha-r-1");
  repository.defaultBranch = "stable";
  await s.deliver("default", { name: "stable" });
  const [stable] = await s.named("stable");
  assert.equal(stable!.id, release!.id, "renamed in place");
  assert.ok(stable!.is_default);
});

test("suspension, revocation and disconnect keep every branch", async (t) => {
  const s = await connected({ createExisting: true });
  t.after(() => s.app.close());
  assert.equal(
    (await s.named("feat/old")).length,
    1,
    "existing branches on request"
  );
  await s.deliver("suspend", {});
  assert.equal(
    (await s.alice("GET", `${s.base}/repository`)).json().repository.status,
    "suspended"
  );
  await s.deliver("unsuspend", {});
  assert.equal(
    (await s.alice("GET", `${s.base}/repository`)).json().repository.status,
    "active"
  );
  await s.deliver("revoke", {});
  assert.equal(
    (await s.alice("GET", `${s.base}/repository`)).json().repository.status,
    "needs_reauthorization"
  );
  const before = (await s.branches()).length;
  const removed = await s.alice("DELETE", `${s.base}/repository`);
  assert.equal(removed.statusCode, 204);
  assert.deepEqual(
    s.fake.calls.filter((call) => call.startsWith("disconnect")),
    [`disconnect:${s.repo.id}`]
  );
  assert.equal(
    (await s.alice("GET", `${s.base}/repository`)).json().repository,
    null
  );
  assert.equal((await s.branches()).length, before, "branches stay");
});

test("webhooks verify signatures, dedupe deliveries and ignore strangers", async (t) => {
  const s = await connected();
  t.after(() => s.app.close());
  const signed = s.fake.sign("push", {
    repository: s.repo.id,
    ref: "refs/heads/x"
  });
  const forged = await s.app.inject({
    method: "POST",
    url: "/api/v1/webhooks/github",
    headers: { ...signed.headers, "x-fake-signature": "0".repeat(64) },
    payload: signed.body
  });
  assert.equal(forged.statusCode, 401);
  for (let attempt = 0; attempt < 2; attempt++)
    assert.equal(
      (await s.webhook("push", { ref: "refs/heads/y" }, "same-id")).statusCode,
      202
    );
  const stranger = s.fake.sign("push", {
    repository: "unknown-repo",
    ref: "refs/heads/z"
  });
  const ignored = await s.app.inject({
    method: "POST",
    url: "/api/v1/webhooks/github",
    headers: stranger.headers,
    payload: stranger.body
  });
  assert.equal(ignored.statusCode, 202);
  const rows = await s.db
    .select()
    .from(repositoryWebhookDeliveries)
    .orderBy(asc(repositoryWebhookDeliveries.receivedAt));
  assert.deepEqual(
    rows.map((row) => [row.deliveryId === "same-id", row.status]),
    [
      [true, "pending"],
      [false, "ignored"]
    ]
  );
  assert.equal(
    (
      await s.app.inject({
        method: "POST",
        url: "/api/v1/webhooks/bitbucket",
        payload: "{}"
      })
    ).statusCode,
    404
  );
});

test("failed deliveries back off and apply once the provider recovers", async (t) => {
  const s = await connected();
  t.after(() => s.app.close());
  s.fake.failing.add("feat/flaky");
  await s.deliver("push", {
    ref: "refs/heads/feat/flaky",
    deleted: true,
    before: "x"
  });
  const [pending] = await s.db.select().from(repositoryWebhookDeliveries);
  assert.equal(pending!.status, "pending");
  assert.equal(pending!.attempts, 1);
  assert.equal(pending!.lastError, "provider unavailable");
  await s.worker.tick();
  assert.equal(
    (await s.db.select().from(repositoryWebhookDeliveries))[0]!.attempts,
    1,
    "not retried before its backoff"
  );
  s.fake.failing.delete("feat/flaky");
  s.advance(21_000);
  await s.worker.tick();
  const [done] = await s.db.select().from(repositoryWebhookDeliveries);
  assert.equal(done!.status, "applied");

  const retried = await s.alice(
    "POST",
    `${s.base}/repository/deliveries/${done!.id}/retry`,
    {}
  );
  assert.equal(retried.statusCode, 404, "only failed deliveries retry");
  await s.db
    .update(repositoryWebhookDeliveries)
    .set({ status: "failed" })
    .where(eq(repositoryWebhookDeliveries.id, done!.id));
  const listed = await s.alice(
    "GET",
    `${s.base}/repository/deliveries?status=failed`
  );
  assert.equal(listed.json().deliveries.length, 1);
  assert.equal(
    (
      await s.alice(
        "POST",
        `${s.base}/repository/deliveries/${done!.id}/retry`,
        {}
      )
    ).json().delivery.status,
    "pending"
  );
});

test("secrets are bound to their row and purpose and survive key rotation", () => {
  const old = new SecretBox({ id: "k0", key: Buffer.alloc(32, 1) });
  const sealed = old.seal(
    "token",
    aad("repository_connections", "row-1", "access_token")
  );
  assert.match(sealed, /^v1\.k0\./);
  assert.throws(() =>
    old.open(sealed, aad("repository_connections", "row-2", "access_token"))
  );
  assert.throws(() =>
    old.open(sealed, aad("repository_connections", "row-1", "refresh_token"))
  );
  const rotated = new SecretBox({ id: "k1", key: Buffer.alloc(32, 2) }, [
    { id: "k0", key: Buffer.alloc(32, 1) }
  ]);
  assert.equal(
    rotated.open(
      sealed,
      aad("repository_connections", "row-1", "access_token")
    ),
    "token"
  );
  assert.match(
    rotated.seal("x", "c"),
    /^v1\.k1\./,
    "writes use the current key"
  );
});
