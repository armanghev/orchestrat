import assert from "node:assert/strict";
import { createConnection } from "node:net";
import test from "node:test";
import { createSupabaseAuth } from "@orchestrat/auth";
import type { Database } from "@orchestrat/db";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { buildApp } from "../app.js";

async function rawRequest(
  port: number,
  authorizationValues: string[]
): Promise<{ body: string; statusCode: number }> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let response = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(
        [
          "GET /api/v1/organizations HTTP/1.1",
          `Host: 127.0.0.1:${port}`,
          ...authorizationValues.map((value) => `Authorization: ${value}`),
          "Connection: close",
          "",
          ""
        ].join("\r\n")
      );
    });
    socket.on("data", (chunk) => {
      response += chunk;
    });
    socket.on("end", () => {
      const [head, body = ""] = response.split("\r\n\r\n", 2);
      const statusCode = Number(head?.split(" ")[1]);
      resolve({ body, statusCode });
    });
    socket.on("error", reject);
  });
}

test("rejects duplicate Authorization lines at the Fastify boundary", async () => {
  const { privateKey, publicKey } = await generateKeyPair("ES256");
  const jwk = await exportJWK(publicKey);
  jwk.alg = "ES256";
  jwk.kid = "duplicate-test-key";
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({
    aud: "authenticated",
    email: "alice@example.com",
    exp: now + 300,
    iat: now,
    iss: "https://example.supabase.co/auth/v1",
    role: "authenticated",
    sub: "550e8400-e29b-41d4-a716-446655440000"
  })
    .setProtectedHeader({ alg: "ES256", kid: "duplicate-test-key" })
    .sign(privateKey);
  const localKeys = createLocalJWKSet({ keys: [jwk] });
  let keyResolutions = 0;
  const auth = createSupabaseAuth(
    {
      algorithm: "ES256",
      audience: "authenticated",
      supabaseUrl: "https://example.supabase.co"
    },
    {
      keyResolver: async (...args) => {
        keyResolutions += 1;
        return localKeys(...args);
      }
    }
  );
  const app = buildApp({ allowedOrigins: [], auth, db: {} as Database });
  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    assert.ok(address && typeof address === "object");
    const response = await rawRequest(address.port, [
      `Bearer ${token}`,
      "Bearer duplicate.second.token"
    ]);
    assert.equal(response.statusCode, 401, response.body);
    assert.equal(JSON.parse(response.body).error.code, "UNAUTHENTICATED");
    assert.equal(keyResolutions, 0);
  } finally {
    await app.close();
  }
});

test("returns 401 for a signed JWT with unsupported protected headers", async () => {
  const { privateKey, publicKey } = await generateKeyPair("ES256");
  const jwk = await exportJWK(publicKey);
  jwk.alg = "ES256";
  jwk.kid = "test-key";
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({
    aud: "authenticated",
    email: "alice@example.com",
    exp: now + 300,
    iat: now,
    iss: "https://example.supabase.co/auth/v1",
    role: "authenticated",
    sub: "550e8400-e29b-41d4-a716-446655440000"
  })
    .setProtectedHeader({
      alg: "ES256",
      crit: ["foo"],
      foo: "unsupported",
      kid: "test-key"
    })
    .sign(privateKey, { crit: { foo: true } });
  const auth = createSupabaseAuth(
    {
      algorithm: "ES256",
      audience: "authenticated",
      supabaseUrl: "https://example.supabase.co"
    },
    { keyResolver: createLocalJWKSet({ keys: [jwk] }) }
  );
  const app = buildApp({ allowedOrigins: [], auth, db: {} as Database });
  try {
    const response = await app.inject({
      headers: { authorization: `Bearer ${token}` },
      method: "GET",
      url: "/api/v1/organizations"
    });
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().error.code, "UNAUTHENTICATED");
  } finally {
    await app.close();
  }
});
