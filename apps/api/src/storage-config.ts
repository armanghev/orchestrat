import { CreateBucketCommand, HeadBucketCommand } from "@aws-sdk/client-s3";
import {
  documentAttachments,
  documentRevisions,
  type Database
} from "@orchestrat/db";
import { logger, type Logger } from "@orchestrat/logger";
import { count, isNotNull, or } from "drizzle-orm";
import type { DocumentStorageConfig } from "./services/document-service.js";
import type { AvatarStorageConfig } from "./services/profile-service.js";
import {
  createS3Client,
  type S3ConnectionConfig
} from "./services/s3-client.js";

/** Per-project attachment quota when ORCHESTRAT_ATTACHMENT_QUOTA_BYTES is unset. */
export const DEFAULT_ATTACHMENT_QUOTA_BYTES = 10 * 1024 * 1024 * 1024;

export type StorageSettings = {
  /** Document revisions and attachments; absent means storage is off. */
  documentStorage?: DocumentStorageConfig;
  /** Avatars, in the same bucket under `avatars/`. */
  avatarStorage?: AvatarStorageConfig;
  attachmentQuotaBytes: number;
  /** Create the bucket at startup when it is missing (`ensureBucket`). */
  createBucket: boolean;
};

// The first name wins; DOCUMENT_STORAGE_* are the deprecated R2-era names.
const variables = {
  endpoint: ["ORCHESTRAT_S3_ENDPOINT", "DOCUMENT_STORAGE_S3_ENDPOINT"],
  publicEndpoint: ["ORCHESTRAT_S3_PUBLIC_ENDPOINT"],
  region: ["ORCHESTRAT_S3_REGION", "DOCUMENT_STORAGE_S3_REGION"],
  bucket: ["ORCHESTRAT_S3_BUCKET", "DOCUMENT_STORAGE_BUCKET"],
  accessKeyId: [
    "ORCHESTRAT_S3_ACCESS_KEY_ID",
    "DOCUMENT_STORAGE_S3_ACCESS_KEY_ID"
  ],
  secretAccessKey: [
    "ORCHESTRAT_S3_SECRET_ACCESS_KEY",
    "DOCUMENT_STORAGE_S3_SECRET_ACCESS_KEY"
  ],
  forcePathStyle: ["ORCHESTRAT_S3_FORCE_PATH_STYLE"],
  createBucket: ["ORCHESTRAT_S3_CREATE_BUCKET"]
} as const;
type Field = keyof typeof variables;
// The rest have defaults, so they alone don't turn storage on.
const enabling: Field[] = [
  "endpoint",
  "publicEndpoint",
  "bucket",
  "accessKeyId",
  "secretAccessKey"
];
const required: Field[] = [
  "endpoint",
  "bucket",
  "accessKeyId",
  "secretAccessKey"
];
const STORAGE_HINT =
  "ORCHESTRAT_S3_ENDPOINT, ORCHESTRAT_S3_BUCKET, ORCHESTRAT_S3_ACCESS_KEY_ID and ORCHESTRAT_S3_SECRET_ACCESS_KEY";

function endpointUrl(name: string, value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an http(s) URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error(`${name} must be an http(s) URL.`);
  if (url.username || url.password)
    throw new Error(
      `${name} must not contain credentials; set ORCHESTRAT_S3_ACCESS_KEY_ID and ORCHESTRAT_S3_SECRET_ACCESS_KEY instead.`
    );
  if (url.search || url.hash)
    throw new Error(`${name} must not have a query string or fragment.`);
  if (
    url.hostname.endsWith(".r2.cloudflarestorage.com") &&
    url.pathname !== "/"
  )
    throw new Error(
      `The R2 endpoint in ${name} must be the account origin without a bucket path; set ORCHESTRAT_S3_BUCKET separately.`
    );
  return url.href.replace(/\/+$/, "");
}

function booleanValue(
  name: string,
  value: string | undefined,
  fallback: boolean
) {
  if (value === undefined) return fallback;
  const normalized = value.toLowerCase();
  if (["true", "1", "yes"].includes(normalized)) return true;
  if (["false", "0", "no"].includes(normalized)) return false;
  throw new Error(`${name} must be true or false.`);
}

function quotaBytes(value: string | undefined) {
  const raw = value?.trim();
  if (!raw) return DEFAULT_ATTACHMENT_QUOTA_BYTES;
  const parsed = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(parsed) || parsed <= 0)
    throw new Error(
      "ORCHESTRAT_ATTACHMENT_QUOTA_BYTES must be a positive whole number of bytes."
    );
  return parsed;
}

/**
 * Object storage settings from the environment. Storage is optional: without
 * it, document revisions stay in Postgres and attachments return 503. Throws
 * on a partial or invalid configuration; never logs values.
 */
export function readStorageConfig(
  env: NodeJS.ProcessEnv = process.env,
  log: Pick<Logger, "warn"> = logger
): StorageSettings {
  const attachmentQuotaBytes = quotaBytes(
    env.ORCHESTRAT_ATTACHMENT_QUOTA_BYTES
  );
  const read = (field: Field) => {
    for (const name of variables[field]) {
      const value = env[name]?.trim();
      if (value) return { name, value };
    }
    return undefined;
  };
  if (enabling.every((field) => !read(field)))
    return { attachmentQuotaBytes, createBucket: false };

  const missing = required
    .filter((field) => !read(field))
    .map((field) => variables[field][0]);
  if (missing.length)
    throw new Error(
      `Object storage is partly configured; set ${missing.join(", ")}, or unset the other ORCHESTRAT_S3_* variables to turn storage off.`
    );
  const legacy = Object.keys(variables)
    .map((field) => read(field as Field)?.name)
    .filter((name) => name?.startsWith("DOCUMENT_STORAGE_"));
  if (legacy.length)
    log.warn(
      { variables: legacy.join(",") },
      "DOCUMENT_STORAGE_* variables are deprecated; rename them to ORCHESTRAT_S3_*."
    );

  const endpointValue = read("endpoint")!;
  const endpoint = endpointUrl(endpointValue.name, endpointValue.value);
  const publicValue = read("publicEndpoint");
  const connection = {
    endpoint,
    region: read("region")?.value ?? "us-east-1",
    bucket: read("bucket")!.value,
    accessKeyId: read("accessKeyId")!.value,
    secretAccessKey: read("secretAccessKey")!.value,
    forcePathStyle: booleanValue(
      "ORCHESTRAT_S3_FORCE_PATH_STYLE",
      read("forcePathStyle")?.value,
      true
    )
  };
  return {
    documentStorage: {
      ...connection,
      publicEndpoint: publicValue
        ? endpointUrl(publicValue.name, publicValue.value)
        : endpoint
    },
    avatarStorage: connection,
    attachmentQuotaBytes,
    createBucket: booleanValue(
      "ORCHESTRAT_S3_CREATE_BUCKET",
      read("createBucket")?.value,
      false
    )
  };
}

const statusOf = (error: unknown) =>
  (error as { $metadata?: { httpStatusCode?: number } }).$metadata
    ?.httpStatusCode;
const nameOf = (error: unknown) => (error as { name?: string }).name;

/**
 * Creates the bucket when it is missing (ORCHESTRAT_S3_CREATE_BUCKET), for
 * fresh SeaweedFS or MinIO volumes. Call at startup, before serving.
 */
export async function ensureBucket(
  config: S3ConnectionConfig,
  client = createS3Client(config)
): Promise<"exists" | "created"> {
  try {
    await client.send(new HeadBucketCommand({ Bucket: config.bucket }));
    return "exists";
  } catch (error) {
    if (statusOf(error) !== 404 && nameOf(error) !== "NotFound")
      throw new Error(
        `Could not check bucket "${config.bucket}" (${nameOf(error) ?? "error"}); check ORCHESTRAT_S3_ENDPOINT and the access key.`
      );
  }
  try {
    await client.send(
      new CreateBucketCommand({
        Bucket: config.bucket,
        // us-east-1 takes no constraint; R2 uses "auto".
        ...(config.region !== "us-east-1" && config.region !== "auto"
          ? {
              CreateBucketConfiguration: {
                LocationConstraint: config.region as never
              }
            }
          : {})
      })
    );
  } catch (error) {
    if (nameOf(error) === "BucketAlreadyOwnedByYou") return "exists";
    throw new Error(
      `Could not create bucket "${config.bucket}" (${nameOf(error) ?? "error"}).`
    );
  }
  return "created";
}

/**
 * Bucket-backed revisions and attachments return 503 while storage is off.
 * Call at startup; logs how many are affected and what to set.
 */
export async function warnIfStorageMissing(
  db: Database,
  documentStorage: DocumentStorageConfig | undefined,
  log: Pick<Logger, "warn"> = logger
) {
  if (documentStorage) return { revisions: 0, attachments: 0 };
  const [revisions] = await db
    .select({ value: count() })
    .from(documentRevisions)
    .where(
      // Metadata marks a revision whose authoritative copy is in the bucket.
      or(
        isNotNull(documentRevisions.contentSha256),
        isNotNull(documentRevisions.contentSizeBytes)
      )
    );
  const [attachments] = await db
    .select({ value: count() })
    .from(documentAttachments);
  const affected = {
    revisions: Number(revisions?.value ?? 0),
    attachments: Number(attachments?.value ?? 0)
  };
  if (affected.revisions || affected.attachments)
    log.warn(
      {
        bucket_revisions: affected.revisions,
        attachments: affected.attachments
      },
      `Object storage is off, but ${affected.revisions} document revisions and ${affected.attachments} attachments are stored in the bucket. They return 503 until you set ${STORAGE_HINT}.`
    );
  return affected;
}
