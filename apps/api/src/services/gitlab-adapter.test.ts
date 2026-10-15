import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import test from "node:test";
import { repositoryConnections } from "@orchestrat/db";
import { eq } from "drizzle-orm";
import { repositoryWorkerOf } from "../app.js";
import { workspace } from "../test/workspace.js";
import { GitlabAdapter } from "./repository/providers/gitlab.js";
import { SecretBox } from "./repository/secrets.js";
import { FakeGitLab } from "./repository/testing/fake-gitlab.js";
import type { ConnectionRow } from "./repository/types.js";

const ZERO = "0".repeat(40);

async function setup() {
  let clock = new Date("2026-10-01T00:00:00.000Z");
  const now = () => clock;
  const gitlab = new FakeGitLab(now);
  gitlab.projects.set(300, {
    id: 300,
    path_with_namespace: "acme/app",
    default_branch: "main",
    branches: new Map([
      ["main", "sha-main"],
      ["feat/a", "sha-a"]
    ]),
    members: new Map([
      [7, 40],
      [8, 30]
    ]),
    mergeRequests: [],
    hooks: new Map()
  });
  const adapter = new GitlabAdapter(
    { clientId: gitlab.clientId, clientSecret: gitlab.clientSecret },
    new SecretBox({ id: "test", key: Buffer.alloc(32, 5) }),
    "https://api.example.test",
    { fetch: gitlab.fetch, sleep: async () => undefined, now }
  );
  const s = await workspace({
    repository: {
      adapters: [adapter],
      secrets: new SecretBox({ id: "test", key: Buffer.alloc(32, 5) }),
      config: {
        publicApiUrl: "https://api.example.test",
        dashboardUrl: "https://app.example.test"
      },
      now
    }
  });
  const base = `/projects/${s.project.id}`;
  const worker = repositoryWorkerOf(s.app)!;
  const authorizeAs = async (userId: number) => {
    const code = gitlab.user(userId);
    const authorization = (
      await s.alice("POST", `${base}/repository/authorizations`, {
        provider: "gitlab"
      })
    ).json();
    const state = new URL(authorization.authorize_url).searchParams.get(
      "state"
    );
    const callback = await s.app.inject({
      method: "GET",
      url: `/api/v1/repository/callback/gitlab?code=${code}&state=${state}`
    });
    assert.match(
      callback.headers.location as string,
      /repository_authorization=/
    );
    return authorization;
  };
  const connect = async () => {
    const authorization = await authorizeAs(7);
    const connected = await s.alice("POST", `${base}/repository`, {
      authorization_id: authorization.authorization_id,
      provider_repository_id: "300"
    });
    assert.equal(connected.statusCode, 201, connected.body);
    await worker.tick();
    return connected.json().repository as { id: string };
  };
  const hookBody = () => [...gitlab.projects.get(300)!.hooks.values()][0]!.body;
  const sign = (
    connectionId: string,
    event: string,
    payload: Record<string, unknown>,
    options: { timestamp?: number; instance?: string; secret?: string } = {}
  ) => {
    const body = Buffer.from(JSON.stringify(payload));
    const id = randomUUID();
    const timestamp = String(
      options.timestamp ?? Math.floor(clock.getTime() / 1000)
    );
    const key = Buffer.from(
      (options.secret ?? String(hookBody().signing_token)).replace(
        /^whsec_/,
        ""
      ),
      "base64"
    );
    const signature = createHmac("sha256", key)
      .update(`${id}.${timestamp}.`)
      .update(body)
      .digest("base64");
    return s.app.inject({
      method: "POST",
      url: `/api/v1/webhooks/gitlab/${connectionId}`,
      headers: {
        "content-type": "application/json",
        "x-gitlab-event": event,
        "x-gitlab-instance": options.instance ?? "https://gitlab.com",
        "webhook-id": id,
        "webhook-timestamp": timestamp,
        "webhook-signature": `v1,${signature}`
      },
      payload: body
    });
  };
  const branches = async () =>
    (await s.alice("GET", `${base}/branches?include_archived=true`)).json()
      .branches as {
      name: string;
      archived_at: string | null;
      is_default: boolean;
    }[];
  const row = async () =>
    (await s.db.select().from(repositoryConnections))[0]! as ConnectionRow;
  return {
    ...s,
    gitlab,
    adapter,
    base,
    worker,
    authorizeAs,
    connect,
    hookBody,
    sign,
    branches,
    row,
    advance: (ms: number) => {
      clock = new Date(clock.getTime() + ms);
    }
  };
}

test("connecting needs a Maintainer and creates a signed hook", async (t) => {
  const s = await setup();
  t.after(() => s.app.close());
  const authorization = (
    await s.alice("POST", `${s.base}/repository/authorizations`, {
      provider: "gitlab"
    })
  ).json();
  const url = new URL(authorization.authorize_url);
  assert.equal(url.searchParams.get("scope"), "api");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");

  const developer = await s.authorizeAs(8);
  const refused = await s.alice("POST", `${s.base}/repository`, {
    authorization_id: developer.authorization_id,
    provider_repository_id: "300"
  });
  assert.equal(refused.statusCode, 409);
  assert.match(refused.json().error.message, /Maintainer/);

  const connection = await s.connect();
  const hook = s.hookBody();
  assert.equal(
    hook.url,
    `https://api.example.test/api/v1/webhooks/gitlab/${connection.id}`
  );
  assert.deepEqual(
    [
      hook.push_events,
      hook.merge_requests_events,
      hook.tag_push_events,
      hook.enable_ssl_verification,
      hook.branch_filter_strategy
    ],
    [true, true, false, true, "all_branches"]
  );
  assert.match(String(hook.signing_token), /^whsec_/);
  assert.equal(
    Buffer.from(String(hook.signing_token).slice(6), "base64").length,
    32
  );
  const stored = await s.row();
  assert.ok(
    stored.accessTokenCiphertext?.startsWith("v1."),
    "tokens are encrypted"
  );
  assert.ok(!JSON.stringify(stored).includes("glpat-"));
  assert.equal(stored.gitlabHookId, "1");
});

test("webhooks check signature, window, instance and project", async (t) => {
  const s = await setup();
  t.after(() => s.app.close());
  const { id } = await s.connect();
  const payload = {
    project: { id: 300, default_branch: "main" },
    ref: "refs/heads/feat/new",
    before: ZERO,
    after: "sha-new"
  };
  assert.equal((await s.sign(id, "Push Hook", payload)).statusCode, 202);
  assert.equal(
    (
      await s.sign(id, "Push Hook", payload, {
        secret: `whsec_${Buffer.alloc(32, 1).toString("base64")}`
      })
    ).statusCode,
    401
  );
  assert.equal(
    (
      await s.sign(id, "Push Hook", payload, {
        timestamp: Math.floor(Date.parse("2026-10-01T00:00:00Z") / 1000) - 600
      })
    ).statusCode,
    401,
    "outside the 5-minute window"
  );
  assert.equal(
    (
      await s.sign(id, "Push Hook", payload, {
        instance: "https://gitlab.example.com"
      })
    ).statusCode,
    401
  );
  assert.equal(
    (await s.sign(randomUUID(), "Push Hook", payload)).statusCode,
    404
  );
  s.gitlab.projects.get(300)!.branches.set("feat/new", "sha-new");
  await s.worker.tick();
  assert.ok((await s.branches()).some((branch) => branch.name === "feat/new"));
});

test("zero SHAs are hints; a push that skips the hook comes in through reconcile", async (t) => {
  const s = await setup();
  t.after(() => s.app.close());
  const { id } = await s.connect();
  const remote = s.gitlab.projects.get(300)!.branches;
  remote.set("feat/x", "sha-x");
  await s.sign(id, "Push Hook", {
    project: { id: 300 },
    ref: "refs/heads/feat/x",
    before: ZERO,
    after: "sha-x"
  });
  await s.worker.tick();
  remote.delete("feat/x");
  await s.sign(id, "Push Hook", {
    project: { id: 300 },
    ref: "refs/heads/feat/x",
    before: "sha-x",
    after: ZERO
  });
  await s.worker.tick();
  assert.ok(
    (await s.branches()).find((branch) => branch.name === "feat/x")!.archived_at
  );

  // GitLab sends no hook for pushes changing more than 3 refs.
  for (const name of ["one", "two", "three", "four", "five"])
    remote.set(`bulk/${name}`, `sha-${name}`);
  await s.alice("POST", `${s.base}/repository/sync`, {});
  await s.worker.tick();
  assert.equal(
    (await s.branches()).filter((branch) => branch.name.startsWith("bulk/"))
      .length,
    5
  );
});

test("merge requests merge, forks don't, and payloads reveal default changes", async (t) => {
  const s = await setup();
  t.after(() => s.app.close());
  const { id } = await s.connect();
  const remote = s.gitlab.projects.get(300)!;
  remote.branches.set("feat/mr", "sha-mr");
  await s.sign(id, "Push Hook", {
    project: { id: 300 },
    ref: "refs/heads/feat/mr",
    before: ZERO,
    after: "sha-mr"
  });
  const merge = (iid: number, source: number) => ({
    project: { id: 300, default_branch: "main" },
    object_attributes: {
      action: "merge",
      iid,
      source_branch: "feat/mr",
      target_branch: "main",
      source_project_id: source,
      target_project_id: 300,
      merged_at: "2026-10-01T00:00:00Z",
      last_commit: { id: "sha-mr" },
      url: `https://gitlab.com/acme/app/-/merge_requests/${iid}`
    }
  });
  await s.sign(id, "Merge Request Hook", merge(1, 300));
  await s.sign(id, "Merge Request Hook", merge(2, 999));
  await s.worker.tick();
  const runs = (await s.alice("GET", `${s.base}/merges`)).json().runs;
  assert.deepEqual(
    runs
      .map(
        (run: {
          provider: { change_number: string };
          status: string;
          skip_reason: string | null;
        }) => [run.provider.change_number, run.status, run.skip_reason]
      )
      .sort(),
    [
      ["1", "applied", null],
      ["2", "skipped", "fork"]
    ],
    "the fork's merge request is recorded as skipped"
  );

  remote.default_branch = "feat/mr";
  await s.sign(id, "Push Hook", {
    project: { id: 300, default_branch: "feat/mr" },
    ref: "refs/heads/feat/mr",
    before: "sha-mr",
    after: "sha-mr-2"
  });
  await s.worker.tick();
  assert.equal(
    (await s.branches()).find((branch) => branch.is_default)!.name,
    "feat/mr"
  );
});

test("hook health shows an auto-disabled hook, and a test delivery re-enables it", async (t) => {
  const s = await setup();
  t.after(() => s.app.close());
  await s.connect();
  const hook = s.gitlab.projects.get(300)!.hooks.get(1)!;
  hook.alert_status = "temporarily_disabled";
  hook.disabled_until = "2026-10-01T01:00:00Z";
  await s.alice("POST", `${s.base}/repository/sync`, {});
  await s.worker.tick();
  const repository = (await s.alice("GET", `${s.base}/repository`)).json()
    .repository;
  assert.deepEqual(repository.hook_health, {
    alert_status: "temporarily_disabled",
    disabled_until: "2026-10-01T01:00:00Z"
  });
  const reenabled = await s.alice(
    "POST",
    `${s.base}/repository/hook/reenable`,
    {}
  );
  assert.equal(reenabled.statusCode, 202, reenabled.body);
  assert.deepEqual(s.gitlab.tested, [1]);
});

test("refresh tokens rotate, and a dead grant asks to reconnect", async (t) => {
  const s = await setup();
  t.after(() => s.app.close());
  await s.connect();
  const before = await s.row();
  s.advance(3 * 3600_000);
  await s.adapter.getBranch(await s.row(), "main");
  const after = await s.row();
  assert.equal(s.gitlab.refreshes, 1);
  assert.notEqual(
    after.refreshTokenCiphertext,
    before.refreshTokenCiphertext,
    "persisted before use"
  );
  await s.adapter.getBranch(after, "main");
  assert.equal(s.gitlab.refreshes, 1, "the new access token is reused");

  s.gitlab.refresh.clear();
  s.advance(3 * 3600_000);
  await assert.rejects(
    s.adapter.getBranch(await s.row(), "main"),
    /revoked or expired/
  );
  assert.equal((await s.row()).status, "needs_reauthorization");
});

test("disconnect deletes the hook and revokes both tokens", async (t) => {
  const s = await setup();
  t.after(() => s.app.close());
  await s.connect();
  assert.equal(
    (await s.alice("DELETE", `${s.base}/repository`)).statusCode,
    204
  );
  assert.equal(s.gitlab.projects.get(300)!.hooks.size, 0);
  assert.equal(s.gitlab.revoked.length, 2);
  const [row] = await s.db
    .select()
    .from(repositoryConnections)
    .where(eq(repositoryConnections.status, "disconnected"));
  assert.equal(row!.accessTokenCiphertext, null, "secrets are wiped");
});

test("an organization integration's tokens serve imported connections and survive a disconnect", async (t) => {
  const s = await setup();
  t.after(() => s.app.close());
  const org = `/organizations/${s.organization.id}`;
  const code = s.gitlab.user(7);
  const started = (
    await s.alice("POST", `${org}/integrations/authorizations`, {
      provider: "gitlab"
    })
  ).json();
  const state = new URL(started.authorize_url).searchParams.get("state");
  const callback = await s.app.inject({
    method: "GET",
    url: `/api/v1/repository/callback/gitlab?code=${code}&state=${state}`
  });
  assert.match(callback.headers.location as string, /\/integrations\?/);
  const created = await s.alice("POST", `${org}/integrations`, {
    provider: "gitlab",
    authorization_id: started.authorization_id,
    repository_selection: "all"
  });
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(created.json().integration.account_name, "user7");
  const [repository] = (await s.alice("GET", `${org}/repositories`)).json()
    .repositories;
  assert.equal(repository.full_name, "acme/app");
  const imported = await s.alice("POST", `${org}/projects/import`, {
    repository_id: repository.id,
    name: "App"
  });
  assert.equal(imported.statusCode, 201, imported.body);
  const connection = await s.row();
  assert.equal(
    connection.accessTokenCiphertext,
    null,
    "the connection keeps no tokens of its own"
  );
  assert.ok(connection.integrationId);
  assert.equal(s.gitlab.projects.get(300)!.hooks.size, 1);

  s.advance(3 * 3600_000);
  await s.adapter.getBranch(connection, "main");
  assert.equal(s.gitlab.refreshes, 1, "the integration's pair rotated");
  await s.adapter.getBranch(await s.row(), "main");
  assert.equal(s.gitlab.refreshes, 1);

  const projectId = imported.json().project.id;
  assert.equal(
    (await s.alice("DELETE", `/projects/${projectId}/repository`)).statusCode,
    204
  );
  assert.equal(s.gitlab.projects.get(300)!.hooks.size, 0, "the hook goes");
  assert.equal(s.gitlab.revoked.length, 0, "the shared tokens stay");
  assert.equal(
    (
      await s.alice(
        "DELETE",
        `${org}/integrations/${created.json().integration.id}`
      )
    ).statusCode,
    204,
    "unused, the integration can go"
  );
});
