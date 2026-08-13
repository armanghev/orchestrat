import assert from "node:assert/strict";
import test from "node:test";
import { POST } from "../app/api/waitlist/route";

function request(email: string, company = "") {
  const formData = new FormData();
  formData.set("email", email);
  formData.set("company", company);

  return new Request("https://landing.test/api/waitlist", {
    body: formData,
    method: "POST"
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
  } finally {
    globalThis.fetch = originalFetch;
    process.env.SUPABASE_URL = originalUrl;
    process.env.SUPABASE_PUBLISHABLE_KEY = originalKey;
  }
});
