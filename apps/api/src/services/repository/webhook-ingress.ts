import {
  repositoryConnections,
  repositoryWebhookDeliveries,
  type Database
} from "@orchestrat/db";
import { and, eq, isNull } from "drizzle-orm";
import type {
  ConnectionRow,
  Headers,
  ProviderAdapter,
  ProviderName
} from "./types.js";

// Webhook receipt (docs/project-branches.md §8.1): verify on the raw body,
// store once per provider delivery id, answer fast. The sync worker applies
// stored deliveries in order; nothing here touches branches.

export type IngressResult = 202 | 401 | 404 | 503;

export class WebhookIngress {
  constructor(
    private readonly db: Database,
    private readonly adapters: Map<ProviderName, ProviderAdapter>,
    private readonly now: () => Date = () => new Date()
  ) {}

  async receive(
    provider: ProviderName,
    headers: Headers,
    rawBody: Buffer,
    connectionId?: string
  ): Promise<IngressResult> {
    const adapter = this.adapters.get(provider);
    if (!adapter) return 404;
    try {
      let connection: ConnectionRow | null = null;
      if (adapter.verifiesPerConnection) {
        // Unknown or disconnected: no secret to verify with, and repeated
        // failures let the provider disable the orphaned hook.
        if (!connectionId) return 404;
        const [row] = await this.db
          .select()
          .from(repositoryConnections)
          .where(
            and(
              eq(repositoryConnections.id, connectionId),
              eq(repositoryConnections.provider, provider),
              isNull(repositoryConnections.disconnectedAt)
            )
          )
          .limit(1);
        if (!row) return 404;
        connection = row;
      }
      const delivery = await adapter.verify({
        headers,
        rawBody,
        connection,
        now: this.now()
      });
      if (!delivery) return 401;
      if (
        connection &&
        delivery.repositoryId &&
        delivery.repositoryId !== connection.providerRepositoryId
      )
        connection = null;
      else if (!connection) connection = await this.resolve(provider, delivery);
      // Installation-wide events apply to every connection of it.
      const installationWide = !connection && Boolean(delivery.installationId);
      await this.db
        .insert(repositoryWebhookDeliveries)
        .values({
          provider,
          deliveryId: delivery.deliveryId,
          connectionId: connection?.id ?? null,
          eventType: delivery.eventType,
          installationId: delivery.installationId,
          payload: delivery.payload,
          status: connection || installationWide ? "pending" : "ignored",
          receivedAt: this.now(),
          nextAttemptAt: this.now()
        })
        .onConflictDoNothing();
      return 202;
    } catch {
      return 503;
    }
  }

  private async resolve(
    provider: ProviderName,
    delivery: { installationId: string | null; repositoryId: string | null }
  ) {
    if (!delivery.repositoryId) return null;
    const [row] = await this.db
      .select()
      .from(repositoryConnections)
      .where(
        and(
          eq(repositoryConnections.provider, provider),
          eq(repositoryConnections.providerRepositoryId, delivery.repositoryId),
          isNull(repositoryConnections.disconnectedAt)
        )
      )
      .limit(1);
    // A repository reached through a different installation isn't ours.
    if (
      row &&
      delivery.installationId &&
      row.installationId &&
      row.installationId !== delivery.installationId
    )
      return null;
    return row ?? null;
  }
}
