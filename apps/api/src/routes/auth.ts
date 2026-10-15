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
import { ApiError } from "../services/api-error.js";
import type { AuthService } from "../services/auth-service.js";
import type { FixedWindowRateLimit } from "../services/rate-limit.js";

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
    loginRateLimit: preHandlerHookHandler;
    // Counts failed logins per email; successes don't count, so nobody can
    // lock an account out by signing in as it.
    loginFailures: FixedWindowRateLimit;
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
    { preHandler: options.loginRateLimit },
    async (request, reply) => {
      const body = loginRequestSchema.parse(request.body);
      const failureKey = `email:${body.email}`;
      const retryAfter = options.loginFailures.blocked(failureKey);
      if (retryAfter !== null) {
        reply.header("retry-after", retryAfter);
        throw new ApiError(
          429,
          "RATE_LIMITED",
          "Too many failed sign-in attempts. Try again later.",
          { retry_after_seconds: retryAfter }
        );
      }
      try {
        return noStore(reply).send(
          await options.auth.login(body, userAgent(request))
        );
      } catch (error) {
        if (error instanceof ApiError && error.code === "INVALID_CREDENTIALS")
          options.loginFailures.check(failureKey);
        throw error;
      }
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

  // Sign-out with only the refresh token, for when the access token has
  // already expired. Always 204, so it reveals nothing about the token.
  app.post(
    "/auth/revoke",
    { preHandler: options.refreshRateLimit },
    async (request, reply) => {
      const body = refreshRequestSchema.parse(request.body);
      await options.auth.revokeRefreshToken(body.refresh_token);
      return reply.code(204).send();
    }
  );
}

export async function authHumanRoutes(
  app: FastifyInstance,
  options: { auth: AuthService; passwordRateLimit: preHandlerHookHandler }
) {
  app.post("/auth/logout", async (request, reply) => {
    await options.auth.logout(request.headers);
    return reply.code(204).send();
  });

  app.post("/auth/logout-all", async (request, reply) => {
    await options.auth.logoutAll(request.userId);
    return reply.code(204).send();
  });

  app.post(
    "/auth/password",
    { preHandler: options.passwordRateLimit },
    async (request, reply) => {
      const body = changePasswordRequestSchema.parse(request.body);
      await options.auth.changePassword(request.userId, request.headers, body);
      return reply.code(204).send();
    }
  );
}
