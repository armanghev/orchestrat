import { expect } from "vitest";
import { http, HttpResponse } from "msw";
import { organization, project } from "@/test/factories";

const apiUrl = "http://localhost:8801/api/v1";

function assertAuthorization(request: Request) {
  expect(request.headers.get("authorization")).toBe("Bearer test-token");
}

function assertJsonRequest(request: Request) {
  expect(request.headers.get("content-type")).toBe("application/json");
}

function assertBodylessRequest(request: Request) {
  expect(request.headers.get("content-type")).toBeNull();
}

export const handlers = [
  http.get(`${apiUrl}/organizations`, ({ request }) => {
    assertAuthorization(request);
    assertBodylessRequest(request);
    return HttpResponse.json({ organizations: [organization()] });
  }),
  http.post(`${apiUrl}/organizations`, ({ request }) => {
    assertAuthorization(request);
    assertJsonRequest(request);
    return HttpResponse.json(organization(), { status: 201 });
  }),
  http.get(
    `${apiUrl}/organizations/:organizationId/projects`,
    ({ request }) => {
      assertAuthorization(request);
      assertBodylessRequest(request);
      return HttpResponse.json({ projects: [project()] });
    }
  ),
  http.post(
    `${apiUrl}/organizations/:organizationId/projects`,
    ({ request }) => {
      assertAuthorization(request);
      assertJsonRequest(request);
      return HttpResponse.json(project(), { status: 201 });
    }
  ),
  http.get(`${apiUrl}/profile`, ({ request }) => {
    assertAuthorization(request);
    assertBodylessRequest(request);
    return HttpResponse.json({
      id: "00000000-0000-4000-8000-000000000004",
      username: "tester",
      full_name: "Test User",
      email: "test@example.com",
      avatar_url: null
    });
  }),
  http.get(`${apiUrl}/organizations/:organizationId/members`, ({ request }) => {
    assertAuthorization(request);
    assertBodylessRequest(request);
    return HttpResponse.json({ members: [] });
  }),
  http.get(`${apiUrl}/projects/:projectId`, ({ request }) => {
    assertAuthorization(request);
    assertBodylessRequest(request);
    return HttpResponse.json(project());
  }),
  http.get(`${apiUrl}/projects/:projectId/tasks`, ({ request }) => {
    assertAuthorization(request);
    assertBodylessRequest(request);
    return HttpResponse.json({ tasks: [], total: 0, next_cursor: null });
  }),
  http.get(`${apiUrl}/projects/:projectId/agents`, ({ request }) => {
    assertAuthorization(request);
    assertBodylessRequest(request);
    return HttpResponse.json({ agents: [] });
  }),
  http.get(`${apiUrl}/projects/:projectId/presence`, ({ request }) => {
    assertAuthorization(request);
    assertBodylessRequest(request);
    return HttpResponse.json({ agents: [] });
  }),
  http.get(`${apiUrl}/projects/:projectId/events`, ({ request }) => {
    assertAuthorization(request);
    assertBodylessRequest(request);
    return HttpResponse.json({ events: [], next_cursor: null });
  }),
  http.get(`${apiUrl}/projects/:projectId/documents`, ({ request }) => {
    assertAuthorization(request);
    assertBodylessRequest(request);
    return HttpResponse.json({ documents: [], next_cursor: null });
  }),
  http.get(`${apiUrl}/documents/:documentId/attachments`, ({ request }) => {
    assertAuthorization(request);
    assertBodylessRequest(request);
    return HttpResponse.json({ attachments: [] });
  })
];
