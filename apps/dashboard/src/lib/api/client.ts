import {
  apiErrorSchema,
  organizationSchema,
  organizationMemberSchema,
  organizationMembersResponseSchema,
  organizationsResponseSchema,
  profileSchema,
  projectSchema,
  projectsResponseSchema,
  deleteResourceResponseSchema,
  type CreateOrganizationRequest,
  type CreateProjectRequest,
  type DeleteResourceResponse,
  type Organization,
  type OrganizationMember,
  type OrganizationMembersResponse,
  type OrganizationsResponse,
  type Profile,
  type Project,
  type ProjectsResponse,
  type UpdateOrganizationRequest,
  type UpdateProjectRequest,
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
  method: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
};

export class ApiClient {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly auth: ApiTokenSource
  ) {
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

  getProfile(): Promise<Profile> {
    return this.request("/api/v1/profile", { method: "GET" }, profileSchema);
  }

  updateProfile(input: {
    username: string;
    full_name: string;
    avatar_url: string | null;
  }): Promise<Profile> {
    return this.request(
      "/api/v1/profile",
      { method: "PATCH", body: input },
      profileSchema
    );
  }

  uploadAvatar(file: File): Promise<Profile> {
    const body = new FormData();
    body.set("avatar", file);
    return this.request(
      "/api/v1/profile/avatar",
      { method: "POST", body },
      profileSchema
    );
  }

  removeAvatar(): Promise<Profile> {
    return this.request(
      "/api/v1/profile/avatar",
      { method: "DELETE" },
      profileSchema
    );
  }

  createOrganization(input: CreateOrganizationRequest): Promise<Organization> {
    return this.request(
      "/api/v1/organizations",
      { method: "POST", body: input },
      organizationSchema
    );
  }

  updateOrganization(
    organizationId: string,
    input: UpdateOrganizationRequest
  ): Promise<Organization> {
    return this.request(
      `/api/v1/organizations/${encodeURIComponent(organizationId)}`,
      { method: "PATCH", body: input },
      organizationSchema
    );
  }

  deleteOrganization(
    organizationId: string,
    name: string
  ): Promise<DeleteResourceResponse> {
    return this.request(
      `/api/v1/organizations/${encodeURIComponent(organizationId)}`,
      { method: "DELETE", body: { name } },
      deleteResourceResponseSchema
    );
  }

  listOrganizationMembers(
    organizationId: string
  ): Promise<OrganizationMembersResponse> {
    return this.request(
      `/api/v1/organizations/${encodeURIComponent(organizationId)}/members`,
      { method: "GET" },
      organizationMembersResponseSchema
    );
  }

  updateOrganizationMember(
    organizationId: string,
    userId: string,
    role: OrganizationMember["role"]
  ): Promise<OrganizationMember> {
    return this.request(
      `/api/v1/organizations/${encodeURIComponent(organizationId)}/members/${encodeURIComponent(userId)}`,
      { method: "PATCH", body: { role } },
      organizationMemberSchema
    );
  }

  removeOrganizationMember(
    organizationId: string,
    userId: string
  ): Promise<DeleteResourceResponse> {
    return this.request(
      `/api/v1/organizations/${encodeURIComponent(organizationId)}/members/${encodeURIComponent(userId)}`,
      { method: "DELETE" },
      deleteResourceResponseSchema
    );
  }

  leaveOrganization(organizationId: string): Promise<DeleteResourceResponse> {
    return this.request(
      `/api/v1/organizations/${encodeURIComponent(organizationId)}/members/leave`,
      { method: "POST" },
      deleteResourceResponseSchema
    );
  }

  listProjects(organizationId: string): Promise<ProjectsResponse> {
    return this.request(
      `/api/v1/organizations/${encodeURIComponent(organizationId)}/projects`,
      { method: "GET" },
      projectsResponseSchema
    );
  }

  createProject(
    organizationId: string,
    input: CreateProjectRequest
  ): Promise<Project> {
    return this.request(
      `/api/v1/organizations/${encodeURIComponent(organizationId)}/projects`,
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

  updateProject(
    projectId: string,
    input: UpdateProjectRequest
  ): Promise<Project> {
    return this.request(
      `/api/v1/projects/${encodeURIComponent(projectId)}`,
      { method: "PATCH", body: input },
      projectSchema
    );
  }

  archiveProject(projectId: string): Promise<Project> {
    return this.request(
      `/api/v1/projects/${encodeURIComponent(projectId)}/archive`,
      { method: "POST" },
      projectSchema
    );
  }

  reactivateProject(projectId: string): Promise<Project> {
    return this.request(
      `/api/v1/projects/${encodeURIComponent(projectId)}/reactivate`,
      { method: "POST" },
      projectSchema
    );
  }

  deleteProject(
    projectId: string,
    name: string
  ): Promise<DeleteResourceResponse> {
    return this.request(
      `/api/v1/projects/${encodeURIComponent(projectId)}`,
      { method: "DELETE", body: { name } },
      deleteResourceResponseSchema
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
    if (options.body !== undefined && !(options.body instanceof FormData))
      headers["Content-Type"] = "application/json";

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: options.method,
        headers,
        body:
          options.body === undefined || options.body instanceof FormData
            ? options.body
            : JSON.stringify(options.body)
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

      if (response.status === 401 && forceRefresh)
        await this.auth.expireSession();
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

  private errorFromResponse(
    response: Response,
    data: unknown
  ): DashboardApiError {
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
      response.status === 401
        ? "Authentication is required."
        : "Dashboard API request failed.",
      response.status === 401 ? "UNAUTHENTICATED" : "INTERNAL_ERROR",
      response.status,
      response.headers.get("x-request-id")
    );
  }
}
