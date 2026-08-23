import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { AgentApiClient, AgentApiError } from "@orchestrat/sdk";
import {
  createDocumentRequestSchema,
  documentConflictDetailsSchema,
  documentListQuerySchema,
  updateDocumentRequestSchema
} from "@orchestrat/protocol";
import { z } from "zod";

export const mcpPackage = "@orchestrat/mcp";

type Client = Pick<
  AgentApiClient,
  | "openSession"
  | "heartbeat"
  | "closeSession"
  | "listTasks"
  | "getTask"
  | "claimTask"
  | "releaseClaim"
  | "completeClaim"
  | "listEvents"
  | "listDocuments"
  | "readDocument"
  | "createDocument"
  | "updateDocument"
>;
export type BridgeOptions = {
  client: Client;
  integration: "codex" | "claude-code";
  runtime?: string;
  heartbeatMs?: number;
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
}

export function mapMcpError(error: unknown) {
  const known = error instanceof AgentApiError;
  const requestId = known ? error.requestId : undefined;
  const parsedDetails =
    known && error.code === "DOCUMENT_CONFLICT"
      ? documentConflictDetailsSchema.safeParse(error.details)
      : undefined;
  const details = parsedDetails?.success ? parsedDetails.data : undefined;
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
  constructor(private readonly options: BridgeOptions) {
    this.server = new McpServer({ name: "orchestrat", version: "0.1.0" });
    this.server.server.onclose = () => {
      void this.stop().catch((error) => this.reportCleanupError(error));
    };
    this.registerTools();
  }
  async start() {
    const opened = await this.options.client.openSession({
      runtime: this.options.runtime ?? this.options.integration,
      integration: this.options.integration
    });
    this.sessionId = opened.session.id;
    this.heartbeatTimer = setInterval(
      () => void this.heartbeat(),
      this.options.heartbeatMs ?? 20_000
    );
    this.heartbeatTimer.unref?.();
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
          await this.options.client.closeSession(sessionId);
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
      await this.options.client.heartbeat(this.sessionId);
    } catch (error) {
      process.stderr.write(
        `orchestrat: heartbeat failed: ${error instanceof Error ? error.message : "unknown error"}\n`
      );
    }
  }
  private registerTools() {
    this.server.registerTool(
      "list_tasks",
      {
        description: "List project tasks visible to this authenticated agent.",
        inputSchema: listTasksInput
      },
      async (input) => this.call(() => this.options.client.listTasks(input))
    );
    this.server.registerTool(
      "get_task",
      {
        description:
          "Get one task. Claim/release/complete require this session and current claim ownership.",
        inputSchema: taskIdInput
      },
      async ({ task_id }) =>
        this.call(() => this.options.client.getTask(task_id))
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
          const result = await this.options.client.claimTask(task_id, {
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
          description: `${name === "release_task" ? "Release" : "Complete"} a task claim owned by this active session; claim token is process-local.`,
          inputSchema: taskIdInput
        },
        async ({ task_id }) =>
          this.call(async () => {
            const token = this.claims.get(task_id);
            if (!token)
              throw new AgentApiError(
                400,
                "CLAIM_NOT_FOUND",
                "No local claim token for this task."
              );
            const result = await this.options.client[action](
              this.requireSession(),
              {
                claim_token: token
              }
            );
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
      async (input) => this.call(() => this.options.client.listEvents(input))
    );
    this.server.registerTool(
      "heartbeat",
      {
        description: "Renew this active agent session and its claims.",
        inputSchema: {}
      },
      async () =>
        this.call(() => this.options.client.heartbeat(this.requireSession()))
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
          this.options.client.listDocuments(
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
        this.call(() => this.options.client.readDocument(document_id))
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
          this.options.client.createDocument(
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
          this.options.client.updateDocument(
            document_id,
            updateDocumentRequestSchema.parse(input)
          )
        )
    );
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
  private async call<T>(operation: () => Promise<T>) {
    try {
      return success(await operation());
    } catch (error) {
      return mapMcpError(error);
    }
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
