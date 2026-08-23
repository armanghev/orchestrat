import {
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
  taskListQuerySchema,
  taskListResponseSchema,
  claimMutationRequestSchema,
  createDocumentRequestSchema,
  createDocumentResponseSchema,
  documentIdParamsSchema,
  documentListQuerySchema,
  documentListResponseSchema,
  documentResponseSchema,
  updateDocumentRequestSchema,
  updateDocumentResponseSchema
} from "@orchestrat/protocol";
import type {
  ClaimTaskRequest,
  CompleteClaimRequest,
  ReleaseClaimRequest,
  OpenAgentSessionRequest,
  PaginationQuery,
  TaskListQuery,
  CreateDocumentRequest,
  DocumentListQuery,
  UpdateDocumentRequest
} from "@orchestrat/protocol";

type Fetch = typeof globalThis.fetch;
type Sleep = (milliseconds: number) => Promise<void>;
type Schema<T> = { parse(value: unknown): T };

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

  constructor(options: AgentApiClientOptions) {
    this.baseUrl = validateAgentApiBaseUrl(options.baseUrl);
    this.token = options.token;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.sleep = options.sleep ?? defaultSleep;
  }

  openSession(input: OpenAgentSessionRequest) {
    return this.request(
      "POST",
      "/sessions",
      agentSessionResponseSchema,
      openAgentSessionRequestSchema.parse(input)
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

  listDocuments(query: Partial<DocumentListQuery> = {}) {
    const parsed = documentListQuerySchema.parse({ limit: 50, ...query });
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

  private async request<T>(
    method: "GET" | "POST" | "PATCH",
    path: string,
    schema: Schema<T>,
    input?: unknown,
    retryable = false
  ): Promise<T> {
    const body = input === undefined ? undefined : JSON.stringify(input);
    for (let attempt = 0; ; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetch(`${this.baseUrl}/api/v1/agent${path}`, {
          method,
          headers: {
            authorization: `Bearer ${this.token}`,
            ...(body ? { "content-type": "application/json" } : {})
          },
          body
        });
      } catch {
        if (!retryable || attempt > 0)
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
        value = await response.json();
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
