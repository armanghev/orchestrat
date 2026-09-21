import assert from "node:assert/strict";
import test from "node:test";
import { FixedWindowRateLimit } from "./rate-limit.js";
import { fixture } from "../test/fixture.js";

test("rate limits by identity, resets windows, and bounds tracked identities", () => {
  let now = 0;
  const limiter = new FixedWindowRateLimit(2, 1_000, 2, () => now);

  assert.equal(limiter.check("one"), null);
  assert.equal(limiter.check("one"), null);
  assert.equal(limiter.check("one"), 1);
  assert.equal(limiter.check("two"), null);
  assert.equal(limiter.check("three"), 1);

  now = 1_000;
  assert.equal(limiter.check("three"), null);
});

test("public CLI authorization ignores spoofed forwarding headers by default", async () => {
  const { app } = await fixture({
    rateLimits: { publicCliCreate: 1 }
  });
  try {
    const first = await app.inject({
      headers: { "x-forwarded-for": "198.51.100.1" },
      method: "POST",
      remoteAddress: "10.0.0.1",
      url: "/api/v1/cli/authorization/attempts"
    });
    assert.equal(first.statusCode, 201);
    const limited = await app.inject({
      headers: { "x-forwarded-for": "198.51.100.2" },
      method: "POST",
      remoteAddress: "10.0.0.1",
      url: "/api/v1/cli/authorization/attempts"
    });
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.headers["retry-after"], "60");
    assert.equal(limited.json().error.code, "RATE_LIMITED");
    assert.equal(limited.json().error.details.retry_after_seconds, 60);
  } finally {
    await app.close();
  }
});

test("public CLI authorization separates clients behind an explicitly trusted proxy", async () => {
  const { app } = await fixture({
    rateLimits: { publicCliCreate: 1 },
    trustProxyHops: 1
  });
  try {
    for (const client of ["198.51.100.1", "198.51.100.2"]) {
      const response = await app.inject({
        headers: { "x-forwarded-for": client },
        method: "POST",
        remoteAddress: "10.0.0.1",
        url: "/api/v1/cli/authorization/attempts"
      });
      assert.equal(response.statusCode, 201);
    }
  } finally {
    await app.close();
  }
});

test("expensive limits use authenticated identities and do not cover heartbeats", async () => {
  const { app } = await fixture({ rateLimits: { expensive: 1 } });
  try {
    const expensiveRequest = (user: string) =>
      app.inject({
        headers: { authorization: `Bearer ${user}` },
        method: "POST",
        url: "/api/v1/documents/not-a-uuid/attachments/not-a-uuid/download"
      });
    assert.equal((await expensiveRequest("alice")).statusCode, 400);
    assert.equal((await expensiveRequest("alice")).statusCode, 429);
    assert.equal((await expensiveRequest("bob")).statusCode, 400);

    const organization = (
      await app.inject({
        headers: { authorization: "Bearer alice" },
        method: "POST",
        payload: { name: "Rate limit heartbeat" },
        url: "/api/v1/organizations"
      })
    ).json();
    const project = (
      await app.inject({
        headers: { authorization: "Bearer alice" },
        method: "POST",
        payload: { name: "Heartbeat" },
        url: `/api/v1/organizations/${organization.id}/projects`
      })
    ).json();
    const agent = (
      await app.inject({
        headers: { authorization: "Bearer alice" },
        method: "POST",
        payload: { name: "heartbeat-agent" },
        url: `/api/v1/projects/${project.id}/agents`
      })
    ).json();
    const credential = (
      await app.inject({
        headers: { authorization: "Bearer alice" },
        method: "POST",
        url: `/api/v1/projects/${project.id}/agents/${agent.id}/credentials`
      })
    ).json();
    const agentHeaders = { authorization: `Bearer ${credential.token}` };
    const session = (
      await app.inject({
        headers: agentHeaders,
        method: "POST",
        payload: { integration: "test", runtime: "test" },
        url: "/api/v1/agent/sessions"
      })
    ).json().session;
    for (let count = 0; count < 2; count += 1) {
      const heartbeat = await app.inject({
        headers: agentHeaders,
        method: "POST",
        url: `/api/v1/agent/sessions/${session.id}/heartbeat`
      });
      assert.equal(heartbeat.statusCode, 200);
    }
  } finally {
    await app.close();
  }
});
