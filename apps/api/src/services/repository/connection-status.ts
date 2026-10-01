import { repositoryConnections, type Database } from "@orchestrat/db";
import { eq } from "drizzle-orm";
import { insertProjectEvent } from "../agent-service.js";
import type { ConnectionRow } from "./types.js";

/**
 * Updates a connection and, when its status actually changes, tells the
 * project with one `repository.status_changed` event (docs/project-branches.md
 * §10), so open dashboards show the new state.
 */
export async function updateConnection(
  db: Database,
  connectionId: string,
  values: Partial<typeof repositoryConnections.$inferInsert>,
  now: Date
) {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(repositoryConnections)
      .where(eq(repositoryConnections.id, connectionId))
      .for("update");
    if (!row) return;
    await tx
      .update(repositoryConnections)
      .set({ ...values, updatedAt: now })
      .where(eq(repositoryConnections.id, connectionId));
    const status = values.status as ConnectionRow["status"] | undefined;
    if (status && status !== row.status)
      await insertProjectEvent(tx, {
        projectId: row.projectId,
        entityId: row.id,
        type: "repository.status_changed",
        payload: {
          provider: row.provider,
          from: row.status,
          status,
          reason: values.statusReason ?? null
        }
      });
  });
}
