import { randomUUID } from "node:crypto";
import type { HumanAuth } from "@orchestrat/auth";
import { users, type Database } from "@orchestrat/db";
import { eq } from "drizzle-orm";

export class IdentityService {
  constructor(
    private readonly db: Database,
    private readonly auth: HumanAuth
  ) {}

  async resolveUserId(authSubject: string) {
    const existing = await this.db.query.users.findFirst({
      columns: { id: true },
      where: eq(users.authSubject, authSubject)
    });
    if (existing) return existing.id;

    const profile = await this.auth.getProfile(authSubject);
    const [user] = await this.db
      .insert(users)
      .values({ id: randomUUID(), ...profile })
      .onConflictDoUpdate({
        target: users.authSubject,
        set: {
          avatarUrl: profile.avatarUrl,
          email: profile.email,
          name: profile.name,
          updatedAt: new Date()
        }
      })
      .returning({ id: users.id });
    return user.id;
  }
}
