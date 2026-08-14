import assert from "node:assert/strict";
import test from "node:test";
import { createClerkAuth } from "./index.js";

const options = {
  authorizedParties: ["https://app.orchestrat.dev"],
  publishableKey: "pk_test_example",
  secretKey: "sk_test_example"
};

test("accepts session and OAuth tokens as human identities", async () => {
  const received: unknown[] = [];
  const states = [
    {
      isAuthenticated: true,
      toAuth: () => ({ tokenType: "session_token", userId: "user_session" })
    },
    {
      isAuthenticated: true,
      toAuth: () => ({
        clientId: "oauth_application_desktop",
        tokenType: "oauth_token",
        userId: "user_oauth"
      })
    },
    { isAuthenticated: false }
  ];
  const clerk = {
    authenticateRequest: async (_request: Request, requestOptions: unknown) => {
      received.push(requestOptions);
      return states.shift();
    },
    users: { getUser: async () => { throw new Error("Not used in this test"); } }
  };
  const auth = createClerkAuth(options, clerk as never);
  const request = {
    headers: { authorization: "Bearer test" },
    method: "GET",
    url: "https://api.orchestrat.dev/api/v1/organizations"
  };

  assert.equal(await auth.authenticate(request), "user_session");
  assert.equal(await auth.authenticate(request), "user_oauth");
  assert.equal(await auth.authenticate(request), null);
  assert.deepEqual(received, [
    {
      acceptsToken: ["session_token", "oauth_token"],
      authorizedParties: options.authorizedParties
    },
    {
      acceptsToken: ["session_token", "oauth_token"],
      authorizedParties: options.authorizedParties
    },
    {
      acceptsToken: ["session_token", "oauth_token"],
      authorizedParties: options.authorizedParties
    }
  ]);
});
