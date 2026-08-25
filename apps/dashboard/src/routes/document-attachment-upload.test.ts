import { describe, expect, it, vi } from "vitest";
import type { DocumentAttachmentUpload } from "@/lib/api/client";
import {
  attachmentProgress,
  uploadMultipart
} from "@/routes/_authenticated.projects.$projectId.documents";

const partSize = 16 * 1024 * 1024;
const documentId = "00000000-0000-4000-8000-000000000005";
const uploadId = "00000000-0000-4000-8000-000000000006";
const expiresAt = "2026-08-25T00:00:00.000Z";

describe("document attachment uploads", () => {
  it("keeps zero-byte upload progress finite", () => {
    expect(attachmentProgress(0, 0)).toBe(0);
    expect(Number.isFinite(attachmentProgress(0, 0))).toBe(true);
  });

  it("resumes only missing multipart parts in bounded signing batches", async () => {
    const refreshParts = vi.fn(
      async (
        _documentId: string,
        _uploadId: string,
        partNumbers: number[]
      ) => ({
        parts: partNumbers.map((part_number) => ({
          part_number,
          upload_url: `https://storage.example.test/${part_number}`
        }))
      })
    );
    const putObject = vi.fn(
      async (
        _url: string,
        _body: Blob,
        onProgress?: (loaded: number) => void
      ) => onProgress?.(1)
    );
    const complete = vi.fn(async () => ({ attachment: {} }));
    const api = {
      refreshDocumentAttachmentParts: refreshParts,
      putPresignedObject: putObject,
      completeDocumentAttachmentUpload: complete
    } as unknown as Parameters<typeof uploadMultipart>[0];
    const file = {
      size: partSize * 102,
      slice: vi.fn(() => new Blob(["part"]))
    } as unknown as File;
    const session = {
      id: uploadId,
      mode: "multipart",
      expires_at: expiresAt,
      part_size_bytes: partSize,
      completed_parts: [{ part_number: 1, etag: "server-listed-etag" }]
    } satisfies DocumentAttachmentUpload;

    await uploadMultipart(
      api,
      documentId,
      session,
      file,
      () => undefined,
      new AbortController().signal,
      async () => undefined
    );

    expect(refreshParts.mock.calls.map(([, , parts]) => parts.length)).toEqual([
      100, 1
    ]);
    expect(
      refreshParts.mock.calls.flatMap(([, , parts]) => parts)
    ).not.toContain(1);
    expect(putObject).toHaveBeenCalledTimes(101);
    expect(complete).toHaveBeenCalledWith(documentId, uploadId);
  });

  it("does not sign or complete an aborted multipart upload", async () => {
    const refreshParts = vi.fn();
    const complete = vi.fn();
    const controller = new AbortController();
    controller.abort();
    const api = {
      refreshDocumentAttachmentParts: refreshParts,
      putPresignedObject: vi.fn(),
      completeDocumentAttachmentUpload: complete
    } as unknown as Parameters<typeof uploadMultipart>[0];
    const session = {
      id: uploadId,
      mode: "multipart",
      expires_at: expiresAt,
      part_size_bytes: partSize
    } satisfies DocumentAttachmentUpload;

    await expect(
      uploadMultipart(
        api,
        documentId,
        session,
        { size: partSize, slice: () => new Blob() } as unknown as File,
        () => undefined,
        controller.signal,
        async () => undefined
      )
    ).rejects.toThrow("Attachment upload aborted.");
    expect(refreshParts).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it("aborts sibling part uploads before returning a retryable failure", async () => {
    const signals: AbortSignal[] = [];
    const putObject = vi.fn(
      (
        _url: string,
        _body: Blob,
        _onProgress?: (loaded: number) => void,
        signal?: AbortSignal
      ) => {
        if (signal) signals.push(signal);
        if (signals.length === 1)
          return Promise.reject(new Error("first part failed"));
        return new Promise<void>((_resolve, reject) =>
          signal?.addEventListener(
            "abort",
            () => reject(new Error("sibling upload aborted")),
            { once: true }
          )
        );
      }
    );
    const api = {
      refreshDocumentAttachmentParts: vi.fn(
        async (
          _documentId: string,
          _uploadId: string,
          partNumbers: number[]
        ) => ({
          parts: partNumbers.map((part_number) => ({
            part_number,
            upload_url: `https://storage.example.test/${part_number}`
          }))
        })
      ),
      putPresignedObject: putObject,
      completeDocumentAttachmentUpload: vi.fn()
    } as unknown as Parameters<typeof uploadMultipart>[0];
    const session = {
      id: uploadId,
      mode: "multipart",
      expires_at: expiresAt,
      part_size_bytes: partSize
    } satisfies DocumentAttachmentUpload;

    await expect(
      uploadMultipart(
        api,
        documentId,
        session,
        { size: partSize * 4, slice: () => new Blob() } as unknown as File,
        () => undefined,
        new AbortController().signal,
        async () => undefined
      )
    ).rejects.toThrow("first part failed");
    expect(signals).toHaveLength(4);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });
});
