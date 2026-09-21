import assert from "node:assert/strict";
import test from "node:test";
import type { Database } from "@orchestrat/db";
import { buildApp } from "../app.js";

test("GET /health returns the service status", async () => {
  const app = buildApp({
    allowedOrigins: [],
    auth: {
      authenticate: async () => null
    },
    db: {} as Database
  });
  const response = await app.inject({ method: "GET", url: "/health" });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: "ok" });
  await app.close();
});

test("GET /ready reports database readiness without changing liveness", async () => {
  let ready = true;
  const app = buildApp({
    allowedOrigins: [],
    auth: { authenticate: async () => null },
    checkDatabase: async () => {
      if (!ready) throw new Error("unavailable");
    },
    db: {} as Database
  });
  try {
    const response = await app.inject({ method: "GET", url: "/ready" });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { status: "ready" });

    ready = false;
    const unavailable = await app.inject({ method: "GET", url: "/ready" });
    assert.equal(unavailable.statusCode, 503);
    assert.deepEqual(unavailable.json(), { status: "not_ready" });
    assert.equal(
      (await app.inject({ method: "GET", url: "/health" })).statusCode,
      200
    );
  } finally {
    await app.close();
  }
});
