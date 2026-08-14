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
  type CreateWorkspaceRequest,
  type Organization,
  type OrganizationsResponse,
  type Project,
  type ProjectsResponse,
  type Workspace,
  type WorkspacesResponse
} from "@orchestrat/protocol";
import type { ZodType } from "zod";

export type ApiErrorKind =
  | "UNAUTHENTICATED"
  | "PERMISSION_DENIED"
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "CONFLICT"
  | "INTERNAL_ERROR"
  | "INVALID_RESPONSE"
  | "NETWORK_ERROR"
  | "CONFIGURATION_ERROR";

export class DashboardApiError extends Error {
  constructor(
    message: string,
    readonly kind: ApiErrorKind,
    readonly status: number | null,
    readonly requestId: string | null,
    readonly details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "DashboardApiError";
  }
}

export interface ApiTokenSource {
  getAccessToken(options: { forceRefresh: boolean }): Promise<string | null>;
  expireSession(): Promise<void>;
}

type RequestOptions = {
  method: "GET" | "POST";
  body?: unknown;
};

export class ApiClient {
  private readonly baseUrl: string;

  constructor(baseUrl: string, private readonly auth: ApiTokenSource) {
    try {
      this.baseUrl = new URL(baseUrl).toString().replace(/\/$/, "");
    } catch {
      throw new DashboardApiError(
        "Dashboard API configuration is invalid.",
        "CONFIGURATION_ERROR",
        null,
        null
      );
    }
  }

  listOrganizations(): Promise<OrganizationsResponse> {
    return this.request(
      "/api/v1/organizations",
      { method: "GET" },
      organizationsResponseSchema
    );
  }

  createOrganization(input: CreateOrganizationRequest): Promise<Organization> {
    return this.request(
      "/api/v1/organizations",
      { method: "POST", body: input },
      organizationSchema
    );
  }

  listWorkspaces(organizationId: string): Promise<WorkspacesResponse> {
    return this.request(
      `/api/v1/organizations/${encodeURIComponent(organizationId)}/workspaces`,
      { method: "GET" },
      workspacesResponseSchema
    );
  }

  createWorkspace(
    organizationId: string,
    input: CreateWorkspaceRequest
  ): Promise<Workspace> {
    return this.request(
      `/api/v1/organizations/${encodeURIComponent(organizationId)}/workspaces`,
      { method: "POST", body: input },
      workspaceSchema
    );
  }

  listProjects(workspaceId: string): Promise<ProjectsResponse> {
    return this.request(
      `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/projects`,
      { method: "GET" },
      projectsResponseSchema
    );
  }

  createProject(
    workspaceId: string,
    input: CreateProjectRequest
  ): Promise<Project> {
    return this.request(
      `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/projects`,
      { method: "POST", body: input },
      projectSchema
    );
  }

  getProject(projectId: string): Promise<Project> {
    return this.request(
      `/api/v1/projects/${encodeURIComponent(projectId)}`,
      { method: "GET" },
      projectSchema
    );
  }

  private async request<T>(
    path: string,
    options: RequestOptions,
    schema: ZodType<T>
  ): Promise<T> {
    return this.send(path, options, schema, false);
  }

  private async send<T>(
    path: string,
    options: RequestOptions,
    schema: ZodType<T>,
    forceRefresh: boolean
  ): Promise<T> {
    const token = await this.auth.getAccessToken({ forceRefresh });
    if (!token) {
      throw new DashboardApiError(
        "Authentication is required.",
        "UNAUTHENTICATED",
        null,
        null
      );
    }

    const headers: HeadersInit = { Authorization: `Bearer ${token}` };
    if (options.body !== undefined) headers["Content-Type"] = "application/json";

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: options.method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body)
      });
    } catch {
      throw new DashboardApiError(
        "Unable to reach the Dashboard API.",
        "NETWORK_ERROR",
        null,
        null
      );
    }

    const data = await this.parseJson(response);
    if (!response.ok) {
      const error = this.errorFromResponse(response, data);
      if (response.status === 401 && !forceRefresh) {
        return this.send(path, options, schema, true);
      }

      if (response.status === 401 && forceRefresh) await this.auth.expireSession();
      throw error;
    }

    const parsed = schema.safeParse(data);
    if (!parsed.success) {
      throw new DashboardApiError(
        "Dashboard API returned an invalid response.",
        "INVALID_RESPONSE",
        response.status,
        response.headers.get("x-request-id")
      );
    }
    return parsed.data;
  }

  private async parseJson(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      return undefined;
    }
  }

  private errorFromResponse(response: Response, data: unknown): DashboardApiError {
    const parsed = apiErrorSchema.safeParse(data);
    if (parsed.success) {
      return new DashboardApiError(
        parsed.data.error.message,
        parsed.data.error.code,
        response.status,
        parsed.data.error.request_id,
        parsed.data.error.details
      );
    }

    return new DashboardApiError(
      response.status === 401 ? "Authentication is required." : "Dashboard API request failed.",
      response.status === 401 ? "UNAUTHENTICATED" : "INTERNAL_ERROR",
      response.status,
      response.headers.get("x-request-id")
    );
  }
}
