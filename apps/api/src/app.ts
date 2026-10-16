import { randomUUID } from "node:crypto";
import cors from "@fastify/cors";
import type { HumanAuth } from "@orchestrat/auth";
import type { SignupMode } from "@orchestrat/protocol";
import type { Database } from "@orchestrat/db";
import { logger } from "@orchestrat/logger";
import type { ApiErrorResponse, ErrorCode } from "@orchestrat/protocol";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { healthRoutes } from "./routes/health.js";
import { agentActionRoutes } from "./routes/agent-actions.js";
import { agentManagementRoutes } from "./routes/agents.js";
import { agentDocumentRoutes } from "./routes/agent-documents.js";
import { documentRoutes } from "./routes/documents.js";
import { agentChatRoutes, humanChatRoutes } from "./routes/chats.js";
import { projectMemberRoutes } from "./routes/project-members.js";
import { v1Routes } from "./routes/v1.js";
import { ApiError } from "./services/api-error.js";
import { AgentService } from "./services/agent-service.js";
import { agentBranchSelector } from "./services/branch-context.js";
import { BranchService } from "./services/branch-service.js";
import { agentBranchRoutes, humanBranchRoutes } from "./routes/branches.js";
import type { RepositoryConfig } from "@orchestrat/config";
import { humanMergeRoutes } from "./routes/merges.js";
import {
  humanRepositoryRoutes,
  publicRepositoryRoutes
} from "./routes/repository.js";
import { BranchSync } from "./services/repository/branch-sync.js";
import { ProviderMerges } from "./services/repository/provider-merges.js";
import { RepositoryService } from "./services/repository/connection-service.js";
import { IntegrationService } from "./services/repository/integration-service.js";
import { integrationRoutes } from "./routes/integrations.js";
import type { SecretBox } from "./services/repository/secrets.js";
import { RepositorySyncWorker } from "./services/repository/sync-worker.js";
import type { ProviderAdapter } from "./services/repository/types.js";
import { WebhookIngress } from "./services/repository/webhook-ingress.js";
import { MergeService } from "./services/merge-service.js";
import { MergeEngine } from "./services/merges/engine.js";
import { TaskClaimService } from "./services/task-claim-service.js";
import { IdentityService } from "./services/identity-service.js";
import {
  AuthService,
  type AuthServiceOptions
} from "./services/auth-service.js";
import { authHumanRoutes, authPublicRoutes } from "./routes/auth.js";
import { PermissionService } from "./services/permission-service.js";
import { ProjectService } from "./services/project-service.js";
import {
  ProfileService,
  type AvatarStorageConfig
} from "./services/profile-service.js";
import { TaskService } from "./services/task-service.js";
import {
  DocumentService,
  type DocumentStorageConfig
} from "./services/document-service.js";
import { AttachmentService } from "./services/attachment-service.js";
import {
  realtimeSocketRoutes,
  realtimeTicketRoutes
} from "./routes/realtime.js";
import { attachmentDownloadRoutes } from "./routes/attachment-download.js";
import { avatarRoutes } from "./routes/avatars.js";
import {
  RealtimeRegistry,
  AttachmentDownloadTicketStore,
  RealtimeTicketStore,
  withRealtimePublisher
} from "./realtime/realtime.js";
import { CliSetupService } from "./services/cli-setup-service.js";
import { cliSetupRoutes } from "./routes/cli-setup.js";
import { CliAuthorizationService } from "./services/cli-authorization-service.js";
import {
  cliAuthorizationHumanRoutes,
  cliAuthorizationPublicRoutes
} from "./routes/cli-authorization.js";
import {
  FixedWindowRateLimit,
  clientKey,
  rateLimitHook
} from "./services/rate-limit.js";
import { ChatService } from "./services/chat-service.js";
import { ProjectMembershipService } from "./services/project-membership-service.js";
import { AttentionService } from "./services/attention-service.js";
import { AttentionWaitHub } from "./services/attention-wait-hub.js";
import { HandoffService } from "./services/handoff-service.js";
import { TaskStatusService } from "./services/task-status-service.js";
import {
  agentAttentionRoutes,
  humanAttentionRoutes
} from "./routes/attention.js";

type AppOptions = {
  /** Repository connections. Off by default. */
  repository?: {
    config?: Partial<
      Pick<
        RepositoryConfig,
        | "publicApiUrl"
        | "dashboardUrl"
        | "unavailable"
        | "hidden"
        | "reconcileIntervalSeconds"
        | "syncEnabled"
      >
    >;
    adapters?: ProviderAdapter[];
    secrets?: SecretBox | null;
    now?: () => Date;
  };
  allowedOrigins: string[];
  /** Overrides the built-in session auth; tests inject a fake here. */
  auth?: HumanAuth;
  signupMode?: SignupMode;
  sessionAuth?: Omit<
    AuthServiceOptions,
    "signupMode" | "setupToken" | "memberships"
  >;
  /** Needed to create the first account on an empty instance. */
  setupToken?: string;
  /** A built dashboard to serve on this origin (single-container self-host). */
  dashboardDir?: string;
  closeDatabase?: () => Promise<void>;
  db: Database;
  avatarStorage?: AvatarStorageConfig;
  documentStorage?: DocumentStorageConfig;
  /** Per-project attachment bytes; 10 GiB by default. */
  attachmentQuotaBytes?: number;
  /** Absolute API URL (ORCHESTRAT_PUBLIC_URL) for stored avatar URLs. */
  publicApiUrl?: string;
  checkDatabase?: () => Promise<void>;
  trustProxyHops?: number;
  rateLimits?: Partial<{
    publicCliCreate: number;
    publicCliPoll: number;
    expensive: number;
    authLogin: number;
    authLoginPerEmail: number;
    authSignup: number;
    authRefresh: number;
    authPassword: number;
  }>;
};

// Tests drive the repository worker's ticks directly.
const repositoryWorkers = new WeakMap<object, RepositorySyncWorker>();
export const repositoryWorkerOf = (app: object) => repositoryWorkers.get(app);

const errorResponse = (
  requestId: string,
  code: ErrorCode,
  message: string,
  details: Record<string, unknown> = {}
): ApiErrorResponse => ({
  error: { code, details, message, request_id: requestId }
});

const rawHeaderEntries = (rawHeaders: string[]) => {
  const entries: [string, string][] = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    entries.push([rawHeaders[index]!, rawHeaders[index + 1]!]);
  }
  return entries;
};

export function buildApp(options: AppOptions) {
  const app = Fastify({
    genReqId: () => `req_${randomUUID()}`,
    logger: true,
    trustProxy: options.trustProxyHops ?? false
  });
  const realtimeTickets = new RealtimeTicketStore();
  const attachmentDownloadTickets = new AttachmentDownloadTicketStore();
  const permissions = new PermissionService(options.db);
  const realtimeRegistry = new RealtimeRegistry(
    (userId, projectId) => permissions.projectAccess(userId, projectId),
    30_000,
    async (userId, event) =>
      event.entity_type !== "chat" ||
      event.event_type === "chat.access_invalidated" ||
      (event.entity_id !== null &&
        (await chats.canHumanViewChat(userId, event.entity_id)))
  );
  // The publisher runs after commit; waits is assigned below, before any
  // request can open a transaction (the same pattern as chats above).
  const db = withRealtimePublisher(options.db, (event, audience) => {
    waits.notify(event);
    return realtimeRegistry.publish(event, audience);
  });
  const chats = new ChatService(db);
  const identities = new IdentityService(db);
  const profiles = new ProfileService(db, options.avatarStorage, {
    publicApiUrl: options.publicApiUrl
  });
  const tasks = new TaskService(db);
  const agents = new AgentService(db);
  const branches = new BranchService(db, agents);
  const claims = new TaskClaimService(db);
  const attention = new AttentionService(db, chats);
  const waits = new AttentionWaitHub(attention, db);
  const statuses = new TaskStatusService(db, claims);
  const handoffs = new HandoffService(db, chats);
  const documents = new DocumentService(db, options.documentStorage);
  const projects = new ProjectService(
    db,
    chats.assertHumanMayLeaveProject.bind(chats),
    (projectId) => documents.deleteProjectStorage(projectId)
  );
  const memberships = new ProjectMembershipService(
    db,
    chats.assertHumanMayLeaveProject.bind(chats)
  );
  const sessions = new AuthService(db, {
    ...options.sessionAuth,
    signupMode: options.signupMode ?? "invite",
    setupToken: options.setupToken,
    memberships
  });
  const humanAuth = options.auth ?? sessions;
  const attachments = new AttachmentService(
    db,
    options.documentStorage,
    attachmentDownloadTickets,
    options.attachmentQuotaBytes
  );
  const repositoryOptions = options.repository ?? {};
  const repositoryConfig = {
    publicApiUrl: repositoryOptions.config?.publicApiUrl ?? null,
    dashboardUrl: repositoryOptions.config?.dashboardUrl ?? null,
    unavailable: repositoryOptions.config?.unavailable ?? {
      github: "Repository connections aren't set up on this server.",
      gitlab: "Repository connections aren't set up on this server.",
      origin: "Repository connections aren't set up on this server."
    },
    hidden: repositoryOptions.config?.hidden ?? []
  };
  const providerAdapters = new Map(
    (repositoryOptions.adapters ?? []).map((adapter) => [
      adapter.provider,
      adapter
    ])
  );
  for (const adapter of providerAdapters.values()) adapter.bind?.({ db });
  const branchSync = new BranchSync(
    db,
    branches,
    providerAdapters,
    repositoryOptions.now
  );
  const mergeEngine = new MergeEngine(
    db,
    branches,
    attachments.mergeObjects(),
    options.attachmentQuotaBytes
  );
  const providerMerges = new ProviderMerges(
    db,
    mergeEngine,
    branchSync,
    repositoryOptions.now
  );
  branchSync.onMerged = (connection, change) =>
    providerMerges.handle(connection, change);
  const repositoryWorker = new RepositorySyncWorker(
    db,
    branchSync,
    providerAdapters,
    {
      reconcileIntervalSeconds:
        repositoryOptions.config?.reconcileIntervalSeconds ?? 900,
      now: repositoryOptions.now
    }
  );
  repositoryWorkers.set(app, repositoryWorker);
  const repositories = new RepositoryService(
    db,
    branches,
    branchSync,
    providerAdapters,
    repositoryConfig,
    repositoryOptions.secrets ?? null,
    (connectionId) => repositoryWorker.requestReconcile(connectionId),
    repositoryOptions.now
  );
  const integrations = new IntegrationService(db, repositories, {
    refreshIntervalSeconds:
      repositoryOptions.config?.reconcileIntervalSeconds ?? 900,
    now: repositoryOptions.now
  });
  repositoryWorker.integrations = integrations;
  const webhookIngress = new WebhookIngress(
    db,
    providerAdapters,
    repositoryOptions.now
  );
  if (repositoryOptions.config?.syncEnabled) {
    app.addHook("onReady", () => repositoryWorker.resetStale());
    app.addHook("onListen", async () => repositoryWorker.start());
    app.addHook("preClose", () => repositoryWorker.stop());
  }
  const merges = new MergeService(db, mergeEngine, branches);
  const cliAuthorization = new CliAuthorizationService(db);
  const cliSetup = new CliSetupService(db);
  const rateLimits = {
    publicCliCreate: 10,
    publicCliPoll: 120,
    expensive: 120,
    authLogin: 20,
    authLoginPerEmail: 10,
    authSignup: 10,
    authRefresh: 60,
    authPassword: 5,
    ...options.rateLimits
  };
  const publicCliCreateRateLimit = rateLimitHook(
    new FixedWindowRateLimit(rateLimits.publicCliCreate, 60_000),
    (request) => clientKey(request.ip)
  );
  const publicCliPollRateLimit = rateLimitHook(
    new FixedWindowRateLimit(rateLimits.publicCliPoll, 60_000),
    (request) => clientKey(request.ip)
  );
  const expensiveRateLimit = rateLimitHook(
    new FixedWindowRateLimit(rateLimits.expensive, 60_000),
    (request) =>
      request.agentPrincipal
        ? `agent:${request.agentPrincipal.credentialId}`
        : `user:${request.userId}`
  );

  app.register(cors, {
    origin: options.allowedOrigins,
    methods: ["GET", "HEAD", "POST", "PATCH", "DELETE"],
    exposedHeaders: ["retry-after", "x-request-id"]
  });
  if (options.dashboardDir) {
    // Only files that exist get routes (wildcard: false); every other
    // non-API GET falls back to index.html below, for client-side routes.
    app.register(fastifyStatic, {
      root: options.dashboardDir,
      wildcard: false,
      index: false,
      // setHeaders decides caching: hashed assets forever, the rest revalidate.
      cacheControl: false,
      setHeaders(response, path) {
        response.setHeader("x-content-type-options", "nosniff");
        response.setHeader(
          "cache-control",
          /[\\/]assets[\\/]/.test(path)
            ? "public, max-age=31536000, immutable"
            : "no-cache"
        );
      }
    });
  }
  app.register(multipart, {
    limits: { fileSize: 2 * 1024 * 1024, files: 1 }
  });
  app.register(websocket, { options: { maxPayload: 64 * 1024 } });
  app.addHook("onRequest", (request, reply, done) => {
    reply.header("x-request-id", request.id);
    done();
  });
  if (options.closeDatabase) {
    app.addHook("onClose", options.closeDatabase);
  }

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      return reply
        .code(error.statusCode)
        .send(
          errorResponse(request.id, error.code, error.message, error.details)
        );
    }

    const caught = error as {
      code?: string;
      cause?: { message?: string };
      issues?: unknown;
      message?: string;
      name?: string;
      statusCode?: number;
    };
    if (
      caught.name === "ZodError" ||
      caught.statusCode === 400 ||
      caught.statusCode === 413
    ) {
      return reply.code(caught.statusCode === 413 ? 413 : 400).send(
        errorResponse(
          request.id,
          "VALIDATION_ERROR",
          "The request is invalid.",
          {
            issues: caught.issues
          }
        )
      );
    }

    if (caught.code === "23505") {
      return reply
        .code(409)
        .send(
          errorResponse(
            request.id,
            "CONFLICT",
            "A record with that slug or email already exists."
          )
        );
    }

    logger.error(
      {
        error: caught.cause?.message ?? caught.message ?? "Unknown error",
        request_id: request.id
      },
      "API request failed"
    );
    return reply
      .code(500)
      .send(errorResponse(request.id, "INTERNAL_ERROR", "The request failed."));
  });

  const isApiPath = (url: string) => /^\/(api|health|ready)(\/|\?|$)/.test(url);
  // A missing file (e.g. a stale /assets/*.js) must 404, not get index.html.
  const looksLikeFile = (url: string) =>
    /\.[A-Za-z0-9]+$/.test(url.split(/[?#]/, 1)[0]!);
  app.setNotFoundHandler((request, reply) => {
    if (
      options.dashboardDir &&
      (request.method === "GET" || request.method === "HEAD") &&
      !isApiPath(request.url) &&
      !looksLikeFile(request.url)
    )
      return reply
        .header("cache-control", "no-cache")
        .header("x-content-type-options", "nosniff")
        .header("x-frame-options", "DENY")
        .header("referrer-policy", "same-origin")
        .sendFile("index.html");
    return reply
      .code(404)
      .send(errorResponse(request.id, "NOT_FOUND", "Route not found."));
  });

  app.register(healthRoutes, { checkDatabase: options.checkDatabase });
  app.register(healthRoutes, {
    prefix: "/api/v1",
    checkDatabase: options.checkDatabase
  });
  app.register(attachmentDownloadRoutes, {
    prefix: "/api/v1",
    attachments
  });
  app.register(avatarRoutes, {
    prefix: "/api/v1",
    profiles,
    rateLimit: rateLimitHook(
      new FixedWindowRateLimit(1200, 60_000),
      (request) => clientKey(request.ip)
    )
  });
  app.register(cliAuthorizationPublicRoutes, {
    prefix: "/api/v1",
    authorization: cliAuthorization,
    createRateLimit: publicCliCreateRateLimit,
    pollRateLimit: publicCliPollRateLimit
  });
  app.register(cliSetupRoutes, { prefix: "/api/v1", setup: cliSetup });
  app.register(authPublicRoutes, {
    prefix: "/api/v1",
    auth: sessions,
    signupRateLimit: rateLimitHook(
      new FixedWindowRateLimit(rateLimits.authSignup, 60_000),
      (request) => clientKey(request.ip)
    ),
    loginRateLimit: rateLimitHook(
      new FixedWindowRateLimit(rateLimits.authLogin, 60_000),
      (request) => clientKey(request.ip)
    ),
    loginFailures: new FixedWindowRateLimit(
      rateLimits.authLoginPerEmail,
      15 * 60_000
    ),
    refreshRateLimit: rateLimitHook(
      new FixedWindowRateLimit(rateLimits.authRefresh, 60_000),
      (request) => clientKey(request.ip)
    )
  });
  app.register(publicRepositoryRoutes, {
    prefix: "/api/v1",
    repositories,
    ingress: webhookIngress,
    rateLimit: rateLimitHook(new FixedWindowRateLimit(600, 60_000), (request) =>
      clientKey(request.ip)
    )
  });
  app.decorateRequest("agentPrincipal", null);
  app.register(
    async (api) => {
      api.decorateRequest("suggestedUsername", null);
      api.decorateRequest("userId", "");
      api.addHook("preHandler", async (request) => {
        const authorization = rawHeaderEntries(request.raw.rawHeaders)
          .filter(([name]) => name.toLowerCase() === "authorization")
          .map(([, value]) => value);
        if (
          authorization.length === 1 &&
          authorization[0]?.match(/^Bearer\s+(orch_agent_\S+)$/)
        ) {
          throw new ApiError(
            401,
            "AGENT_CREDENTIAL_INVALID",
            "Agent credentials are only valid on agent routes."
          );
        }
        const principal = await humanAuth.authenticate({
          headers: rawHeaderEntries(request.raw.rawHeaders),
          method: request.method,
          url: `http://${request.headers.host ?? "localhost"}${request.url}`
        });
        if (!principal) {
          throw new ApiError(
            401,
            "UNAUTHENTICATED",
            "Authentication is required."
          );
        }
        request.suggestedUsername = principal.username;
        request.userId =
          principal.userId ?? (await identities.resolveUserId(principal));
      });
      api.register(v1Routes, {
        projects,
        profiles,
        tasks,
        expensiveRateLimit
      });
      api.register(realtimeTicketRoutes, {
        prefix: "/realtime",
        projects,
        tickets: realtimeTickets
      });
      api.register(documentRoutes, {
        documents,
        attachments,
        expensiveRateLimit
      });
      api.register(agentManagementRoutes, { agents });
      api.register(humanBranchRoutes, { branches });
      api.register(humanMergeRoutes, { merges });
      api.register(humanRepositoryRoutes, { repositories });
      api.register(integrationRoutes, { integrations, projects });
      api.register(humanChatRoutes, { chats });
      api.register(projectMemberRoutes, { memberships });
      api.register(humanAttentionRoutes, {
        attention,
        waits,
        statuses,
        handoffs
      });
      api.register(cliAuthorizationHumanRoutes, {
        authorization: cliAuthorization
      });
      api.register(authHumanRoutes, {
        auth: sessions,
        passwordRateLimit: rateLimitHook(
          new FixedWindowRateLimit(rateLimits.authPassword, 15 * 60_000),
          (request) => `user:${request.userId}`
        )
      });
    },
    { prefix: "/api/v1" }
  );
  app.register(realtimeSocketRoutes, {
    prefix: "/api/v1/realtime",
    tickets: realtimeTickets,
    registry: realtimeRegistry
  });
  app.register(
    async (api) => {
      api.addHook("preHandler", async (request) => {
        const values = rawHeaderEntries(request.raw.rawHeaders)
          .filter(([name]) => name.toLowerCase() === "authorization")
          .map(([, value]) => value);
        if (values.length !== 1) {
          throw new ApiError(
            401,
            "AGENT_CREDENTIAL_INVALID",
            "Agent credential is invalid."
          );
        }
        const match = values[0]?.match(/^Bearer\s+([^\s]+)$/);
        if (!match || !match[1]?.startsWith("orch_agent_")) {
          throw new ApiError(
            401,
            "AGENT_CREDENTIAL_INVALID",
            "Agent credential is invalid."
          );
        }
        request.agentPrincipal = {
          ...(await agents.authenticate(match[1])),
          branch: agentBranchSelector(request.headers)
        };
      });
      api.register(agentActionRoutes, { agents, tasks, claims });
      api.register(agentBranchRoutes, { branches });
      api.register(agentChatRoutes, { chats });
      api.register(agentAttentionRoutes, {
        attention,
        waits,
        statuses,
        handoffs
      });
      api.register(agentDocumentRoutes, {
        documents,
        attachments,
        expensiveRateLimit
      });
    },
    { prefix: "/api/v1/agent" }
  );

  return app;
}
