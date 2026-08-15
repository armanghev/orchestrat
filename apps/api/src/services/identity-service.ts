import { randomUUID } from "node:crypto";
import type { HumanPrincipal } from "@orchestrat/auth";
import { users, type Database } from "@orchestrat/db";

export class IdentityService {
  constructor(private readonly db: Database) {}

  async resolveUserId(principal: HumanPrincipal) {
    const [user] = await this.db
      .insert(users)
      .values({
        id: randomUUID(),
        authProvider: principal.provider,
        authSubject: principal.authSubject,
        avatarUrl: principal.avatarUrl,
        email: principal.email,
        name: principal.name ?? principal.email.split("@")[0]!
      })
      .onConflictDoUpdate({
        target: [users.authProvider, users.authSubject],
        set: {
          avatarUrl: principal.avatarUrl,
          email: principal.email,
          name: principal.name ?? principal.email.split("@")[0]!,
          updatedAt: new Date()
        }
      })
      .returning({ id: users.id });
    return user.id;
  }
}
