import {
  connectRepositoryRequestSchema,
  createRepositoryAuthorizationRequestSchema,
  githubInstallationRequestSchema,
  pendingRepositoryAuthorizationQuerySchema,
  projectTaskParamsSchema,
  repositoryAuthorizationParamsSchema,
  repositoryDeliveriesQuerySchema,
  repositoryDeliveryParamsSchema,
  repositoryProviderSchema
} from "@orchestrat/protocol";
import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import type { RepositoryService } from "../services/repository/connection-service.js";
import type { WebhookIngress } from "../services/repository/webhook-ingress.js";

// Repository connection routes (docs/project-branches.md §6.7). Owners and
// admins connect, sync and disconnect; members see the status.
export async function humanRepositoryRoutes(
  app: FastifyInstance,
  options: { repositories: RepositoryService }
) {
  const project = (params: unknown) =>
    projectTaskParamsSchema.parse(params).projectId;
  app.get("/repository/providers", () => options.repositories.listProviders());
  app.get("/repository/authorizations/pending", (request) =>
    options.repositories.pending(
      request.userId,
      pendingRepositoryAuthorizationQuerySchema.parse(request.query).provider
    )
  );
  app.get("/projects/:projectId/repository", (request) =>
    options.repositories.get(request.userId, project(request.params))
  );
  app.post("/projects/:projectId/repository/authorizations", (request) =>
    options.repositories.authorize(
      request.userId,
      project(request.params),
      createRepositoryAuthorizationRequestSchema.parse(request.body)
    )
  );
  app.post(
    "/projects/:projectId/repository/authorizations/:authorizationId/github-installation",
    (request) => {
      const params = repositoryAuthorizationParamsSchema.parse(request.params);
      return options.repositories.githubInstallation(
        request.userId,
        params.projectId,
        params.authorizationId,
        githubInstallationRequestSchema.parse(request.body).installation_id
      );
    }
  );
  app.get(
    "/projects/:projectId/repository/authorizations/:authorizationId/repositories",
    (request) => {
      const params = repositoryAuthorizationParamsSchema.parse(request.params);
      return options.repositories.candidates(
        request.userId,
        params.projectId,
        params.authorizationId
      );
    }
  );
  app.post("/projects/:projectId/repository", async (request, reply) =>
    reply
      .code(201)
      .send(
        await options.repositories.connect(
          request.userId,
          project(request.params),
          connectRepositoryRequestSchema.parse(request.body)
        )
      )
  );
  app.post("/projects/:projectId/repository/sync", async (request, reply) =>
    reply
      .code(202)
      .send(
        await options.repositories.requestSync(
          request.userId,
          project(request.params)
        )
      )
  );
  app.post(
    "/projects/:projectId/repository/hook/reenable",
    async (request, reply) =>
      reply
        .code(202)
        .send(
          await options.repositories.reenableHook(
            request.userId,
            project(request.params)
          )
        )
  );
  app.get("/projects/:projectId/repository/deliveries", (request) =>
    options.repositories.deliveries(
      request.userId,
      project(request.params),
      repositoryDeliveriesQuerySchema.parse(request.query).status
    )
  );
  app.post(
    "/projects/:projectId/repository/deliveries/:deliveryId/retry",
    (request) => {
      const params = repositoryDeliveryParamsSchema.parse(request.params);
      return options.repositories.retry(
        request.userId,
        params.projectId,
        params.deliveryId
      );
    }
  );
  app.delete("/projects/:projectId/repository", async (request, reply) => {
    await options.repositories.disconnect(
      request.userId,
      project(request.params)
    );
    return reply.code(204).send();
  });
}

/**
 * Public routes outside both auth scopes: provider callbacks redirect to the
 * dashboard, and webhooks are verified on their raw body.
 */
export async function publicRepositoryRoutes(
  app: FastifyInstance,
  options: {
    repositories: RepositoryService;
    ingress: WebhookIngress;
    rateLimit: preHandlerHookHandler;
  }
) {
  app.get("/repository/callback/:provider", async (request, reply) => {
    const provider = repositoryProviderSchema.safeParse(
      (request.params as { provider?: string }).provider
    );
    if (!provider.success) return reply.code(404).send();
    return reply.redirect(
      await options.repositories.callback(
        provider.data,
        request.query as Record<string, string | undefined>
      ),
      302
    );
  });
  // The raw body is what providers sign, so this scope parses nothing.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser(
    "*",
    { parseAs: "buffer", bodyLimit: 10 * 1024 * 1024 },
    (_request, body, done) => done(null, body)
  );
  const receive =
    (fixed?: "gitlab") =>
    async (
      request: {
        params: unknown;
        headers: Record<string, string | string[] | undefined>;
        body: unknown;
      },
      reply: { code(status: number): { send(body?: unknown): unknown } }
    ) => {
      const params = request.params as {
        provider?: string;
        connectionId?: string;
      };
      const provider = repositoryProviderSchema.safeParse(
        fixed ?? params.provider
      );
      if (!provider.success) return reply.code(404).send();
      const status = await options.ingress.receive(
        provider.data,
        request.headers,
        Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0),
        params.connectionId
      );
      return reply
        .code(status)
        .send(status === 202 ? { received: true } : undefined);
    };
  app.post("/webhooks/:provider", { preHandler: options.rateLimit }, receive());
  app.post(
    "/webhooks/gitlab/:connectionId",
    { preHandler: options.rateLimit },
    receive("gitlab")
  );
}
