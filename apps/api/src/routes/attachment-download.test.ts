import assert from "node:assert/strict";
import { Readable } from "node:stream";
import Fastify from "fastify";
import test from "node:test";
import type { AttachmentService } from "../services/attachment-service.js";
import { AttachmentService as RealAttachmentService } from "../services/attachment-service.js";
import { AttachmentDownloadTicketStore } from "../realtime/realtime.js";
import { attachmentDownloadRoutes } from "./attachment-download.js";

const ids = {
  attachmentId: "00000000-0000-4000-8000-000000000001",
  projectId: "00000000-0000-4000-8000-000000000002",
  documentId: "00000000-0000-4000-8000-000000000003"
};

test("attachment download tickets are high entropy, scoped, single-use, and expire", () => {
  let now = 1000;
  const store = new AttachmentDownloadTicketStore(
    () => now,
    () => Buffer.alloc(32, 7)
  );
  const issued = store.issue(
    ids.attachmentId,
    ids.projectId,
    ids.documentId,
    10
  );
  assert.match(issued.ticket, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(
    store.consume(issued.ticket, {
      projectId: "00000000-0000-4000-8000-000000000004"
    }),
    null
  );

  const second = store.issue(
    ids.attachmentId,
    ids.projectId,
    ids.documentId,
    10
  );
  now = 1010;
  assert.equal(store.consume(second.ticket), null);

  const third = store.issue(ids.attachmentId, ids.projectId, ids.documentId);
  assert.equal(store.consume(third.ticket)?.attachmentId, ids.attachmentId);
  assert.equal(store.consume(third.ticket), null);
});

test("public attachment download streams private content with safe headers", async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  app.setErrorHandler((error, _request, reply) =>
    reply
      .code(error instanceof Error && error.name === "ZodError" ? 400 : 500)
      .send()
  );
  await app.register(attachmentDownloadRoutes, {
    attachments: {
      async downloadByTicket(ticket: string) {
        assert.equal(ticket, "ticket");
        return {
          body: Readable.from(["secret"]),
          contentLength: 6,
          contentType: "application/octet-stream",
          contentDisposition: 'attachment; filename="private.bin"'
        };
      }
    } as unknown as AttachmentService
  });

  const response = await app.inject({
    method: "GET",
    url: "/attachments/download?ticket=ticket"
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body, "secret");
  assert.equal(response.headers["cache-control"], "private, no-store");
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.equal(response.headers["content-type"], "application/octet-stream");
  assert.equal(
    response.headers["content-disposition"],
    'attachment; filename="private.bin"'
  );
  assert.equal(response.headers["content-length"], "6");
  assert.equal(
    (await app.inject({ method: "GET", url: "/attachments/download" }))
      .statusCode,
    400
  );
});

test("ticket download rechecks the attachment row before fetching storage", async () => {
  const row = {
    id: ids.attachmentId,
    projectId: ids.projectId,
    documentId: ids.documentId,
    filename: "résumé.bin",
    mimeType: "application/octet-stream",
    sizeBytes: 6
  };
  let rows: (typeof row)[] = [row];
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => rows })
      })
    })
  };
  const store = new AttachmentDownloadTicketStore();
  const service = new RealAttachmentService(
    db as never,
    {
      bucket: "documents",
      endpoint: "https://storage.example.test",
      region: "us-east-1",
      accessKeyId: "access",
      secretAccessKey: "secret",
      client: {
        send: async () => ({
          Body: Readable.from(["secret"]),
          ContentLength: 6
        })
      } as never
    },
    store
  );
  const first = store.issue(ids.attachmentId, ids.projectId, ids.documentId);
  const downloaded = await service.downloadByTicket(first.ticket);
  assert.equal(downloaded.contentLength, 6);
  assert.equal(downloaded.contentType, "application/octet-stream");
  assert.equal(
    downloaded.contentDisposition,
    `attachment; filename="r_sum_.bin"; filename*=UTF-8''r%C3%A9sum%C3%A9.bin`
  );

  rows = [{ ...row, filename: "diagram.png", mimeType: "image/png" }];
  const imageTicket = store.issue(
    ids.attachmentId,
    ids.projectId,
    ids.documentId
  );
  const image = await service.downloadByTicket(imageTicket.ticket);
  assert.equal(image.contentType, "image/png");
  assert.equal(
    image.contentDisposition,
    `inline; filename="diagram.png"; filename*=UTF-8''diagram.png`
  );

  rows = [];
  const second = store.issue(ids.attachmentId, ids.projectId, ids.documentId);
  await assert.rejects(
    () => service.downloadByTicket(second.ticket),
    (error: unknown) =>
      error instanceof Error && error.message === "Attachment not found."
  );
});
