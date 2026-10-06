import assert from "node:assert/strict";
import { repositoryWorkerOf } from "../app.js";
import { SecretBox } from "../services/repository/secrets.js";
import { FakeProvider } from "../services/repository/testing/fake-provider.js";
import { workspace } from "./workspace.js";

// A project connected to a fake provider's repository through the real
// routes, plus helpers to send signed webhooks and read branches.

export type Branch = {
  id: string;
  name: string;
  is_default: boolean;
  archived_at: string | null;
  archived_reason: string | null;
  created_via: string;
  provider: { state: string } | null;
};

export async function connected(
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
