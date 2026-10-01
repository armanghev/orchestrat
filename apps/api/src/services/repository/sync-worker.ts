import { createHash } from "node:crypto";
import {
  repositoryConnections,
  repositoryWebhookDeliveries,
  type Database
} from "@orchestrat/db";
import { and, asc, eq, isNull, lt, lte } from "drizzle-orm";
import { ApiError } from "../api-error.js";
import type { BranchSync } from "./branch-sync.js";
import {
  ProviderAuthorizationError,
  type ConnectionRow,
  type ProviderAdapter,
  type ProviderName
} from "./types.js";

// Applies stored webhook deliveries in received order and reconciles every
// active connection (docs/project-branches.md §8.1, §8.8). One replica runs
// it in-process: a single-flight tick, an optimistic claim, and backoff.

type DeliveryRow = typeof repositoryWebhookDeliveries.$inferSelect;

export const MAX_ATTEMPTS = 10;
const STALE_PROCESSING_MS = 5 * 60_000;
// Provider errors are recorded without bodies, headers or tokens.
const errorText = (error: unknown) =>
  (error instanceof Error ? error.message : "Delivery failed.").slice(0, 1000);

export class RepositorySyncWorker {
  private timer?: ReturnType<typeof setInterval>;
  private running: Promise<void> | null = null;
  private readonly requested = new Set<string>();

  constructor(
    private readonly db: Database,
    private readonly sync: BranchSync,
    private readonly adapters: Map<ProviderName, ProviderAdapter>,
    private readonly options: {
      reconcileIntervalSeconds: number;
      tickMs?: number;
      batch?: number;
      now?: () => Date;
    }
  ) {}

  private now() {
    return this.options.now?.() ?? new Date();
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(
      () => void this.tick(),
      this.options.tickMs ?? 2000
    );
    this.timer.unref?.();
  }

  /** Stops the interval and waits for the tick in flight. */
  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }

  requestReconcile(connectionId: string) {
    this.requested.add(connectionId);
  }

  /** On boot: work a crashed worker left in `processing` goes back in line. */
  async resetStale() {
    await this.db
      .update(repositoryWebhookDeliveries)
      .set({ status: "pending", nextAttemptAt: this.now() })
      .where(
        and(
          eq(repositoryWebhookDeliveries.status, "processing"),
          lt(
            repositoryWebhookDeliveries.processedAt,
            new Date(this.now().getTime() - STALE_PROCESSING_MS)
          )
        )
      );
  }

  tick() {
    if (!this.running)
      this.running = this.run().finally(() => {
        this.running = null;
      });
    return this.running;
  }

  private async run() {
    const due = await this.db
      .select()
      .from(repositoryWebhookDeliveries)
      .where(
        and(
          eq(repositoryWebhookDeliveries.status, "pending"),
          lte(repositoryWebhookDeliveries.nextAttemptAt, this.now())
        )
      )
      .orderBy(asc(repositoryWebhookDeliveries.receivedAt))
      .limit(this.options.batch ?? 50);
    for (const row of due) {
      const [claimed] = await this.db
        .update(repositoryWebhookDeliveries)
        .set({ status: "processing", processedAt: this.now() })
        .where(
          and(
            eq(repositoryWebhookDeliveries.id, row.id),
            eq(repositoryWebhookDeliveries.status, "pending")
          )
        )
        .returning();
      if (claimed) await this.deliver(claimed);
    }
    await this.reconcileDue();
  }

  private async deliver(delivery: DeliveryRow) {
    try {
      const applied = await this.process(delivery);
      await this.finish(delivery.id, {
        status: applied ? "applied" : "ignored",
        processedAt: this.now(),
        lastError: null
      });
    } catch (error) {
      // An archived project takes no more provider changes.
      if (error instanceof ApiError && error.code === "PROJECT_ARCHIVED")
        return this.finish(delivery.id, {
          status: "ignored",
          processedAt: this.now(),
          lastError: null
        });
      const attempts = delivery.attempts + 1;
      await this.finish(delivery.id, {
        status: attempts >= MAX_ATTEMPTS ? "failed" : "pending",
        attempts,
        nextAttemptAt: new Date(
          this.now().getTime() + Math.min(10_000 * 2 ** attempts, 3_600_000)
        ),
        lastError: errorText(error),
        processedAt: this.now()
      });
    }
  }

  private finish(
    id: string,
    values: Partial<typeof repositoryWebhookDeliveries.$inferInsert>
  ) {
    return this.db
      .update(repositoryWebhookDeliveries)
      .set(values)
      .where(eq(repositoryWebhookDeliveries.id, id));
  }

  /** Returns false when no active connection takes the delivery. */
  private async process(delivery: DeliveryRow) {
    const connections = delivery.connectionId
      ? await this.db
          .select()
          .from(repositoryConnections)
          .where(
            and(
              eq(repositoryConnections.id, delivery.connectionId),
              isNull(repositoryConnections.disconnectedAt)
            )
          )
      : delivery.installationId
        ? await this.db
            .select()
            .from(repositoryConnections)
            .where(
              and(
                eq(repositoryConnections.provider, delivery.provider),
                eq(
                  repositoryConnections.installationId,
                  delivery.installationId
                ),
                isNull(repositoryConnections.disconnectedAt)
              )
            )
        : [];
    if (!connections.length) return false;
    const adapter = this.adapters.get(delivery.provider);
    if (!adapter) return false;
    for (const connection of connections)
      await this.sync.apply(
        connection,
        adapter.parse(
          { eventType: delivery.eventType, payload: delivery.payload },
          connection
        ),
        delivery.deliveryId
      );
    return true;
  }

  // Spread reconciles over ±20% of the interval, stable per connection.
  private jitter(connectionId: string) {
    const byte = createHash("sha256").update(connectionId).digest()[0]!;
    return 0.8 + (byte / 255) * 0.4;
  }

  private async reconcileDue() {
    const active = await this.db
      .select()
      .from(repositoryConnections)
      .where(isNull(repositoryConnections.disconnectedAt));
    for (const connection of active) {
      const interval =
        this.options.reconcileIntervalSeconds *
        1000 *
        this.jitter(connection.id);
      const due =
        this.requested.has(connection.id) ||
        !connection.lastReconciledAt ||
        this.now().getTime() - connection.lastReconciledAt.getTime() >=
          interval;
      if (!due) continue;
      this.requested.delete(connection.id);
      await this.reconcile(connection);
    }
  }

  async reconcile(connection: ConnectionRow) {
    if (
      connection.status === "suspended" ||
      connection.status === "needs_reauthorization"
    )
      return;
    try {
      await this.sync.reconcile(connection);
    } catch (error) {
      await this.db
        .update(repositoryConnections)
        .set(
          error instanceof ProviderAuthorizationError
            ? {
                status: "needs_reauthorization",
                statusReason: "Reconnect to restore access.",
                updatedAt: this.now()
              }
            : {
                status: "error",
                statusReason: errorText(error),
                lastReconciledAt: this.now(),
                updatedAt: this.now()
              }
        )
        .where(eq(repositoryConnections.id, connection.id));
    }
  }
}
