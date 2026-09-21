import type {
  FastifyReply,
  FastifyRequest,
  preHandlerHookHandler
} from "fastify";
import { ApiError } from "./api-error.js";

type Bucket = { count: number; resetAt: number };

export class FixedWindowRateLimit {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxKeys = 10_000,
    private readonly now: () => number = Date.now
  ) {}

  check(key: string): number | null {
    const now = this.now();
    let bucket = this.buckets.get(key);
    if (bucket && bucket.resetAt <= now) {
      this.buckets.delete(key);
      bucket = undefined;
    }
    if (!bucket) {
      if (this.buckets.size >= this.maxKeys) {
        for (const [candidate, value] of this.buckets)
          if (value.resetAt <= now) this.buckets.delete(candidate);
      }
      // ponytail: reject new identities at capacity; use a shared limiter before multi-replica scale.
      if (this.buckets.size >= this.maxKeys)
        return Math.ceil(this.windowMs / 1_000);
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      return null;
    }
    if (bucket.count >= this.limit)
      return Math.max(1, Math.ceil((bucket.resetAt - now) / 1_000));
    bucket.count += 1;
    return null;
  }
}

export const rateLimitHook = (
  limiter: FixedWindowRateLimit,
  key: (request: FastifyRequest) => string
): preHandlerHookHandler =>
  async function enforceRateLimit(
    request: FastifyRequest,
    reply: FastifyReply
  ) {
    const retryAfter = limiter.check(key(request));
    if (retryAfter === null) return;
    reply.header("retry-after", retryAfter);
    throw new ApiError(429, "RATE_LIMITED", "Too many requests.", {
      retry_after_seconds: retryAfter
    });
  };
