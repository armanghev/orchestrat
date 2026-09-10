import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { Database } from "@orchestrat/db";
import {
  attachmentObjectKey,
  backfill,
  isMissingObject,
  isStaleOrphanMultipart,
  isStaleUnreferencedObject,
  parseOperatorArgs,
  readStorageConfig,
  revisionReferences,
  revisionObjectKey
} from "./storage-operations.js";
import { readDocumentStorageConfig } from "../document-storage-config.js";

test("backfill only treats provider not-found responses as missing", () => {
  assert.equal(isMissingObject({ name: "NotFound" }), true);
  assert.equal(isMissingObject({ name: "NoSuchKey" }), true);
  assert.equal(isMissingObject({ $metadata: { httpStatusCode: 404 } }), true);
  assert.equal(isMissingObject({ $metadata: { httpStatusCode: 503 } }), false);
});

test("backfill is restartable and never overwrites an existing revision object", async () => {
  const rows: Array<{
    id: string;
    projectId: string;
    documentId: string;
    contentMarkdown: string;
    contentSizeBytes: number | null;
    contentSha256: string | null;
  }> = [
    {
      id: "revision-new",
      projectId: "project",
      documentId: "document",
      contentMarkdown: "new revision ✓",
      contentSizeBytes: null,
      contentSha256: null
    },
    {
      id: "revision-existing",
      projectId: "project",
      documentId: "document",
      contentMarkdown: "existing revision",
      contentSizeBytes: null,
      contentSha256: null
    }
  ];
  const objects = new Map<
    string,
    { body: Buffer; metadata: { sha256: string } }
  >();
  const existingKey = revisionObjectKey(
    "project",
    "document",
    "revision-existing"
  );
  const existingBody = Buffer.from("existing revision", "utf8");
  objects.set(existingKey, {
    body: existingBody,
    metadata: {
      sha256: createHash("sha256").update(existingBody).digest("hex")
    }
  });
  let putCount = 0;
  const storage = {
    async send(command: { constructor: { name: string }; input: any }) {
      const key = command.input.Key as string;
      if (command.constructor.name === "HeadObjectCommand") {
        const object = objects.get(key);
        if (!object) throw { name: "NotFound" };
        return {
          ContentLength: object.body.byteLength,
          Metadata: object.metadata
        };
      }
      if (command.constructor.name === "PutObjectCommand") {
        putCount += 1;
        const body = Buffer.from(command.input.Body);
        objects.set(key, {
          body,
          metadata: command.input.Metadata
        });
        return {};
      }
      if (command.constructor.name === "GetObjectCommand") {
        const object = objects.get(key);
        if (!object) throw { name: "NotFound" };
        return {
          Body: {
            async transformToByteArray() {
              return object.body;
            }
          }
        };
      }
      throw new Error(`Unexpected command: ${command.constructor.name}`);
    }
  };
  let updateIndex = 0;
  const db = {
    select() {
      return {
        from() {
          return {
            where() {
              return Promise.resolve(
                rows.filter(
                  (row) =>
                    row.contentSizeBytes === null || row.contentSha256 === null
                )
              );
            }
          };
        }
      };
    },
    update() {
      return {
        set() {
          return {
            where() {
              const row = rows[updateIndex++];
              if (!row) return Promise.resolve({ rowCount: 0 });
              const body = Buffer.from(row.contentMarkdown, "utf8");
              row.contentSizeBytes = body.byteLength;
              row.contentSha256 = createHash("sha256")
                .update(body)
                .digest("hex");
              return Promise.resolve({ rowCount: 1 });
            }
          };
        }
      };
    }
  } as unknown as Database;
  const config = {
    bucket: "documents",
    endpoint: "https://storage.example",
    region: "region",
    accessKeyId: "key",
    secretAccessKey: "secret"
  };

  const first = await backfill(db, storage as never, config, true);
  assert.deepEqual(
    {
      planned: first.planned,
      uploaded: first.uploaded,
      updated: first.updated
    },
    { planned: 2, uploaded: 1, updated: 2 }
  );
  assert.equal(putCount, 1);
  const second = await backfill(db, storage as never, config, true);
  assert.deepEqual(
    {
      planned: second.planned,
      uploaded: second.uploaded,
      updated: second.updated
    },
    { planned: 0, uploaded: 0, updated: 0 }
  );
  assert.equal(putCount, 1);
});

test("operator commands default to dry-run and accept only --apply", () => {
  assert.deepEqual(parseOperatorArgs([]), { apply: false });
  assert.deepEqual(parseOperatorArgs(["--apply"]), { apply: true });
  assert.deepEqual(parseOperatorArgs(["--dry-run"]), { apply: false });
  assert.throws(() => parseOperatorArgs(["--yes"]));
  assert.throws(() => parseOperatorArgs(["--dry-run", "--apply"]));
});

test("storage keys are deterministic and reference-aware", () => {
  const revision = revisionObjectKey("project", "document", "revision");
  const attachment = attachmentObjectKey("project", "document", "attachment");
  assert.equal(revision, "document-revisions/v1/project/document/revision.md");
  assert.equal(
    attachment,
    "document-attachments/v1/project/document/attachment"
  );
  const cutoff = new Date("2026-01-02T00:00:00Z");
  assert.equal(
    isStaleUnreferencedObject(
      revision,
      new Date("2026-01-01T00:00:00Z"),
      cutoff,
      new Set(),
      new Set()
    ),
    true
  );
  assert.equal(
    isStaleUnreferencedObject(
      revision,
      new Date("2026-01-01T00:00:00Z"),
      cutoff,
      new Set([revision]),
      new Set()
    ),
    false
  );
  const legacyRevision = revisionObjectKey("project", "document", "legacy");
  assert.equal(
    isStaleUnreferencedObject(
      legacyRevision,
      new Date("2026-01-01T00:00:00Z"),
      cutoff,
      revisionReferences([
        { projectId: "project", documentId: "document", id: "legacy" }
      ]),
      new Set()
    ),
    false
  );
  assert.equal(
    isStaleUnreferencedObject(
      attachment,
      new Date("2026-01-02T00:00:00Z"),
      cutoff,
      new Set(),
      new Set([attachment])
    ),
    false
  );
});

test("multipart GC only selects old attachment uploads without DB sessions", () => {
  const key = attachmentObjectKey("project", "document", "upload");
  const cutoff = new Date("2026-01-02T00:00:00Z");
  const old = new Date("2026-01-01T00:00:00Z");
  assert.equal(isStaleOrphanMultipart(key, old, cutoff, new Set()), true);
  assert.equal(isStaleOrphanMultipart(key, old, cutoff, new Set([key])), false);
  assert.equal(isStaleOrphanMultipart(key, cutoff, cutoff, new Set()), false);
  assert.equal(
    isStaleOrphanMultipart("other/" + key, old, cutoff, new Set()),
    false
  );
});

test("storage configuration supports a dedicated provider and rejects unsafe config", () => {
  assert.throws(
    () =>
      readDocumentStorageConfig({
        DOCUMENT_STORAGE_BUCKET: "documents",
        DOCUMENT_STORAGE_S3_ENDPOINT:
          "https://account.r2.cloudflarestorage.com/documents",
        DOCUMENT_STORAGE_S3_REGION: "auto",
        DOCUMENT_STORAGE_S3_ACCESS_KEY_ID: "key",
        DOCUMENT_STORAGE_S3_SECRET_ACCESS_KEY: "secret"
      }),
    /without a bucket path/
  );
  assert.equal(
    readDocumentStorageConfig({
      SUPABASE_AVATAR_BUCKET: "avatars",
      SUPABASE_S3_ENDPOINT: "https://supabase.example"
    }),
    undefined
  );
  assert.throws(() => readStorageConfig({}));
  assert.deepEqual(
    readStorageConfig({
      DOCUMENT_STORAGE_BUCKET: "r2-documents",
      DOCUMENT_STORAGE_S3_ENDPOINT: "https://account.r2.cloudflarestorage.com",
      DOCUMENT_STORAGE_S3_REGION: "auto",
      DOCUMENT_STORAGE_S3_ACCESS_KEY_ID: "key",
      DOCUMENT_STORAGE_S3_SECRET_ACCESS_KEY: "secret",
      SUPABASE_AVATAR_BUCKET: "avatars",
      SUPABASE_S3_ENDPOINT: "https://supabase.example",
      SUPABASE_S3_REGION: "us-east-1",
      SUPABASE_S3_ACCESS_KEY_ID: "supabase-key",
      SUPABASE_S3_SECRET_ACCESS_KEY: "supabase-secret"
    }),
    {
      bucket: "r2-documents",
      endpoint: "https://account.r2.cloudflarestorage.com",
      region: "auto",
      accessKeyId: "key",
      secretAccessKey: "secret"
    }
  );
  assert.throws(() =>
    readStorageConfig({
      DOCUMENT_STORAGE_BUCKET: "r2-documents",
      SUPABASE_S3_ENDPOINT: "https://supabase.example",
      SUPABASE_S3_REGION: "us-east-1",
      SUPABASE_S3_ACCESS_KEY_ID: "supabase-key",
      SUPABASE_S3_SECRET_ACCESS_KEY: "supabase-secret"
    })
  );
  assert.throws(() =>
    readStorageConfig({
      SUPABASE_DOCUMENT_BUCKET: "legacy-documents",
      SUPABASE_S3_ENDPOINT: "https://supabase.example",
      SUPABASE_S3_REGION: "us-east-1",
      SUPABASE_S3_ACCESS_KEY_ID: "supabase-key",
      SUPABASE_S3_SECRET_ACCESS_KEY: "supabase-secret"
    })
  );
  assert.throws(() =>
    readStorageConfig({
      DOCUMENT_STORAGE_BUCKET: "avatars",
      DOCUMENT_STORAGE_S3_ENDPOINT: "https://example.test/",
      DOCUMENT_STORAGE_S3_REGION: "region",
      DOCUMENT_STORAGE_S3_ACCESS_KEY_ID: "key",
      DOCUMENT_STORAGE_S3_SECRET_ACCESS_KEY: "secret",
      SUPABASE_AVATAR_BUCKET: "avatars",
      SUPABASE_S3_ENDPOINT: "https://example.test",
      SUPABASE_S3_REGION: "region",
      SUPABASE_S3_ACCESS_KEY_ID: "key",
      SUPABASE_S3_SECRET_ACCESS_KEY: "secret"
    })
  );
  assert.equal(
    readStorageConfig({
      DOCUMENT_STORAGE_BUCKET: "avatars",
      DOCUMENT_STORAGE_S3_ENDPOINT: "https://account.r2.cloudflarestorage.com",
      DOCUMENT_STORAGE_S3_REGION: "auto",
      DOCUMENT_STORAGE_S3_ACCESS_KEY_ID: "key",
      DOCUMENT_STORAGE_S3_SECRET_ACCESS_KEY: "secret",
      SUPABASE_AVATAR_BUCKET: "avatars",
      SUPABASE_S3_ENDPOINT: "https://supabase.example"
    })?.bucket,
    "avatars"
  );
});
