import assert from "node:assert/strict";
import test from "node:test";
import {
  organizationIntegrations,
  projects,
  repositoryConnectionAttempts,
  repositoryConnections
} from "@orchestrat/db";
import {
  importRepositoryProjectResponseSchema,
  integrationAuthorizationOptionsResponseSchema,
  organizationIntegrationResponseSchema,
  organizationIntegrationsResponseSchema,
  organizationRepositoriesResponseSchema
} from "@orchestrat/protocol";
import { eq } from "drizzle-orm";
import { repositoryWorkerOf } from "../app.js";
import { SecretBox, aad } from "../services/repository/secrets.js";
import { FakeProvider } from "../services/repository/testing/fake-provider.js";
import { workspace } from "../test/workspace.js";

// Organization Git integrations through the real routes, against an
// in-memory provider: connect once, see what it reaches, import a
// repository as a project, notice new repositories.

const secrets = new SecretBox({ id: "test", key: Buffer.alloc(32, 9) });

async function setup(provider: "github" | "gitlab" = "github") {
  const fake = new FakeProvider(provider);
  const app = fake.repository({
    fullName: "acme/app",
    defaultBranch: "trunk",
    installation: "101",
    pushedAt: new Date("2026-09-30T00:00:00.000Z"),
    branches: new Map([
      ["trunk", "sha-trunk-1"],
      ["feat/old", "sha-old-1"]
    ])
  });
  const docs = fake.repository({
    fullName: "acme/docs",
    installation: "101",
    pushedAt: new Date("2026-09-20T00:00:00.000Z")
  });
  const other = fake.repository({
    fullName: "someone/else",
    installation: "202"
  });
  let clock = new Date("2026-10-01T00:00:00.000Z");
  const s = await workspace({
    repository: {
      adapters: [fake],
      secrets,
      config: {
        publicApiUrl: "https://api.example.test",
        dashboardUrl: "https://app.example.test"
      },
      now: () => clock
    }
  });
  const org = `/organizations/${s.organization.id}`;
  const worker = repositoryWorkerOf(s.app)!;
  const advance = (ms: number) => {
    clock = new Date(clock.getTime() + ms);
  };
  /** Authorize through the provider and return the attempt id. */
  const authorize = async () => {
    const started = await s.alice(
      "POST",
      `${org}/integrations/authorizations`,
      {
        provider
      }
    );
    assert.equal(started.statusCode, 200, started.body);
    const state = new URL(started.json().authorize_url).searchParams.get(
      "state"
    )!;
    const callback = await s.app.inject({
      method: "GET",
      url: `/api/v1/repository/callback/${provider}?code=good-code&state=${state}`
    });
    assert.equal(callback.statusCode, 302, callback.body);
    assert.equal(
      callback.headers.location,
      `https://app.example.test/organizations/${s.organization.id}/integrations?repository_authorization=${started.json().authorization_id}`,
      "organization attempts return to Integrations"
    );
    return started.json().authorization_id as string;
  };
  const repositories = async (filter = "importable") =>
    organizationRepositoriesResponseSchema.parse(
      (await s.alice("GET", `${org}/repositories?filter=${filter}`)).json()
    ).repositories;
  return {
    ...s,
    fake,
    app_: app,
    docs,
    other,
    org,
    worker,
    advance,
    authorize,
    repositories
  };
}

test("a GitHub installation connects to the organization and its repositories import as projects", async (t) => {
  const s = await setup();
  t.after(() => s.app.close());
  assert.equal(
    (await s.bob("GET", `${s.org}/integrations`)).statusCode,
    403,
    "members can't see integrations"
  );
  assert.equal(
    (
      await s.bob("POST", `${s.org}/integrations/authorizations`, {
        provider: "github"
      })
    ).statusCode,
    403
  );
  const authorization = await s.authorize();
  const options = integrationAuthorizationOptionsResponseSchema.parse(
    (
      await s.alice(
        "GET",
        `${s.org}/integrations/authorizations/${authorization}`
      )
    ).json()
  );
  assert.deepEqual(
    options.installations.map((installation) => [
      installation.installation_id,
      installation.account_name,
      installation.connected
    ]),
    [
      ["101", "acct-101", false],
      ["202", "acct-202", false]
    ]
  );
  // The pending lookup the Setup URL uses names the organization.
  const pending = (
    await s.alice("GET", "/repository/authorizations/pending?provider=github")
  ).json();
  assert.equal(pending.organization_id, s.organization.id);
  assert.equal(pending.project_id, null);

  const created = await s.alice("POST", `${s.org}/integrations`, {
    provider: "github",
    authorization_id: authorization,
    installation_id: "101"
  });
  assert.equal(created.statusCode, 201, created.body);
  const { integration } = organizationIntegrationResponseSchema.parse(
    created.json()
  );
  assert.equal(integration.account_name, "acct-101");
  assert.equal(integration.repository_selection, "selected");
  assert.equal(integration.repository_count, 2);
  assert.equal(
    integration.manage_url,
    "https://fake.provider.test/installations/101"
  );
  const [attempt] = await s.db
    .select()
    .from(repositoryConnectionAttempts)
    .where(eq(repositoryConnectionAttempts.id, authorization));
  assert.equal(attempt!.status, "consumed");
  assert.equal(attempt!.userTokenCiphertext, null);

  const importable = await s.repositories();
  assert.deepEqual(
    importable.map((repository) => [repository.full_name, repository.is_new]),
    [
      ["acme/app", false],
      ["acme/docs", false]
    ],
    "newest push first; the initial sync isn't new"
  );
  assert.equal(
    (await s.bob("GET", `${s.org}/repositories`)).statusCode,
    403,
    "members can't list or import"
  );
  assert.equal(
    (
      await s.bob("POST", `${s.org}/projects/import`, {
        repository_id: importable[0]!.id,
        name: "App"
      })
    ).statusCode,
    403
  );

  const imported = await s.alice("POST", `${s.org}/projects/import`, {
    repository_id: importable[0]!.id,
    name: "App",
    task_key_prefix: "app"
  });
  assert.equal(imported.statusCode, 201, imported.body);
  const result = importRepositoryProjectResponseSchema.parse(imported.json());
  assert.equal(result.project.name, "App");
  assert.equal(result.repository.full_name, "acme/app");
  assert.equal(result.repository.project_id, result.project.id);
  const [connection] = await s.db
    .select()
    .from(repositoryConnections)
    .where(eq(repositoryConnections.projectId, result.project.id));
  assert.equal(connection!.integrationId, integration.id);
  assert.equal(connection!.installationId, "101");
  const branches = (
    await s.alice("GET", `/projects/${result.project.id}/branches`)
  ).json().branches as { name: string; is_default: boolean }[];
  assert.deepEqual(
    branches.filter((branch) => branch.is_default).map((branch) => branch.name),
    ["trunk"],
    "the default branch follows the provider's"
  );
  assert.deepEqual(
    (await s.repositories()).map((repository) => repository.full_name),
    ["acme/docs"],
    "an imported repository isn't importable again"
  );
  const all = await s.repositories("all");
  assert.equal(
    all.find((repository) => repository.full_name === "acme/app")!.project_id,
    result.project.id
  );

  // Importing a repository already connected fails without leaving a project.
  const before = (await s.db.select().from(projects)).length;
  const again = await s.alice("POST", `${s.org}/projects/import`, {
    repository_id: importable[0]!.id,
    name: "App again"
  });
  assert.equal(again.statusCode, 409, again.body);
  assert.equal(again.json().error.code, "REPOSITORY_CONNECTION_EXISTS");
  assert.equal((await s.db.select().from(projects)).length, before);

  // An existing project connects to an organization repository too.
  const docsRepository = (await s.repositories())[0]!;
  const linked = await s.alice(
    "POST",
    `/projects/${s.project.id}/repository/import`,
    { repository_id: docsRepository.id }
  );
  assert.equal(linked.statusCode, 201, linked.body);
  assert.equal(linked.json().repository.full_name, "acme/docs");
});

test("repositories added to an installation show up as new; dismissed ones stay hidden", async (t) => {
  const s = await setup();
  t.after(() => s.app.close());
  const authorization = await s.authorize();
  await s.alice("POST", `${s.org}/integrations`, {
    provider: "github",
    authorization_id: authorization,
    installation_id: "101"
  });
  s.advance(10 * 60_000);
  const added = s.fake.repository({
    fullName: "acme/new-thing",
    installation: "101",
    pushedAt: new Date("2026-10-01T00:05:00.000Z")
  });
  // GitHub tells the app; the delivery refreshes the integration.
  const signed = s.fake.sign("installation_repositories", {
    installation: "101",
    action: "added"
  });
  const response = await s.app.inject({
    method: "POST",
    url: "/api/v1/webhooks/github",
    headers: signed.headers,
    payload: signed.body
  });
  assert.equal(response.statusCode, 202, response.body);
  s.advance(20_000);
  await s.worker.tick();
  const importable = await s.repositories();
  const fresh = importable.find(
    (repository) => repository.id && repository.full_name === "acme/new-thing"
  );
  assert.ok(fresh, "the added repository is listed");
  assert.equal(fresh!.is_new, true);
  assert.equal(fresh!.provider_repository_id, added.id);
  assert.equal(importable[0]!.full_name, "acme/new-thing", "newest first");

  const dismissed = await s.alice(
    "POST",
    `${s.org}/repositories/${fresh!.id}/dismiss`,
    {}
  );
  assert.equal(dismissed.statusCode, 200, dismissed.body);
  assert.ok(
    !(await s.repositories()).some((repository) => repository.id === fresh!.id)
  );
  assert.equal(
    (await s.repositories("all")).find(
      (repository) => repository.id === fresh!.id
    )!.dismissed,
    true
  );

  // A repository removed from the installation drops off on refresh.
  s.fake.repositories.delete(s.docs.id);
  const integrations = organizationIntegrationsResponseSchema.parse(
    (await s.alice("GET", `${s.org}/integrations`)).json()
  ).integrations;
  const refreshed = await s.alice(
    "POST",
    `${s.org}/integrations/${integrations[0]!.id}/refresh`,
    {}
  );
  assert.equal(refreshed.statusCode, 200, refreshed.body);
  assert.ok(
    !(await s.repositories("all")).some(
      (repository) => repository.full_name === "acme/docs"
    )
  );
});

test("a GitLab integration keeps its tokens sealed, honours selected projects and can't be removed while in use", async (t) => {
  const s = await setup("gitlab");
  t.after(() => s.app.close());
  const authorization = await s.authorize();
  const options = integrationAuthorizationOptionsResponseSchema.parse(
    (
      await s.alice(
        "GET",
        `${s.org}/integrations/authorizations/${authorization}`
      )
    ).json()
  );
  assert.equal(options.installations.length, 0);
  const created = await s.alice("POST", `${s.org}/integrations`, {
    provider: "gitlab",
    authorization_id: authorization,
    repository_selection: "selected",
    selected_repository_ids: [s.app_.id]
  });
  assert.equal(created.statusCode, 201, created.body);
  const { integration } = organizationIntegrationResponseSchema.parse(
    created.json()
  );
  assert.equal(integration.account_name, "fake");
  assert.deepEqual(integration.selected_repository_ids, [s.app_.id]);
  const [row] = await s.db
    .select()
    .from(organizationIntegrations)
    .where(eq(organizationIntegrations.id, integration.id));
  assert.notEqual(row!.accessTokenCiphertext, "integration-access");
  assert.equal(
    secrets.open(
      row!.accessTokenCiphertext!,
      aad("organization_integrations", integration.id, "access_token")
    ),
    "integration-access",
    "tokens are sealed to the integration row"
  );
  assert.deepEqual(
    (await s.repositories()).map((repository) => repository.full_name),
    ["acme/app"],
    "only the selected project is visible"
  );

  const widened = await s.alice(
    "PATCH",
    `${s.org}/integrations/${integration.id}`,
    { repository_selection: "all" }
  );
  assert.equal(widened.statusCode, 200, widened.body);
  assert.equal((await s.repositories()).length, 3);

  const imported = await s.alice("POST", `${s.org}/projects/import`, {
    repository_id: (await s.repositories()).find(
      (repository) => repository.full_name === "acme/app"
    )!.id,
    name: "App"
  });
  assert.equal(imported.statusCode, 201, imported.body);
  const removed = await s.alice(
    "DELETE",
    `${s.org}/integrations/${integration.id}`
  );
  assert.equal(removed.statusCode, 409, removed.body);
  assert.equal(removed.json().error.code, "INTEGRATION_IN_USE");

  // Another organization's repository ids aren't reachable from here.
  const elsewhere = (
    await s.alice("POST", "/organizations", { name: "Elsewhere" })
  ).json();
  const foreign = await s.alice(
    "POST",
    `/organizations/${elsewhere.id}/projects/import`,
    {
      repository_id: (await s.repositories("all"))[0]!.id,
      name: "Nope"
    }
  );
  assert.equal(foreign.statusCode, 404, foreign.body);
});
