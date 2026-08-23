import { createHash, randomBytes } from "node:crypto";
import {
  cliAuthorizationAttempts,
  cliCredentials,
  type Database
} from "@orchestrat/db";
import { and, eq } from "drizzle-orm";
import { ApiError } from "./api-error.js";
import { PermissionService } from "./permission-service.js";

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const ATTEMPT_TTL_MS = 10 * 60_000;
const POLL_MIN_INTERVAL_MS = 2_000;
// ponytail: per-process limiter with bounded clear-all; use a shared store when API replicas or poll volume grow.
const pollTimes = new Map<string, number>();

export class CliAuthorizationService {
  private readonly permissions: PermissionService;
  constructor(
    private readonly db: Database,
    private readonly now: () => Date = () => new Date()
  ) {
    this.permissions = new PermissionService(db);
  }

  async createAttempt() {
    const attemptId = `ca_${randomBytes(24).toString("base64url")}`;
    const secret = randomBytes(32).toString("base64url");
    const expiresAt = new Date(this.now().getTime() + ATTEMPT_TTL_MS);
    await this.db.insert(cliAuthorizationAttempts).values({
      id: attemptId,
      secretHash: hash(secret),
      status: "pending",
      expiresAt
    });
    return {
      attempt_id: attemptId,
      secret,
      expires_at: expiresAt.toISOString()
    };
  }

  async approve(userId: string, attemptId: string, projectId: string) {
    await this.permissions.projectAccess(userId, projectId);
    await this.db.transaction(async (tx) => {
      const [attempt] = await tx
        .select()
        .from(cliAuthorizationAttempts)
        .where(
          and(
            eq(cliAuthorizationAttempts.id, attemptId),
            eq(cliAuthorizationAttempts.status, "pending")
          )
        )
        .for("update");
      if (
        !attempt ||
        attempt.expiresAt <= this.now() ||
        attempt.status !== "pending"
      )
        throw new ApiError(
          409,
          "CONFLICT",
          "Authorization attempt is no longer pending."
        );
      await tx
        .update(cliAuthorizationAttempts)
        .set({ status: "approved", projectId, approvedByUserId: userId })
        .where(eq(cliAuthorizationAttempts.id, attemptId));
    });
    return { status: "approved" as const };
  }

  async deny(attemptId: string) {
    await this.db.transaction(async (tx) => {
      const [attempt] = await tx
        .select()
        .from(cliAuthorizationAttempts)
        .where(
          and(
            eq(cliAuthorizationAttempts.id, attemptId),
            eq(cliAuthorizationAttempts.status, "pending")
          )
        )
        .for("update");
      if (
        !attempt ||
        attempt.expiresAt <= this.now() ||
        attempt.status !== "pending"
      )
        throw new ApiError(
          409,
          "CONFLICT",
          "Authorization attempt is no longer pending."
        );
      await tx
        .update(cliAuthorizationAttempts)
        .set({ status: "denied" })
        .where(eq(cliAuthorizationAttempts.id, attemptId));
    });
    return { status: "denied" as const };
  }

  async poll(attemptId: string, secret: string) {
    const now = this.now().getTime();
    const previous = pollTimes.get(attemptId) ?? 0;
    if (now - previous < POLL_MIN_INTERVAL_MS)
      throw new ApiError(
        429,
        "CONFLICT",
        "Poll again after the retry interval."
      );
    pollTimes.set(attemptId, now);
    if (pollTimes.size > 10_000) pollTimes.clear();
    const [attempt] = await this.db
      .select()
      .from(cliAuthorizationAttempts)
      .where(
        and(
          eq(cliAuthorizationAttempts.id, attemptId),
          eq(cliAuthorizationAttempts.secretHash, hash(secret))
        )
      )
      .limit(1);
    if (!attempt)
      throw new ApiError(404, "NOT_FOUND", "Authorization attempt not found.");
    if (attempt.expiresAt <= this.now() && attempt.status === "pending") {
      await this.db
        .update(cliAuthorizationAttempts)
        .set({ status: "expired" })
        .where(eq(cliAuthorizationAttempts.id, attemptId));
      return { status: "expired" as const };
    }
    if (attempt.status === "exchanged")
      throw new ApiError(
        409,
        "CONFLICT",
        "Authorization attempt was already exchanged."
      );
    if (attempt.status !== "approved")
      return { status: attempt.status as "pending" | "denied" | "expired" };
    if (attempt.expiresAt <= this.now()) {
      await this.db
        .update(cliAuthorizationAttempts)
        .set({ status: "expired" })
        .where(
          and(
            eq(cliAuthorizationAttempts.id, attemptId),
            eq(cliAuthorizationAttempts.status, "approved")
          )
        );
      return { status: "expired" as const };
    }
    const credential = `orch_cli_${randomBytes(32).toString("base64url")}`;
    let expired = false;
    let exchangedProjectId: string | null = null;
    await this.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(cliAuthorizationAttempts)
        .where(eq(cliAuthorizationAttempts.id, attemptId))
        .for("update");
      if (!current || current.status !== "approved")
        throw new ApiError(
          409,
          "CONFLICT",
          "Authorization attempt was already exchanged."
        );
      if (current.expiresAt <= this.now()) {
        await tx
          .update(cliAuthorizationAttempts)
          .set({ status: "expired" })
          .where(eq(cliAuthorizationAttempts.id, attemptId));
        expired = true;
        return;
      }
      exchangedProjectId = current.projectId;
      await tx.insert(cliCredentials).values({
        projectId: current.projectId!,
        userId: current.approvedByUserId!,
        tokenHash: hash(credential)
      });
      await tx
        .update(cliAuthorizationAttempts)
        .set({
          status: "exchanged",
          exchangedAt: this.now(),
          credentialHash: hash(credential)
        })
        .where(
          and(
            eq(cliAuthorizationAttempts.id, attemptId),
            eq(cliAuthorizationAttempts.status, "approved")
          )
        );
    });
    if (expired) return { status: "expired" as const };
    return {
      status: "approved" as const,
      project_id: exchangedProjectId!,
      credential
    };
  }
}
