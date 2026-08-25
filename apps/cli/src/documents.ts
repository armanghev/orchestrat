import { basename } from "node:path";
import { createReadStream } from "node:fs";
import { open, stat, unlink } from "node:fs/promises";
import {
  AgentApiClient,
  type AttachmentUpload,
  type EditDocumentRequest
} from "@orchestrat/sdk";
import { readBoundedStdin } from "./hooks.js";

const PART_SIZE = 16 * 1024 * 1024;
const MAX_PART_SIGN_BATCH = 100;
const MAX_UPLOAD_RETRIES = 3;
const progress = (message: string) =>
  process.stderr.write(`orchestrat: ${message}\n`);

export type DocumentCommandInput = {
  action:
    | "list"
    | "read"
    | "create"
    | "write"
    | "patch"
    | "history"
    | "upload"
    | "download";
  client: AgentApiClient;
  documentId?: string;
  path?: string;
  attachmentId?: string;
  limit?: number;
  cursor?: string;
  baseRevision?: number;
  resume?: string;
  includeArchived?: boolean;
};

export async function readJsonStdin() {
  return readBoundedStdin(
    process.stdin,
    8 * 1024 * 1024,
    "Document input exceeds 8 MiB"
  );
}

function contentInput(value: unknown) {
  if (typeof value === "string") return value;
  if (
    value &&
    typeof value === "object" &&
    typeof (value as { content?: unknown }).content === "string"
  )
    return (value as { content: string }).content;
  throw new Error('stdin must be a JSON string or {"content": string}');
}

async function putWithRetry(
  client: AgentApiClient,
  url: string,
  path: string,
  start: number,
  end: number,
  size: number,
  contentType?: string,
  refresh?: () => Promise<string>
) {
  let activeUrl = url;
  for (let attempt = 0; ; attempt++) {
    const stream =
      size === 0 ? undefined : createReadStream(path, { start, end });
    try {
      return await client.putPresignedObject(
        activeUrl,
        (stream ?? new Uint8Array(0)) as unknown as BodyInit,
        contentType,
        size
      );
    } catch (error) {
      stream?.destroy();
      if (attempt + 1 >= MAX_UPLOAD_RETRIES) throw error;
      if (refresh) activeUrl = await refresh();
    }
  }
}

function completedParts(session: AttachmentUpload) {
  return new Map(
    Array.isArray(session.completed_parts)
      ? session.completed_parts
          .filter(
            (part) =>
              Number.isInteger(part.part_number) &&
              typeof part.etag === "string"
          )
          .map((part) => [part.part_number, part.etag] as const)
      : []
  );
}

async function multipartUpload(
  client: AgentApiClient,
  session: AttachmentUpload,
  path: string,
  size: number,
  contentType: string | undefined,
  documentId: string
) {
  const totalParts = Math.ceil(size / PART_SIZE);
  const done = completedParts(session);
  const parts: Array<{ part_number: number; etag: string }> = [...done].map(
    ([part_number, etag]) => ({ part_number, etag })
  );
  for (let offset = 1; offset <= totalParts; offset += MAX_PART_SIGN_BATCH) {
    const numbers = Array.from(
      { length: Math.min(MAX_PART_SIGN_BATCH, totalParts - offset + 1) },
      (_, index) => offset + index
    ).filter((part) => !done.has(part));
    if (!numbers.length) continue;
    const signed = await client.refreshDocumentAttachmentParts(
      documentId,
      session.id,
      numbers
    );
    let cursor = 0;
    const worker = async () => {
      while (cursor < signed.parts.length) {
        const part = signed.parts[cursor++];
        const start = (part.part_number - 1) * PART_SIZE;
        const end = Math.min(size, start + PART_SIZE) - 1;
        const etag = await putWithRetry(
          client,
          part.upload_url,
          path,
          start,
          end,
          end - start + 1,
          contentType,
          () =>
            client
              .refreshDocumentAttachmentParts(documentId, session.id, [
                part.part_number
              ])
              .then((response) => {
                const refreshed = response.parts[0]?.upload_url;
                if (!refreshed)
                  throw new Error(
                    "Attachment part refresh returned no upload URL."
                  );
                return refreshed;
              })
        );
        if (!etag)
          throw new Error(
            `Missing ETag for attachment part ${part.part_number}`
          );
        parts.push({ part_number: part.part_number, etag });
        progress(`uploaded attachment part ${part.part_number}`);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(4, signed.parts.length) }, worker)
    );
  }
  return client.completeDocumentAttachmentUpload(
    documentId,
    session.id,
    parts.sort((a, b) => a.part_number - b.part_number)
  );
}

function safeUploadResult(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(safeUploadResult);
  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(
    value as Record<string, unknown>
  )) {
    if (["upload_url", "download_url", "url"].includes(key)) continue;
    result[key] = safeUploadResult(nested);
  }
  return result;
}

export async function runDocumentCommand(input: DocumentCommandInput) {
  const { action, client } = input;
  if (action === "list")
    return client.listDocuments({
      limit: input.limit,
      cursor: input.cursor,
      ...(input.includeArchived === undefined
        ? {}
        : { include_archived: input.includeArchived })
    });
  if (!input.documentId && action !== "create")
    throw new Error("document id is required");
  if (action === "read") return client.readDocument(input.documentId!);
  if (action === "history")
    return client.listDocumentRevisions(input.documentId!, {
      limit: input.limit,
      cursor: input.cursor
    });
  if (action === "create") {
    if (!input.path) throw new Error("document path is required");
    return client.createDocument({
      path: input.path,
      content: contentInput(await readJsonStdin())
    });
  }
  if (action === "write") {
    const content = contentInput(await readJsonStdin());
    if (!input.baseRevision) throw new Error("--base-revision is required");
    return client.updateDocument(input.documentId!, {
      content,
      base_revision: input.baseRevision
    });
  }
  if (action === "patch") {
    const patch = (await readJsonStdin()) as EditDocumentRequest;
    if (!input.baseRevision && !patch.base_revision)
      throw new Error("base_revision is required in stdin or --base-revision");
    return client.editDocument(input.documentId!, {
      ...patch,
      base_revision: input.baseRevision ?? patch.base_revision
    });
  }
  if (action === "upload") {
    if (!input.path) throw new Error("attachment path is required");
    const file = await stat(input.path);
    if (!file.isFile()) throw new Error("attachment path must be a file");
    let session = input.resume
      ? await client.getDocumentAttachmentUpload(
          input.documentId!,
          input.resume
        )
      : await client.startDocumentAttachmentUpload(input.documentId!, {
          filename: basename(input.path),
          size_bytes: file.size,
          content_type: "application/octet-stream"
        });
    if (session.mode === "single" && !session.upload_url)
      session = await client.refreshAttachmentUpload(
        input.documentId!,
        session.id
      );
    progress(`uploading ${basename(input.path)}`);
    const mode = session.mode;
    if (mode === "single") {
      if (!session.upload_url)
        throw new Error("upload session did not provide a direct URL");
      await putWithRetry(
        client,
        session.upload_url,
        input.path,
        0,
        file.size - 1,
        file.size,
        undefined,
        async () => {
          const refreshed = await client.refreshAttachmentUpload(
            input.documentId!,
            session.id
          );
          if (!refreshed.upload_url)
            throw new Error(
              "Attachment upload refresh returned no upload URL."
            );
          return refreshed.upload_url;
        }
      );
      const completed = await client.completeDocumentAttachmentUpload(
        input.documentId!,
        session.id
      );
      progress("attachment upload complete");
      return safeUploadResult(completed);
    }
    const completed = await multipartUpload(
      client,
      session,
      input.path,
      file.size,
      "application/octet-stream",
      input.documentId!
    );
    progress("attachment upload complete");
    return safeUploadResult(completed);
  }
  if (action === "download") {
    if (!input.documentId || !input.attachmentId || !input.path)
      throw new Error(
        "document id, attachment id, and output path are required"
      );
    const download = await client.downloadDocumentAttachment(
      input.documentId!,
      input.attachmentId
    );
    const response = await fetch(download.download_url);
    if (!response.ok || !response.body)
      throw new Error("Attachment download failed.");
    const handle = await open(input.path, "wx");
    let closed = false;
    let size = 0;
    const total = Number(response.headers.get("content-length")) || 0;
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        const buffer = Buffer.from(chunk);
        await handle.write(buffer);
        size += buffer.byteLength;
        if (total) progress(`downloaded ${size}/${total} bytes`);
      }
    } catch (error) {
      await handle.close();
      closed = true;
      await unlink(input.path).catch(() => undefined);
      throw error;
    } finally {
      if (!closed) await handle.close();
    }
    return {
      attachment_id: input.attachmentId,
      path: input.path,
      size_bytes: size
    };
  }
  throw new Error(`unsupported document action: ${action}`);
}
