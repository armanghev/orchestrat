import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiClient,
  DashboardApiError,
  type ApiTokenSource
} from "@/lib/api/client";
import { DesktopAuthClient } from "@/features/auth/desktop-auth-client";
import { documentDetail, organization, project } from "@/test/factories";
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

  it("posts the exact project JSON to its organization endpoint", async () => {
    const input = {
      name: "Console",
      slug: "console",
      description: "Internal dashboard"
    };
    const expected = project();
    server.use(
      http.post(
        `${apiUrl}/api/v1/organizations/${expected.organization_id}/projects`,
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
      api.createProject(expected.organization_id, input)
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

  it("lists project events with the API pagination cursor", async () => {
    const projectId = project().id;
    server.use(
      http.get(
        `${apiUrl}/api/v1/projects/${projectId}/events`,
        ({ request }) => {
          expect(new URL(request.url).search).toBe("?limit=10&after=42");
          return HttpResponse.json({ events: [], next_cursor: null });
        }
      )
    );
    const api = new ApiClient(apiUrl, authTokenFixture(["test-token"]));

    await expect(
      api.listProjectEvents(projectId, { limit: 10, after: "42" })
    ).resolves.toEqual({
      events: [],
      next_cursor: null
    });
  });

  it("sends task creation JSON with its idempotency key", async () => {
    const projectId = project().id;
    server.use(
      http.post(
        `${apiUrl}/api/v1/projects/${projectId}/tasks`,
        async ({ request }) => {
          expect(request.headers.get("idempotency-key")).toBe("task-1");
          expect(request.headers.get("content-type")).toBe("application/json");
          await expect(request.json()).resolves.toEqual({ title: "Ship it" });
          return HttpResponse.json(
            {
              error: {
                code: "TASK_VERSION_CONFLICT",
                message: "Task changed.",
                details: { current_version: 2 },
                request_id: "req_task"
              }
            },
            { status: 409 }
          );
        }
      )
    );
    const api = new ApiClient(apiUrl, authTokenFixture(["test-token"]));

    await expect(
      api.createTask(projectId, { title: "Ship it" }, "task-1")
    ).rejects.toMatchObject({
      kind: "TASK_VERSION_CONFLICT",
      details: { current_version: 2 }
    });
  });

  it("preserves document conflict errors for UI recovery", async () => {
    const documentId = "00000000-0000-4000-8000-000000000005";
    server.use(
      http.patch(`${apiUrl}/api/v1/documents/${documentId}`, () =>
        HttpResponse.json(
          {
            error: {
              code: "DOCUMENT_CONFLICT",
              message: "Document changed.",
              details: { current_revision: 3, base_revision: 2 },
              request_id: "req_document"
            }
          },
          { status: 409 }
        )
      )
    );
    const api = new ApiClient(apiUrl, authTokenFixture(["test-token"]));

    await expect(
      api.updateDocument(documentId, { content: "draft", base_revision: 2 })
    ).rejects.toMatchObject({
      kind: "DOCUMENT_CONFLICT",
      details: { current_revision: 3, base_revision: 2 }
    });
  });

  it("accepts minimal document lifecycle responses", async () => {
    const detail = documentDetail();
    server.use(
      http.patch(`${apiUrl}/api/v1/documents/${detail.document.id}/path`, () =>
        HttpResponse.json({ document: detail.document })
      ),
      http.post(
        `${apiUrl}/api/v1/documents/${detail.document.id}/archive`,
        () => HttpResponse.json({ document: detail.document })
      ),
      http.post(
        `${apiUrl}/api/v1/documents/${detail.document.id}/restore`,
        () => HttpResponse.json({ document: detail.document })
      )
    );
    const api = new ApiClient(
      apiUrl,
      authTokenFixture(["test-token", "test-token", "test-token"])
    );

    await expect(
      api.renameDocument(detail.document.id, {
        path: "renamed.md",
        expected_revision: 1
      })
    ).resolves.toEqual({ document: detail.document });
    await expect(api.archiveDocument(detail.document.id)).resolves.toEqual({
      document: detail.document
    });
    await expect(api.restoreDocument(detail.document.id)).resolves.toEqual({
      document: detail.document
    });
  });

  it("unwraps a historical document revision response", async () => {
    const detail = documentDetail();
    server.use(
      http.get(
        `${apiUrl}/api/v1/documents/${detail.document.id}/revisions/1`,
        () => HttpResponse.json({ revision: detail.revision })
      )
    );
    const api = new ApiClient(apiUrl, authTokenFixture(["test-token"]));

    await expect(
      api.getDocumentRevision(detail.document.id, 1)
    ).resolves.toEqual(detail.revision);
  });

  it("completes a zero-byte direct upload without non-finite progress", async () => {
    class ZeroByteXmlHttpRequest {
      status = 200;
      upload = {} as XMLHttpRequestUpload;
      onload: XMLHttpRequest["onload"] = null;
      onerror: XMLHttpRequest["onerror"] = null;
      onabort: XMLHttpRequest["onabort"] = null;
      open() {}
      abort() {}
      getResponseHeader() {
        return null;
      }
      send() {
        this.onload?.call(
          this as unknown as XMLHttpRequest,
          new ProgressEvent("load")
        );
      }
    }
    vi.stubGlobal("XMLHttpRequest", ZeroByteXmlHttpRequest);
    try {
      const api = new ApiClient(apiUrl, authTokenFixture([]));
      const progress: number[] = [];

      await api.putPresignedObject(
        "https://storage.example.test/upload",
        new Blob(),
        (loaded) => progress.push(loaded)
      );

      expect(progress).toEqual([0]);
      expect(progress.every(Number.isFinite)).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("resolves relative attachment download tickets against the API base", async () => {
    const detail = documentDetail();
    server.use(
      http.post(
        `${apiUrl}/api/v1/documents/${detail.document.id}/attachments/${detail.document.id}/download`,
        () =>
          HttpResponse.json({
            download_url: "/api/v1/attachments/download?ticket=ticket"
          })
      )
    );
    const api = new ApiClient(apiUrl, authTokenFixture(["test-token"]));

    await expect(
      api.downloadDocumentAttachment(detail.document.id, detail.document.id)
    ).resolves.toEqual({
      download_url: `${apiUrl}/api/v1/attachments/download?ticket=ticket`
    });
  });
});
