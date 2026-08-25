import {
  apiErrorResponseSchema,
  organizationSchema,
  organizationMemberSchema,
  organizationMembersResponseSchema,
  organizationsResponseSchema,
  profileSchema,
  projectSchema,
  projectsResponseSchema,
  deleteResourceResponseSchema,
  agentsResponseSchema,
  agentPresenceSchema,
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
  documentDetailSchema,
  documentSchema,
  documentRevisionsResponseSchema,
  historicalDocumentRevisionResponseSchema,
  documentRevisionSummarySchema,
  documentRevisionSummaryResponseSchema,
  attachmentSchema,
  documentAttachmentsResponseSchema,
  attachmentUploadResponseSchema,
  attachmentPartsResponseSchema,
  attachmentUploadCompletionResponseSchema,
  documentsResponseSchema,
  projectEventsResponseSchema,
  taskCommentsResponseSchema,
  taskDependenciesResponseSchema,
  taskListResponseSchema,
  taskSchema,
  type AgentPresence,
  type AgentsResponse,
  type CreateDocumentRequest,
  type CreateTaskCommentRequest,
  type CreateTaskDependencyRequest,
  type CreateTaskRequest,
  type DocumentDetail,
  type DocumentListQuery,
  type DocumentRevisionsResponse,
  type DocumentsResponse,
  type MoveTaskRequest,
  type PaginationQuery,
  type ProjectEventsResponse,
  type Task,
  type TaskCommentsQuery,
  type TaskCommentsResponse,
  type TaskDependenciesResponse,
  type TaskListQuery,
  type TaskListResponse,
  type UpdateDocumentRequest,
  type UpdateTaskRequest,
  type TaskComment,
  type DocumentRevision,
  type ErrorCode,
  realtimeTicketResponseSchema,
  type RealtimeTicketResponse,
  cliAuthorizationPollResponseSchema,
  type CliAuthorizationPollResponse
} from "@orchestrat/protocol";
import { z, type ZodType } from "zod";

const documentLifecycleResponseSchema = z.object({ document: documentSchema });

export type DocumentRevisionSummary = z.infer<
  typeof documentRevisionSummarySchema
>;
export type DocumentAttachment = z.infer<typeof attachmentSchema>;
export type DocumentAttachmentUpload = z.infer<
  typeof attachmentUploadResponseSchema
>["upload"];

export type ApiErrorKind =
  ErrorCode | "INVALID_RESPONSE" | "NETWORK_ERROR" | "CONFIGURATION_ERROR";

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
  headers?: HeadersInit;
};

const queryString = (
  values: Record<string, string | number | boolean | undefined>
) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values))
    if (value !== undefined) params.set(key, String(value));
  const result = params.toString();
  return result ? `?${result}` : "";
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

  listTasks(
    projectId: string,
    query: Partial<TaskListQuery> = {}
  ): Promise<TaskListResponse> {
    return this.request(
      `/api/v1/projects/${encodeURIComponent(projectId)}/tasks${queryString(query)}`,
      { method: "GET" },
      taskListResponseSchema
    );
  }

  createTask(
    projectId: string,
    input: CreateTaskRequest,
    idempotencyKey: string
  ): Promise<Task> {
    return this.request(
      `/api/v1/projects/${encodeURIComponent(projectId)}/tasks`,
      {
        method: "POST",
        body: input,
        headers: idempotencyKey
          ? { "Idempotency-Key": idempotencyKey }
          : undefined
      },
      taskSchema
    );
  }

  getTask(taskId: string): Promise<Task> {
    return this.request(
      `/api/v1/tasks/${encodeURIComponent(taskId)}`,
      { method: "GET" },
      taskSchema
    );
  }

  updateTask(taskId: string, input: UpdateTaskRequest): Promise<Task> {
    return this.request(
      `/api/v1/tasks/${encodeURIComponent(taskId)}`,
      { method: "PATCH", body: input },
      taskSchema
    );
  }

  moveTask(taskId: string, input: MoveTaskRequest): Promise<Task> {
    return this.request(
      `/api/v1/tasks/${encodeURIComponent(taskId)}/move`,
      { method: "POST", body: input },
      taskSchema
    );
  }

  listTaskComments(
    taskId: string,
    query: Partial<TaskCommentsQuery> = {}
  ): Promise<TaskCommentsResponse> {
    return this.request(
      `/api/v1/tasks/${encodeURIComponent(taskId)}/comments${queryString(query)}`,
      { method: "GET" },
      taskCommentsResponseSchema
    );
  }

  createTaskComment(
    taskId: string,
    input: CreateTaskCommentRequest,
    idempotencyKey: string
  ): Promise<TaskComment> {
    return this.request(
      `/api/v1/tasks/${encodeURIComponent(taskId)}/comments`,
      {
        method: "POST",
        body: input,
        headers: idempotencyKey
          ? { "Idempotency-Key": idempotencyKey }
          : undefined
      },
      taskCommentsResponseSchema.shape.comments.element
    );
  }

  getTaskDependencies(taskId: string): Promise<TaskDependenciesResponse> {
    return this.request(
      `/api/v1/tasks/${encodeURIComponent(taskId)}/dependencies`,
      { method: "GET" },
      taskDependenciesResponseSchema
    );
  }

  addTaskDependency(
    taskId: string,
    input: CreateTaskDependencyRequest
  ): Promise<Task> {
    return this.request(
      `/api/v1/tasks/${encodeURIComponent(taskId)}/dependencies`,
      { method: "POST", body: input },
      taskSchema
    );
  }

  removeTaskDependency(
    taskId: string,
    dependsOnTaskId: string,
    expectedVersion: number
  ): Promise<Task> {
    return this.request(
      `/api/v1/tasks/${encodeURIComponent(taskId)}/dependencies/${encodeURIComponent(dependsOnTaskId)}`,
      { method: "DELETE", body: { expected_version: expectedVersion } },
      taskSchema
    );
  }

  listAgents(projectId: string): Promise<AgentsResponse> {
    return this.request(
      `/api/v1/projects/${encodeURIComponent(projectId)}/agents`,
      { method: "GET" },
      agentsResponseSchema
    );
  }

  getAgentPresence(projectId: string): Promise<{ agents: AgentPresence[] }> {
    return this.request(
      `/api/v1/projects/${encodeURIComponent(projectId)}/presence`,
      { method: "GET" },
      z.object({ agents: z.array(agentPresenceSchema) })
    );
  }

  listProjectEvents(
    projectId: string,
    query: Partial<PaginationQuery> = {}
  ): Promise<ProjectEventsResponse> {
    return this.request(
      `/api/v1/projects/${encodeURIComponent(projectId)}/events${queryString(query)}`,
      { method: "GET" },
      projectEventsResponseSchema
    );
  }

  createRealtimeTicket(projectId: string): Promise<RealtimeTicketResponse> {
    return this.request(
      "/api/v1/realtime/tickets",
      { method: "POST", body: { project_id: projectId } },
      realtimeTicketResponseSchema
    );
  }

  realtimeSocketUrl(projectId: string, ticket: string): string {
    const url = new URL(
      `/api/v1/realtime/projects/${encodeURIComponent(projectId)}`,
      this.baseUrl
    );
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("ticket", ticket);
    return url.toString();
  }

  listDocuments(
    projectId: string,
    query: Partial<DocumentListQuery> = {}
  ): Promise<DocumentsResponse> {
    return this.request(
      `/api/v1/projects/${encodeURIComponent(projectId)}/documents${queryString(query)}`,
      { method: "GET" },
      documentsResponseSchema
    );
  }

  createDocument(
    projectId: string,
    input: CreateDocumentRequest
  ): Promise<DocumentDetail> {
    return this.request(
      `/api/v1/projects/${encodeURIComponent(projectId)}/documents`,
      { method: "POST", body: input },
      documentDetailSchema
    );
  }

  getDocument(documentId: string): Promise<DocumentDetail> {
    return this.request(
      `/api/v1/documents/${encodeURIComponent(documentId)}`,
      { method: "GET" },
      documentDetailSchema
    );
  }

  updateDocument(
    documentId: string,
    input: UpdateDocumentRequest
  ): Promise<DocumentDetail> {
    return this.request(
      `/api/v1/documents/${encodeURIComponent(documentId)}`,
      { method: "PATCH", body: input },
      documentDetailSchema
    );
  }

  renameDocument(
    documentId: string,
    input: { path: string; expected_revision: number }
  ): Promise<{ document: z.infer<typeof documentSchema> }> {
    return this.request(
      `/api/v1/documents/${encodeURIComponent(documentId)}/path`,
      { method: "PATCH", body: input },
      documentLifecycleResponseSchema
    );
  }

  archiveDocument(
    documentId: string
  ): Promise<{ document: z.infer<typeof documentSchema> }> {
    return this.request(
      `/api/v1/documents/${encodeURIComponent(documentId)}/archive`,
      { method: "POST", body: {} },
      documentLifecycleResponseSchema
    );
  }

  restoreDocument(
    documentId: string
  ): Promise<{ document: z.infer<typeof documentSchema> }> {
    return this.request(
      `/api/v1/documents/${encodeURIComponent(documentId)}/restore`,
      { method: "POST", body: {} },
      documentLifecycleResponseSchema
    );
  }

  listDocumentRevisions(
    documentId: string
  ): Promise<DocumentRevisionsResponse> {
    return this.request(
      `/api/v1/documents/${encodeURIComponent(documentId)}/revisions`,
      { method: "GET" },
      documentRevisionsResponseSchema
    );
  }

  listDocumentRevisionSummaries(
    documentId: string,
    cursor?: string
  ): Promise<{
    revisions: DocumentRevisionSummary[];
    next_cursor: string | null;
  }> {
    return this.request(
      `/api/v1/documents/${encodeURIComponent(documentId)}/revisions${queryString({ view: "summary", limit: 50, cursor })}`,
      { method: "GET" },
      documentRevisionSummaryResponseSchema
    );
  }

  getDocumentRevision(
    documentId: string,
    revision: number
  ): Promise<DocumentRevision> {
    return this.request(
      `/api/v1/documents/${encodeURIComponent(documentId)}/revisions/${revision}`,
      { method: "GET" },
      historicalDocumentRevisionResponseSchema
    ).then((response) => response.revision);
  }

  listDocumentAttachments(
    documentId: string
  ): Promise<{ attachments: DocumentAttachment[] }> {
    return this.request(
      `/api/v1/documents/${encodeURIComponent(documentId)}/attachments`,
      { method: "GET" },
      documentAttachmentsResponseSchema
    );
  }

  startDocumentAttachmentUpload(
    documentId: string,
    input: { filename: string; content_type: string; size_bytes: number }
  ): Promise<{ upload: DocumentAttachmentUpload }> {
    return this.request(
      `/api/v1/documents/${encodeURIComponent(documentId)}/attachments/uploads`,
      { method: "POST", body: input },
      attachmentUploadResponseSchema
    );
  }

  getDocumentAttachmentUpload(
    documentId: string,
    uploadId: string
  ): Promise<{ upload: DocumentAttachmentUpload }> {
    return this.request(
      `/api/v1/documents/${encodeURIComponent(documentId)}/attachments/uploads/${encodeURIComponent(uploadId)}`,
      { method: "GET" },
      attachmentUploadResponseSchema
    );
  }

  refreshDocumentAttachmentUpload(
    documentId: string,
    uploadId: string
  ): Promise<{ upload: DocumentAttachmentUpload }> {
    return this.request(
      `/api/v1/documents/${encodeURIComponent(documentId)}/attachments/uploads/${encodeURIComponent(uploadId)}/refresh`,
      { method: "POST", body: {} },
      attachmentUploadResponseSchema
    );
  }

  refreshDocumentAttachmentParts(
    documentId: string,
    uploadId: string,
    part_numbers: number[]
  ): Promise<{ parts: Array<{ part_number: number; upload_url: string }> }> {
    return this.request(
      `/api/v1/documents/${encodeURIComponent(documentId)}/attachments/uploads/${encodeURIComponent(uploadId)}/parts`,
      { method: "POST", body: { part_numbers } },
      attachmentPartsResponseSchema
    );
  }

  completeDocumentAttachmentUpload(
    documentId: string,
    uploadId: string,
    parts?: Array<{ part_number: number; etag: string }>
  ): Promise<{ attachment: DocumentAttachment }> {
    return this.request(
      `/api/v1/documents/${encodeURIComponent(documentId)}/attachments/uploads/${encodeURIComponent(uploadId)}/complete`,
      { method: "POST", body: parts === undefined ? {} : { parts } },
      attachmentUploadCompletionResponseSchema
    );
  }

  abortDocumentAttachmentUpload(
    documentId: string,
    uploadId: string
  ): Promise<void> {
    return this.request(
      `/api/v1/documents/${encodeURIComponent(documentId)}/attachments/uploads/${encodeURIComponent(uploadId)}`,
      { method: "DELETE" },
      z.undefined()
    );
  }

  removeDocumentAttachment(
    documentId: string,
    attachmentId: string
  ): Promise<void> {
    return this.request(
      `/api/v1/documents/${encodeURIComponent(documentId)}/attachments/${encodeURIComponent(attachmentId)}`,
      { method: "DELETE" },
      z.undefined()
    );
  }

  downloadDocumentAttachment(
    documentId: string,
    attachmentId: string
  ): Promise<{ download_url: string }> {
    return this.request(
      `/api/v1/documents/${encodeURIComponent(documentId)}/attachments/${encodeURIComponent(attachmentId)}/download`,
      { method: "POST", body: {} },
      z.object({ download_url: z.string() })
    ).then(({ download_url }) => ({
      download_url: new URL(download_url, `${this.baseUrl}/`).toString()
    }));
  }

  async putPresignedObject(
    url: string,
    body: Blob,
    onProgress?: (loaded: number) => void,
    signal?: AbortSignal
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = new XMLHttpRequest();
      const abort = () => request.abort();
      request.open("PUT", url);
      request.upload.onprogress = (event) => {
        if (event.lengthComputable) onProgress?.(event.loaded);
      };
      request.onload = () => {
        signal?.removeEventListener("abort", abort);
        if (request.status >= 200 && request.status < 300) {
          onProgress?.(body.size);
          resolve();
          return;
        }
        reject(
          new DashboardApiError(
            "Attachment upload failed.",
            "NETWORK_ERROR",
            request.status,
            null
          )
        );
      };
      request.onerror = request.onabort = () => {
        signal?.removeEventListener("abort", abort);
        reject(
          new DashboardApiError(
            signal?.aborted
              ? "Attachment upload aborted."
              : "Attachment upload failed.",
            "NETWORK_ERROR",
            null,
            null
          )
        );
      };
      if (signal?.aborted) {
        abort();
        return;
      }
      signal?.addEventListener("abort", abort, { once: true });
      request.send(body);
    });
  }

  approveCliAuthorization(
    attemptId: string
  ): Promise<CliAuthorizationPollResponse> {
    return this.request(
      `/api/v1/cli/authorization/attempts/${encodeURIComponent(attemptId)}/approve`,
      { method: "POST", body: {} },
      cliAuthorizationPollResponseSchema
    );
  }

  denyCliAuthorization(
    attemptId: string
  ): Promise<CliAuthorizationPollResponse> {
    return this.request(
      `/api/v1/cli/authorization/attempts/${encodeURIComponent(attemptId)}/deny`,
      { method: "POST", body: {} },
      cliAuthorizationPollResponseSchema
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

    const headers = new Headers(options.headers);
    headers.set("Authorization", `Bearer ${token}`);
    if (options.body !== undefined && !(options.body instanceof FormData))
      headers.set("Content-Type", "application/json");

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
    const parsed = apiErrorResponseSchema.safeParse(data);
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
