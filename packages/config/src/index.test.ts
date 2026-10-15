import assert from "node:assert/strict";
import test from "node:test";
import { loadApiConfig, loadRepositoryConfig } from "./index.js";

const env = {
  ORCHESTRAT_DATABASE_URL: "postgres://localhost/orchestrat"
};

test("defaults to dedicated local ports and rejects invalid TCP ports", () => {
  const config = loadApiConfig(env);
  assert.equal(config.ORCHESTRAT_API_PORT, 8801);
  assert.equal(config.ORCHESTRAT_TRUST_PROXY_HOPS, 0);
  assert.deepEqual(config.ORCHESTRAT_ALLOWED_ORIGINS, [
    "http://localhost:8813"
  ]);
  for (const port of ["0", "65536", "88001", "1.5"])
    assert.throws(() => loadApiConfig({ ...env, ORCHESTRAT_API_PORT: port }));
  assert.equal(
    loadApiConfig({ ...env, ORCHESTRAT_API_PORT: "65535" }).ORCHESTRAT_API_PORT,
    65535
  );
});

test("accepts only a bounded trusted proxy hop count", () => {
  assert.equal(
    loadApiConfig({ ...env, ORCHESTRAT_TRUST_PROXY_HOPS: "1" })
      .ORCHESTRAT_TRUST_PROXY_HOPS,
    1
  );
  for (const hops of ["-1", "4", "true"])
    assert.throws(() =>
      loadApiConfig({ ...env, ORCHESTRAT_TRUST_PROXY_HOPS: hops })
    );
});

test("splits allowed origins", () => {
  const config = loadApiConfig({
    ...env,
    ORCHESTRAT_ALLOWED_ORIGINS: "https://one.example, https://two.example"
  });
  assert.deepEqual(config.ORCHESTRAT_ALLOWED_ORIGINS, [
    "https://one.example",
    "https://two.example"
  ]);
});

test("signup defaults to invite-only and accepts only known modes", () => {
  assert.equal(loadApiConfig(env).ORCHESTRAT_SIGNUP, "invite");
  for (const mode of ["invite", "open", "closed"] as const)
    assert.equal(
      loadApiConfig({ ...env, ORCHESTRAT_SIGNUP: mode }).ORCHESTRAT_SIGNUP,
      mode
    );
  assert.throws(() => loadApiConfig({ ...env, ORCHESTRAT_SIGNUP: "anyone" }));
});

test("prefers Orchestrat host and port over provider-injected fallbacks", () => {
  const config = loadApiConfig({
    ...env,
    HOST: "provider-host",
    PORT: "8080",
    ORCHESTRAT_API_HOST: "0.0.0.0",
    ORCHESTRAT_API_PORT: "8801"
  });
  assert.equal(config.ORCHESTRAT_API_HOST, "0.0.0.0");
  assert.equal(config.ORCHESTRAT_API_PORT, 8801);
});

test("accepts standard host and port fallbacks", () => {
  const config = loadApiConfig({ ...env, HOST: "127.0.0.1", PORT: "8080" });
  assert.equal(config.ORCHESTRAT_API_HOST, "127.0.0.1");
  assert.equal(config.ORCHESTRAT_API_PORT, 8080);
});

const repositoryEnv = {
  ORCHESTRAT_PUBLIC_API_URL: "https://api.example.test",
  ORCHESTRAT_DASHBOARD_URL: "https://app.example.test",
  ORCHESTRAT_REPOSITORY_SECRET_KEY: Buffer.alloc(32, 7).toString("base64"),
  ORCHESTRAT_REPOSITORY_SECRET_KEY_ID: "k1",
  ORCHESTRAT_GITLAB_OAUTH_CLIENT_ID: "gitlab-app",
  ORCHESTRAT_GITLAB_OAUTH_CLIENT_SECRET: "gitlab-secret"
};

test("repository providers count as configured only when complete", () => {
  const config = loadRepositoryConfig(repositoryEnv);
  assert.deepEqual(config.gitlab, {
    clientId: "gitlab-app",
    clientSecret: "gitlab-secret"
  });
  assert.equal(config.github, null);
  assert.match(config.unavailable.github!, /ORCHESTRAT_GITHUB_APP_ID/);
  assert.equal(config.unavailable.gitlab, null);
  assert.equal(config.syncEnabled, true, "on when a provider is configured");
  assert.equal(config.reconcileIntervalSeconds, 900);
  assert.equal(config.secretKey?.id, "k1");

  // Origin stays hidden, even fully configured, until it's turned on.
  const originEnv = {
    ...repositoryEnv,
    ORCHESTRAT_ORIGIN_APP_ID: "app_test",
    ORCHESTRAT_ORIGIN_APP_PRIVATE_KEY_BASE64:
      Buffer.from("pem").toString("base64")
  };
  const hidden = loadRepositoryConfig(originEnv);
  assert.deepEqual(hidden.hidden, ["origin"]);
  assert.equal(hidden.origin, null);
  const enabled = loadRepositoryConfig({
    ...originEnv,
    ORCHESTRAT_ORIGIN_ENABLED: "true"
  });
  assert.deepEqual(enabled.hidden, []);
  assert.equal(enabled.origin?.appId, "app_test");
  assert.equal(enabled.unavailable.origin, null);

  const bare = loadRepositoryConfig({});
  assert.equal(bare.syncEnabled, false);
  assert.match(bare.unavailable.gitlab!, /ORCHESTRAT_PUBLIC_API_URL/);
  assert.throws(() =>
    loadRepositoryConfig({
      ...repositoryEnv,
      ORCHESTRAT_REPOSITORY_SECRET_KEY: "dG9vIHNob3J0"
    })
  );
  const rotated = loadRepositoryConfig({
    ...repositoryEnv,
    ORCHESTRAT_REPOSITORY_PREVIOUS_SECRET_KEYS: `k0:${Buffer.alloc(32, 1).toString("base64")}`
  });
  assert.deepEqual(
    rotated.previousSecretKeys.map((entry) => entry.id),
    ["k0"]
  );
});
