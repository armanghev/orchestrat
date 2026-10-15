import { eq } from "drizzle-orm";
import {
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import { users, type Database } from "@orchestrat/db";
import type { UpdateProfileRequest } from "@orchestrat/protocol";

const profileJson = (user: typeof users.$inferSelect) => ({
  user_id: user.id,
  provider: user.authProvider,
  username: user.username,
  full_name: user.name,
  email: user.email,
  avatar_url: user.avatarUrl,
  is_instance_admin: user.isInstanceAdmin
});

export type AvatarStorageConfig = {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  publicUrlBase: string;
};

type AvatarFile = { mimetype: string; buffer: Buffer };

export class ProfileService {
  private readonly storage: S3Client | null;

  constructor(
    private readonly db: Database,
    private readonly avatarStorage?: AvatarStorageConfig
  ) {
    this.storage = avatarStorage
      ? new S3Client({
          forcePathStyle: true,
          region: avatarStorage.region,
          endpoint: avatarStorage.endpoint,
          credentials: {
            accessKeyId: avatarStorage.accessKeyId,
            secretAccessKey: avatarStorage.secretAccessKey
          }
        })
      : null;
  }

  async get(userId: string) {
    const user = await this.db.query.users.findFirst({
      where: eq(users.id, userId)
    });
    if (!user) throw new Error("Authenticated user was not found.");
    return profileJson(user);
  }

  async update(userId: string, input: UpdateProfileRequest) {
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
    return profileJson(user);
  }

  async updateAvatar(userId: string, file: AvatarFile) {
    const user = await this.db.query.users.findFirst({
      where: eq(users.id, userId)
    });
    if (!user) throw new Error("Authenticated user was not found.");
    if (!this.storage || !this.avatarStorage)
      throw new Error("Avatar storage is not configured.");

    await this.storage.send(
      new PutObjectCommand({
        Bucket: this.avatarStorage.bucket,
        Key: `${user.authSubject}/avatar`,
        Body: file.buffer,
        ContentType: file.mimetype,
        CacheControl: "no-cache"
      })
    );

    const avatarUrl = `${this.avatarStorage.publicUrlBase}/${encodeURIComponent(
      user.authSubject
    )}/avatar?v=${Date.now()}`;
    const [updated] = await this.db
      .update(users)
      .set({ avatarUrl, updatedAt: new Date() })
      .where(eq(users.id, userId))
      .returning();
    if (!updated) throw new Error("Authenticated user was not found.");
    return profileJson(updated);
  }

  async removeAvatar(userId: string) {
    const user = await this.db.query.users.findFirst({
      where: eq(users.id, userId)
    });
    if (!user) throw new Error("Authenticated user was not found.");

    if (this.storage && this.avatarStorage) {
      await this.storage.send(
        new DeleteObjectCommand({
          Bucket: this.avatarStorage.bucket,
          Key: `${user.authSubject}/avatar`
        })
      );
    }

    const [updated] = await this.db
      .update(users)
      .set({ avatarUrl: null, updatedAt: new Date() })
      .where(eq(users.id, userId))
      .returning();
    if (!updated) throw new Error("Authenticated user was not found.");
    return profileJson(updated);
  }
}
