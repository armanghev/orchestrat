import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { S3Client } from "@aws-sdk/client-s3";
import {
  documentAttachmentUploads,
  documentAttachments,
  documents,
  projectEvents,
  users
} from "@orchestrat/db";
import { eq } from "drizzle-orm";
import { fixture } from "../test/fixture.js";
import type { AgentPrincipal } from "./agent-service.js";
import { ApiError } from "./api-error.js";
import { AttachmentService } from "./attachment-service.js";
import type { DocumentStorageConfig } from "./document-service.js";
import { expireUploads } from "../operations/storage-operations.js";

const AUTH_SUBJECT = "550e8400-e29b-41d4-a716-446655440000";
const DIRECT_SIZE = 100 * 1024 * 1024;
const PART_SIZE = 16 * 1024 * 1024;
const MULTIPART_SIZE = DIRECT_SIZE + 1;
const config = {
  bucket: "documents",
  endpoint: "https://storage.example.test",
  region: "us-east-1",
  accessKeyId: "access",
  secretAccessKey: "secret"
};

type Command = { input: Record<string, any> };

class FakeS3 {
  readonly objects = new Map<string, number>();
  readonly multipart = new Map<
    string,
    { key: string; parts: Map<number, string> }
  >();
  readonly commands: string[] = [];
  completeParts: Array<{ PartNumber: number; ETag: string }> = [];
  completeCalls = 0;
  failCompleteAfterCommit = false;
  beforeSend?: (name: string) => Promise<void>;

  async send(command: Command) {
    const name = command.constructor.name;
    await this.beforeSend?.(name);
    const input = command.input;
    this.commands.push(name);
    const key = String(input.Key ?? "");
    if (name === "PutObjectCommand") {
      this.objects.set(key, Number(input.ContentLength ?? 0));
      return {};
    }
    if (name === "CreateMultipartUploadCommand") {
      const uploadId = `provider-${this.multipart.size + 1}`;
      this.multipart.set(uploadId, { key, parts: new Map() });
      return { UploadId: uploadId };
    }
    if (name === "ListPartsCommand") {
      const upload = this.multipart.get(String(input.UploadId));
      if (!upload) throw new Error("NoSuchUpload");
      return {
        Parts: [...upload.parts.entries()].map(([PartNumber, ETag]) => ({
          PartNumber,
          ETag
        }))
      };
    }
    if (name === "CompleteMultipartUploadCommand") {
      this.completeCalls += 1;
      const uploadId = String(input.UploadId);
      const upload = this.multipart.get(uploadId);
      if (!upload) throw new Error("NoSuchUpload");
      const parts = input.MultipartUpload.Parts as Array<{
        PartNumber: number;
        ETag: string;
      }>;
      this.completeParts = parts;
      const size = parts.reduce(
        (total, part) =>
          total +
          (part.PartNumber === Math.ceil(MULTIPART_SIZE / PART_SIZE)
            ? MULTIPART_SIZE % PART_SIZE || PART_SIZE
            : PART_SIZE),
        0
      );
      this.objects.set(upload.key, size);
      this.multipart.delete(uploadId);
      if (this.failCompleteAfterCommit) {
        this.failCompleteAfterCommit = false;
        throw new Error("provider response lost after commit");
      }
      return {};
    }
    if (name === "HeadObjectCommand") {
      const size = this.objects.get(key);
      if (size === undefined) throw new Error("NotFound");
      return { ContentLength: size };
    }
    if (name === "AbortMultipartUploadCommand") {
      this.multipart.delete(String(input.UploadId));
      return {};
    }
    if (name === "DeleteObjectCommand") {
      this.objects.delete(key);
      return {};
    }
    if (name === "CopyObjectCommand") {
      const source = String(input.CopySource).replace(/^[^/]+\//, "");
      const size = this.objects.get(source);
      if (size === undefined) throw new Error("NoSuchKey");
      this.objects.set(key, size);
      return {};
    }
    throw new Error(`Unsupported command: ${name}`);
  }
}

function storageClient(fake: FakeS3, endpoint = config.endpoint) {
  const client = new S3Client({
    forcePathStyle: true,
    region: config.region,
    endpoint,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey
    }
  });
  client.send = ((command: Command) =>
    fake.send(command)) as typeof client.send;
  return client;
}

async function setup(
  storage: Partial<DocumentStorageConfig> = {},
  quotaBytes?: number
) {
  const { app, db } = await fixture();
  const organization = (
    await app.inject({
      method: "POST",
      url: "/api/v1/organizations",
      headers: { authorization: "Bearer alice" },
      payload: { name: `Attachments ${randomUUID()}` }
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
      payload: { path: `docs/${randomUUID()}.md`, content: "content" }
    })
  ).json();
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.authSubject, AUTH_SUBJECT));
  const fake = new FakeS3();
  const settings = { ...config, ...storage };
  const service = new AttachmentService(
    db,
    { ...settings, client: storageClient(fake, settings.endpoint) },
    undefined,
    quotaBytes
  );
  return {
    app,
    db,
    document: document.document,
    project,
    service,
    fake,
    userId: user.id
  };
}

const input = (size_bytes: number) => ({
  filename: "archive.bin",
  content_type: "application/octet-stream",
  size_bytes
});

function apiError(code: string) {
  return (error: unknown) => error instanceof ApiError && error.code === code;
}

function signsContentLength(url: unknown) {
  return new URL(String(url)).searchParams
    .get("X-Amz-SignedHeaders")
    ?.split(";")
    .includes("content-length");
}

test("server selects direct at 100 MiB and multipart above it", async () => {
  const { document, service, userId } = await setup();
  const direct = await service.create(userId, document.id, input(DIRECT_SIZE));
  assert.equal(direct.upload.mode, "single");
  assert.equal(
    signsContentLength((direct.upload as Record<string, unknown>).upload_url),
    true
  );
  assert.equal(
    signsContentLength(
      (
        (await service.refresh(userId, direct.upload.id, document.id))
          .upload as Record<string, unknown>
      ).upload_url
    ),
    true
  );
  const multipart = await service.create(
    userId,
    document.id,
    input(MULTIPART_SIZE)
  );
  assert.equal(multipart.upload.mode, "multipart");
  assert.equal(
    (multipart.upload as Record<string, unknown>).part_size_bytes,
    PART_SIZE
  );
  assert.ok((multipart.upload as Record<string, unknown>).upload_id);
});

test("upload URLs are signed for the public endpoint; server calls stay internal", async () => {
  const { document, project, service, fake, userId } = await setup({
    endpoint: "http://minio:9000",
    publicEndpoint: "http://localhost:9000"
  });
  const host = (url: unknown) => new URL(String(url)).host;
  const direct = await service.create(userId, document.id, input(10));
  const directUrl = (direct.upload as Record<string, unknown>).upload_url;
  assert.equal(host(directUrl), "localhost:9000");
  // An empty-body checksum in the URL would make real uploads fail.
  assert.equal(
    new URL(String(directUrl)).searchParams.has("x-amz-checksum-crc32"),
    false
  );
  assert.match(
    new URL(String(directUrl)).pathname,
    new RegExp(`^/documents/document-attachments/v1/${project.id}/`)
  );
  assert.equal(
    host(
      (
        (await service.refresh(userId, direct.upload.id, document.id))
          .upload as Record<string, unknown>
      ).upload_url
    ),
    "localhost:9000"
  );

  const multipart = await service.create(
    userId,
    document.id,
    input(MULTIPART_SIZE)
  );
  const signed = await service.signPartsForUser(
    userId,
    multipart.upload.id,
    [1, 2],
    document.id
  );
  assert.deepEqual(
    signed.parts.map((part) => host(part.upload_url)),
    ["localhost:9000", "localhost:9000"]
  );
  // Every provider call went through the internal client; none was signed.
  assert.deepEqual(fake.commands, ["CreateMultipartUploadCommand"]);

  const key = `document-attachments/v1/${project.id}/${document.id}/${direct.upload.id}`;
  fake.objects.set(key, 10);
  const completed = await service.complete(
    userId,
    direct.upload.id,
    undefined,
    document.id
  );
  assert.equal(completed.attachment.size_bytes, 10);
  await service.mergeObjects()!.copy(
    {
      projectId: project.id,
      documentId: document.id,
      attachmentId: direct.upload.id
    },
    { projectId: project.id, documentId: document.id, attachmentId: "copy" }
  );
  assert.deepEqual(fake.commands.slice(1), [
    "HeadObjectCommand",
    "CopyObjectCommand"
  ]);

  // Without a public endpoint, URLs use the server endpoint as before.
  const plain = await setup();
  const plainUpload = await plain.service.create(
    plain.userId,
    plain.document.id,
    input(10)
  );
  assert.equal(
    host((plainUpload.upload as Record<string, unknown>).upload_url),
    "storage.example.test"
  );
});

test("a configured attachment quota replaces the 10 GiB default", async () => {
  const { document, service, userId } = await setup({}, 1000);
  await service.create(userId, document.id, input(600));
  await assert.rejects(
    service.create(userId, document.id, input(401)),
    apiError("ATTACHMENT_QUOTA_EXCEEDED")
  );
  await service.create(userId, document.id, input(400));
});

test("buildApp passes the quota to attachment uploads", async (t) => {
  const fake = new FakeS3();
  const { app } = await fixture({
    documentStorage: { ...config, client: storageClient(fake) },
    attachmentQuotaBytes: 100
  });
  t.after(() => app.close());
  const alice = { authorization: "Bearer alice" };
  const organization = (
    await app.inject({
      method: "POST",
      url: "/api/v1/organizations",
      headers: alice,
      payload: { name: `Quota ${randomUUID()}` }
    })
  ).json();
  const project = (
    await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organization.id}/projects`,
      headers: alice,
      payload: { name: "Primary" }
    })
  ).json();
  const document = (
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/documents`,
      headers: alice,
      payload: { path: "docs/quota.md", content: "content" }
    })
  ).json().document;
  const upload = (size_bytes: number) =>
    app.inject({
      method: "POST",
      url: `/api/v1/documents/${document.id}/attachments/uploads`,
      headers: alice,
      payload: input(size_bytes)
    });
  assert.equal((await upload(100)).statusCode, 201);
  const over = await upload(1);
  assert.equal(over.statusCode, 409);
  assert.equal(over.json().error.code, "ATTACHMENT_QUOTA_EXCEEDED");
});

test("rejects attachments above 2 GiB before reserving quota", async () => {
  const { db, document, service, userId } = await setup();
  await assert.rejects(
    service.create(userId, document.id, input(2 * 1024 * 1024 * 1024 + 1)),
    apiError("VALIDATION_ERROR")
  );
  assert.equal(
    (
      await db
        .select()
        .from(documentAttachmentUploads)
        .where(eq(documentAttachmentUploads.documentId, document.id))
    ).length,
    0
  );
});

test("bounds part signing and refresh/inspection use provider parts", async () => {
  const { document, service, fake, userId } = await setup();
  const created = await service.create(
    userId,
    document.id,
    input(MULTIPART_SIZE)
  );
  const uploadId = created.upload.id;
  const providerId = created.upload.upload_id!;
  fake.multipart.get(providerId)!.parts.set(1, "server-etag");
  await assert.rejects(
    service.signPartsForUser(userId, uploadId, [1, 1], document.id),
    apiError("VALIDATION_ERROR")
  );
  await assert.rejects(
    service.signPartsForUser(
      userId,
      uploadId,
      Array.from({ length: 101 }, (_, i) => i + 1),
      document.id
    ),
    apiError("VALIDATION_ERROR")
  );
  await assert.rejects(
    service.signPartsForUser(userId, uploadId, [8], document.id),
    apiError("VALIDATION_ERROR")
  );
  const signed = await service.signPartsForUser(
    userId,
    uploadId,
    [1, 7],
    document.id
  );
  assert.equal(signed.parts.length, 2);
  assert.equal(signed.parts[0].part_number, 1);
  assert.match(signed.parts[0].upload_url, /^https:\/\//);
  assert.equal(
    signed.parts.every((part) => signsContentLength(part.upload_url)),
    true
  );
  assert.deepEqual(
    (
      (await service.inspect(userId, uploadId, document.id)).upload as Record<
        string,
        unknown
      >
    ).completed_parts,
    [{ part_number: 1, etag: "server-etag" }]
  );
  assert.deepEqual(
    (
      (await service.refresh(userId, uploadId, document.id)).upload as Record<
        string,
        unknown
      >
    ).completed_parts,
    [{ part_number: 1, etag: "server-etag" }]
  );
});

test("direct completion verifies HeadObject size and records an event", async () => {
  const { db, document, service, fake, project, userId } = await setup();
  const created = await service.create(userId, document.id, input(10));
  const key = `document-attachments/v1/${project.id}/${document.id}/${created.upload.id}`;
  fake.objects.set(key, 10);
  const result = await service.complete(
    userId,
    created.upload.id,
    [],
    document.id
  );
  assert.equal(result.attachment.id, created.upload.id);
  assert.equal(result.upload?.status, "completed");
  assert.ok(fake.commands.includes("HeadObjectCommand"));
  const events = await db
    .select()
    .from(projectEvents)
    .where(eq(projectEvents.projectId, project.id));
  assert.equal(events.at(-1)?.type, "document.attachment_added");
});

test("direct completion rejects a corrupt object without attachment metadata", async () => {
  const { db, document, service, fake, userId } = await setup();
  const created = await service.create(userId, document.id, input(10));
  fake.objects.set(
    `document-attachments/v1/${document.project_id}/${document.id}/${created.upload.id}`,
    9
  );
  await assert.rejects(
    service.complete(userId, created.upload.id, [], document.id),
    apiError("STORAGE_UPLOAD_FAILED")
  );
  assert.equal(
    (
      await db
        .select()
        .from(documentAttachments)
        .where(eq(documentAttachments.id, created.upload.id))
    ).length,
    0
  );
  const [upload] = await db
    .select()
    .from(documentAttachmentUploads)
    .where(eq(documentAttachmentUploads.id, created.upload.id));
  assert.equal(upload.status, "aborted");
});

test("multipart completion uses listed ETags and recovers an already-completed object", async () => {
  const { db, document, service, fake, project, userId } = await setup();
  const created = await service.create(
    userId,
    document.id,
    input(MULTIPART_SIZE)
  );
  const providerId = created.upload.upload_id!;
  const upload = fake.multipart.get(providerId)!;
  const expectedParts = Math.ceil(MULTIPART_SIZE / PART_SIZE);
  for (let part = 1; part <= expectedParts; part += 1)
    upload.parts.set(part, `server-${part}`);
  fake.failCompleteAfterCommit = true;
  await service.complete(
    userId,
    created.upload.id,
    [{ part_number: 1, etag: "client-forged" }],
    document.id
  );
  const complete = fake.commands.indexOf("CompleteMultipartUploadCommand");
  assert.ok(complete >= 0);
  assert.equal(fake.completeCalls, 1);
  assert.deepEqual(
    fake.completeParts,
    Array.from({ length: expectedParts }, (_, index) => ({
      PartNumber: index + 1,
      ETag: `server-${index + 1}`
    }))
  );
  assert.equal(fake.objects.size, 1);
  assert.equal(fake.multipart.size, 0);
  const events = await db
    .select()
    .from(projectEvents)
    .where(eq(projectEvents.projectId, project.id));
  assert.equal(
    events.filter((event) => event.type === "document.attachment_added").length,
    1
  );
});

test("abort clears direct and multipart sessions; expired sessions are rejected", async () => {
  const direct = await setup();
  const directUpload = await direct.service.create(
    direct.userId,
    direct.document.id,
    input(10)
  );
  await direct.service.abort(
    direct.userId,
    directUpload.upload.id,
    direct.document.id
  );
  assert.ok(direct.fake.commands.includes("DeleteObjectCommand"));
  const [aborted] = await direct.db
    .select()
    .from(documentAttachmentUploads)
    .where(eq(documentAttachmentUploads.id, directUpload.upload.id));
  assert.equal(aborted.status, "aborted");

  const multipart = await setup();
  const multipartUpload = await multipart.service.create(
    multipart.userId,
    multipart.document.id,
    input(MULTIPART_SIZE)
  );
  await multipart.service.abort(
    multipart.userId,
    multipartUpload.upload.id,
    multipart.document.id
  );
  assert.ok(multipart.fake.commands.includes("AbortMultipartUploadCommand"));

  const expired = await setup();
  const expiredUpload = await expired.service.create(
    expired.userId,
    expired.document.id,
    input(10)
  );
  await expired.db
    .update(documentAttachmentUploads)
    .set({ expiresAt: new Date(Date.now() - 1_000) })
    .where(eq(documentAttachmentUploads.id, expiredUpload.upload.id));
  await assert.rejects(
    expired.service.inspect(
      expired.userId,
      expiredUpload.upload.id,
      expired.document.id
    ),
    apiError("ATTACHMENT_UPLOAD_EXPIRED")
  );
  const [expiredRow] = await expired.db
    .select()
    .from(documentAttachmentUploads)
    .where(eq(documentAttachmentUploads.id, expiredUpload.upload.id));
  assert.equal(expiredRow.status, "pending");
  const cleanup = await expireUploads(
    expired.db,
    storageClient(expired.fake),
    config,
    new Date(),
    true
  );
  assert.equal(cleanup.expired, 1);
  assert.ok(expired.fake.commands.includes("DeleteObjectCommand"));
});

test("archived documents reject attachment uploads", async () => {
  const { app, document, service, fake, userId } = await setup();
  const response = await app.inject({
    method: "POST",
    url: `/api/v1/documents/${document.id}/archive`,
    headers: { authorization: "Bearer alice" }
  });
  assert.equal(response.statusCode, 200);
  await assert.rejects(
    service.create(userId, document.id, input(10)),
    apiError("DOCUMENT_ARCHIVED")
  );
  assert.equal(fake.commands.length, 0);
});

test("project quota includes completed and pending reservations", async () => {
  const { db, document, project, service, userId } = await setup();
  const [{ branchId }] = await db
    .select({ branchId: documents.branchId })
    .from(documents)
    .where(eq(documents.id, document.id));
  await db.insert(documentAttachments).values({
    id: randomUUID(),
    projectId: project.id,
    branchId,
    documentId: document.id,
    filename: "existing.bin",
    mimeType: "application/octet-stream",
    sizeBytes: 9 * 1024 * 1024 * 1024,
    addedByType: "human",
    addedByUserId: userId
  });
  await db.insert(documentAttachmentUploads).values({
    id: randomUUID(),
    projectId: project.id,
    branchId,
    documentId: document.id,
    filename: "reserved.bin",
    mimeType: "application/octet-stream",
    reservedBytes: 1024 * 1024 * 1024,
    uploadMode: "single",
    actorType: "human",
    actorUserId: userId,
    expiresAt: new Date(Date.now() + 60_000)
  });
  await assert.rejects(
    service.create(userId, document.id, input(1)),
    apiError("ATTACHMENT_QUOTA_EXCEEDED")
  );
});

test("agent project and document scope is enforced", async () => {
  const { app, document, service, userId } = await setup();
  await assert.rejects(
    service.create(randomUUID(), document.id, input(10)),
    apiError("PERMISSION_DENIED")
  );
  const organization = (
    await app.inject({
      method: "POST",
      url: "/api/v1/organizations",
      headers: { authorization: "Bearer alice" },
      payload: { name: `Other ${randomUUID()}` }
    })
  ).json();
  const project = (
    await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organization.id}/projects`,
      headers: { authorization: "Bearer alice" },
      payload: { name: "Other project" }
    })
  ).json();
  const principal: AgentPrincipal = {
    agentId: randomUUID(),
    projectId: project.id,
    credentialId: randomUUID()
  };
  await assert.rejects(
    service.createForAgent(principal, document.id, input(10)),
    apiError("NOT_FOUND")
  );
  await assert.rejects(
    service.create(userId, randomUUID(), input(10)),
    apiError("NOT_FOUND")
  );
});

test("completed upload completion is idempotent", async () => {
  const { document, project, service, fake, userId } = await setup();
  const created = await service.create(userId, document.id, input(10));
  fake.objects.set(
    `document-attachments/v1/${project.id}/${document.id}/${created.upload.id}`,
    10
  );
  const first = await service.complete(
    userId,
    created.upload.id,
    [],
    document.id
  );
  const commandCount = fake.commands.length;
  const second = await service.complete(
    userId,
    created.upload.id,
    [],
    document.id
  );
  assert.deepEqual(second, first);
  assert.equal(fake.commands.length, commandCount);
});

test("abort commits cancellation before cleanup can race with completion", async () => {
  const { db, document, service, fake, userId } = await setup();
  const { upload } = await service.create(userId, document.id, input(10));
  const key = `document-attachments/v1/${document.project_id}/${document.id}/${upload.id}`;
  fake.objects.set(key, 10);
  let raced = false;
  fake.beforeSend = async (name) => {
    if (name !== "DeleteObjectCommand") return;
    fake.beforeSend = undefined;
    raced = true;
    await assert.rejects(
      service.complete(userId, upload.id, [], document.id),
      apiError("CONFLICT")
    );
  };
  await service.abort(userId, upload.id, document.id);
  assert.equal(raced, true);
  assert.equal(fake.objects.has(key), false);
  assert.equal(
    (
      await db
        .select()
        .from(documentAttachments)
        .where(eq(documentAttachments.id, upload.id))
    ).length,
    0
  );
});

test("stale abort and expiry candidates preserve a completed attachment", async () => {
  const { db, document, service, fake, userId } = await setup();
  const { upload } = await service.create(userId, document.id, input(10));
  const [pending] = await db
    .select()
    .from(documentAttachmentUploads)
    .where(eq(documentAttachmentUploads.id, upload.id));
  const key = `document-attachments/v1/${document.project_id}/${document.id}/${upload.id}`;
  fake.objects.set(key, 10);
  await service.complete(userId, upload.id, [], document.id);
  const commands = fake.commands.length;
  await assert.rejects(
    (
      service as unknown as {
        abortProject: (row: typeof pending) => Promise<void>;
      }
    ).abortProject(pending),
    apiError("CONFLICT")
  );
  // Supply the expiry worker's already-read candidate, while its conditional
  // write still uses the real database containing the winning completion.
  const stale = Object.create(db) as typeof db;
  stale.select = (() => ({
    from: () => ({ where: async () => [pending] })
  })) as unknown as typeof db.select;
  const result = await expireUploads(
    stale,
    storageClient(fake),
    config,
    new Date(pending.expiresAt.getTime() + 1),
    true
  );
  assert.equal(result.expired, 0);
  assert.equal(fake.commands.length, commands);
  assert.equal(fake.objects.get(key), 10);
  assert.equal(
    (
      await db
        .select()
        .from(documentAttachments)
        .where(eq(documentAttachments.id, upload.id))
    ).length,
    1
  );
});
