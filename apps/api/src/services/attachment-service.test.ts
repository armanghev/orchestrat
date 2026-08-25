import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { S3Client } from "@aws-sdk/client-s3";
import {
  documentAttachmentUploads,
  documentAttachments,
  projectEvents,
  users
} from "@orchestrat/db";
import { eq } from "drizzle-orm";
import { fixture } from "../test/fixture.js";
import type { AgentPrincipal } from "./agent-service.js";
import { ApiError } from "./api-error.js";
import { AttachmentService } from "./attachment-service.js";

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

  async send(command: Command) {
    const name = command.constructor.name;
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
    throw new Error(`Unsupported command: ${name}`);
  }
}

function storageClient(fake: FakeS3) {
  const client = new S3Client({
    forcePathStyle: true,
    region: config.region,
    endpoint: config.endpoint,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey
    }
  });
  client.send = ((command: Command) =>
    fake.send(command)) as typeof client.send;
  return client;
}

async function setup() {
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
  const service = new AttachmentService(db, {
    ...config,
    client: storageClient(fake)
  });
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

test("server selects direct at 100 MiB and multipart above it", async () => {
  const { document, service, userId } = await setup();
  const direct = await service.create(userId, document.id, input(DIRECT_SIZE));
  assert.equal(direct.upload.mode, "single");
  assert.ok((direct.upload as Record<string, unknown>).upload_url);
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
    [1],
    document.id
  );
  assert.equal(signed.parts.length, 1);
  assert.equal(signed.parts[0].part_number, 1);
  assert.match(signed.parts[0].upload_url, /^https:\/\//);
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
  assert.equal(expiredRow.status, "expired");
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
  await db.insert(documentAttachments).values({
    id: randomUUID(),
    projectId: project.id,
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
