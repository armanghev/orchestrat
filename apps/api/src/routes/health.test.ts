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
