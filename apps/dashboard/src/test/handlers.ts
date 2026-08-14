import { expect } from "vitest";
import { http, HttpResponse } from "msw";
import { organization, project, workspace } from "@/test/factories";

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
  http.get(`${apiUrl}/organizations/:organizationId/workspaces`, ({ request }) => {
    assertAuthorization(request);
    assertBodylessRequest(request);
    return HttpResponse.json({ workspaces: [workspace()] });
  }),
  http.post(`${apiUrl}/organizations/:organizationId/workspaces`, ({ request }) => {
    assertAuthorization(request);
    assertJsonRequest(request);
    return HttpResponse.json(workspace(), { status: 201 });
  }),
  http.get(`${apiUrl}/workspaces/:workspaceId/projects`, ({ request }) => {
    assertAuthorization(request);
    assertBodylessRequest(request);
    return HttpResponse.json({ projects: [project()] });
  }),
  http.post(`${apiUrl}/workspaces/:workspaceId/projects`, ({ request }) => {
    assertAuthorization(request);
    assertJsonRequest(request);
    return HttpResponse.json(project(), { status: 201 });
  }),
  http.get(`${apiUrl}/projects/:projectId`, ({ request }) => {
    assertAuthorization(request);
    assertBodylessRequest(request);
    return HttpResponse.json(project());
  })
];
