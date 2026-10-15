import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  type GetObjectCommandOutput,
  PutObjectCommand,
  type S3Client
} from "@aws-sdk/client-s3";
import { users, type Database } from "@orchestrat/db";
import {
  avatarKeySchema,
  type UpdateProfileRequest
} from "@orchestrat/protocol";
import { ApiError } from "./api-error.js";
import { createS3Client, type S3ConnectionConfig } from "./s3-client.js";

const profileJson = (user: typeof users.$inferSelect) => ({
  user_id: user.id,
  provider: user.authProvider,
  username: user.username,
  full_name: user.name,
  email: user.email,
  avatar_url: user.avatarUrl,
  is_instance_admin: user.isInstanceAdmin
});

/**
 * Avatars live in the document bucket under `avatars/` and are served by
 * GET /api/v1/avatars/:key, so the bucket stays private.
 */
export type AvatarStorageConfig = S3ConnectionConfig & {
  /** Replaces the client (tests). */
  client?: S3Client;
};

type AvatarFile = { mimetype: string; buffer: Buffer };

export const AVATAR_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const AVATAR_ROUTE = "/api/v1/avatars/";
// Every upload gets a new key, so its URL never changes content.
export const AVATAR_CACHE_CONTROL = "public, max-age=31536000, immutable";
const avatarObjectKey = (key: string) => `avatars/${key}`;
const avatarNotFound = () =>
  new ApiError(404, "NOT_FOUND", "Avatar not found.");

/**
 * The key of an avatar this API stored, from any URL whose path ends in
 * /api/v1/avatars/<key>, whatever its origin: the public URL may have changed
 * since it was stored.
 */
export function avatarKeyFromUrl(value: string | null | undefined) {
  if (!value) return undefined;
  let url: URL;
  try {
    url = new URL(value, "http://relative.invalid");
  } catch {
    return undefined;
  }
  const match = url.pathname.match(/\/api\/v1\/avatars\/([^/]+)$/);
  return match && avatarKeySchema.safeParse(match[1]).success
    ? match[1]
    : undefined;
}

export class ProfileService {
  private readonly storage: S3Client | null;
  private readonly publicApiUrl: string;

  constructor(
    private readonly db: Database,
    private readonly avatarStorage?: AvatarStorageConfig,
    options: {
      /** Absolute API origin for stored avatar URLs; root-relative without it. */
      publicApiUrl?: string;
    } = {}
  ) {
    this.storage = avatarStorage
      ? (avatarStorage.client ?? createS3Client(avatarStorage))
      : null;
    this.publicApiUrl = options.publicApiUrl
      ? new URL(options.publicApiUrl).href.replace(/\/+$/, "")
      : "";
  }

  private async user(userId: string) {
    const user = await this.db.query.users.findFirst({
      where: eq(users.id, userId)
    });
    if (!user) throw new Error("Authenticated user was not found.");
    return user;
  }

  /** Best effort: a leftover object is unreachable once its URL is gone. */
  private async deleteAvatar(key: string | undefined) {
    if (!key || !this.storage || !this.avatarStorage) return;
    await this.storage
      .send(
        new DeleteObjectCommand({
          Bucket: this.avatarStorage.bucket,
          Key: avatarObjectKey(key)
        })
      )
      .catch(() => undefined);
  }

  async get(userId: string) {
    return profileJson(await this.user(userId));
  }

  async update(userId: string, input: UpdateProfileRequest) {
    const current = await this.user(userId);
    const currentKey = avatarKeyFromUrl(current.avatarUrl);
    const nextKey = avatarKeyFromUrl(input.avatar_url);
    // Only an upload sets an avatar URL of ours. Otherwise a user could point
    // at someone else's key and delete that object by removing "their" avatar.
    if (nextKey && nextKey !== currentKey)
      throw new ApiError(
        400,
        "VALIDATION_ERROR",
        "Upload avatar images with POST /api/v1/profile/avatar."
      );
    const [user] = await this.db
      .update(users)
      .set({
        username: input.username.toLowerCase(),
        name: input.full_name,
        avatarUrl: input.avatar_url,
        updatedAt: new Date()
      })
      .where(eq(users.id, userId))
      .returning();
    if (!user) throw new Error("Authenticated user was not found.");
    if (currentKey !== nextKey) await this.deleteAvatar(currentKey);
    return profileJson(user);
  }

  async updateAvatar(userId: string, file: AvatarFile) {
    const user = await this.user(userId);
    if (!this.storage || !this.avatarStorage)
      throw new ApiError(
        503,
        "STORAGE_UPLOAD_FAILED",
        "Avatar storage is not configured."
      );
    if (!AVATAR_TYPES.has(file.mimetype))
      throw new ApiError(
        400,
        "VALIDATION_ERROR",
        "Avatars must be JPEG, PNG, or WebP images."
      );

    const key = randomBytes(24).toString("base64url");
    try {
      await this.storage.send(
        new PutObjectCommand({
          Bucket: this.avatarStorage.bucket,
          Key: avatarObjectKey(key),
          Body: file.buffer,
          ContentType: file.mimetype,
          CacheControl: AVATAR_CACHE_CONTROL
        })
      );
    } catch {
      throw new ApiError(
        502,
        "STORAGE_UPLOAD_FAILED",
        "Storage could not save the avatar."
      );
    }

    const [updated] = await this.db
      .update(users)
      .set({
        avatarUrl: `${this.publicApiUrl}${AVATAR_ROUTE}${key}`,
        updatedAt: new Date()
      })
      .where(eq(users.id, userId))
      .returning();
    if (!updated) {
      await this.deleteAvatar(key);
      throw new Error("Authenticated user was not found.");
    }
    await this.deleteAvatar(avatarKeyFromUrl(user.avatarUrl));
    return profileJson(updated);
  }

  async removeAvatar(userId: string) {
    const user = await this.user(userId);
    const [updated] = await this.db
      .update(users)
      .set({ avatarUrl: null, updatedAt: new Date() })
      .where(eq(users.id, userId))
      .returning();
    if (!updated) throw new Error("Authenticated user was not found.");
    await this.deleteAvatar(avatarKeyFromUrl(user.avatarUrl));
    return profileJson(updated);
  }

  /** The stored image for GET /api/v1/avatars/:key, which is public. */
  async avatar(key: string) {
    if (!avatarKeySchema.safeParse(key).success) throw avatarNotFound();
    if (!this.storage || !this.avatarStorage) throw avatarNotFound();
    let object: GetObjectCommandOutput;
    try {
      object = await this.storage.send(
        new GetObjectCommand({
          Bucket: this.avatarStorage.bucket,
          Key: avatarObjectKey(key)
        })
      );
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } })
        .$metadata?.httpStatusCode;
      const name = (error as { name?: string }).name;
      if (status === 404 || name === "NoSuchKey" || name === "NotFound")
        throw avatarNotFound();
      throw new ApiError(
        503,
        "INTERNAL_ERROR",
        "Avatar storage is unavailable."
      );
    }
    if (!object.Body) throw avatarNotFound();
    return {
      body: object.Body,
      contentLength: object.ContentLength,
      // Only image types are served as such; anything else is a download.
      contentType: AVATAR_TYPES.has(object.ContentType ?? "")
        ? object.ContentType!
        : "application/octet-stream"
    };
  }
}
