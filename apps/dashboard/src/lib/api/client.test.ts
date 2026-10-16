import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiClient,
  DashboardApiError,
  type ApiTokenSource
} from "@/lib/api/client";
import { WebAuthClient } from "@/features/auth/web-auth-client";
import {
  AUTH_SESSION_STORAGE_KEY,
  AuthSessionStorage
} from "@/features/auth/web-auth-storage";
import { documentDetail, organization, project } from "@/test/factories";
import { handlers } from "@/test/handlers";
import { server } from "@/test/msw-server";

const apiUrl = "http://localhost:8801";

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

  it("loads schema-validated project summaries", async () => {
    const item = {
      ...project(),
      task_key_prefix: "ORC",
      default_branch_name: "main",
      member_count: 2,
      open_task_count: 3,
      last_activity_at: null,
      repository: null
    };
    server.use(
      http.get(
        `${apiUrl}/api/v1/organizations/${item.organization_id}/project-summaries`,
        ({ request }) => {
          expect(request.headers.get("authorization")).toBe(
            "Bearer test-token"
          );
          return HttpResponse.json({ projects: [item] });
        }
      )
    );
    const api = new ApiClient(apiUrl, authTokenFixture(["test-token"]));
    await expect(
      api.listProjectSummaries(item.organization_id)
    ).resolves.toEqual({ projects: [item] });
  });

  it("loads repository providers without a project", async () => {
    const response = {
      providers: [
        {
          provider: "github",
          configured: false,
          unavailable_reason: "Not configured"
        }
      ]
    };
    server.use(
      http.get(`${apiUrl}/api/v1/repository/providers`, ({ request }) => {
        expect(request.headers.get("authorization")).toBe("Bearer test-token");
        return HttpResponse.json(response);
      })
    );
    const api = new ApiClient(apiUrl, authTokenFixture(["test-token"]));
    await expect(api.listRepositoryProviders()).resolves.toEqual(response);
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

  it("does not replay a rejected token when the forced refresh is transient", async () => {
    let requests = 0;
    let refreshes = 0;
    server.use(
      http.get(`${apiUrl}/api/v1/organizations`, ({ request }) => {
        requests += 1;
        if (requests === 1) {
          expect(request.headers.get("authorization")).toBe(
            "Bearer orch_sess_old"
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
          "Bearer orch_sess_new"
        );
        return HttpResponse.json({ organizations: [organization()] });
      }),
      http.post(`${apiUrl}/api/v1/auth/refresh`, () => {
        refreshes += 1;
        if (refreshes === 1)
          return HttpResponse.json(
            {
              error: {
                code: "INTERNAL_ERROR",
                message: "Try again.",
                details: {},
                request_id: "req_refresh"
              }
            },
            { status: 503 }
          );
        return HttpResponse.json({
          access_token: "orch_sess_new",
          refresh_token: "orch_refresh_new",
          token_type: "Bearer",
          expires_in: 3600,
          refresh_expires_in: 2592000,
          user: {
            user_id: "00000000-0000-4000-8000-000000000001",
            email: "ada@example.com",
            full_name: "Ada",
            is_instance_admin: false
          }
        });
      })
    );
    const values = new Map([
      [
        AUTH_SESSION_STORAGE_KEY,
        JSON.stringify({
          version: 1,
          access_token: "orch_sess_old",
          refresh_token: "orch_refresh_old",
          access_expires_at: Date.now() + 3_600_000,
          refresh_expires_at: Date.now() + 86_400_000,
          user: {
            user_id: "00000000-0000-4000-8000-000000000001",
            email: "ada@example.com",
            full_name: "Ada",
            is_instance_admin: false
          }
        })
      ]
    ]);
    const auth = new WebAuthClient({
      apiUrl,
      storage: new AuthSessionStorage({
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => void values.set(key, value),
        removeItem: (key) => void values.delete(key)
      })
    });
    await auth.initialize();
    const api = new ApiClient(apiUrl, auth);

    await expect(api.listOrganizations()).rejects.toMatchObject({
      kind: "UNAUTHENTICATED",
      status: null
    } satisfies Partial<DashboardApiError>);
    expect(requests).toBe(1);
    expect(refreshes).toBe(1);
    expect(auth.getSnapshot().status).toBe("signedIn");

    await expect(auth.getAccessToken({ forceRefresh: true })).resolves.toBe(
      "orch_sess_new"
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
