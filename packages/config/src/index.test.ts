import assert from "node:assert/strict";
import test from "node:test";
import { loadApiConfig } from "./index.js";

const env = {
  ORCHESTRAT_DATABASE_URL: "postgres://localhost/orchestrat",
  ORCHESTRAT_SUPABASE_JWT_ALGORITHM: "ES256",
  ORCHESTRAT_SUPABASE_JWT_AUDIENCE: "authenticated",
  ORCHESTRAT_SUPABASE_URL: "https://example.supabase.co"
};

test("defaults to dedicated local ports and rejects invalid TCP ports", () => {
  const config = loadApiConfig(env);
  assert.equal(config.ORCHESTRAT_API_PORT, 8801);
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

test("loads Supabase human JWT configuration independently from CORS", () => {
  const config = loadApiConfig({
    ...env,
    ORCHESTRAT_ALLOWED_ORIGINS: "https://one.example, https://two.example"
  });
  assert.equal(config.ORCHESTRAT_SUPABASE_URL, env.ORCHESTRAT_SUPABASE_URL);
  assert.equal(config.ORCHESTRAT_SUPABASE_JWT_AUDIENCE, "authenticated");
  assert.equal(config.ORCHESTRAT_SUPABASE_JWT_ALGORITHM, "ES256");
  assert.deepEqual(config.ORCHESTRAT_ALLOWED_ORIGINS, [
    "https://one.example",
    "https://two.example"
  ]);
});

test("rejects unsupported Supabase JWT algorithms", () => {
  assert.throws(() =>
    loadApiConfig({ ...env, ORCHESTRAT_SUPABASE_JWT_ALGORITHM: "HS256" })
  );
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
