import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import {
  AVATAR_CACHE_CONTROL,
  type ProfileService
} from "../services/profile-service.js";

/**
 * Public: avatar URLs end up in <img src>, which sends no bearer token. The
 * key is 24 random bytes, so only people shown the URL can fetch it.
 */
export async function avatarRoutes(
  app: FastifyInstance,
  options: { profiles: ProfileService; rateLimit?: preHandlerHookHandler }
) {
  app.get<{ Params: { key: string } }>(
    "/avatars/:key",
    { logLevel: "warn", preHandler: options.rateLimit },
    async (request, reply) => {
      // The service rejects malformed keys with 404 before touching storage.
      const avatar = await options.profiles.avatar(request.params.key);
      reply
        .header("Cache-Control", AVATAR_CACHE_CONTROL)
        .header("X-Content-Type-Options", "nosniff")
        .header("Content-Security-Policy", "default-src 'none'; sandbox")
        .header("Content-Type", avatar.contentType);
      if (avatar.contentLength !== undefined)
        reply.header("Content-Length", String(avatar.contentLength));
      return reply.send(avatar.body);
    }
  );
}
