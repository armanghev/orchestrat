import { expect } from "vitest";
import { http, HttpResponse } from "msw";
import { organization, project } from "@/test/factories";

const apiUrl = "http://localhost:3001/api/v1";

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
  http.get(`${apiUrl}/projects/:projectId`, ({ request }) => {
    assertAuthorization(request);
    assertBodylessRequest(request);
    return HttpResponse.json(project());
  })
];
