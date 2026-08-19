import "fastify";

declare module "fastify" {
  interface FastifyRequest {
    suggestedUsername: string | null;
    userId: string;
  }
}
