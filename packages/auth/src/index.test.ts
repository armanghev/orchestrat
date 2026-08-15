import assert from "node:assert/strict";
import test from "node:test";
import {
  createLocalJWKSet,
  errors,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWK
} from "jose";
import {
  AuthInfrastructureError,
  createSupabaseAuth,
  type AuthRequest
} from "./index.js";

const baseUrl = "https://example.supabase.co";
const issuer = `${baseUrl}/auth/v1`;
const subject = "550e8400-e29b-41d4-a716-446655440000";
const now = Math.floor(Date.now() / 1000);
const options = {
  algorithm: "ES256" as const,
  audience: "authenticated",
  supabaseUrl: baseUrl
};

const ec = await generateKeyPair("ES256");
const otherEc = await generateKeyPair("ES256");
const rsa = await generateKeyPair("RS256");
const publicJwks: JWK[] = await Promise.all([
  exportJWK(ec.publicKey),
  exportJWK(rsa.publicKey)
]);
publicJwks[0]!.kid = "ec-key";
publicJwks[0]!.alg = "ES256";
publicJwks[1]!.kid = "rsa-key";
publicJwks[1]!.alg = "RS256";
const localKeys = createLocalJWKSet({ keys: publicJwks });

const request = (authorization?: string): AuthRequest => ({
  headers: authorization === undefined ? {} : { authorization },
  method: "GET",
  url: "https://api.orchestrat.dev/api/v1/organizations"
});

async function token(
  overrides: Record<string, unknown> = {},
  signing: { algorithm?: "ES256" | "RS256"; key?: CryptoKey; kid?: string } = {}
) {
  const algorithm = signing.algorithm ?? "ES256";
  const key = signing.key ?? ec.privateKey;
  const kid = signing.kid ?? "ec-key";
  return new SignJWT({
    aud: options.audience,
    email: "  ALICE@Example.COM ",
    exp: now + 300,
    iat: now,
    iss: issuer,
    role: "authenticated",
    sub: subject,
    user_metadata: {
      avatar_url: "https://cdn.example.com/alice.png",
      full_name: "  Alice Example  "
    },
    ...overrides
  })
    .setProtectedHeader({ alg: algorithm, kid, typ: "JWT" })
    .sign(key);
}

const auth = () => createSupabaseAuth(options, { keyResolver: localKeys });

test("returns a normalized Supabase principal for a valid signed JWT", async () => {
  assert.deepEqual(
    await auth().authenticate(request(`Bearer ${await token()}`)),
    {
      authSubject: subject,
      avatarUrl: "https://cdn.example.com/alice.png",
      email: "alice@example.com",
      name: "Alice Example",
      provider: "supabase"
    }
  );
});

test("accepts RS256 when it is the single configured algorithm", async () => {
  const rsaAuth = createSupabaseAuth(
    { ...options, algorithm: "RS256" },
    { keyResolver: localKeys }
  );
  const value = await token(
    {},
    { algorithm: "RS256", key: rsa.privateKey, kid: "rsa-key" }
  );
  assert.equal(
    (await rsaAuth.authenticate(request(`Bearer ${value}`)))?.provider,
    "supabase"
  );
});

test("derives and caches the remote Supabase JWKS", async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = async (input) => {
    requests.push(String(input));
    return new Response(JSON.stringify({ keys: [publicJwks[0]] }), {
      headers: { "content-type": "application/json" },
      status: 200
    });
  };
  try {
    const remoteAuth = createSupabaseAuth(options);
    const value = await token();
    assert.ok(await remoteAuth.authenticate(request(`Bearer ${value}`)));
    assert.ok(await remoteAuth.authenticate(request(`Bearer ${value}`)));
    assert.deepEqual(requests, [`${baseUrl}/auth/v1/.well-known/jwks.json`]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("requires one exact Bearer token", async () => {
  for (const header of [
    undefined,
    "",
    "bearer token",
    "Bearer",
    "Bearer  token",
    "Bearer token extra",
    " Basic token",
    "Bearer token "
  ]) {
    assert.equal(await auth().authenticate(request(header)), null, header);
  }
});

test("rejects whitespace, casing, arrays, and duplicate bearer headers", async () => {
  let keyResolutions = 0;
  const strictAuth = createSupabaseAuth(options, {
    keyResolver: async (...args) => {
      keyResolutions += 1;
      return localKeys(...args);
    }
  });
  const value = await token();
  for (const authorization of [
    ` Bearer ${value}`,
    `Bearer ${value} `,
    `Bearer\t${value}`,
    `bearer ${value}`
  ]) {
    assert.equal(
      await strictAuth.authenticate(request(authorization)),
      null,
      authorization
    );
  }

  await assert.doesNotReject(async () => {
    assert.equal(
      await strictAuth.authenticate({
        ...request(),
        headers: { authorization: [`Bearer ${value}`] }
      }),
      null
    );
  });
  assert.equal(
    await strictAuth.authenticate({
      ...request(),
      headers: [
        ["authorization", `Bearer ${value}`],
        ["Authorization", `Bearer ${value}`]
      ]
    }),
    null
  );
  assert.equal(keyResolutions, 0);
});

test("rejects an avatar URL whose canonical form exceeds the bound", async () => {
  const rawAvatar = `https://example.com/${"é".repeat(680)}`;
  assert.ok(rawAvatar.length < 2048);
  const value = await token({
    user_metadata: { avatar_url: rawAvatar, full_name: "Alice" }
  });
  const result = await auth().authenticate(request(`Bearer ${value}`));
  assert.ok(result);
  assert.equal(result.avatarUrl, null);
});

test("rejects invalid signature, issuer, audience, and algorithm", async () => {
  const cases = [
    await token({}, { key: otherEc.privateKey }),
    await token({ iss: "https://attacker.example/auth/v1" }),
    await token({ aud: "another-audience" }),
    await token({}, { algorithm: "RS256", key: rsa.privateKey, kid: "rsa-key" })
  ];
  for (const value of cases) {
    assert.equal(await auth().authenticate(request(`Bearer ${value}`)), null);
  }
});

test("rejects expired, not-yet-valid, and future-issued JWTs", async () => {
  for (const claims of [
    { exp: now - 60 },
    { nbf: now + 300 },
    { iat: now + 300 }
  ]) {
    assert.equal(
      await auth().authenticate(request(`Bearer ${await token(claims)}`)),
      null
    );
  }
});

test("requires a UUID subject and authenticated role", async () => {
  for (const claims of [
    { sub: undefined },
    { sub: "not-a-uuid" },
    { role: "service_role" },
    { role: undefined }
  ]) {
    assert.equal(
      await auth().authenticate(request(`Bearer ${await token(claims)}`)),
      null
    );
  }
});

test("requires a normalized, bounded email", async () => {
  for (const email of [
    undefined,
    "not-an-email",
    `${"a".repeat(310)}@example.com`
  ]) {
    assert.equal(
      await auth().authenticate(request(`Bearer ${await token({ email })}`)),
      null
    );
  }
});

test("bounds optional profile claims and ignores unsafe avatar URLs", async () => {
  const longName = `  ${"x".repeat(250)}  `;
  const principal = await auth().authenticate(
    request(
      `Bearer ${await token({
        user_metadata: {
          avatar_url: `https://example.com/${"a".repeat(2100)}`,
          full_name: longName
        }
      })}`
    )
  );
  assert.equal(principal?.name, "x".repeat(200));
  assert.equal(principal?.avatarUrl, null);

  const unsafe = await auth().authenticate(
    request(
      `Bearer ${await token({
        user_metadata: { avatar_url: "javascript:alert(1)", name: "  " }
      })}`
    )
  );
  assert.equal(unsafe?.name, null);
  assert.equal(unsafe?.avatarUrl, null);
});

test("treats an unknown kid as invalid credentials", async () => {
  const value = await token({}, { kid: "unknown" });
  assert.equal(await auth().authenticate(request(`Bearer ${value}`)), null);
});

test("distinguishes key infrastructure failures from invalid credentials", async () => {
  for (const failure of [
    new Error("network details that must not become a principal"),
    new errors.JWKSInvalid("invalid remote response details")
  ]) {
    const failing = createSupabaseAuth(options, {
      keyResolver: async () => {
        throw failure;
      }
    });
    await assert.rejects(
      failing.authenticate(request(`Bearer ${await token()}`)),
      AuthInfrastructureError
    );
  }
});

test("validates the Supabase URL and configured asymmetric algorithm", () => {
  for (const invalid of [
    { ...options, algorithm: "HS256" },
    { ...options, supabaseUrl: "not a URL" },
    { ...options, supabaseUrl: "https://example.supabase.co/project" },
    { ...options, supabaseUrl: "http://example.supabase.co" }
  ]) {
    assert.throws(() => createSupabaseAuth(invalid as never));
  }
  assert.doesNotThrow(() =>
    createSupabaseAuth({ ...options, algorithm: "RS256" })
  );
});
