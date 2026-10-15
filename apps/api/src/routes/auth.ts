import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  preHandlerHookHandler
} from "fastify";
import {
  changePasswordRequestSchema,
  loginRequestSchema,
  refreshRequestSchema,
  signupRequestSchema
} from "@orchestrat/protocol";
import type { AuthService } from "../services/auth-service.js";

const userAgent = (request: FastifyRequest) => {
  const value = request.headers["user-agent"];
  return typeof value === "string" ? value : undefined;
};

// Session tokens must never be cached by the browser or a proxy.
const noStore = (reply: FastifyReply) =>
  reply.header("cache-control", "no-store");

export async function authPublicRoutes(
  app: FastifyInstance,
  options: {
    auth: AuthService;
    signupRateLimit: preHandlerHookHandler;
    loginRateLimits: preHandlerHookHandler[];
    refreshRateLimit: preHandlerHookHandler;
  }
) {
  app.get("/auth/instance", () => options.auth.instance());

  app.post(
    "/auth/signup",
    { preHandler: options.signupRateLimit },
    async (request, reply) => {
      const body = signupRequestSchema.parse(request.body);
      const session = await options.auth.signup(body, userAgent(request));
      return noStore(reply).code(201).send(session);
    }
  );

  app.post(
    "/auth/login",
    { preHandler: options.loginRateLimits },
    async (request, reply) => {
      const body = loginRequestSchema.parse(request.body);
      return noStore(reply).send(
        await options.auth.login(body, userAgent(request))
      );
    }
  );

  app.post(
    "/auth/refresh",
    { preHandler: options.refreshRateLimit },
    async (request, reply) => {
      const body = refreshRequestSchema.parse(request.body);
      return noStore(reply).send(
        await options.auth.refresh(body.refresh_token, userAgent(request))
      );
    }
  );
}

export async function authHumanRoutes(
  app: FastifyInstance,
  options: { auth: AuthService }
) {
  app.post("/auth/logout", async (request, reply) => {
    await options.auth.logout(request.headers);
    return reply.code(204).send();
  });

  app.post("/auth/logout-all", async (request, reply) => {
    await options.auth.logoutAll(request.userId);
    return reply.code(204).send();
  });

  app.post("/auth/password", async (request, reply) => {
    const body = changePasswordRequestSchema.parse(request.body);
    await options.auth.changePassword(request.userId, request.headers, body);
    return reply.code(204).send();
  });
}
