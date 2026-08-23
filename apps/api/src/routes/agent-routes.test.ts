import assert from "node:assert/strict";
import test from "node:test";
import type { HumanAuth } from "@orchestrat/auth";
import type { Database } from "@orchestrat/db";
import { buildApp } from "../app.js";

const appWithAuthSpy = () => {
  let humanAuthCalls = 0;
  const auth: HumanAuth = {
    async authenticate() {
      humanAuthCalls += 1;
      return null;
    }
  };
  return {
    app: buildApp({ allowedOrigins: [], auth, db: {} as Database }),
    calls: () => humanAuthCalls
  };
};

test("agent routes reject missing, malformed, and unprefixed credentials", async () => {
  const { app, calls } = appWithAuthSpy();
  try {
    for (const authorization of [
      undefined,
      "Basic abc",
      "Bearer human-token"
    ]) {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/agent/tasks",
        ...(authorization ? { headers: { authorization } } : {})
      });
      assert.equal(response.statusCode, 401);
      assert.equal(response.json().error.code, "AGENT_CREDENTIAL_INVALID");
    }
    const duplicate = await app.inject({
      method: "GET",
      url: "/api/v1/agent/tasks",
      headers: {
        authorization: ["Bearer orch_agent_one", "Bearer orch_agent_two"] as any
      }
    } as any);
    assert.equal(duplicate.statusCode, 401);
    assert.equal(duplicate.json().error.code, "AGENT_CREDENTIAL_INVALID");
    assert.equal(calls(), 0);
  } finally {
    await app.close();
  }
});

test("agent credentials never fall through to human authentication", async () => {
  const { app, calls } = appWithAuthSpy();
  try {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/organizations",
      headers: { authorization: "Bearer orch_agent_not-a-valid-token" }
    });
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().error.code, "AGENT_CREDENTIAL_INVALID");
    assert.equal(calls(), 0);
  } finally {
    await app.close();
  }
});
