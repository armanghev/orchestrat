import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentApiClient } from "@orchestrat/sdk";
import { runDocumentCommand } from "./documents.js";

test("resumed multipart upload skips completed parts and uses four workers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orchestrat-cli-upload-"));
  const path = join(directory, "attachment.bin");
  await writeFile(path, "");
  await truncate(path, 5 * 16 * 1024 * 1024);
  let active = 0;
  let maxActive = 0;
  const uploaded: number[] = [];
  const client = {
    getDocumentAttachmentUpload: async () => ({
      id: "upload-id",
      mode: "multipart" as const,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      completed_parts: [{ part_number: 1, etag: '"etag-1"' }]
    }),
    refreshDocumentAttachmentParts: async (
      _documentId: string,
      _uploadId: string,
      partNumbers: number[]
    ) => ({
      parts: partNumbers.map((part_number) => ({
        part_number,
        upload_url: `https://storage.test/${part_number}`
      }))
    }),
    putPresignedObject: async (url: string, body: unknown) => {
      const part = Number(new URL(url).pathname.slice(1));
      uploaded.push(part);
      active += 1;
      maxActive = Math.max(maxActive, active);
      (body as { destroy?: () => void }).destroy?.();
      await new Promise<void>((resolve) => setImmediate(resolve));
      active -= 1;
      return `"etag-${part}"`;
    },
    completeDocumentAttachmentUpload: async (
      _documentId: string,
      _uploadId: string,
      parts: Array<{ part_number: number; etag: string }>
    ) => {
      assert.deepEqual(
        parts.map((part) => part.part_number),
        [1, 2, 3, 4, 5]
      );
      return { attachment: { id: "attachment-id" } };
    }
  };
  try {
    await runDocumentCommand({
      action: "upload",
      client: client as unknown as AgentApiClient,
      documentId: "document-id",
      path,
      resume: "upload-id"
    });
    assert.deepEqual(
      uploaded.sort((left, right) => left - right),
      [2, 3, 4, 5]
    );
    assert.equal(maxActive, 4);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("attachment download writes only to the explicit new path", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orchestrat-cli-download-"));
  const path = join(directory, "download.bin");
  const client = {
    downloadDocumentAttachment: async () => ({
      download_url: "data:application/octet-stream;base64,AAECAw=="
    })
  };
  try {
    const result = await runDocumentCommand({
      action: "download",
      client: client as unknown as AgentApiClient,
      documentId: "document-id",
      attachmentId: "attachment-id",
      path
    });
    assert.deepEqual(await readFile(path), Buffer.from([0, 1, 2, 3]));
    assert.deepEqual(result, {
      attachment_id: "attachment-id",
      path,
      size_bytes: 4
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
