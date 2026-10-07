import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { AgentApiClient, AgentApiError } from "@orchestrat/sdk";
import {
  createDocumentRequestSchema,
  documentConflictDetailsSchema,
  documentEditMismatchDetailsSchema,
  documentListQuerySchema,
  updateDocumentRequestSchema,
  editDocumentRequestSchema,
  agentCreateTaskRequestSchema,
  agentUpdateTaskRequestSchema,
  agentBulkCreateTasksRequestSchema,
  agentBulkUpdateTasksRequestSchema,
  createTaskCommentRequestSchema,
  createChatRequestSchema,
  manageChatMembersRequestSchema,
  sendMessageRequestSchema,
  unreadCommentsErrorDetailsSchema,
  type AttentionSummary
} from "@orchestrat/protocol";
import { z } from "zod";
import { cliSetupIntegrationSchema } from "@orchestrat/protocol";
import {
  attentionNotice,
  registerAttentionTools,
  type AttentionToolHost
} from "./attention-tools.js";
import {
  BranchController,
  registerBranchTools,
  type BranchNotice,
  type CheckoutBranch
} from "./branch-tools.js";
export type { CheckoutBranch } from "./branch-tools.js";

export const mcpPackage = "@orchestrat/mcp";

type Client = Pick<
  AgentApiClient,
  | "openSession"
  | "heartbeat"
  | "closeSession"
  | "getProject"
  | "listTasks"
  | "getTask"
  | "createTask"
  | "updateTask"
  | "createTasks"
  | "updateTasks"
  | "listTaskComments"
  | "addTaskComment"
  | "listAgents"
  | "claimTask"
  | "releaseClaim"
  | "completeClaim"
  | "listEvents"
  | "listDocuments"
  | "readDocument"
  | "createDocument"
  | "updateDocument"
  | "editDocument"
  | "listDocumentRevisions"
  | "readDocumentRevision"
  | "listMessageCandidates"
  | "listChats"
  | "getChat"
  | "createChat"
  | "manageChatMembers"
  | "listChatMessages"
  | "sendMessage"
  | "acknowledgeMessages"
  | "getInbox"
  | "attention"
> &
  // Absent on clients from before branches; the bridge then never switches.
  Partial<Pick<AgentApiClient, "branches" | "withBranch" | "withSession">>;
export type BridgeOptions = {
  client?: Client;
  projects?: { id: string; name: string; client: Client }[];
  integration: z.infer<typeof cliSetupIntegrationSchema>;
  runtime?: string;
  heartbeatMs?: number;
  inboxTimeoutMs?: number;
  waitBudgetSeconds?: number;
  /** Project-scoped CLI only: the branch the Git checkout is on. */
  resolveCheckoutBranch?: () => Promise<CheckoutBranch | null>;
};
type Claim = { task_id: string; [key: string]: unknown };

export class ClaimTokenStore {
  private readonly tokens = new Map<string, string>();
  set(claim: Claim, token: string) {
    this.tokens.set(claim.task_id, token);
  }
  get(taskId: string) {
    return this.tokens.get(taskId);
  }
  take(taskId: string) {
    const token = this.tokens.get(taskId);
    if (token) this.tokens.delete(taskId);
    return token;
  }
  clear() {
    this.tokens.clear();
  }
  taskIds() {
    return [...this.tokens.keys()];
  }
}

const bulkItemDetailsSchema = z.object({
  index: z.number().int().min(0),
  task_id: z.string().optional(),
  title: z.string().optional()
});

// Bulk inputs are checked here (duplicate task_ids, per-item rules) so the
// agent gets the failing index instead of a generic failure.
function parseBulkInput<T>(
  schema: { safeParse(value: unknown): z.ZodSafeParseResult<T> },
  input: unknown
): T {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0]!;
  const index =
    issue.path[0] === "tasks" && typeof issue.path[1] === "number"
      ? issue.path[1]
      : undefined;
  if (index === undefined)
    throw new AgentApiError(400, "VALIDATION_ERROR", issue.message);
  const item = (input as { tasks: { task_id?: unknown; title?: unknown }[] })
    .tasks[index];
  throw new AgentApiError(
    400,
    "VALIDATION_ERROR",
    `tasks[${index}] is invalid: ${issue.message}`,
    {
      index,
      ...(typeof item?.task_id === "string" ? { task_id: item.task_id } : {}),
      ...(typeof item?.title === "string" ? { title: item.title } : {})
    }
  );
}

export function mapMcpError(error: unknown) {
  const known = error instanceof AgentApiError;
  const requestId = known ? error.requestId : undefined;
  const parsedDetails =
    known && error.code === "DOCUMENT_CONFLICT"
      ? documentConflictDetailsSchema.safeParse(error.details)
      : known && error.code === "DOCUMENT_EDIT_MISMATCH"
        ? documentEditMismatchDetailsSchema.safeParse(error.details)
        : known && error.code === "TASK_VERSION_CONFLICT"
          ? z
              .object({ current_version: z.number().int().min(1) })
              .safeParse(error.details)
          : known && error.code === "TASK_COMMENTS_UNREAD"
            ? unreadCommentsErrorDetailsSchema.safeParse(error.details)
            : known && error.code === "TASK_NOT_CLAIMABLE"
              ? z.object({ reason: z.string() }).safeParse(error.details)
              : undefined;
  // Bulk tools name the failing item; keep that next to any typed details.
  const item = known
    ? bulkItemDetailsSchema.safeParse(error.details)
    : undefined;
  const details =
    parsedDetails?.success || item?.success
      ? {
          ...(parsedDetails?.success ? parsedDetails.data : {}),
          ...(item?.success ? item.data : {})
        }
      : undefined;
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          error: {
            code: known ? error.code : "INTERNAL_ERROR",
            message: known ? error.message : "The Orchestrat request failed.",
            ...(details ? { details } : {}),
            ...(requestId ? { request_id: requestId } : {})
          }
        })
      }
    ]
  };
}
const success = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }]
});
const taskIdInput = { task_id: z.string().uuid() };
// Shared by update_task and update_tasks so the two never disagree.
const statusRules =
  "status moves an unclaimed task to any column except claimed (e.g. backlog to ready). A task claimed by another agent is refused with TASK_NOT_CLAIMABLE; for a task this agent has claimed, use set_task_status, complete_task or release_task instead. Moving to review or done applies complete_task's unread-comment check: on TASK_COMMENTS_UNREAD, read the returned comments and retry with acknowledged_through set to details.latest_sequence.";
const listTasksInput = {
  status: z
    .enum([
      "backlog",
      "ready",
      "claimed",
      "in_progress",
      "blocked",
      "review",
      "done",
      "cancelled"
    ])
    .optional(),
  priority: z.enum(["urgent", "high", "medium", "low", "none"]).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).optional()
};

export class McpBridge {
  readonly server: McpServer;
  readonly claims = new ClaimTokenStore();
  private sessionId?: string;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private stopping?: Promise<void>;
  // `base` is the project client; `client` is scoped to the session's branch.
  private base?: Client;
  private client?: Client;
  private readonly branches: BranchController<Client>;
  private attentionUnsupported = false;
  constructor(private readonly options: BridgeOptions) {
    this.base = options.client;
    this.client = options.client;
    this.branches = new BranchController<Client>({
      base: () => this.base,
      client: () => this.client,
      session: () => this.sessionId,
      adopt: (client, sessionId) => {
        this.client = client;
        this.sessionId = sessionId;
      },
      claims: this.claims,
      openInput: () => ({
        runtime: this.options.runtime ?? this.options.integration,
        integration: this.options.integration
      }),
      resolveCheckout: options.resolveCheckoutBranch
    });
    this.server = new McpServer({ name: "orchestrat", version: "0.1.0" });
    this.server.server.onclose = () => {
      void this.stop().catch((error) => this.reportCleanupError(error));
    };
    this.registerTools();
  }
  async start() {
    if (!this.client) return this.server;
    await this.branches.start();
    this.startHeartbeat();
    return this.server;
  }
  async stop() {
    if (this.stopping) return this.stopping;
    this.stopping = (async () => {
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      const sessionId = this.sessionId;
      this.sessionId = undefined;
      this.claims.clear();
      try {
        await this.server.close();
      } catch (error) {
        this.reportCleanupError(error);
      }
      if (sessionId)
        try {
          await this.activeClient().closeSession(sessionId);
        } catch (error) {
          this.reportCleanupError(error);
        }
    })();
    return this.stopping;
  }
  private reportCleanupError(error: unknown) {
    process.stderr.write(
      `orchestrat: cleanup failed: ${error instanceof Error ? error.message : "unknown error"}\n`
    );
  }
  private async heartbeat() {
    if (!this.sessionId) return;
    try {
      await this.activeClient().heartbeat(this.sessionId);
    } catch (error) {
      process.stderr.write(
        `orchestrat: heartbeat failed: ${error instanceof Error ? error.message : "unknown error"}\n`
      );
    }
  }
  private startHeartbeat() {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(
      () => void this.heartbeat(),
      this.options.heartbeatMs ?? 20_000
    );
    this.heartbeatTimer.unref?.();
  }
  private registerTools() {
    if (this.options.projects) {
      this.server.registerTool(
        "list_projects",
        {
          description:
            "List Orchestrat projects available to this global Cursor connection.",
          inputSchema: {}
        },
        async () =>
          this.call(() =>
            Promise.resolve(
              this.options.projects!.map(({ id, name }) => ({
                project_id: id,
                name
              }))
            )
          )
      );
      this.server.registerTool(
        "select_project",
        {
          description:
            "Select the Orchestrat project for subsequent work in this global Cursor connection.",
          inputSchema: { project_id: z.string().uuid() }
        },
        async ({ project_id }) =>
          this.call(() => this.selectProject(project_id), {
            inboxClient:
              this.options.projects?.find(
                (project) => project.id === project_id
              )?.client ?? null
          })
      );
    }
    this.server.registerTool(
      "get_project",
      {
        description: "Get the selected project for this authenticated agent.",
        inputSchema: {}
      },
      async () =>
        this.call(async () => ({
          ...(await this.activeClient().getProject()),
          ...(await this.branches.describe())
        }))
    );
    this.server.registerTool(
      "list_tasks",
      {
        description: "List project tasks visible to this authenticated agent.",
        inputSchema: listTasksInput
      },
      async (input) => this.call(() => this.activeClient().listTasks(input))
    );
    this.server.registerTool(
      "get_task",
      {
        description:
          "Get one task. Claim/release/complete require this session and current claim ownership.",
        inputSchema: taskIdInput
      },
      async ({ task_id }) =>
        this.call(() => this.activeClient().getTask(task_id))
    );
    this.server.registerTool(
      "create_task",
      {
        description:
          "Create a task authored by this agent. Supply a stable idempotency_key and reuse the same key and body after an ambiguous response.",
        inputSchema: {
          ...agentCreateTaskRequestSchema.shape,
          idempotency_key: z.string().trim().min(1).max(128)
        }
      },
      async ({ idempotency_key, ...input }) =>
        this.call(() =>
          this.activeClient().createTask(
            agentCreateTaskRequestSchema.parse(input),
            idempotency_key
          )
        )
    );
    this.server.registerTool(
      "update_task",
      {
        description: `Update task title, description, priority, or status using the current expected_version. ${statusRules}`,
        inputSchema: {
          ...taskIdInput,
          ...agentUpdateTaskRequestSchema.shape
        }
      },
      async ({ task_id, ...input }) =>
        this.call(() =>
          this.activeClient().updateTask(
            task_id,
            agentUpdateTaskRequestSchema.parse(input)
          )
        )
    );
    this.server.registerTool(
      "create_tasks",
      {
        description:
          "Create 1-50 tasks authored by this agent in one all-or-nothing batch; keys are allocated and results returned in input order. Supply a stable idempotency_key and reuse the same key and body after an ambiguous response. On error nothing was created and details.index names the failing item.",
        inputSchema: {
          ...agentBulkCreateTasksRequestSchema.shape,
          idempotency_key: z.string().trim().min(1).max(128)
        }
      },
      async ({ idempotency_key, ...input }) =>
        this.call(() =>
          this.activeClient().createTasks(
            parseBulkInput(agentBulkCreateTasksRequestSchema, input),
            idempotency_key
          )
        )
    );
    this.server.registerTool(
      "update_tasks",
      {
        description: `Update 1-50 distinct tasks in one all-or-nothing batch; each item follows update_task's rules and results come back in input order. On error nothing was changed and details.index and details.task_id name the failing item. ${statusRules}`,
        inputSchema: agentBulkUpdateTasksRequestSchema.shape
      },
      async (input) =>
        this.call(() =>
          this.activeClient().updateTasks(
            parseBulkInput(agentBulkUpdateTasksRequestSchema, input)
          )
        )
    );
    this.server.registerTool(
      "list_task_comments",
      {
        description: "Read chronological human and agent comments on a task.",
        inputSchema: {
          ...taskIdInput,
          limit: z.number().int().min(1).max(100).optional(),
          cursor: z.string().min(1).optional()
        }
      },
      async ({ task_id, limit, cursor }) =>
        this.call(() =>
          this.activeClient().listTaskComments(task_id, { limit, cursor })
        )
    );
    this.server.registerTool(
      "add_task_comment",
      {
        description:
          "Add an agent-authored Markdown comment. Supply a stable idempotency_key and reuse it with the same body after an ambiguous response; commenting does not claim the task.",
        inputSchema: {
          ...taskIdInput,
          ...createTaskCommentRequestSchema.shape,
          idempotency_key: z.string().trim().min(1).max(128)
        }
      },
      async ({ task_id, idempotency_key, ...input }) =>
        this.call(() =>
          this.activeClient().addTaskComment(
            task_id,
            createTaskCommentRequestSchema.parse(input),
            idempotency_key
          )
        )
    );
    this.server.registerTool(
      "list_agents",
      {
        description: "List existing agent presence for the selected project.",
        inputSchema: {}
      },
      async () => this.call(() => this.activeClient().listAgents())
    );
    this.server.registerTool(
      "claim_task",
      {
        description:
          "Claim a ready task for this active session; the claim token stays process-local and is never returned.",
        inputSchema: {
          ...taskIdInput,
          lease_seconds: z.number().int().min(30).max(86400).optional()
        }
      },
      async ({ task_id, lease_seconds }) =>
        this.call(async () => {
          const sessionId = this.requireSession();
          const result = await this.activeClient().claimTask(task_id, {
            session_id: sessionId,
            lease_seconds: lease_seconds ?? 300
          });
          this.claims.set(result.claim, result.claim_token);
          return { claim: result.claim };
        })
    );
    for (const [name, action] of [
      ["release_task", "releaseClaim"],
      ["complete_task", "completeClaim"]
    ] as const)
      this.server.registerTool(
        name,
        {
          description: `${name === "release_task" ? "Release" : "Complete"} a task claim owned by this active session; claim token is process-local. On TASK_COMMENTS_UNREAD, read the returned comments and retry with acknowledged_through set to details.latest_sequence.`,
          inputSchema: {
            ...taskIdInput,
            acknowledged_through: z.number().int().nonnegative().optional()
          }
        },
        async ({ task_id, acknowledged_through }) =>
          this.call(async () => {
            const token = this.claims.get(task_id);
            if (!token)
              throw new AgentApiError(
                400,
                "CLAIM_NOT_FOUND",
                "No local claim token for this task."
              );
            const result = await this.activeClient()[action](
              this.requireSession(),
              {
                claim_token: token,
                ...(acknowledged_through === undefined
                  ? {}
                  : { acknowledged_through })
              }
            );
            // Only a successful mutation ends the claim; on 409 the agent
            // still holds it and retries with the same local token.
            this.claims.take(task_id);
            return result;
          })
      );
    this.server.registerTool(
      "get_recent_activity",
      {
        description:
          "Read recent project activity available to this authenticated agent.",
        inputSchema: {
          limit: z.number().int().min(1).max(100).optional(),
          after: z.string().min(1).optional()
        }
      },
      async (input) => this.call(() => this.activeClient().listEvents(input))
    );
    this.server.registerTool(
      "heartbeat",
      {
        description: "Renew this active agent session and its claims.",
        inputSchema: {}
      },
      async () =>
        this.call(() => this.activeClient().heartbeat(this.requireSession()))
    );
    this.server.registerTool(
      "list_documents",
      {
        description:
          "List project documents visible to this authenticated agent. Read content with read_document.",
        inputSchema: {
          limit: z.number().int().min(1).max(100).optional(),
          cursor: z.string().min(1).optional()
        }
      },
      async (input) =>
        this.call(() =>
          this.activeClient().listDocuments(
            documentListQuerySchema.parse(input)
          )
        )
    );
    this.server.registerTool(
      "read_document",
      {
        description:
          "Read the current revision and content of one project document.",
        inputSchema: { document_id: z.string().uuid() }
      },
      async ({ document_id }) =>
        this.call(() => this.activeClient().readDocument(document_id))
    );
    this.server.registerTool(
      "create_document",
      {
        description:
          "Create a project document at a project-relative POSIX path; paths must be unique.",
        inputSchema: {
          path: z.string().min(1).max(1024),
          content: z.string().max(1_000_000)
        }
      },
      async (input) =>
        this.call(() =>
          this.activeClient().createDocument(
            createDocumentRequestSchema.parse(input)
          )
        )
    );
    this.server.registerTool(
      "update_document",
      {
        description:
          "Create a new revision only when base_revision matches current; stale updates return DOCUMENT_CONFLICT and never overwrite content.",
        inputSchema: {
          document_id: z.string().uuid(),
          content: z.string().max(1_000_000),
          base_revision: z.number().int().min(1)
        }
      },
      async ({ document_id, ...input }) =>
        this.call(() =>
          this.activeClient().updateDocument(
            document_id,
            updateDocumentRequestSchema.parse(input)
          )
        )
    );
    this.server.registerTool(
      "edit_document",
      {
        description:
          "Apply exact sequential text replacements against a document revision. Every old_text must match exactly once.",
        inputSchema: {
          document_id: z.string().uuid(),
          base_revision: editDocumentRequestSchema.shape.base_revision,
          edits: editDocumentRequestSchema.shape.edits.min(1)
        }
      },
      async ({ document_id, ...input }) =>
        this.call(() => this.activeClient().editDocument(document_id, input))
    );
    this.server.registerTool(
      "list_document_revisions",
      {
        description:
          "List document revision metadata without fetching revision bodies.",
        inputSchema: {
          document_id: z.string().uuid(),
          limit: z.number().int().min(1).max(100).optional(),
          cursor: z.string().min(1).optional()
        }
      },
      async ({ document_id, limit, cursor }) =>
        this.call(() =>
          this.activeClient().listDocumentRevisions(document_id, {
            limit,
            cursor
          })
        )
    );
    this.server.registerTool(
      "read_document_revision",
      {
        description: "Read one historical document revision and its content.",
        inputSchema: {
          document_id: z.string().uuid(),
          revision: z.number().int().min(1)
        }
      },
      async ({ document_id, revision }) =>
        this.call(() =>
          this.activeClient().readDocumentRevision(document_id, revision)
        )
    );
    this.server.registerTool(
      "list_message_candidates",
      {
        description:
          "List humans and agents eligible to participate in project chats.",
        inputSchema: {}
      },
      async () => this.call(() => this.activeClient().listMessageCandidates())
    );
    this.server.registerTool(
      "list_chats",
      {
        description:
          "List chats visible to this authenticated agent, including unread counts.",
        inputSchema: {}
      },
      async () => this.call(() => this.activeClient().listChats())
    );
    this.server.registerTool(
      "create_chat",
      {
        description:
          "Create a direct or named group chat. Supply a stable idempotency_key and reuse it with the same request after an ambiguous response.",
        inputSchema: {
          ...createChatRequestSchema.shape,
          idempotency_key: z.string().trim().min(1).max(128)
        }
      },
      async ({ idempotency_key, ...input }) =>
        this.call(() =>
          this.activeClient().createChat(
            createChatRequestSchema.parse(input),
            idempotency_key
          )
        )
    );
    this.server.registerTool(
      "manage_chat_members",
      {
        description:
          "Add or remove one participant from a group chat. Direct chat membership is fixed.",
        inputSchema: {
          chat_id: z.string().uuid(),
          ...manageChatMembersRequestSchema.shape
        }
      },
      async ({ chat_id, ...input }) =>
        this.call(() =>
          this.activeClient().manageChatMembers(
            chat_id,
            manageChatMembersRequestSchema.parse(input)
          )
        )
    );
    this.server.registerTool(
      "send_message",
      {
        description:
          "Send an immutable Markdown message to a chat. Supply a stable idempotency_key and reuse it with the same request after an ambiguous response.",
        inputSchema: {
          chat_id: z.string().uuid(),
          ...sendMessageRequestSchema.shape,
          idempotency_key: z.string().trim().min(1).max(128)
        }
      },
      async ({ chat_id, idempotency_key, ...input }) =>
        this.call(() =>
          this.activeClient().sendMessage(
            chat_id,
            sendMessageRequestSchema.parse(input),
            idempotency_key
          )
        )
    );
    this.server.registerTool(
      "check_messages",
      {
        description:
          "Read chat messages without marking them read. With no cursor, returns the oldest unread page.",
        inputSchema: {
          chat_id: z.string().uuid(),
          after: z.number().int().nonnegative().optional(),
          before: z.number().int().positive().optional(),
          unread_only: z.boolean().optional(),
          limit: z.number().int().min(1).max(100).optional()
        }
      },
      async ({ chat_id, ...input }) =>
        this.call(() =>
          this.activeClient().listChatMessages(chat_id, {
            ...input,
            ...(input.after === undefined &&
            input.before === undefined &&
            input.unread_only === undefined
              ? { unread_only: true }
              : {})
          })
        )
    );
    this.server.registerTool(
      "acknowledge_messages",
      {
        description:
          "Advance this agent's read position through one received message. Newer messages remain unread.",
        inputSchema: {
          chat_id: z.string().uuid(),
          through_message_id: z.string().uuid()
        }
      },
      async ({ chat_id, through_message_id }) =>
        this.call(() =>
          this.activeClient().acknowledgeMessages(chat_id, through_message_id)
        )
    );
    registerAttentionTools(this.attentionHost());
    registerBranchTools({
      server: this.server,
      call: (operation, options) => this.call(operation, options),
      branches: this.branches
    });
  }
  private attentionHost(): AttentionToolHost {
    return {
      server: this.server,
      call: (operation, options) => this.call(operation, options),
      client: () => this.activeClient(),
      requireSession: () => this.requireSession(),
      claims: this.claims,
      integration: this.options.integration,
      waitBudgetSeconds: this.options.waitBudgetSeconds
    };
  }
  private requireSession() {
    if (!this.sessionId)
      throw new AgentApiError(
        409,
        "AGENT_SESSION_NOT_FOUND",
        "The agent session is not open."
      );
    return this.sessionId;
  }
  private activeClient() {
    if (!this.client)
      throw new AgentApiError(
        409,
        "AGENT_SESSION_NOT_FOUND",
        "Select an Orchestrat project before using project tools."
      );
    return this.client;
  }
  private async selectProject(projectId: string) {
    const project = this.options.projects?.find(
      (item) => item.id === projectId
    );
    if (!project)
      throw new AgentApiError(
        404,
        "NOT_FOUND",
        "Selected project is unavailable."
      );
    const previousSessionId = this.sessionId;
    this.sessionId = undefined;
    if (previousSessionId)
      await this.activeClient().closeSession(previousSessionId);
    this.claims.clear();
    this.base = project.client;
    this.client = project.client;
    await this.branches.reset();
    this.startHeartbeat();
    return { project_id: project.id, name: project.name };
  }
  private async call<T>(
    operation: () => Promise<T>,
    options: {
      notifyInbox?: boolean;
      inboxClient?: Client | null;
      followCheckout?: boolean;
    } = {}
  ) {
    // Follow the checkout before binding this call to a client, so the
    // operation and its notices use the same branch and session.
    const branchNotices: BranchNotice[] =
      options.followCheckout === false ? [] : await this.branches.follow();
    const operationClient = this.client;
    const inboxClient =
      "inboxClient" in options ? options.inboxClient : operationClient;
    let operationSucceeded = false;
    let response: ReturnType<typeof success> | ReturnType<typeof mapMcpError>;
    try {
      response = success(await operation());
      operationSucceeded = true;
    } catch (error) {
      response = mapMcpError(error);
      branchNotices.push(...(await this.branches.afterError(error)));
    }
    const noticeClient = operationSucceeded ? inboxClient : operationClient;
    if (options.notifyInbox !== false && noticeClient) {
      const attention = await this.readAttention(noticeClient);
      if (attention && attention.unread_chats.length > 0)
        response.content.push({
          type: "text",
          text: JSON.stringify({
            notice: {
              type: "unread_chats",
              unread_chats: attention.unread_chats
            }
          })
        });
      const notice = attention?.summary && attentionNotice(attention.summary);
      if (notice)
        response.content.push({ type: "text", text: JSON.stringify(notice) });
    }
    for (const notice of branchNotices)
      response.content.push({ type: "text", text: JSON.stringify({ notice }) });
    return response;
  }
  // One notice read per tool call, bounded by inboxTimeoutMs overall (the
  // 404 fallback shares the same budget) and aborted when it runs out.
  private async readAttention(client: Client) {
    const controller = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        resolve(undefined);
      }, this.options.inboxTimeoutMs ?? 1_000);
    });
    try {
      return await Promise.race([
        this.fetchAttention(client, controller.signal).catch(() => undefined),
        timeout
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      if (timedOut) controller.abort();
    }
  }
  private async fetchAttention(
    client: Client,
    signal: AbortSignal
  ): Promise<
    | {
        unread_chats: AttentionSummary["unread_chats"];
        summary?: AttentionSummary;
      }
    | undefined
  > {
    if (
      !this.attentionUnsupported &&
      typeof client.attention?.summary === "function"
    ) {
      try {
        const summary = await client.attention.summary(signal);
        return { unread_chats: summary.unread_chats, summary };
      } catch (error) {
        if (!(error instanceof AgentApiError && error.status === 404))
          return undefined;
        // An API without the attention routes: use the chat inbox from now on.
        this.attentionUnsupported = true;
      }
    }
    if (typeof client.getInbox !== "function" || signal.aborted)
      return undefined;
    return client.getInbox(signal);
  }
}

export async function startStdioBridge(options: BridgeOptions) {
  const bridge = new McpBridge(options);
  try {
    await bridge.start();
    const transport = new StdioServerTransport();
    await bridge.server.connect(transport);
    return { bridge, transport };
  } catch (error) {
    await bridge.stop();
    throw error;
  }
}
