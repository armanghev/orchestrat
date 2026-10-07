import {
  BRANCH_ID_HEADER,
  SESSION_ID_HEADER,
  agentSessionResponseSchema,
  apiErrorResponseSchema,
  claimResponseSchema,
  completeClaimRequestSchema,
  heartbeatResponseSchema,
  openAgentSessionRequestSchema,
  paginationQuerySchema,
  projectEventsResponseSchema,
  agentPresenceSchema,
  claimTaskRequestSchema,
  taskCardSchema,
  taskSchema,
  taskListQuerySchema,
  taskListResponseSchema,
  taskCommentsQuerySchema,
  taskCommentsResponseSchema,
  taskCommentSchema,
  agentCreateTaskRequestSchema,
  updateTaskRequestSchema,
  createTaskCommentRequestSchema,
  claimMutationRequestSchema,
  createDocumentRequestSchema,
  createDocumentResponseSchema,
  createAttachmentUploadRequestSchema,
  documentIdParamsSchema,
  documentListQuerySchema,
  documentListResponseSchema,
  documentResponseSchema,
  updateDocumentRequestSchema,
  updateDocumentResponseSchema,
  agentLifecycleHookResponseSchema,
  agentLifecycleHookRequestSchema,
  projectSchema,
  idParamsSchema,
  messageCandidatesResponseSchema,
  chatsResponseSchema,
  chatSchema,
  chatMessageSchema,
  createChatRequestSchema,
  manageChatMembersRequestSchema,
  sendMessageRequestSchema,
  chatMessagesQuerySchema,
  chatMessagesResponseSchema,
  acknowledgeMessagesRequestSchema,
  acknowledgeMessagesResponseSchema,
  inboxSummarySchema
} from "@orchestrat/protocol";
import type {
  ClaimTaskRequest,
  CompleteClaimRequest,
  ReleaseClaimRequest,
  OpenAgentSessionRequest,
  PaginationQuery,
  TaskListQuery,
  TaskCommentsQuery,
  AgentCreateTaskRequest,
  UpdateTaskRequest,
  CreateTaskCommentRequest,
  CreateDocumentRequest,
  DocumentListQuery,
  UpdateDocumentRequest,
  AgentLifecycleHookRequest,
  CreateChatRequest,
  ManageChatMembersRequest,
  SendMessageRequest,
  ChatMessagesQuery
} from "@orchestrat/protocol";
import {
  parseAttachmentParts,
  parseAttachmentUpload,
  parseCompletedAttachmentUpload,
  parseDocumentRevisionHistory,
  parseHistoricalDocumentRevision,
  documentMutationResponse,
  parseEditDocumentRequest,
  parseRenameDocumentRequest,
  type AttachmentPartsResponse,
  type AttachmentUpload,
  type CreateAttachmentUploadRequest,
  type CompletedAttachmentUpload,
  type DocumentRevisionHistory,
  type HistoricalDocumentRevision,
  type EditDocumentRequest,
  type RenameDocumentRequest
} from "./documents.js";
export * from "./documents.js";
import { AttentionApi } from "./attention.js";
export * from "./attention.js";
import { BranchesApi } from "./branches.js";
export * from "./branches.js";

type Fetch = typeof globalThis.fetch;
type Sleep = (milliseconds: number) => Promise<void>;
type Schema<T> = { parse(value: unknown): T };
type SendMessageInput = Omit<SendMessageRequest, "mentions" | "document_ids"> &
  Partial<Pick<SendMessageRequest, "mentions" | "document_ids">>;
type TaskCommentInput = Omit<CreateTaskCommentRequest, "mentions"> &
  Partial<Pick<CreateTaskCommentRequest, "mentions">>;

export class AgentApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
    readonly requestId?: string
  ) {
    super(message);
    this.name = "AgentApiError";
  }
}

export type AgentApiClientOptions = {
  baseUrl: string;
  token: string;
  fetch?: Fetch;
  sleep?: Sleep;
  /** Sent as X-Orchestrat-Branch-Id; absent = the project's default branch. */
  branchId?: string;
  /**
   * Sent as X-Orchestrat-Session-Id. The server then works on the session's
   * pinned branch and refuses a different branch with BRANCH_MISMATCH.
   */
  sessionId?: string;
};

export function validateAgentApiBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid Orchestrat API URL");
  }
  const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash
  )
    throw new Error("Orchestrat API URL must be HTTPS or loopback HTTP root");
  return url.toString().replace(/\/$/, "");
}

const defaultSleep: Sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export class AgentApiClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetch: Fetch;
  private readonly sleep: Sleep;
  private readonly options: AgentApiClientOptions;
  private readonly branchHeaders: Record<string, string>;
  readonly attention: AttentionApi;
  readonly branches: BranchesApi;

  constructor(options: AgentApiClientOptions) {
    this.baseUrl = validateAgentApiBaseUrl(options.baseUrl);
    this.token = options.token;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.options = options;
    const branchId = options.branchId
      ? idParamsSchema.parse({ id: options.branchId }).id
      : undefined;
    const sessionId = options.sessionId
      ? idParamsSchema.parse({ id: options.sessionId }).id
      : undefined;
    this.branchHeaders = {
      ...(branchId ? { [BRANCH_ID_HEADER]: branchId } : {}),
      ...(sessionId ? { [SESSION_ID_HEADER]: sessionId } : {})
    };
    this.attention = new AttentionApi(this.request.bind(this));
    this.branches = new BranchesApi(this.request.bind(this));
  }

  get branchId() {
    return this.options.branchId;
  }

  get sessionId() {
    return this.options.sessionId;
  }

  /**
   * A copy that works on another branch. It drops the session pin, which
   * belongs to the old branch; open a session on the copy to pin again.
   */
  withBranch(branchId: string | undefined): AgentApiClient {
    return new AgentApiClient({
      ...this.options,
      branchId,
      sessionId: undefined
    });
  }

  /** A copy whose requests are pinned to an open session's branch. */
  withSession(sessionId: string | undefined): AgentApiClient {
    return new AgentApiClient({ ...this.options, sessionId });
  }

  openSession(input: OpenAgentSessionRequest) {
    return this.request(
      "POST",
      "/sessions",
      agentSessionResponseSchema,
      openAgentSessionRequestSchema.parse({
        ...(this.options.branchId ? { branch_id: this.options.branchId } : {}),
        ...input
      })
    );
  }

  heartbeat(sessionId: string) {
    return this.request(
      "POST",
      `/sessions/${encodeURIComponent(sessionId)}/heartbeat`,
      heartbeatResponseSchema
    );
  }

  closeSession(sessionId: string) {
    return this.request(
      "POST",
      `/sessions/${encodeURIComponent(sessionId)}/close`,
      agentSessionResponseSchema
    );
  }

  getProject() {
    return this.request("GET", "/project", projectSchema, undefined, true);
  }

  listMessageCandidates() {
    return this.request(
      "GET",
      "/message-candidates",
      messageCandidatesResponseSchema,
      undefined,
      true
    );
  }

  listChats() {
    return this.request("GET", "/chats", chatsResponseSchema, undefined, true);
  }

  getChat(chatId: string) {
    const id = idParamsSchema.parse({ id: chatId }).id;
    return this.request(
      "GET",
      `/chats/${encodeURIComponent(id)}`,
      chatSchema,
      undefined,
      true
    );
  }

  createChat(input: CreateChatRequest, idempotencyKey: string) {
    return this.request(
      "POST",
      "/chats",
      chatSchema,
      createChatRequestSchema.parse(input),
      false,
      { "idempotency-key": idempotencyKey }
    );
  }

  manageChatMembers(chatId: string, input: ManageChatMembersRequest) {
    const id = idParamsSchema.parse({ id: chatId }).id;
    return this.request(
      "POST",
      `/chats/${encodeURIComponent(id)}/members`,
      chatSchema,
      manageChatMembersRequestSchema.parse(input)
    );
  }

  listChatMessages(chatId: string, query: Partial<ChatMessagesQuery> = {}) {
    const id = idParamsSchema.parse({ id: chatId }).id;
    const parsed = chatMessagesQuerySchema.parse({ limit: 50, ...query });
    return this.request(
      "GET",
      `/chats/${encodeURIComponent(id)}/messages${queryString(parsed)}`,
      chatMessagesResponseSchema,
      undefined,
      true
    );
  }

  sendMessage(chatId: string, input: SendMessageInput, idempotencyKey: string) {
    const id = idParamsSchema.parse({ id: chatId }).id;
    return this.request(
      "POST",
      `/chats/${encodeURIComponent(id)}/messages`,
      chatMessageSchema,
      sendMessageRequestSchema.parse(input),
      false,
      { "idempotency-key": idempotencyKey }
    );
  }

  acknowledgeMessages(chatId: string, throughMessageId: string) {
    const id = idParamsSchema.parse({ id: chatId }).id;
    return this.request(
      "POST",
      `/chats/${encodeURIComponent(id)}/read`,
      acknowledgeMessagesResponseSchema,
      acknowledgeMessagesRequestSchema.parse({
        through_message_id: throughMessageId
      })
    );
  }

  getInbox(signal?: AbortSignal) {
    return this.request(
      "GET",
      "/inbox",
      inboxSummarySchema,
      undefined,
      true,
      {},
      signal
    );
  }

  listTasks(query: Partial<TaskListQuery> = {}) {
    const parsed = taskListQuerySchema.parse(query);
    return this.request(
      "GET",
      `/tasks${queryString(parsed)}`,
      taskListResponseSchema,
      undefined,
      true
    );
  }

  getTask(taskId: string) {
    return this.request(
      "GET",
      `/tasks/${encodeURIComponent(taskId)}`,
      taskCardSchema,
      undefined,
      true
    );
  }

  createTask(input: AgentCreateTaskRequest, idempotencyKey: string) {
    return this.request(
      "POST",
      "/tasks",
      taskSchema,
      agentCreateTaskRequestSchema.parse(input),
      false,
      { "idempotency-key": idempotencyKey }
    );
  }

  updateTask(taskId: string, input: UpdateTaskRequest) {
    return this.request(
      "PATCH",
      `/tasks/${encodeURIComponent(taskId)}`,
      taskSchema,
      updateTaskRequestSchema.parse(input)
    );
  }

  listTaskComments(taskId: string, query: Partial<TaskCommentsQuery> = {}) {
    const parsed = taskCommentsQuerySchema.parse(query);
    return this.request(
      "GET",
      `/tasks/${encodeURIComponent(taskId)}/comments${queryString(parsed)}`,
      taskCommentsResponseSchema,
      undefined,
      true
    );
  }

  addTaskComment(
    taskId: string,
    input: TaskCommentInput,
    idempotencyKey: string
  ) {
    return this.request(
      "POST",
      `/tasks/${encodeURIComponent(taskId)}/comments`,
      taskCommentSchema,
      createTaskCommentRequestSchema.parse(input),
      false,
      { "idempotency-key": idempotencyKey }
    );
  }

  claimTask(taskId: string, input: ClaimTaskRequest) {
    return this.request(
      "POST",
      `/tasks/${encodeURIComponent(taskId)}/claim`,
      claimResponseSchema,
      claimTaskRequestSchema.parse(input)
    );
  }

  releaseClaim(sessionId: string, input: ReleaseClaimRequest) {
    return this.request(
      "POST",
      `/sessions/${encodeURIComponent(sessionId)}/claims/release`,
      claimResponseSchema.pick({ claim: true }),
      claimMutationRequestSchema.parse(input)
    );
  }

  completeClaim(sessionId: string, input: CompleteClaimRequest) {
    return this.request(
      "POST",
      `/sessions/${encodeURIComponent(sessionId)}/claims/complete`,
      claimResponseSchema.pick({ claim: true }),
      completeClaimRequestSchema.parse(input)
    );
  }

  getPresence() {
    return this.request(
      "GET",
      "/presence",
      { parse: (value: unknown) => parseAgents(value) },
      undefined,
      true
    );
  }

  listAgents() {
    return this.getPresence();
  }

  listEvents(query: Partial<PaginationQuery> = {}) {
    const parsed = paginationQuerySchema.parse(query);
    return this.request(
      "GET",
      `/events${queryString(parsed)}`,
      projectEventsResponseSchema,
      undefined,
      true
    );
  }

  listDocuments(
    query: Partial<DocumentListQuery> & { include_archived?: boolean } = {}
  ) {
    const parsed = documentListQuerySchema.parse({
      limit: 50,
      ...query,
      ...(query.include_archived === undefined
        ? {}
        : { include_archived: String(query.include_archived) })
    });
    return this.request(
      "GET",
      `/documents${queryString(parsed)}`,
      documentListResponseSchema,
      undefined,
      true
    );
  }

  readDocument(documentId: string) {
    const id = documentIdParamsSchema.parse({ id: documentId }).id;
    return this.request(
      "GET",
      `/documents/${encodeURIComponent(id)}`,
      documentResponseSchema,
      undefined,
      true
    );
  }

  createDocument(input: CreateDocumentRequest) {
    return this.request(
      "POST",
      "/documents",
      createDocumentResponseSchema,
      createDocumentRequestSchema.parse(input)
    );
  }

  updateDocument(documentId: string, input: UpdateDocumentRequest) {
    const id = documentIdParamsSchema.parse({ id: documentId }).id;
    return this.request(
      "PATCH",
      `/documents/${encodeURIComponent(id)}`,
      updateDocumentResponseSchema,
      updateDocumentRequestSchema.parse(input)
    );
  }

  editDocument(documentId: string, input: EditDocumentRequest) {
    const id = documentIdParamsSchema.parse({ id: documentId }).id;
    return this.request(
      "POST",
      `/documents/${encodeURIComponent(id)}/edits`,
      documentResponseSchema,
      parseEditDocumentRequest(input)
    );
  }

  renameDocument(documentId: string, input: RenameDocumentRequest) {
    const id = documentIdParamsSchema.parse({ id: documentId }).id;
    return this.request(
      "PATCH",
      `/documents/${encodeURIComponent(id)}/path`,
      documentMutationResponse,
      parseRenameDocumentRequest(input)
    );
  }

  archiveDocument(documentId: string) {
    return this.documentLifecycle(documentId, "archive");
  }

  restoreDocument(documentId: string) {
    return this.documentLifecycle(documentId, "restore");
  }

  listDocumentRevisions(
    documentId: string,
    query: { limit?: number; cursor?: string } = {}
  ): Promise<DocumentRevisionHistory> {
    const id = documentIdParamsSchema.parse({ id: documentId }).id;
    const limit = query.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new Error("revision limit must be between 1 and 100");
    return this.request(
      "GET",
      `/documents/${encodeURIComponent(id)}/revisions${queryString({
        view: "summary",
        limit,
        cursor: query.cursor
      })}`,
      { parse: parseDocumentRevisionHistory },
      undefined,
      true
    );
  }

  readDocumentRevision(
    documentId: string,
    revision: number
  ): Promise<HistoricalDocumentRevision> {
    const id = documentIdParamsSchema.parse({ id: documentId }).id;
    if (!Number.isInteger(revision) || revision < 1)
      throw new Error("revision must be a positive integer");
    return this.request(
      "GET",
      `/documents/${encodeURIComponent(id)}/revisions/${revision}`,
      { parse: parseHistoricalDocumentRevision },
      undefined,
      true
    );
  }

  startDocumentAttachmentUpload(
    documentId: string,
    input: CreateAttachmentUploadRequest
  ): Promise<AttachmentUpload> {
    const id = documentIdParamsSchema.parse({ id: documentId }).id;
    return this.request(
      "POST",
      `/documents/${encodeURIComponent(id)}/attachments/uploads`,
      { parse: parseAttachmentUpload },
      createAttachmentUploadRequestSchema.parse(input)
    );
  }

  getDocumentAttachmentUpload(
    documentId: string,
    uploadSessionId: string
  ): Promise<AttachmentUpload> {
    const id = documentIdParamsSchema.parse({ id: documentId }).id;
    return this.request(
      "GET",
      `/documents/${encodeURIComponent(id)}/attachments/uploads/${encodeURIComponent(uploadSessionId)}`,
      { parse: parseAttachmentUpload },
      undefined,
      true
    );
  }

  refreshAttachmentUpload(
    documentId: string,
    uploadSessionId: string
  ): Promise<AttachmentUpload> {
    const id = documentIdParamsSchema.parse({ id: documentId }).id;
    return this.request(
      "POST",
      `/documents/${encodeURIComponent(id)}/attachments/uploads/${encodeURIComponent(uploadSessionId)}/refresh`,
      { parse: parseAttachmentUpload },
      {}
    );
  }

  refreshDocumentAttachmentParts(
    documentId: string,
    uploadSessionId: string,
    partNumbers: number[]
  ): Promise<AttachmentPartsResponse> {
    if (
      !partNumbers.length ||
      partNumbers.length > 100 ||
      new Set(partNumbers).size !== partNumbers.length ||
      partNumbers.some(
        (part) => !Number.isInteger(part) || part < 1 || part > 10_000
      )
    )
      throw new Error(
        "part numbers must contain 1-100 unique positive integers"
      );
    const id = documentIdParamsSchema.parse({ id: documentId }).id;
    return this.request(
      "POST",
      `/documents/${encodeURIComponent(id)}/attachments/uploads/${encodeURIComponent(uploadSessionId)}/parts`,
      { parse: parseAttachmentParts },
      { part_numbers: partNumbers }
    );
  }

  completeDocumentAttachmentUpload(
    documentId: string,
    uploadSessionId: string,
    parts?: Array<{ part_number: number; etag: string }>
  ): Promise<CompletedAttachmentUpload> {
    const id = documentIdParamsSchema.parse({ id: documentId }).id;
    return this.request(
      "POST",
      `/documents/${encodeURIComponent(id)}/attachments/uploads/${encodeURIComponent(uploadSessionId)}/complete`,
      { parse: parseCompletedAttachmentUpload },
      { parts }
    );
  }

  abortDocumentAttachmentUpload(documentId: string, uploadSessionId: string) {
    const id = documentIdParamsSchema.parse({ id: documentId }).id;
    return this.request(
      "DELETE",
      `/documents/${encodeURIComponent(id)}/attachments/uploads/${encodeURIComponent(uploadSessionId)}`,
      { parse: (value: unknown) => value }
    );
  }

  downloadDocumentAttachment(
    documentId: string,
    attachmentId: string
  ): Promise<{ download_url: string }> {
    const id = documentIdParamsSchema.parse({ id: documentId }).id;
    return this.request(
      "POST",
      `/documents/${encodeURIComponent(id)}/attachments/${encodeURIComponent(attachmentId)}/download`,
      {
        parse: (value: unknown) => {
          const url = (value as { download_url?: unknown })?.download_url;
          if (typeof url !== "string")
            throw new Error("invalid download response");
          return {
            download_url: new URL(url, `${this.baseUrl}/`).toString()
          };
        }
      },
      {}
    );
  }

  async putPresignedObject(
    url: string,
    body: BodyInit,
    contentType?: string,
    contentLength?: number
  ) {
    const uploadBody = contentLength === 0 ? new Uint8Array(0) : body;
    const response = await this.fetch(url, {
      method: "PUT",
      headers: {
        ...(contentType ? { "content-type": contentType } : {}),
        ...(contentLength === undefined
          ? {}
          : { "content-length": String(contentLength) })
      },
      body: uploadBody,
      ...(typeof uploadBody === "object" ? { duplex: "half" as const } : {})
    });
    if (!response.ok)
      throw new AgentApiError(
        response.status,
        "STORAGE_UPLOAD_FAILED",
        "Object upload failed."
      );
    return response.headers.get("etag") ?? undefined;
  }

  private documentLifecycle(documentId: string, action: "archive" | "restore") {
    const id = documentIdParamsSchema.parse({ id: documentId }).id;
    return this.request(
      "POST",
      `/documents/${encodeURIComponent(id)}/${action}`,
      documentMutationResponse,
      {}
    );
  }

  ingestLifecycle(input: AgentLifecycleHookRequest, idempotencyKey: string) {
    return this.request(
      "POST",
      "/hooks/lifecycle",
      agentLifecycleHookResponseSchema,
      agentLifecycleHookRequestSchema.parse(input),
      false,
      { "idempotency-key": idempotencyKey }
    );
  }

  private async request<T>(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    schema: Schema<T>,
    input?: unknown,
    retryable = false,
    extraHeaders: Record<string, string> = {},
    signal?: AbortSignal
  ): Promise<T> {
    const body = input === undefined ? undefined : JSON.stringify(input);
    for (let attempt = 0; ; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetch(`${this.baseUrl}/api/v1/agent${path}`, {
          method,
          headers: {
            authorization: `Bearer ${this.token}`,
            ...this.branchHeaders,
            ...extraHeaders,
            ...(body ? { "content-type": "application/json" } : {})
          },
          signal,
          body
        });
      } catch {
        if (!retryable || attempt > 0 || signal?.aborted)
          throw new AgentApiError(
            0,
            "NETWORK_ERROR",
            "The API request failed."
          );
        await this.sleep(100);
        continue;
      }
      let value: unknown;
      try {
        const text = await response.text();
        value = text.length ? JSON.parse(text) : undefined;
      } catch {
        throw new AgentApiError(
          response.status,
          "INTERNAL_ERROR",
          "The API returned an invalid response."
        );
      }
      if (!response.ok) throw this.error(response.status, value);
      try {
        return schema.parse(value);
      } catch {
        throw new AgentApiError(
          response.status,
          "INTERNAL_ERROR",
          "The API returned an invalid response."
        );
      }
    }
  }

  private error(status: number, value: unknown) {
    const parsed = apiErrorResponseSchema.safeParse(value);
    return parsed.success
      ? new AgentApiError(
          status,
          parsed.data.error.code,
          parsed.data.error.message,
          parsed.data.error.details,
          parsed.data.error.request_id
        )
      : new AgentApiError(
          status,
          "INTERNAL_ERROR",
          "The API returned an invalid error response."
        );
  }
}

const parseAgents = (value: unknown) => {
  const parsed = Array.isArray((value as { agents?: unknown })?.agents)
    ? (value as { agents: unknown[] }).agents.map((agent) =>
        agentPresenceSchema.parse(agent)
      )
    : [];
  if (!Array.isArray((value as { agents?: unknown })?.agents))
    throw new Error("invalid agents response");
  return { agents: parsed };
};

const queryString = (query: Record<string, unknown>) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query))
    if (value !== undefined) params.set(key, String(value));
  const encoded = params.toString();
  return encoded ? `?${encoded}` : "";
};

export { ProjectsApi } from "./projects.js";
