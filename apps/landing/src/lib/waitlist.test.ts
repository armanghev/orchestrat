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

test("validates emails and writes normalized values to Supabase", async () => {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.SUPABASE_URL;
  const originalKey = process.env.SUPABASE_PUBLISHABLE_KEY;
  let sent: RequestInit | undefined;

  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_PUBLISHABLE_KEY = "sb_publishable_test";
  globalThis.fetch = async (_input, init) => {
    sent = init;
    return new Response(null, { status: 201 });
  };

  try {
    const invalid = await POST(request("not-an-email"));
    assert.equal(
      invalid.headers.get("location"),
      "https://landing.test/?waitlist=invalid#waitlist"
    );

    const joined = await POST(request("  Dev@Example.COM "));
    assert.equal(
      joined.headers.get("location"),
      "https://landing.test/?waitlist=joined#waitlist"
    );
    assert.equal(sent?.body, JSON.stringify({ email: "dev@example.com" }));

    const accepted = await POST(request("dev@example.com", "", true));
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), { status: "joined" });
    globalThis.fetch = async () => new Response(null, { status: 409 });
    assert.deepEqual(
      await (await POST(request("dev@example.com", "", true))).json(),
      { status: "joined" }
    );
    const invalidJson = await POST(request("invalid", "", true));
    assert.equal(invalidJson.status, 400);
    assert.deepEqual(await invalidJson.json(), { status: "invalid" });
    delete process.env.SUPABASE_URL;
    const unavailable = await POST(request("dev@example.com", "", true));
    assert.equal(unavailable.status, 503);
    assert.deepEqual(await unavailable.json(), { status: "unavailable" });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = originalUrl;
    if (originalKey === undefined) delete process.env.SUPABASE_PUBLISHABLE_KEY;
    else process.env.SUPABASE_PUBLISHABLE_KEY = originalKey;
  }
});
