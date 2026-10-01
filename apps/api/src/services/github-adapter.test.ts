import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync, verify } from "node:crypto";
import test from "node:test";
import { repositoryConnections } from "@orchestrat/db";
import { repositoryWorkerOf } from "../app.js";
import { workspace } from "../test/workspace.js";
import {
  GithubAdapter,
  githubSignatureMatches
} from "./repository/providers/github.js";
import { SecretBox } from "./repository/secrets.js";
import { FakeGitHub } from "./repository/testing/fake-github.js";
import type { ConnectionRow } from "./repository/types.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048
});
const config = {
  appId: "1234",
  clientId: "Iv1.fakeclient",
  clientSecret: "github-client-secret",
  slug: "orchestrat-test",
  privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  webhookSecret: "a-webhook-secret-of-at-least-32-chars!!"
};

function world() {
  const github = new FakeGitHub();
  github.installations.set(10, { suspended: false, repositories: [100] });
  github.installations.set(20, { suspended: false, repositories: [200] });
  github.repositories.set(100, {
    id: 100,
    full_name: "acme/app",
    default_branch: "main",
    branches: new Map([
      ["main", "sha-main"],
      ["feat/a", "sha-a"],
      ["feat/b", "sha-b"]
    ]),
    pulls: []
  });
  github.repositories.set(200, {
    id: 200,
    full_name: "rival/secret",
    default_branch: "main",
    branches: new Map([["main", "x"]]),
    pulls: []
  });
  let clock = new Date("2026-10-01T00:00:00.000Z");
  const adapter = new GithubAdapter(config, {
    fetch: github.fetch,
    sleep: async () => undefined,
    now: () => clock
  });
  return {
    github,
    adapter,
    advance: (ms: number) => {
      clock = new Date(clock.getTime() + ms);
    }
  };
}

test("webhook signatures match GitHub's documented test vector", () => {
  assert.ok(
    githubSignatureMatches(
      "It's a Secret to Everybody",
      Buffer.from("Hello, World!"),
      "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17"
    )
  );
  assert.ok(
    !githubSignatureMatches(
      "It's a Secret to Everybody",
      Buffer.from("Hello, World?"),
      "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17"
    )
  );
});

test("app JWTs are RS256, backdated a minute, short-lived and issued by the client id", () => {
  const { adapter } = world();
  const [head, body, signature] = adapter.appJwt().split(".");
  assert.ok(
    verify(
      "RSA-SHA256",
      Buffer.from(`${head}.${body}`),
      publicKey,
      Buffer.from(signature!, "base64url")
    )
  );
  const claims = JSON.parse(Buffer.from(body!, "base64url").toString());
  const now = Date.parse("2026-10-01T00:00:00.000Z") / 1000;
  assert.equal(claims.iat, now - 60);
  assert.ok(claims.exp - now <= 600);
  assert.equal(claims.iss, config.clientId);
});

test("events map to branch signals and stay within their installation", () => {
  const { adapter } = world();
  const connection = {
    installationId: "10",
    providerRepositoryId: "100"
  } as ConnectionRow;
  const parse = (eventType: string, payload: Record<string, unknown>) =>
    adapter.parse(
      { eventType, payload: { installation: { id: 10 }, ...payload } },
      connection
    );
  assert.deepEqual(parse("push", { ref: "refs/heads/feat/x", after: "s1" }), [
    { type: "ref_pushed", name: "feat/x", sha: "s1" }
  ]);
  assert.deepEqual(
    parse("push", { ref: "refs/heads/feat/x", deleted: true, before: "s1" }),
    [{ type: "ref_deleted", name: "feat/x", beforeSha: "s1" }]
  );
  assert.deepEqual(parse("push", { ref: "refs/tags/v1", after: "t" }), []);
  assert.deepEqual(parse("delete", { ref: "feat/x", ref_type: "branch" }), [
    { type: "ref_deleted", name: "feat/x", beforeSha: null }
  ]);
  const pull = (headRepo: number) => ({
    action: "closed",
    pull_request: {
      number: 7,
      html_url: "https://github.com/acme/app/pull/7",
      merged_at: "2026-10-01T00:00:00Z",
      head: { ref: "feat/x", sha: "s2", repo: { id: headRepo } },
      base: { ref: "main", repo: { id: 100 } }
    }
  });
  const [merged] = parse("pull_request", pull(100));
  assert.equal(merged?.type, "change_merged");
  assert.equal(
    merged?.type === "change_merged" && merged.change.fromFork,
    false
  );
  const [forked] = parse("pull_request", pull(999));
  assert.ok(forked?.type === "change_merged" && forked.change.fromFork);
  assert.deepEqual(
    parse("repository", {
      action: "edited",
      changes: { default_branch: { from: "main" } },
      repository: { default_branch: "trunk" }
    }),
    [{ type: "default_branch_changed", name: "trunk" }]
  );
  assert.deepEqual(parse("installation", { action: "suspend" }), [
    { type: "installation_suspended" }
  ]);
  assert.deepEqual(
    parse("installation_repositories", {
      action: "removed",
      repositories_removed: [{ id: 100 }]
    }),
    [{ type: "authorization_revoked" }]
  );
  assert.deepEqual(
    adapter.parse(
      {
        eventType: "push",
        payload: { installation: { id: 20 }, ref: "refs/heads/x", after: "1" }
      },
      connection
    ),
    [],
    "another installation never speaks for this connection"
  );
});

test("connecting checks the installation id and mints only narrow tokens", async (t) => {
  const { github, adapter } = world();
  const s = await workspace({
    repository: {
      adapters: [adapter],
      secrets: new SecretBox({ id: "test", key: Buffer.alloc(32, 4) }),
      config: {
        publicApiUrl: "https://api.example.test",
        dashboardUrl: "https://app.example.test"
      }
    }
  });
  t.after(() => s.app.close());
  const base = `/projects/${s.project.id}`;
  const person = github.user(42, [10]);
  const authorization = (
    await s.alice("POST", `${base}/repository/authorizations`, {
      provider: "github"
    })
  ).json();
  const authorizeUrl = new URL(authorization.authorize_url);
  assert.equal(authorizeUrl.searchParams.get("code_challenge_method"), "S256");
  const callback = await s.app.inject({
    method: "GET",
    url: `/api/v1/repository/callback/github?code=${person.code}&state=${authorizeUrl.searchParams.get("state")}`
  });
  assert.match(
    callback.headers.location as string,
    /repository_authorization=/
  );
  const install = (installation_id: string) =>
    s.alice(
      "POST",
      `${base}/repository/authorizations/${authorization.authorization_id}/github-installation`,
      { installation_id }
    );
  const foreign = await install("20");
  assert.equal(foreign.statusCode, 409);
  assert.equal(foreign.json().error.code, "REPOSITORY_AUTHORIZATION_INVALID");
  assert.deepEqual((await install("10")).json(), { next: "pick_repository" });
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
  const stolen = await s.alice("POST", `${base}/repository`, {
    authorization_id: authorization.authorization_id,
    provider_repository_id: "200"
  });
  assert.equal(stolen.statusCode, 409, "a repository the person can't see");
  const connected = await s.alice("POST", `${base}/repository`, {
    authorization_id: authorization.authorization_id,
    provider_repository_id: "100"
  });
  assert.equal(connected.statusCode, 201, connected.body);
  const [row] = await s.db.select().from(repositoryConnections);
  assert.equal(row!.installationId, "10");
  assert.ok(github.minted.length > 0);
  for (const minted of github.minted) {
    assert.deepEqual(minted.body.repository_ids, [100]);
    assert.ok(
      !("contents" in (minted.body.permissions as object)),
      "never contents"
    );
  }
  await repositoryWorkerOf(s.app)!.tick();
  const branches = (await s.alice("GET", `${base}/branches`)).json().branches;
  assert.ok(
    branches.some(
      (branch: { name: string; is_default: boolean }) =>
        branch.is_default && branch.name === "main"
    )
  );
});

test("a suspended installation can't be connected", async () => {
  const { github, adapter } = world();
  github.installations.get(10)!.suspended = true;
  const person = github.user(42, [10]);
  await assert.rejects(
    adapter.prepareConnection({
      attempt: { providerUserId: "42" } as never,
      userToken: person.token,
      providerRepositoryId: "100"
    }),
    /suspended/
  );
});

test("reads page through results and reuse tokens for 55 minutes", async () => {
  const { github, adapter, advance } = world();
  const connection = {
    installationId: "10",
    providerRepositoryId: "100"
  } as ConnectionRow;
  const branches = await adapter.listBranches(connection);
  assert.deepEqual(
    branches.map((branch) => branch.name).sort(),
    ["feat/a", "feat/b", "main"],
    "three branches over two pages"
  );
  assert.deepEqual(await adapter.getBranch(connection, "feat/missing"), null);
  assert.equal((await adapter.getBranch(connection, "feat/a"))?.sha, "sha-a");
  assert.equal(github.minted.length, 1, "one metadata token served every read");
  advance(56 * 60_000);
  await adapter.getRepository(connection);
  assert.equal(github.minted.length, 2, "minted again after 55 minutes");
});

test("deliveries that never succeeded are redelivered once an hour", async () => {
  const { github, adapter, advance } = world();
  const at = (minutes: number) =>
    new Date(
      Date.parse("2026-10-01T00:00:00Z") - minutes * 60_000
    ).toISOString();
  github.deliveries.push(
    { id: 1, guid: "lost", status_code: 502, delivered_at: at(10) },
    { id: 2, guid: "fine", status_code: 500, delivered_at: at(20) },
    { id: 3, guid: "fine", status_code: 202, delivered_at: at(15) },
    { id: 4, guid: "ancient", status_code: 500, delivered_at: at(5 * 24 * 60) }
  );
  await adapter.maintain();
  assert.deepEqual(github.redelivered, [1]);
  await adapter.maintain();
  assert.deepEqual(github.redelivered, [1], "at most once an hour");
  advance(61 * 60_000);
  await adapter.maintain();
  assert.deepEqual(github.redelivered, [1, 1]);
});

test("a head deleted before its merge event still merges through the GitHub route", async (t) => {
  const { github, adapter } = world();
  const s = await workspace({
    repository: {
      adapters: [adapter],
      secrets: new SecretBox({ id: "test", key: Buffer.alloc(32, 4) }),
      config: {
        publicApiUrl: "https://api.example.test",
        dashboardUrl: "https://app.example.test"
      }
    }
  });
  t.after(() => s.app.close());
  const { project } = s;
  await s.db.insert(repositoryConnections).values({
    projectId: project.id,
    provider: "github",
    providerRepositoryId: "100",
    repositoryFullName: "acme/app",
    providerDefaultBranch: "main",
    installationId: "10",
    lastReconciledAt: new Date()
  });
  const worker = repositoryWorkerOf(s.app)!;
  const send = async (event: string, payload: Record<string, unknown>) => {
    const body = Buffer.from(
      JSON.stringify({
        installation: { id: 10 },
        repository: { id: 100 },
        ...payload
      })
    );
    const response = await s.app.inject({
      method: "POST",
      url: "/api/v1/webhooks/github",
      headers: {
        "content-type": "application/json",
        "x-github-event": event,
        "x-github-delivery": crypto.randomUUID(),
        "x-hub-signature-256": `sha256=${createHmac("sha256", config.webhookSecret).update(body).digest("hex")}`
      },
      payload: body
    });
    assert.equal(response.statusCode, 202);
    await worker.tick();
  };
  await send("push", { ref: "refs/heads/main", after: "sha-main" });
  github.repositories.get(100)!.branches.set("feat/x", "sha-x");
  await send("push", { ref: "refs/heads/feat/x", after: "sha-x" });
  github.repositories.get(100)!.branches.delete("feat/x");
  await send("push", {
    ref: "refs/heads/feat/x",
    deleted: true,
    before: "sha-x"
  });
  await send("pull_request", {
    action: "closed",
    pull_request: {
      number: 9,
      merged_at: "2026-10-01T00:00:00Z",
      head: { ref: "feat/x", sha: "sha-x", repo: { id: 100 } },
      base: { ref: "main", repo: { id: 100 } }
    }
  });
  const runs = (await s.alice("GET", `/projects/${project.id}/merges`)).json()
    .runs;
  assert.equal(runs.length, 1);
  assert.equal(runs[0].trigger, "provider_merge");
  assert.equal(runs[0].provider.change_number, "9");
});
