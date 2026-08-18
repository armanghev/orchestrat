import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiClient,
  DashboardApiError,
  type ApiTokenSource
} from "@/lib/api/client";
import { DesktopAuthClient } from "@/features/auth/desktop-auth-client";
import { organization, project, workspace } from "@/test/factories";
import { handlers } from "@/test/handlers";
import { server } from "@/test/msw-server";

const apiUrl = "http://localhost:3001";

function authTokenFixture(tokens: Array<string | null>): ApiTokenSource {
  return {
    getAccessToken: vi.fn(async () => tokens.shift() ?? null),
    expireSession: vi.fn(async () => undefined)
  };
}

describe("ApiClient", () => {
  beforeEach(() => server.use(...handlers));

  it("returns a schema-valid organization response", async () => {
    const api = new ApiClient(apiUrl, authTokenFixture(["test-token"]));

    await expect(api.listOrganizations()).resolves.toEqual({
      organizations: [organization()]
    });
  });

  it("posts the exact organization JSON to the organization endpoint", async () => {
    const input = { name: "Product Studio", slug: "product-studio" };
    const expected = organization();
    server.use(
      http.post(`${apiUrl}/api/v1/organizations`, async ({ request }) => {
        expect(request.method).toBe("POST");
        expect(request.headers.get("authorization")).toBe("Bearer test-token");
        expect(request.headers.get("content-type")).toBe("application/json");
        await expect(request.json()).resolves.toEqual(input);
        return HttpResponse.json(expected, { status: 201 });
      })
    );
    const api = new ApiClient(apiUrl, authTokenFixture(["test-token"]));

    await expect(api.createOrganization(input)).resolves.toEqual(expected);
  });

  it("posts the exact workspace JSON to its organization endpoint", async () => {
    const input = { name: "Frontend", slug: "frontend" };
    const expected = workspace();
    server.use(
      http.post(
        `${apiUrl}/api/v1/organizations/${expected.organization_id}/workspaces`,
        async ({ request }) => {
          expect(request.method).toBe("POST");
          expect(request.headers.get("authorization")).toBe(
            "Bearer test-token"
          );
          expect(request.headers.get("content-type")).toBe("application/json");
          await expect(request.json()).resolves.toEqual(input);
          return HttpResponse.json(expected, { status: 201 });
        }
      )
    );
    const api = new ApiClient(apiUrl, authTokenFixture(["test-token"]));

    await expect(
      api.createWorkspace(expected.organization_id, input)
    ).resolves.toEqual(expected);
  });

  it("posts the exact project JSON to its workspace endpoint", async () => {
    const input = {
      name: "Console",
      slug: "console",
      description: "Internal dashboard"
    };
    const expected = project();
    server.use(
      http.post(
        `${apiUrl}/api/v1/workspaces/${expected.workspace_id}/projects`,
        async ({ request }) => {
          expect(request.method).toBe("POST");
          expect(request.headers.get("authorization")).toBe(
            "Bearer test-token"
          );
          expect(request.headers.get("content-type")).toBe("application/json");
          await expect(request.json()).resolves.toEqual(input);
          return HttpResponse.json(expected, { status: 201 });
        }
      )
    );
    const api = new ApiClient(apiUrl, authTokenFixture(["test-token"]));

    await expect(
      api.createProject(expected.workspace_id, input)
    ).resolves.toEqual(expected);
  });

  it("retains a protocol error envelope", async () => {
    server.use(
      http.get(`${apiUrl}/api/v1/organizations`, () =>
        HttpResponse.json(
          {
            error: {
              code: "NOT_FOUND",
              message: "Organization missing",
              details: { resource: "organization" },
              request_id: "req_123"
            }
          },
          { status: 404 }
        )
      )
    );
    const api = new ApiClient(apiUrl, authTokenFixture(["test-token"]));

    await expect(api.listOrganizations()).rejects.toMatchObject({
      name: "DashboardApiError",
      kind: "NOT_FOUND",
      status: 404,
      requestId: "req_123",
      details: { resource: "organization" }
    } satisfies Partial<DashboardApiError>);
  });

  it("turns invalid success JSON into INVALID_RESPONSE", async () => {
    server.use(
      http.get(`${apiUrl}/api/v1/organizations`, () =>
        HttpResponse.json({ organizations: [{ id: "not-a-uuid" }] })
      )
    );
    const api = new ApiClient(apiUrl, authTokenFixture(["test-token"]));

    await expect(api.listOrganizations()).rejects.toMatchObject({
      kind: "INVALID_RESPONSE",
      status: 200,
      requestId: null
    } satisfies Partial<DashboardApiError>);
  });

  it("turns a network error into NETWORK_ERROR", async () => {
    server.use(
      http.get(`${apiUrl}/api/v1/organizations`, () => HttpResponse.error())
    );
    const api = new ApiClient(apiUrl, authTokenFixture(["test-token"]));

    await expect(api.listOrganizations()).rejects.toMatchObject({
      kind: "NETWORK_ERROR",
      status: null,
      requestId: null
    } satisfies Partial<DashboardApiError>);
  });

  it("forces one token refresh after a 401", async () => {
    let requests = 0;
    server.use(
      http.get(`${apiUrl}/api/v1/organizations`, ({ request }) => {
        requests += 1;
        if (requests === 1) {
          return HttpResponse.json(
            {
              error: {
                code: "UNAUTHENTICATED",
                message: "Expired",
                details: {},
                request_id: "req_1"
              }
            },
            { status: 401 }
          );
        }
        expect(request.headers.get("authorization")).toBe(
          "Bearer refreshed-token"
        );
        return HttpResponse.json({ organizations: [organization()] });
      })
    );
    const auth = authTokenFixture(["expired-token", "refreshed-token"]);
    const api = new ApiClient(apiUrl, auth);

    await expect(api.listOrganizations()).resolves.toEqual({
      organizations: [organization()]
    });
    expect(auth.getAccessToken).toHaveBeenNthCalledWith(1, {
      forceRefresh: false
    });
    expect(auth.getAccessToken).toHaveBeenNthCalledWith(2, {
      forceRefresh: true
    });
    expect(requests).toBe(2);
  });

  it("does not replay an old JWT when forced native refresh is transient", async () => {
    let requests = 0;
    server.use(
      http.get(`${apiUrl}/api/v1/organizations`, ({ request }) => {
        requests += 1;
        if (requests === 1) {
          expect(request.headers.get("authorization")).toBe(
            "Bearer old-native-token"
          );
          return HttpResponse.json(
            {
              error: {
                code: "UNAUTHENTICATED",
                message: "Expired",
                details: {},
                request_id: "req_old"
              }
            },
            { status: 401 }
          );
        }
        expect(request.headers.get("authorization")).toBe(
          "Bearer recovered-native-token"
        );
        return HttpResponse.json({ organizations: [organization()] });
      })
    );
    let now = 1_000;
    const bridge = {
      beginGitHub: vi.fn(async () => undefined),
      sendMagicLink: vi.fn(async () => undefined),
      complete: vi.fn(async () => ({
        accessToken: "unused",
        expiresAtMs: 90_000
      })),
      refresh: vi
        .fn()
        .mockRejectedValueOnce({
          code: "provider_unavailable",
          message: "Try again."
        })
        .mockResolvedValueOnce({
          accessToken: "recovered-native-token",
          expiresAtMs: 90_000
        }),
      restore: vi.fn(async () => ({
        accessToken: "old-native-token",
        expiresAtMs: 60_000
      })),
      expire: vi.fn(async () => undefined),
      signOut: vi.fn(async () => undefined)
    };
    const platform = {
      kind: "desktop" as const,
      preferences: { load: vi.fn(), save: vi.fn() },
      openExternal: vi.fn(async () => undefined),
      onAuthCallback: vi.fn(async () => () => undefined)
    };
    const auth = new DesktopAuthClient(platform, bridge, () => now);
    await auth.initialize();
    const api = new ApiClient(apiUrl, auth);

    await expect(api.listOrganizations()).rejects.toMatchObject({
      kind: "UNAUTHENTICATED",
      status: null
    } satisfies Partial<DashboardApiError>);
    expect(requests).toBe(1);
    expect(bridge.refresh).toHaveBeenCalledOnce();
    expect(bridge.expire).not.toHaveBeenCalled();

    now += 1_000;
    await expect(auth.getAccessToken({ forceRefresh: true })).resolves.toBe(
      "recovered-native-token"
    );
    await expect(api.listOrganizations()).resolves.toEqual({
      organizations: [organization()]
    });
    expect(requests).toBe(2);
    auth.dispose();
  });

  it("expires the session once after a second 401", async () => {
    server.use(
      http.get(`${apiUrl}/api/v1/organizations`, () =>
        HttpResponse.json(
          {
            error: {
              code: "UNAUTHENTICATED",
              message: "Expired",
              details: {},
              request_id: "req_2"
            }
          },
          { status: 401 }
        )
      )
    );
    const auth = authTokenFixture(["expired-token", "still-expired-token"]);
    const api = new ApiClient(apiUrl, auth);

    await expect(api.listOrganizations()).rejects.toMatchObject({
      kind: "UNAUTHENTICATED",
      status: 401,
      requestId: "req_2"
    } satisfies Partial<DashboardApiError>);
    expect(auth.expireSession).toHaveBeenCalledTimes(1);
  });

  it("gets a project from its real endpoint without a content type", async () => {
    const expected = project();
    const api = new ApiClient(apiUrl, authTokenFixture(["test-token"]));

    await expect(api.getProject(expected.id)).resolves.toEqual(expected);
  });
});
