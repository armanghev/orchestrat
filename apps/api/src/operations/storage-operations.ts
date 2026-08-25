import { createHash } from "node:crypto";
import { config as loadEnv } from "dotenv";
import {
  AbortMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import {
  createDatabase,
  documentAttachmentUploads,
  documentAttachments,
  documentRevisions,
  type Database
} from "@orchestrat/db";

export const STORAGE_GRACE_MS = 24 * 60 * 60 * 1000;

export type OperatorArgs = { apply: boolean };

export type StorageConfig = {
  bucket: string;
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
};

export function parseOperatorArgs(argv: readonly string[]): OperatorArgs {
  const unknown = argv.filter(
    (argument) => argument !== "--apply" && argument !== "--dry-run"
  );
  if (unknown.length > 0) throw new Error("Unknown operator argument.");
  if (argv.includes("--apply") && argv.includes("--dry-run"))
    throw new Error("Choose either --apply or --dry-run.");
  return { apply: argv.includes("--apply") };
}

export function revisionObjectKey(
  projectId: string,
  documentId: string,
  revisionId: string
) {
  return `document-revisions/v1/${projectId}/${documentId}/${revisionId}.md`;
}

export function attachmentObjectKey(
  projectId: string,
  documentId: string,
  attachmentId: string
) {
  return `document-attachments/v1/${projectId}/${documentId}/${attachmentId}`;
}

export function revisionReferences(
  rows: ReadonlyArray<{
    projectId: string;
    documentId: string;
    id: string;
  }>
) {
  return new Set(
    rows.map((row) => revisionObjectKey(row.projectId, row.documentId, row.id))
  );
}

export function isStaleUnreferencedObject(
  key: string,
  lastModified: Date | undefined,
  cutoff: Date,
  references: ReadonlySet<string>,
  pendingUploads: ReadonlySet<string>
) {
  return Boolean(
    lastModified &&
    lastModified <= cutoff &&
    !references.has(key) &&
    !pendingUploads.has(key) &&
    (key.startsWith("document-revisions/v1/") ||
      key.startsWith("document-attachments/v1/"))
  );
}

export function isStaleOrphanMultipart(
  key: string | undefined,
  initiated: Date | undefined,
  cutoff: Date,
  pendingUploads: ReadonlySet<string>
) {
  return Boolean(
    key &&
    initiated &&
    initiated < cutoff &&
    !pendingUploads.has(key) &&
    key.startsWith("document-attachments/v1/")
  );
}

export function readStorageConfig(env: NodeJS.ProcessEnv = process.env) {
  const values = {
    bucket: env.SUPABASE_DOCUMENT_BUCKET,
    endpoint: env.SUPABASE_S3_ENDPOINT,
    region: env.SUPABASE_S3_REGION,
    accessKeyId: env.SUPABASE_S3_ACCESS_KEY_ID,
    secretAccessKey: env.SUPABASE_S3_SECRET_ACCESS_KEY
  };
  if (Object.values(values).some((value) => !value))
    throw new Error(
      "Document storage operations require a complete Supabase S3 configuration."
    );
  if (
    values.bucket === env.SUPABASE_AVATAR_BUCKET &&
    values.bucket !== undefined
  )
    throw new Error("Document storage must not use the avatar bucket.");
  return values as StorageConfig;
}

export function createStorageClient(config: StorageConfig) {
  return new S3Client({
    forcePathStyle: true,
    region: config.region,
    endpoint: config.endpoint,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey
    }
  });
}

export function createOperatorContext(): {
  config: StorageConfig;
  db: Database;
  pool: { end(): Promise<void> };
  storage: S3Client;
} {
  loadEnv({ path: "../../.env", quiet: true });
  const databaseUrl = process.env.ORCHESTRAT_DATABASE_URL;
  if (!databaseUrl)
    throw new Error(
      "ORCHESTRAT_DATABASE_URL is required for storage operations."
    );
  const config = readStorageConfig();
  const { db, pool } = createDatabase({ connectionString: databaseUrl });
  return { config, db, pool, storage: createStorageClient(config) };
}

export function sha256(content: Buffer) {
  return createHash("sha256").update(content).digest("hex");
}

export function isMissingObject(error: unknown) {
  const value = error as {
    name?: string;
    $metadata?: { httpStatusCode?: number };
  };
  return (
    value?.name === "NotFound" ||
    value?.name === "NoSuchKey" ||
    value?.$metadata?.httpStatusCode === 404
  );
}

async function readBody(body: unknown): Promise<Buffer> {
  if (
    body &&
    typeof (body as { transformToByteArray?: unknown }).transformToByteArray ===
      "function"
  )
    return Buffer.from(
      await (
        body as { transformToByteArray: () => Promise<Uint8Array> }
      ).transformToByteArray()
    );
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array | string>)
    chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

export async function backfill(
  db: Database,
  storage: S3Client,
  config: StorageConfig,
  apply: boolean
) {
  const rows = await db
    .select({
      id: documentRevisions.id,
      projectId: documentRevisions.projectId,
      documentId: documentRevisions.documentId,
      contentMarkdown: documentRevisions.contentMarkdown,
      contentSizeBytes: documentRevisions.contentSizeBytes,
      contentSha256: documentRevisions.contentSha256
    })
    .from(documentRevisions)
    .where(
      or(
        isNull(documentRevisions.contentSizeBytes),
        isNull(documentRevisions.contentSha256)
      )
    );
  let planned = 0;
  let uploaded = 0;
  let updated = 0;
  let skipped = 0;
  for (const row of rows) {
    if (row.contentMarkdown === null) {
      skipped += 1;
      continue;
    }
    planned += 1;
    const body = Buffer.from(row.contentMarkdown, "utf8");
    const size = body.byteLength;
    const hash = sha256(body);
    if (!apply) continue;
    const key = revisionObjectKey(row.projectId, row.documentId, row.id);
    let head;
    try {
      head = await storage.send(
        new HeadObjectCommand({ Bucket: config.bucket, Key: key })
      );
    } catch (error) {
      if (!isMissingObject(error)) throw error;
    }
    if (!head) {
      await storage.send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: key,
          Body: body,
          ContentLength: size,
          ContentType: "text/markdown; charset=utf-8",
          Metadata: { sha256: hash }
        })
      );
      uploaded += 1;
      head = await storage.send(
        new HeadObjectCommand({ Bucket: config.bucket, Key: key })
      );
    }
    if (
      Number(head.ContentLength ?? -1) !== size ||
      head.Metadata?.sha256 !== hash
    )
      throw new Error(
        "Storage object metadata did not match revision content."
      );
    const object = await storage.send(
      new GetObjectCommand({ Bucket: config.bucket, Key: key })
    );
    const downloaded = await readBody(object.Body);
    if (downloaded.byteLength !== size || sha256(downloaded) !== hash)
      throw new Error("Storage object content did not match revision content.");
    const result = await db
      .update(documentRevisions)
      .set({
        contentSizeBytes: sql`coalesce(${documentRevisions.contentSizeBytes}, ${size})`,
        contentSha256: sql`coalesce(${documentRevisions.contentSha256}, ${hash})`
      })
      .where(
        and(
          eq(documentRevisions.id, row.id),
          or(
            isNull(documentRevisions.contentSizeBytes),
            isNull(documentRevisions.contentSha256)
          )
        )
      );
    if (result.rowCount === 0) skipped += 1;
    else updated += 1;
  }
  return { apply, scanned: rows.length, planned, uploaded, updated, skipped };
}

async function expireUploads(
  db: Database,
  storage: S3Client,
  config: StorageConfig,
  now: Date,
  apply: boolean
) {
  const rows = await db
    .select()
    .from(documentAttachmentUploads)
    .where(
      and(
        eq(documentAttachmentUploads.status, "pending"),
        lte(documentAttachmentUploads.expiresAt, now)
      )
    );
  if (!apply) return { scanned: rows.length, expired: 0 };
  let expired = 0;
  for (const row of rows) {
    const key = attachmentObjectKey(row.projectId, row.documentId, row.id);
    if (row.providerUploadId)
      await storage
        .send(
          new AbortMultipartUploadCommand({
            Bucket: config.bucket,
            Key: key,
            UploadId: row.providerUploadId
          })
        )
        .catch(() => undefined);
    else
      await storage
        .send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }))
        .catch(() => undefined);
    const result = await db
      .update(documentAttachmentUploads)
      .set({ status: "expired" })
      .where(
        and(
          eq(documentAttachmentUploads.id, row.id),
          eq(documentAttachmentUploads.status, "pending"),
          lte(documentAttachmentUploads.expiresAt, now)
        )
      );
    expired += result.rowCount ?? 0;
  }
  return { scanned: rows.length, expired };
}

async function referenceSets(db: Database) {
  const [revisions, attachments, pending] = await Promise.all([
    db
      .select({
        projectId: documentRevisions.projectId,
        documentId: documentRevisions.documentId,
        id: documentRevisions.id
      })
      .from(documentRevisions),
    db
      .select({
        projectId: documentAttachments.projectId,
        documentId: documentAttachments.documentId,
        id: documentAttachments.id
      })
      .from(documentAttachments),
    db
      .select({
        projectId: documentAttachmentUploads.projectId,
        documentId: documentAttachmentUploads.documentId,
        id: documentAttachmentUploads.id
      })
      .from(documentAttachmentUploads)
      .where(eq(documentAttachmentUploads.status, "pending"))
  ]);
  return {
    references: new Set([
      ...revisionReferences(revisions),
      ...attachments.map((row) =>
        attachmentObjectKey(row.projectId, row.documentId, row.id)
      )
    ]),
    pendingUploads: new Set(
      pending.map((row) =>
        attachmentObjectKey(row.projectId, row.documentId, row.id)
      )
    )
  };
}

async function gcMultipartUploads(
  storage: S3Client,
  config: StorageConfig,
  cutoff: Date,
  pendingUploads: ReadonlySet<string>,
  apply: boolean
) {
  let continuationKeyMarker: string | undefined;
  let continuationUploadIdMarker: string | undefined;
  let listed = 0;
  let candidates = 0;
  let aborted = 0;
  do {
    const page = await storage.send(
      new ListMultipartUploadsCommand({
        Bucket: config.bucket,
        Prefix: "document-attachments/v1/",
        KeyMarker: continuationKeyMarker,
        UploadIdMarker: continuationUploadIdMarker
      })
    );
    for (const upload of page.Uploads ?? []) {
      listed += 1;
      if (
        !isStaleOrphanMultipart(
          upload.Key,
          upload.Initiated,
          cutoff,
          pendingUploads
        )
      )
        continue;
      candidates += 1;
      if (apply) {
        if (!upload.Key || !upload.UploadId) continue;
        await storage.send(
          new AbortMultipartUploadCommand({
            Bucket: config.bucket,
            Key: upload.Key,
            UploadId: upload.UploadId
          })
        );
        aborted += 1;
      }
    }
    continuationKeyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
    continuationUploadIdMarker = page.IsTruncated
      ? page.NextUploadIdMarker
      : undefined;
  } while (continuationKeyMarker || continuationUploadIdMarker);
  return { listed, candidates, aborted };
}

async function gc(
  db: Database,
  storage: S3Client,
  config: StorageConfig,
  now: Date,
  apply: boolean
) {
  const expired = await expireUploads(db, storage, config, now, apply);
  const { references, pendingUploads } = await referenceSets(db);
  const cutoff = new Date(now.getTime() - STORAGE_GRACE_MS);
  const multipart = await gcMultipartUploads(
    storage,
    config,
    cutoff,
    pendingUploads,
    apply
  );
  let listed = 0;
  let candidates = 0;
  let deleted = 0;
  for (const prefix of ["document-revisions/v1/", "document-attachments/v1/"]) {
    let continuationToken: string | undefined;
    do {
      const page = await storage.send(
        new ListObjectsV2Command({
          Bucket: config.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken
        })
      );
      for (const object of page.Contents ?? []) {
        listed += 1;
        if (
          object.Key &&
          isStaleUnreferencedObject(
            object.Key,
            object.LastModified,
            cutoff,
            references,
            pendingUploads
          )
        ) {
          candidates += 1;
          if (apply) {
            await storage.send(
              new DeleteObjectCommand({
                Bucket: config.bucket,
                Key: object.Key
              })
            );
            deleted += 1;
          }
        }
      }
      continuationToken = page.IsTruncated
        ? page.NextContinuationToken
        : undefined;
    } while (continuationToken);
  }
  return {
    apply,
    expiredUploads: expired.expired,
    expiredUploadCandidates: expired.scanned,
    listed,
    candidates,
    deleted,
    multipartUploadsListed: multipart.listed,
    multipartUploadCandidates: multipart.candidates,
    multipartUploadsAborted: multipart.aborted,
    gracePeriodHours: STORAGE_GRACE_MS / (60 * 60 * 1000)
  };
}

export async function runBackfill(args: OperatorArgs) {
  const context = createOperatorContext();
  try {
    return await backfill(
      context.db,
      context.storage,
      context.config,
      args.apply
    );
  } finally {
    await context.pool.end();
  }
}

export async function runGc(args: OperatorArgs) {
  const context = createOperatorContext();
  try {
    return await gc(
      context.db,
      context.storage,
      context.config,
      new Date(),
      args.apply
    );
  } finally {
    await context.pool.end();
  }
}
