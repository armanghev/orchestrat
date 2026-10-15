import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import test from "node:test";
import type { S3Client } from "@aws-sdk/client-s3";
import {
  profileSchema,
  updateProfileRequestSchema
} from "@orchestrat/protocol";
import { fixture } from "../test/fixture.js";

type Stored = { body: Buffer; contentType?: string; cacheControl?: string };

class FakeAvatarStorage {
  readonly objects = new Map<string, Stored>();
  readonly commands: string[] = [];

  async send(command: { input: Record<string, unknown> }) {
    const name = command.constructor.name;
    const input = command.input;
    const key = String(input.Key);
    this.commands.push(`${name}:${key}`);
    assert.equal(input.Bucket, "orchestrat");
    if (name === "PutObjectCommand") {
      this.objects.set(key, {
        body: Buffer.from(input.Body as Buffer),
        contentType: input.ContentType as string | undefined,
        cacheControl: input.CacheControl as string | undefined
      });
      return {};
    }
    if (name === "GetObjectCommand") {
      const object = this.objects.get(key);
      if (!object)
        throw Object.assign(new Error("missing"), {
          name: "NoSuchKey",
          $metadata: { httpStatusCode: 404 }
        });
      return {
        Body: Readable.from([object.body]),
        ContentType: object.contentType,
        ContentLength: object.body.byteLength
      };
    }
    if (name === "DeleteObjectCommand") {
      this.objects.delete(key);
      return {};
    }
    throw new Error(`unsupported command: ${name}`);
  }
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);
const alice = { authorization: "Bearer alice" };
const bob = { authorization: "Bearer bob" };

async function setup(publicApiUrl?: string, withStorage = true) {
  const storage = new FakeAvatarStorage();
  const { app } = await fixture({
    publicApiUrl,
    avatarStorage: withStorage
      ? {
          endpoint: "http://minio:9000",
          region: "us-east-1",
          bucket: "orchestrat",
          accessKeyId: "key",
          secretAccessKey: "secret",
          client: storage as unknown as S3Client
        }
      : undefined
  });
  const upload = (
    headers: Record<string, string>,
    contentType = "image/png",
    body = PNG
  ) => {
    const boundary = `----orchestrat${randomUUID()}`;
    return app.inject({
      method: "POST",
      url: "/api/v1/profile/avatar",
      headers: {
        ...headers,
        "content-type": `multipart/form-data; boundary=${boundary}`
      },
      payload: Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="avatar"; filename="me.png"\r\nContent-Type: ${contentType}\r\n\r\n`
        ),
        body,
        Buffer.from(`\r\n--${boundary}--\r\n`)
      ])
    });
  };
  const fetchAvatar = (url: string) =>
    app.inject({
      method: "GET",
      url: new URL(url, "http://api.test").pathname
    });
  return { app, storage, upload, fetchAvatar };
}

test("an uploaded avatar is served publicly by the API and removed with it", async (t) => {
  const { app, storage, upload, fetchAvatar } = await setup();
  t.after(() => app.close());

  const uploaded = await upload(alice);
  assert.equal(uploaded.statusCode, 200, uploaded.body);
  const profile = profileSchema.parse(uploaded.json());
  const url = profile.avatar_url!;
  // No public URL configured: a root-relative path the dashboard resolves.
  assert.match(url, /^\/api\/v1\/avatars\/[A-Za-z0-9_-]{32}$/);
  const key = url.split("/").pop()!;
  assert.deepEqual([...storage.objects.keys()], [`avatars/${key}`]);
  assert.equal(storage.objects.get(`avatars/${key}`)!.contentType, "image/png");
  assert.equal(
    storage.objects.get(`avatars/${key}`)!.cacheControl,
    "public, max-age=31536000, immutable"
  );

  // No credentials: <img src> sends none.
  const served = await fetchAvatar(url);
  assert.equal(served.statusCode, 200);
  assert.deepEqual(served.rawPayload, PNG);
  assert.equal(served.headers["content-type"], "image/png");
  assert.equal(served.headers["content-length"], String(PNG.byteLength));
  assert.equal(
    served.headers["cache-control"],
    "public, max-age=31536000, immutable"
  );
  assert.equal(served.headers["x-content-type-options"], "nosniff");
  assert.equal(
    served.headers["content-security-policy"],
    "default-src 'none'; sandbox"
  );

  // The dashboard saves the profile with the URL it got back.
  const saved = await app.inject({
    method: "PATCH",
    url: "/api/v1/profile",
    headers: alice,
    payload: updateProfileRequestSchema.parse({
      username: "alice",
      full_name: "Alice",
      avatar_url: url
    })
  });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(saved.json().avatar_url, url);

  // A new upload gets a new key and deletes the old object.
  const replaced = profileSchema.parse((await upload(alice)).json());
  assert.notEqual(replaced.avatar_url, url);
  assert.equal((await fetchAvatar(url)).statusCode, 404);
  assert.equal((await fetchAvatar(replaced.avatar_url!)).statusCode, 200);
  assert.equal(storage.objects.size, 1);

  const removed = await app.inject({
    method: "DELETE",
    url: "/api/v1/profile/avatar",
    headers: alice
  });
  assert.equal(removed.statusCode, 200);
  assert.equal(removed.json().avatar_url, null);
  assert.equal(storage.objects.size, 0);
  assert.equal((await fetchAvatar(replaced.avatar_url!)).statusCode, 404);
});

test("with a public URL the stored avatar URL is absolute", async (t) => {
  const { app, upload, fetchAvatar } = await setup(
    "https://orchestrat.example.com/"
  );
  t.after(() => app.close());
  const profile = profileSchema.parse((await upload(alice)).json());
  assert.match(
    profile.avatar_url!,
    /^https:\/\/orchestrat\.example\.com\/api\/v1\/avatars\/[A-Za-z0-9_-]{32}$/
  );
  assert.equal((await fetchAvatar(profile.avatar_url!)).statusCode, 200);
});

test("malformed or unknown avatar keys are not found", async (t) => {
  const { app, storage } = await setup();
  t.after(() => app.close());
  for (const key of [
    "short",
    "a".repeat(33),
    `${"a".repeat(31)}.`,
    "..%2F..%2Fdocument-revisions",
    `%2E%2E%2F${"a".repeat(26)}`
  ]) {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/avatars/${key}`
    });
    assert.equal(response.statusCode, 404, key);
    assert.equal(response.json().error.code, "NOT_FOUND");
  }
  assert.deepEqual(storage.commands, [], "malformed keys never reach storage");
  const unknown = await app.inject({
    method: "GET",
    url: `/api/v1/avatars/${"a".repeat(32)}`
  });
  assert.equal(unknown.statusCode, 404);
  assert.deepEqual(storage.commands, [
    `GetObjectCommand:avatars/${"a".repeat(32)}`
  ]);
});

test("only image types are served as images", async (t) => {
  const { app, storage, fetchAvatar } = await setup();
  t.after(() => app.close());
  const key = "b".repeat(32);
  storage.objects.set(`avatars/${key}`, {
    body: Buffer.from("<script>alert(1)</script>"),
    contentType: "text/html"
  });
  const served = await fetchAvatar(`/api/v1/avatars/${key}`);
  assert.equal(served.statusCode, 200);
  assert.equal(served.headers["content-type"], "application/octet-stream");
  assert.equal(served.headers["x-content-type-options"], "nosniff");
});

test("a profile cannot claim another user's uploaded avatar", async (t) => {
  const { app, storage, upload } = await setup();
  t.after(() => app.close());
  const url = profileSchema.parse((await upload(alice)).json()).avatar_url!;
  for (const avatar_url of [
    url,
    `https://elsewhere.example${url}`,
    `${url}?v=1`
  ]) {
    const claimed = await app.inject({
      method: "PATCH",
      url: "/api/v1/profile",
      headers: bob,
      payload: { username: "bobby", full_name: "Bob", avatar_url }
    });
    assert.equal(claimed.statusCode, 400, avatar_url);
  }
  // Otherwise removing "his" avatar would delete Alice's object.
  await app.inject({
    method: "DELETE",
    url: "/api/v1/profile/avatar",
    headers: bob
  });
  assert.equal(storage.objects.size, 1);
  const external = await app.inject({
    method: "PATCH",
    url: "/api/v1/profile",
    headers: bob,
    payload: {
      username: "bobby",
      full_name: "Bob",
      avatar_url: "https://cdn.example.com/bob.png"
    }
  });
  assert.equal(external.statusCode, 200);
  // Replacing an uploaded avatar with an external URL deletes the object.
  const replaced = await app.inject({
    method: "PATCH",
    url: "/api/v1/profile",
    headers: alice,
    payload: {
      username: "alice",
      full_name: "Alice",
      avatar_url: "https://cdn.example.com/alice.png"
    }
  });
  assert.equal(replaced.statusCode, 200);
  assert.equal(storage.objects.size, 0);
});

test("uploads are rejected without storage and with a non-image type", async (t) => {
  const off = await setup(undefined, false);
  t.after(() => off.app.close());
  const unconfigured = await off.upload(alice);
  assert.equal(unconfigured.statusCode, 503);
  assert.equal(unconfigured.json().error.code, "STORAGE_UPLOAD_FAILED");
  assert.equal(
    (
      await off.app.inject({
        method: "GET",
        url: `/api/v1/avatars/${"a".repeat(32)}`
      })
    ).statusCode,
    404
  );

  const on = await setup();
  t.after(() => on.app.close());
  const html = await on.upload(alice, "text/html", Buffer.from("<html>"));
  assert.notEqual(html.statusCode, 200);
  assert.equal(on.storage.objects.size, 0);
});
