import assert from "node:assert/strict";
import test from "node:test";
import { POST } from "../app/api/waitlist/route";

function request(email: string, company = "", json = false) {
  const formData = new FormData();
  formData.set("email", email);
  formData.set("company", company);

  return new Request("https://landing.test/api/waitlist", {
    body: formData,
    method: "POST",
    headers: json ? { Accept: "application/json" } : undefined
  });
}

test("validates signups and welcomes only newly saved waitlist members", async (t) => {
  const envKeys = [
    "SUPABASE_URL",
    "SUPABASE_PUBLISHABLE_KEY",
    "RESEND_API_KEY"
  ];
  const originalEnv = envKeys.map((key) => [key, process.env[key]] as const);
  t.after(() => {
    for (const [key, value] of originalEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  let calls: { url: string; init?: RequestInit }[] = [];
  let databaseResult: number | Error = 201;
  let emailResult: number | Error = 200;
  const errors = t.mock.method(console, "error", () => {});

  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_PUBLISHABLE_KEY = "sb_publishable_test";
  process.env.RESEND_API_KEY = "re_test";
  t.mock.method(
    globalThis,
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      const isDatabase =
        url === "https://example.supabase.co/rest/v1/orchestrat";
      if (!isDatabase) assert.equal(url, "https://api.resend.com/emails");
      const result = isDatabase ? databaseResult : emailResult;
      if (result instanceof Error) throw result;
      return new Response(null, { status: result });
    }
  );

  const invalid = await POST(request("not-an-email"));
  assert.equal(
    invalid.headers.get("location"),
    "https://landing.test/?waitlist=invalid#waitlist"
  );
  const invalidJson = await POST(request("invalid", "", true));
  assert.equal(invalidJson.status, 400);
  assert.deepEqual(await invalidJson.json(), { status: "invalid" });
  assert.equal(
    (await POST(request(`${"a".repeat(250)}@example.com`, "", true))).status,
    400
  );
  const honeypot = await POST(request("dev@example.com", "Bot Inc", true));
  assert.deepEqual(await honeypot.json(), { status: "joined" });
  assert.equal(calls.length, 0);

  const joined = await POST(request("  Dev@Example.COM "));
  assert.equal(
    joined.headers.get("location"),
    "https://landing.test/?waitlist=joined#waitlist"
  );
  assert.deepEqual(
    calls.map(({ url }) => url),
    [
      "https://example.supabase.co/rest/v1/orchestrat",
      "https://api.resend.com/emails"
    ]
  );
  assert.equal(
    calls[0]?.init?.body,
    JSON.stringify({ email: "dev@example.com" })
  );
  const sent = calls[1]?.init;
  assert.equal(sent?.method, "POST");
  assert.equal(
    new Headers(sent?.headers).get("Authorization"),
    "Bearer re_test"
  );
  const message = JSON.parse(String(sent?.body));
  assert.equal(message.from, "Orchestrat <welcome@orchestrat.dev>");
  assert.deepEqual(message.to, ["dev@example.com"]);
  assert.match(message.subject, /Orchestrat waitlist/);
  assert.match(message.text, /Your place is saved/);
  assert.match(message.html, /Your place is saved/);
  assert.match(
    message.html,
    /<img src="https:\/\/orchestrat\.dev\/favicon-96x96\.png"[^>]+alt="Orchestrat logo"/
  );
  assert.match(message.html, /href="https:\/\/orchestrat\.dev"/);
  assert.ok(sent?.signal instanceof AbortSignal);

  calls = [];
  databaseResult = 409;
  const duplicate = await POST(request("dev@example.com", "", true));
  assert.equal(duplicate.status, 200);
  assert.deepEqual(await duplicate.json(), { status: "joined" });
  assert.equal(
    calls.length,
    1,
    "duplicate signups must not send another email"
  );

  for (databaseResult of [500, new TypeError("Database unavailable")]) {
    calls = [];
    const failed = await POST(request("dev@example.com", "", true));
    assert.equal(failed.status, 503);
    assert.deepEqual(await failed.json(), { status: "error" });
    assert.equal(calls.length, 1, "failed inserts must not send an email");
  }

  databaseResult = 201;
  for (emailResult of [
    200,
    429,
    500,
    new TypeError("Resend unavailable"),
    new DOMException("Timed out", "TimeoutError")
  ]) {
    calls = [];
    const accepted = await POST(request("dev@example.com", "", true));
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), { status: "joined" });
    assert.equal(calls.length, 2);
  }

  calls = [];
  delete process.env.RESEND_API_KEY;
  const withoutEmail = await POST(request("dev@example.com", "", true));
  assert.equal(withoutEmail.status, 200);
  assert.deepEqual(await withoutEmail.json(), { status: "joined" });
  assert.equal(calls.length, 1);
  assert.equal(
    errors.mock.callCount(),
    7,
    "delivery and insert failures are logged"
  );

  calls = [];
  delete process.env.SUPABASE_URL;
  const unavailable = await POST(request("dev@example.com", "", true));
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), { status: "unavailable" });
  assert.equal(calls.length, 0);
});
