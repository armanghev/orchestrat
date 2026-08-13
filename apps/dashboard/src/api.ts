import {
  apiErrorSchema,
  organizationSchema,
  organizationsResponseSchema,
  projectSchema,
  projectsResponseSchema,
  workspaceSchema,
  workspacesResponseSchema,
  type CreateOrganizationRequest,
  type CreateProjectRequest,
  type CreateWorkspaceRequest
} from "@orchestrat/protocol";
import type { ZodType } from "zod";

const apiUrl = import.meta.env.VITE_API_URL ?? "http://localhost:3001";

export class ApiClient {
  constructor(private readonly getToken: () => Promise<string | null>) {}

  private async request<T>(path: string, schema: ZodType<T>, init?: RequestInit) {
    const token = await this.getToken();
    if (!token) throw new Error("Your session is no longer available.");
    const response = await fetch(`${apiUrl}/api/v1${path}`, {
      ...init,
      headers: {
        ...(init?.body ? { "content-type": "application/json" } : {}),
        authorization: `Bearer ${token}`,
        ...init?.headers
      }
    });
    const body: unknown = await response.json();
    if (!response.ok) {
      const parsed = apiErrorSchema.safeParse(body);
      throw new Error(parsed.success ? parsed.data.error.message : "The request failed.");
    }
    return schema.parse(body);
  }

  listOrganizations() {
    return this.request("/organizations", organizationsResponseSchema);
  }

  createOrganization(input: CreateOrganizationRequest) {
    return this.request("/organizations", organizationSchema, {
      body: JSON.stringify(input),
      method: "POST"
    });
  }

  listWorkspaces(organizationId: string) {
    return this.request(
      `/organizations/${organizationId}/workspaces`,
      workspacesResponseSchema
    );
  }

  createWorkspace(organizationId: string, input: CreateWorkspaceRequest) {
    return this.request(
      `/organizations/${organizationId}/workspaces`,
      workspaceSchema,
      { body: JSON.stringify(input), method: "POST" }
    );
  }

  listProjects(workspaceId: string) {
    return this.request(
      `/workspaces/${workspaceId}/projects`,
      projectsResponseSchema
    );
  }

  createProject(workspaceId: string, input: CreateProjectRequest) {
    return this.request(`/workspaces/${workspaceId}/projects`, projectSchema, {
      body: JSON.stringify(input),
      method: "POST"
    });
  }
}
