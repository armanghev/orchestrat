import assert from "node:assert/strict";
import test from "node:test";
import type { S3Client } from "@aws-sdk/client-s3";
import { documentRevisions } from "@orchestrat/db";
import { eq } from "drizzle-orm";
import {
  DEFAULT_ATTACHMENT_QUOTA_BYTES,
  ensureBucket,
  readStorageConfig,
  warnIfStorageMissing
} from "../storage-config.js";
import { fixture } from "../test/fixture.js";

const complete = {
  ORCHESTRAT_S3_ENDPOINT: "http://minio:9000/",
  ORCHESTRAT_S3_BUCKET: "orchestrat",
  ORCHESTRAT_S3_ACCESS_KEY_ID: "new-key",
  ORCHESTRAT_S3_SECRET_ACCESS_KEY: "new-secret"
};
const legacy = {
  DOCUMENT_STORAGE_BUCKET: "r2-documents",
  DOCUMENT_STORAGE_S3_ENDPOINT: "https://account.r2.cloudflarestorage.com",
  DOCUMENT_STORAGE_S3_REGION: "auto",
  DOCUMENT_STORAGE_S3_ACCESS_KEY_ID: "old-key",
  DOCUMENT_STORAGE_S3_SECRET_ACCESS_KEY: "old-secret"
};

function capture() {
  const lines: string[] = [];
  return {
    lines,
    warn: (context: object, message: string) =>
      lines.push(JSON.stringify({ message, ...context }))
  };
}

test("new variables configure documents and avatars in one bucket", () => {
  const log = capture();
  const settings = readStorageConfig(complete, log);
  const connection = {
    endpoint: "http://minio:9000",
    region: "us-east-1",
    bucket: "orchestrat",
    accessKeyId: "new-key",
    secretAccessKey: "new-secret",
    forcePathStyle: true
  };
  assert.deepEqual(settings, {
    documentStorage: { ...connection, publicEndpoint: "http://minio:9000" },
    avatarStorage: connection,
    attachmentQuotaBytes: DEFAULT_ATTACHMENT_QUOTA_BYTES,
    createBucket: false
  });
  assert.deepEqual(log.lines, []);

  const tuned = readStorageConfig({
    ...complete,
    ORCHESTRAT_S3_PUBLIC_ENDPOINT: "https://files.example.com/",
    ORCHESTRAT_S3_REGION: "eu-central-1",
    ORCHESTRAT_S3_FORCE_PATH_STYLE: "false",
    ORCHESTRAT_S3_CREATE_BUCKET: "true"
  });
  assert.equal(tuned.documentStorage?.endpoint, "http://minio:9000");
  assert.equal(
    tuned.documentStorage?.publicEndpoint,
    "https://files.example.com"
  );
  assert.equal(tuned.documentStorage?.region, "eu-central-1");
  assert.equal(tuned.documentStorage?.forcePathStyle, false);
  assert.equal(tuned.avatarStorage?.forcePathStyle, false);
  assert.equal(tuned.createBucket, true);
  assert.throws(
    () => readStorageConfig({ ...complete, ORCHESTRAT_S3_CREATE_BUCKET: "on" }),
    /ORCHESTRAT_S3_CREATE_BUCKET must be true or false/
  );
  assert.throws(
    () =>
      readStorageConfig({ ...complete, ORCHESTRAT_S3_FORCE_PATH_STYLE: "x" }),
    /ORCHESTRAT_S3_FORCE_PATH_STYLE must be true or false/
  );
});

test("storage stays off until a connection variable is set", () => {
  for (const env of [
    {},
    { ORCHESTRAT_S3_REGION: "us-east-1", ORCHESTRAT_S3_FORCE_PATH_STYLE: "1" },
    // Compose passes unset variables through as empty strings.
    { ORCHESTRAT_S3_ENDPOINT: "", ORCHESTRAT_S3_BUCKET: "  " },
    // The Supabase avatar variables are no longer read.
    {
      SUPABASE_AVATAR_BUCKET: "avatars",
      SUPABASE_S3_ENDPOINT: "https://example.supabase.co/storage/v1/s3",
      SUPABASE_S3_REGION: "us-east-1",
      SUPABASE_S3_ACCESS_KEY_ID: "key",
      SUPABASE_S3_SECRET_ACCESS_KEY: "secret"
    }
  ])
    assert.deepEqual(readStorageConfig(env), {
      attachmentQuotaBytes: DEFAULT_ATTACHMENT_QUOTA_BYTES,
      createBucket: false
    });
});

test("DOCUMENT_STORAGE_* still work, with a warning that names no values", () => {
  const log = capture();
  const settings = readStorageConfig(legacy, log);
  assert.deepEqual(settings.documentStorage, {
    endpoint: "https://account.r2.cloudflarestorage.com",
    publicEndpoint: "https://account.r2.cloudflarestorage.com",
    region: "auto",
    bucket: "r2-documents",
    accessKeyId: "old-key",
    secretAccessKey: "old-secret",
    forcePathStyle: true
  });
  assert.equal(log.lines.length, 1);
  assert.match(log.lines[0]!, /DOCUMENT_STORAGE_BUCKET/);
  assert.match(log.lines[0]!, /deprecated/);
  for (const secret of ["old-key", "old-secret", "r2-documents"])
    assert.ok(!log.lines[0]!.includes(secret), secret);

  // New names win over old ones, variable by variable.
  const mixed = readStorageConfig(
    { ...legacy, ORCHESTRAT_S3_BUCKET: "renamed" },
    capture()
  );
  assert.equal(mixed.documentStorage?.bucket, "renamed");
  assert.equal(mixed.documentStorage?.accessKeyId, "old-key");
  const renamed = readStorageConfig({ ...legacy, ...complete }, log);
  assert.equal(renamed.documentStorage?.endpoint, "http://minio:9000");
  assert.equal(renamed.documentStorage?.region, "auto");
});

test("an incomplete configuration names what is missing", () => {
  assert.throws(
    () => readStorageConfig({ ORCHESTRAT_S3_BUCKET: "orchestrat" }),
    (error: Error) => {
      assert.match(
        error.message,
        /ORCHESTRAT_S3_ENDPOINT, ORCHESTRAT_S3_ACCESS_KEY_ID, ORCHESTRAT_S3_SECRET_ACCESS_KEY/
      );
      assert.doesNotMatch(error.message, /set ORCHESTRAT_S3_BUCKET/);
      return true;
    }
  );
  assert.throws(
    () =>
      readStorageConfig({
        ORCHESTRAT_S3_PUBLIC_ENDPOINT: "http://localhost:9000"
      }),
    /ORCHESTRAT_S3_ENDPOINT, ORCHESTRAT_S3_BUCKET/
  );
  assert.throws(
    () =>
      readStorageConfig({ ...complete, ORCHESTRAT_S3_SECRET_ACCESS_KEY: "" }),
    /partly configured; set ORCHESTRAT_S3_SECRET_ACCESS_KEY,/
  );
});

test("endpoints must be plain http(s) URLs, and R2 endpoints bucket-free", () => {
  for (const endpoint of [
    "minio:9000",
    "ftp://minio:9000",
    "not a url",
    "http://user:pass@minio:9000",
    "http://minio:9000/?bucket=x"
  ])
    assert.throws(
      () =>
        readStorageConfig({ ...complete, ORCHESTRAT_S3_ENDPOINT: endpoint }),
      /ORCHESTRAT_S3_ENDPOINT must/
    );
  assert.throws(
    () =>
      readStorageConfig({
        ...complete,
        ORCHESTRAT_S3_PUBLIC_ENDPOINT: "localhost:9000"
      }),
    /ORCHESTRAT_S3_PUBLIC_ENDPOINT must be an http\(s\) URL/
  );
  // Credentials never reach the error message.
  assert.throws(
    () =>
      readStorageConfig({
        ...complete,
        ORCHESTRAT_S3_ENDPOINT: "http://user:hunter2@minio:9000"
      }),
    (error: Error) => !error.message.includes("hunter2")
  );
  assert.throws(
    () =>
      readStorageConfig({
        ...legacy,
        DOCUMENT_STORAGE_S3_ENDPOINT:
          "https://account.r2.cloudflarestorage.com/documents"
      }),
    /R2 endpoint in DOCUMENT_STORAGE_S3_ENDPOINT must be the account origin without a bucket path/
  );
  assert.throws(
    () =>
      readStorageConfig({
        ...complete,
        ORCHESTRAT_S3_PUBLIC_ENDPOINT:
          "https://account.r2.cloudflarestorage.com/orchestrat"
      }),
    /without a bucket path/
  );
  // Other providers may serve S3 under a path.
  assert.equal(
    readStorageConfig({
      ...complete,
      ORCHESTRAT_S3_ENDPOINT: "https://project.supabase.co/storage/v1/s3"
    }).documentStorage?.endpoint,
    "https://project.supabase.co/storage/v1/s3"
  );
});

test("the attachment quota parses as positive whole bytes", () => {
  assert.equal(
    readStorageConfig({}).attachmentQuotaBytes,
    10 * 1024 * 1024 * 1024
  );
  assert.equal(
    readStorageConfig({ ORCHESTRAT_ATTACHMENT_QUOTA_BYTES: " 1048576 " })
      .attachmentQuotaBytes,
    1048576
  );
  assert.equal(
    readStorageConfig({ ...complete, ORCHESTRAT_ATTACHMENT_QUOTA_BYTES: "5" })
      .attachmentQuotaBytes,
    5
  );
  for (const value of ["0", "-1", "1.5", "10GB", "1e9", "9007199254740993"])
    assert.throws(
      () => readStorageConfig({ ORCHESTRAT_ATTACHMENT_QUOTA_BYTES: value }),
      /ORCHESTRAT_ATTACHMENT_QUOTA_BYTES must be a positive whole number/
    );
});

test("startup warns when bucket-backed revisions exist but storage is off", async (t) => {
  const { app, db } = await fixture();
  t.after(() => app.close());
  const log = capture();
  assert.deepEqual(await warnIfStorageMissing(db, undefined, log), {
    revisions: 0,
    attachments: 0
  });
  const organization = (
    await app.inject({
      method: "POST",
      url: "/api/v1/organizations",
      headers: { authorization: "Bearer alice" },
      payload: { name: "Storage warning" }
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
  for (const path of ["docs/a.md", "docs/b.md"])
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/documents`,
      headers: { authorization: "Bearer alice" },
      payload: { path, content: "inline" }
    });
  // Inline revisions (no object metadata) need no storage.
  assert.equal((await warnIfStorageMissing(db, undefined, log)).revisions, 0);
  assert.deepEqual(log.lines, []);

  const [revision] = await db.select().from(documentRevisions).limit(1);
  await db
    .update(documentRevisions)
    .set({ contentSizeBytes: 6, contentSha256: "a".repeat(64) })
    .where(eq(documentRevisions.id, revision!.id));
  assert.deepEqual(await warnIfStorageMissing(db, undefined, log), {
    revisions: 1,
    attachments: 0
  });
  assert.equal(log.lines.length, 1);
  assert.match(log.lines[0]!, /1 document revisions/);
  assert.match(log.lines[0]!, /ORCHESTRAT_S3_ENDPOINT/);

  const configured = readStorageConfig(complete).documentStorage;
  assert.deepEqual(await warnIfStorageMissing(db, configured, log), {
    revisions: 0,
    attachments: 0
  });
  assert.equal(log.lines.length, 1);
});

test("ensureBucket creates a missing bucket and leaves an existing one", async () => {
  const config = readStorageConfig(complete).documentStorage!;
  const calls: string[] = [];
  let exists = false;
  let headError: unknown = undefined;
  const client = {
    async send(command: { input: Record<string, unknown> }) {
      const name = command.constructor.name;
      calls.push(`${name}:${String(command.input.Bucket)}`);
      if (name === "HeadBucketCommand") {
        if (headError) throw headError;
        if (!exists)
          throw Object.assign(new Error("not found"), {
            name: "NotFound",
            $metadata: { httpStatusCode: 404 }
          });
        return {};
      }
      if (name === "CreateBucketCommand") {
        assert.equal(command.input.CreateBucketConfiguration, undefined);
        exists = true;
        return {};
      }
      throw new Error(`unexpected ${name}`);
    }
  } as unknown as S3Client;

  assert.equal(await ensureBucket(config, client), "created");
  assert.equal(await ensureBucket(config, client), "exists");
  assert.deepEqual(calls, [
    "HeadBucketCommand:orchestrat",
    "CreateBucketCommand:orchestrat",
    "HeadBucketCommand:orchestrat"
  ]);
  headError = Object.assign(new Error("denied"), {
    name: "Forbidden",
    $metadata: { httpStatusCode: 403 }
  });
  await assert.rejects(
    ensureBucket(config, client),
    /Could not check bucket "orchestrat" \(Forbidden\)/
  );
});
