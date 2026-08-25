import assert from "node:assert/strict";
import test from "node:test";
import { createDatabase, projectEvents } from "@orchestrat/db";
import { and, eq } from "drizzle-orm";
import { DocumentService } from "../services/document-service.js";
import { ApiError } from "../services/api-error.js";

const enabled = process.env.ORCHESTRAT_RUN_REAL_DOCUMENT_CONCURRENCY === "1";

test(
  "real PostgreSQL serializes two same-base document writes",
  { skip: !enabled },
  async () => {
    const databaseUrl = process.env.ORCHESTRAT_DATABASE_URL;
    const userId = process.env.ORCHESTRAT_DOCUMENT_TEST_USER_ID;
    const documentId = process.env.ORCHESTRAT_DOCUMENT_TEST_DOCUMENT_ID;
    if (!databaseUrl || !userId || !documentId)
      throw new Error(
        "ORCHESTRAT_DATABASE_URL, ORCHESTRAT_DOCUMENT_TEST_USER_ID, and ORCHESTRAT_DOCUMENT_TEST_DOCUMENT_ID are required."
      );
    const { db, pool } = createDatabase({ connectionString: databaseUrl });
    try {
      const documents = new DocumentService(db);
      const before = await documents.get(userId, documentId);
      const eventBefore = await db
        .select({ id: projectEvents.id })
        .from(projectEvents)
        .where(
          and(
            eq(projectEvents.projectId, before.document.project_id),
            eq(projectEvents.entityId, documentId),
            eq(projectEvents.type, "document.updated")
          )
        );
      const [left, right] = await Promise.allSettled([
        documents.update(userId, documentId, {
          base_revision: before.document.current_revision,
          content: `${before.revision.content}\nconcurrency-a`
        }),
        documents.update(userId, documentId, {
          base_revision: before.document.current_revision,
          content: `${before.revision.content}\nconcurrency-b`
        })
      ]);
      const results = [left, right];
      const fulfilled = results.filter(
        (result) => result.status === "fulfilled"
      );
      const conflicts = results.filter(
        (result) =>
          result.status === "rejected" &&
          result.reason instanceof ApiError &&
          result.reason.code === "DOCUMENT_CONFLICT"
      );
      assert.equal(fulfilled.length, 1);
      assert.equal(conflicts.length, 1);
      const after = await documents.get(userId, documentId);
      assert.equal(
        after.document.current_revision,
        before.document.current_revision + 1
      );
      const eventAfter = await db
        .select({ id: projectEvents.id })
        .from(projectEvents)
        .where(
          and(
            eq(projectEvents.projectId, before.document.project_id),
            eq(projectEvents.entityId, documentId),
            eq(projectEvents.type, "document.updated")
          )
        );
      assert.equal(eventAfter.length, eventBefore.length + 1);
    } finally {
      await pool.end();
    }
  }
);
