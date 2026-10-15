import { expect, test, type Page, type Route } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

// These specs run the real password client (not the e2e stub) against
// mocked /api/v1/auth routes.
const api = "https://api.orchestrat.test/api/v1";
const userId = "00000000-0000-4000-8000-000000000007";

type AuthCall = {
  path: string;
  body: Record<string, unknown> | null;
  authorization: string | undefined;
};

async function seedPasswordClient(page: Page) {
  await page.addInitScript(() => {
    if (sessionStorage.getItem("orchestrat.e2e.seeded")) return;
    localStorage.clear();
    localStorage.setItem("orchestrat.e2e.auth", "password");
    sessionStorage.setItem("orchestrat.e2e.seeded", "true");
  });
}

function session(n: number) {
  return {
    // The signed-in mock below accepts only this token.
    access_token: n === 1 ? "e2e-session-token" : "e2e-refreshed-token",
    refresh_token: `orch_refresh_e2e_${n}`,
    token_type: "Bearer",
    expires_in: 3600,
    refresh_expires_in: 2_592_000,
    user: {
      user_id: userId,
      email: "ada@example.com",
      full_name: "Ada Lovelace",
      is_instance_admin: true
    }
  };
}

function apiError(route: Route, status: number, code: string, details = {}) {
  return route.fulfill({
    status,
    json: { error: { code, message: code, details, request_id: "e2e" } }
  });
}

// Signed-in API calls for an account with no organizations yet.
async function mockEmptyWorkspace(page: Page) {
  await page.route(`${api}/**`, (route) => {
    expect(route.request().headers().authorization).toBe(
      "Bearer e2e-session-token"
    );
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/v1/organizations")
      return route.fulfill({ json: { organizations: [] } });
    if (path === "/api/v1/profile")
      return route.fulfill({
        json: {
          user_id: userId,
          provider: "local",
          username: "ada",
          full_name: "Ada Lovelace",
          email: "ada@example.com",
          avatar_url: null,
          is_instance_admin: true
        }
      });
    if (path === "/api/v1/preferences")
      return route.fulfill({ json: { preferences: {} } });
    return route.fulfill({ json: {} });
  });
}

// Registered after the workspace mock, so these take precedence.
async function mockAuth(
  page: Page,
  handlers: Record<
    string,
    (route: Route, body: Record<string, unknown> | null) => Promise<void>
  >
) {
  const calls: AuthCall[] = [];
  await page.route(`${api}/auth/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/api/v1", "");
    const body = request.postData()
      ? (JSON.parse(request.postData()!) as Record<string, unknown>)
      : null;
    calls.push({ path, body, authorization: request.headers().authorization });
    const handler = handlers[`${request.method()} ${path}`];
    if (handler) return handler(route, body);
    return apiError(route, 404, "NOT_FOUND");
  });
  return calls;
}

async function expectNoAxe(page: Page) {
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
}

test("@auth signs in through the password form, then signs out with revoke", async ({
  page
}) => {
  await seedPasswordClient(page);
  await mockEmptyWorkspace(page);
  let logins = 0;
  const calls = await mockAuth(page, {
    "GET /auth/instance": (route) =>
      route.fulfill({ json: { needs_setup: false, signup_mode: "invite" } }),
    "POST /auth/login": (route) => {
      logins += 1;
      if (logins === 1) return apiError(route, 401, "INVALID_CREDENTIALS");
      if (logins === 2)
        return apiError(route, 429, "RATE_LIMITED", {
          retry_after_seconds: 30
        });
      return route.fulfill({ status: 200, json: session(1) });
    },
    "POST /auth/password": (route, body) =>
      body?.current_password === "correct horse battery"
        ? route.fulfill({ status: 204, body: "" })
        : apiError(route, 403, "PASSWORD_INCORRECT"),
    "POST /auth/revoke": (route) => route.fulfill({ status: 204, body: "" })
  });

  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Sign in to Orchestrat" })
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Create an account" })
  ).toHaveAttribute("href", "/signup");
  await expectNoAxe(page);

  await page.getByLabel("Email").fill("Ada@Example.com");
  await page.getByLabel("Password").fill("not my password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "Email or password is incorrect."
  );
  await expectNoAxe(page);

  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "Too many sign-in attempts. Try again in 30 seconds."
  );

  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(
    page.getByRole("heading", { name: "Create your organization" })
  ).toBeVisible();
  expect(calls.filter((call) => call.path === "/auth/login").at(-1)).toEqual({
    path: "/auth/login",
    body: { email: "ada@example.com", password: "correct horse battery" },
    authorization: undefined
  });
  const stored = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("orchestrat.auth.session.v1") ?? "null")
  );
  expect(stored).toMatchObject({
    version: 1,
    access_token: "e2e-session-token",
    refresh_token: "orch_refresh_e2e_1",
    user: { user_id: userId }
  });

  // Reload restores the session without signing in again.
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Create your organization" })
  ).toBeVisible();
  expect(logins).toBe(3);

  await page.goto("/profile");
  await expect(
    page.getByRole("heading", { name: "Profile", exact: true })
  ).toBeVisible();
  await expect(page.getByText("Admin of this Orchestrat server")).toBeVisible();
  await page.getByLabel("Current password").fill("wrong current password");
  await page
    .getByLabel("New password", { exact: true })
    .fill("a brand new password");
  await page.getByLabel("Confirm new password").fill("a brand new password");
  await page.getByRole("button", { name: "Change password" }).click();
  await expect(
    page.getByText("Your current password is incorrect.")
  ).toBeVisible();
  await page.getByLabel("Current password").fill("correct horse battery");
  await page.getByRole("button", { name: "Change password" }).click();
  await expect(page.getByRole("status")).toHaveText(
    "Password changed. Your other sessions were signed out."
  );
  expect(calls.filter((call) => call.path === "/auth/password").at(-1)).toEqual(
    {
      path: "/auth/password",
      body: {
        current_password: "correct horse battery",
        new_password: "a brand new password"
      },
      authorization: "Bearer e2e-session-token"
    }
  );
  await expectNoAxe(page);

  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Sign in to Orchestrat" })
  ).toBeVisible();
  expect(calls.find((call) => call.path === "/auth/revoke")).toEqual({
    path: "/auth/revoke",
    body: { refresh_token: "orch_refresh_e2e_1" },
    authorization: undefined
  });
  expect(
    await page.evaluate(() =>
      localStorage.getItem("orchestrat.auth.session.v1")
    )
  ).toBeNull();
});

test("@auth first-run setup creates the admin account with the setup token", async ({
  page
}) => {
  await seedPasswordClient(page);
  await mockEmptyWorkspace(page);
  let needsSetup = true;
  const calls = await mockAuth(page, {
    "GET /auth/instance": (route) =>
      route.fulfill({
        json: { needs_setup: needsSetup, signup_mode: "invite" }
      }),
    "POST /auth/signup": (route, body) => {
      if (body?.setup_token !== "tok_from_server_log")
        return apiError(route, 403, "SETUP_TOKEN_REQUIRED");
      needsSetup = false;
      return route.fulfill({
        status: 201,
        json: { ...session(1), invited_project_id: null }
      });
    }
  });

  await page.goto("/?setup_token=wrong_token");
  await expect(
    page.getByRole("heading", { name: "Set up this Orchestrat server" })
  ).toBeVisible();
  await expect(page.getByLabel("Setup token")).toHaveValue("wrong_token");
  await expectNoAxe(page);

  await page.getByLabel("Name").fill("Ada Lovelace");
  await page.getByLabel("Email").fill("ada@example.com");
  await page.getByLabel("Password", { exact: true }).fill("short");
  await page.getByLabel("Confirm password").fill("different");
  await page.getByRole("button", { name: "Create admin account" }).click();
  await expect(page.getByText("Use at least 10 characters.")).toBeVisible();
  await expect(page.getByText("The passwords don't match.")).toBeVisible();
  await expectNoAxe(page);

  await page
    .getByLabel("Password", { exact: true })
    .fill("correct horse battery");
  await page.getByLabel("Confirm password").fill("correct horse battery");
  await page.getByRole("button", { name: "Create admin account" }).click();
  await expect(
    page.getByText(
      "This setup token is missing or wrong. Copy it from the server log."
    )
  ).toBeVisible();
  await expect(page.getByLabel("Setup token")).toBeFocused();

  await page.getByLabel("Setup token").fill("tok_from_server_log");
  await page.getByRole("button", { name: "Create admin account" }).click();
  await expect(
    page.getByRole("heading", { name: "Create your organization" })
  ).toBeVisible();
  expect(calls.filter((call) => call.path === "/auth/signup").at(-1)).toEqual({
    path: "/auth/signup",
    body: {
      email: "ada@example.com",
      password: "correct horse battery",
      full_name: "Ada Lovelace",
      setup_token: "tok_from_server_log"
    },
    authorization: undefined
  });
  expect(new URL(page.url()).searchParams.get("setup_token")).toBeNull();
});
