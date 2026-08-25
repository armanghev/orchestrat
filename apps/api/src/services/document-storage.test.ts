import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { S3Client } from "@aws-sdk/client-s3";
import {
  createDatabase,
  documents,
  documentRevisions,
  projectEvents,
  users
} from "@orchestrat/db";
import { and, eq } from "drizzle-orm";
import { fixture } from "../test/fixture.js";
import { ApiError } from "./api-error.js";
import { DocumentService } from "./document-service.js";

const ALICE = "550e8400-e29b-41d4-a716-446655440000";

class FakeObjectStorage {
  readonly objects = new Map<string, Buffer>();
  readonly putKeys: string[] = [];
  readonly deleteKeys: string[] = [];
  getCount = 0;
  failPut = false;
  onPut: (() => Promise<void>) | undefined;
  onList: (() => Promise<void>) | undefined;

  async send(command: { input: Record<string, unknown> }) {
    const name = command.constructor.name;
    const input = command.input;
    const key = String(input.Key);
    if (name === "PutObjectCommand") {
      if (this.failPut) throw new Error("put failed");
      await this.onPut?.();
      const body = input.Body;
      this.objects.set(
        key,
        Buffer.isBuffer(body)
          ? Buffer.from(body)
          : Buffer.from(String(body ?? ""))
      );
      this.putKeys.push(key);
      return {};
    }
    if (name === "DeleteObjectCommand") {
      this.objects.delete(key);
      this.deleteKeys.push(key);
      return {};
    }
    if (name === "ListObjectsV2Command") {
      await this.onList?.();
      const prefix = String(input.Prefix);
      return {
        Contents: [...this.objects.keys()]
          .filter((objectKey) => objectKey.startsWith(prefix))
          .map((Key) => ({ Key }))
      };
    }
    if (name === "GetObjectCommand") {
      this.getCount += 1;
      const body = this.objects.get(key);
      if (!body) throw new Error("missing object");
      return { Body: { transformToByteArray: async () => body } };
    }
    throw new Error(`unsupported command: ${name}`);
  }
}

async function setup(initialContent = "one") {
  const { app, db } = await fixture();
  const organization = (
    await app.inject({
      method: "POST",
      url: "/api/v1/organizations",
      headers: { authorization: "Bearer alice" },
      payload: { name: `Documents ${randomUUID()}` }
    })
  ).json();
  const project = (
    await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organization.id}/projects`,
      headers: { authorization: "Bearer alice" },
      payload: { name: "Primary" }
    })
  ).json();
  const document = (
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/documents`,
      headers: { authorization: "Bearer alice" },
      payload: { path: `docs/${randomUUID()}.md`, content: initialContent }
    })
  ).json();
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.authSubject, ALICE));
  const storage = new FakeObjectStorage();
  const service = new DocumentService(db, {
    endpoint: "http://storage.test",
    region: "us-east-1",
    accessKeyId: "test",
    secretAccessKey: "test",
    bucket: "documents",
    client: storage as unknown as S3Client
  });
  return { app, db, document, service, storage, userId: user.id };
}

async function events(
  db: ReturnType<typeof createDatabase>["db"],
  projectId: string
) {
  return db
    .select()
    .from(projectEvents)
    .where(eq(projectEvents.projectId, projectId));
}

function assertApiError(code: string, details?: Record<string, unknown>) {
  return (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.code, code);
    if (details) assert.deepEqual(error.details, details);
    return true;
  };
}

test("exact edits apply sequentially and preserve Unicode", async () => {
  const { document, service, userId } = await setup("name: café\nemoji: 🙂");
  const result = await service.edit(userId, document.document.id, {
    base_revision: 1,
    edits: [
      { old_text: "café", new_text: "tea" },
      { old_text: "🙂", new_text: "🌟" }
    ]
  });
  assert.equal(result.revision.content, "name: tea\nemoji: 🌟");
});

test("exact edits reject ambiguous, missing, and overlapping matches", async () => {
  const ambiguous = await setup("a-a");
  await assert.rejects(
    ambiguous.service.edit(ambiguous.userId, ambiguous.document.document.id, {
      base_revision: 1,
      edits: [{ old_text: "a", new_text: "b" }]
    }),
    assertApiError("DOCUMENT_EDIT_MISMATCH", { edit_index: 0, match_count: 2 })
  );

  const missing = await setup("abc");
  await assert.rejects(
    missing.service.edit(missing.userId, missing.document.document.id, {
      base_revision: 1,
      edits: [{ old_text: "x", new_text: "y" }]
    }),
    assertApiError("DOCUMENT_EDIT_MISMATCH", { edit_index: 0, match_count: 0 })
  );

  const overlapping = await setup("aaaa");
  await assert.rejects(
    overlapping.service.edit(
      overlapping.userId,
      overlapping.document.document.id,
      {
        base_revision: 1,
        edits: [{ old_text: "aa", new_text: "b" }]
      }
    ),
    assertApiError("DOCUMENT_EDIT_MISMATCH", { edit_index: 0, match_count: 3 })
  );
});

test("content size and stale bases are rejected", async () => {
  const { app, document, service, userId } = await setup();
  const response = await app.inject({
    method: "PATCH",
    url: `/api/v1/documents/${document.document.id}`,
    headers: { authorization: "Bearer alice" },
    payload: { base_revision: 1, content: "x".repeat(1_000_001) }
  });
  assert.equal(response.statusCode, 400);

  await service.update(userId, document.document.id, {
    base_revision: 1,
    content: "two"
  });
  await assert.rejects(
    service.update(userId, document.document.id, {
      base_revision: 1,
      content: "three"
    }),
    assertApiError("DOCUMENT_CONFLICT", {
      current_revision: 2,
      base_revision: 1
    })
  );
});

test("stale same-content full writes are no-ops", async () => {
  const { db, document, service, userId } = await setup();
  await service.update(userId, document.document.id, {
    base_revision: 1,
    content: "two",
    save_kind: "autosave"
  });
  const beforeRevisions = await db
    .select()
    .from(documentRevisions)
    .where(eq(documentRevisions.documentId, document.document.id));
  const beforeEvents = await events(db, document.document.project_id);
  assert.equal(beforeEvents.at(-1)?.payload.save_kind, "autosave");
  const result = await service.update(userId, document.document.id, {
    base_revision: 1,
    content: "two"
  });
  assert.equal(result.revision.revision_number, 2);
  assert.equal(
    (
      await db
        .select()
        .from(documentRevisions)
        .where(eq(documentRevisions.documentId, document.document.id))
    ).length,
    beforeRevisions.length
  );
  assert.equal(
    (await events(db, document.document.project_id)).length,
    beforeEvents.length
  );
});

test("storage Put failure creates no revision or event", async () => {
  const { db, document, service, storage, userId } = await setup();
  const beforeRevisions = await db
    .select()
    .from(documentRevisions)
    .where(eq(documentRevisions.documentId, document.document.id));
  const beforeEvents = await events(db, document.document.project_id);
  storage.failPut = true;
  await assert.rejects(
    service.update(userId, document.document.id, {
      base_revision: 1,
      content: "two"
    }),
    assertApiError("STORAGE_UPLOAD_FAILED")
  );
  assert.equal(
    (
      await db
        .select()
        .from(documentRevisions)
        .where(eq(documentRevisions.documentId, document.document.id))
    ).length,
    beforeRevisions.length
  );
  assert.equal(
    (await events(db, document.document.project_id)).length,
    beforeEvents.length
  );
});

test("stale conflict removes an uploaded orphan when its revision is absent", async () => {
  const { db, document, service, storage, userId } = await setup();
  storage.onPut = async () => {
    await db
      .update(documents)
      .set({ currentRevision: 2, updatedAt: new Date() })
      .where(eq(documents.id, document.document.id));
  };
  await assert.rejects(
    service.update(userId, document.document.id, {
      base_revision: 1,
      content: "two"
    }),
    assertApiError("DOCUMENT_CONFLICT")
  );
  assert.equal(storage.deleteKeys.length, 1);
  assert.equal(
    (
      await db
        .select()
        .from(documentRevisions)
        .where(eq(documentRevisions.documentId, document.document.id))
    ).length,
    1
  );
  /* The deliberately advanced pointer models a concurrent writer in this test. */
  await db
    .update(documents)
    .set({ currentRevision: 1 })
    .where(eq(documents.id, document.document.id));
  void userId;
});

test("an ambiguous commit response retains a potentially referenced object", async () => {
  const { db, document, service, storage, userId } = await setup();
  const transaction = db.transaction.bind(db);
  Object.defineProperty(db, "transaction", {
    configurable: true,
    value: async (callback: Parameters<typeof db.transaction>[0]) => {
      await transaction(callback);
      throw new Error("commit response lost");
    }
  });
  await assert.rejects(
    service.update(userId, document.document.id, {
      base_revision: 1,
      content: "two"
    }),
    /commit response lost/
  );
  assert.equal(storage.deleteKeys.length, 0);
  assert.equal(
    (
      await db
        .select()
        .from(documentRevisions)
        .where(eq(documentRevisions.documentId, document.document.id))
    ).length,
    2
  );
});

test("corrupt and missing metadata-backed objects are unavailable", async () => {
  const corrupt = await setup();
  await corrupt.service.update(corrupt.userId, corrupt.document.document.id, {
    base_revision: 1,
    content: "two"
  });
  const corruptRevision = (
    await corrupt.db
      .select()
      .from(documentRevisions)
      .where(
        and(
          eq(documentRevisions.documentId, corrupt.document.document.id),
          eq(documentRevisions.revisionNumber, 2)
        )
      )
  )[0];
  const corruptKey = `document-revisions/v1/${corrupt.document.document.project_id}/${corrupt.document.document.id}/${corruptRevision.id}.md`;
  corrupt.storage.objects.set(corruptKey, Buffer.from("tampered"));
  await assert.rejects(
    corrupt.service.get(corrupt.userId, corrupt.document.document.id),
    assertApiError("DOCUMENT_CONTENT_UNAVAILABLE")
  );

  const missing = await setup();
  await missing.service.update(missing.userId, missing.document.document.id, {
    base_revision: 1,
    content: "two"
  });
  const missingRevision = (
    await missing.db
      .select()
      .from(documentRevisions)
      .where(
        and(
          eq(documentRevisions.documentId, missing.document.document.id),
          eq(documentRevisions.revisionNumber, 2)
        )
      )
  )[0];
  const missingKey = `document-revisions/v1/${missing.document.document.project_id}/${missing.document.document.id}/${missingRevision.id}.md`;
  missing.storage.objects.delete(missingKey);
  await assert.rejects(
    missing.service.get(missing.userId, missing.document.document.id),
    assertApiError("DOCUMENT_CONTENT_UNAVAILABLE")
  );
});

test("summary history avoids object reads and detail reads one historical object", async () => {
  const { document, service, storage, userId } = await setup();
  await service.update(userId, document.document.id, {
    base_revision: 1,
    content: "two"
  });
  storage.getCount = 0;
  const summary = await service.revisions(userId, document.document.id, {
    view: "summary",
    limit: 50
  });
  assert.equal(summary.revisions.length, 2);
  assert.equal(storage.getCount, 0);

  const detail = await service.revision(userId, document.document.id, 2);
  assert.equal(detail.revision.content, "two");
  assert.equal(storage.getCount, 1);
});

test("project deletion removes database state before best-effort object cleanup", async () => {
  const storage = new FakeObjectStorage();
  const storageConfig = {
    endpoint: "http://storage.test",
    region: "us-east-1",
    accessKeyId: "test",
    secretAccessKey: "test",
    bucket: "documents",
    client: storage as unknown as S3Client
  };
  const { app, db } = await fixture({ documentStorage: storageConfig });
  const organization = (
    await app.inject({
      method: "POST",
      url: "/api/v1/organizations",
      headers: { authorization: "Bearer alice" },
      payload: { name: `Cleanup ${randomUUID()}` }
    })
  ).json();
  const project = (
    await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organization.id}/projects`,
      headers: { authorization: "Bearer alice" },
      payload: { name: "Cleanup" }
    })
  ).json();
  await app.inject({
    method: "POST",
    url: `/api/v1/projects/${project.id}/documents`,
    headers: { authorization: "Bearer alice" },
    payload: { path: "cleanup.md", content: "cleanup" }
  });
  storage.objects.set(
    `document-attachments/v1/${project.id}/${randomUUID()}/${randomUUID()}`,
    Buffer.from("attachment")
  );
  storage.objects.set(
    `document-revisions/v1/${randomUUID()}/${randomUUID()}/${randomUUID()}.md`,
    Buffer.from("other project")
  );
  storage.onList = async () => {
    assert.equal(
      (
        await db
          .select()
          .from(documents)
          .where(eq(documents.projectId, project.id))
      ).length,
      0
    );
  };

  const response = await app.inject({
    method: "DELETE",
    url: `/api/v1/projects/${project.id}`,
    headers: { authorization: "Bearer alice" },
    payload: { name: "Cleanup" }
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(
    [...storage.objects.keys()].some((key) => key.includes(project.id)),
    false
  );
  assert.equal(storage.objects.size, 1);
});
