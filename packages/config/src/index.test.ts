import assert from "node:assert/strict";
import test from "node:test";
import { loadApiConfig } from "./index.js";

const env = {
  ORCHESTRAT_DATABASE_URL: "postgres://localhost/orchestrat",
  ORCHESTRAT_SUPABASE_JWT_ALGORITHM: "ES256",
  ORCHESTRAT_SUPABASE_JWT_AUDIENCE: "authenticated",
  ORCHESTRAT_SUPABASE_URL: "https://example.supabase.co"
};

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
