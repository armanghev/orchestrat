import { randomUUID } from "node:crypto";
import type { HumanPrincipal } from "@orchestrat/auth";
import { users, type Database } from "@orchestrat/db";

const NAME_MAX_LENGTH = 200;

const fallbackName = (email: string) =>
  Array.from(email.split("@")[0]!).slice(0, NAME_MAX_LENGTH).join("");

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
        name: principal.name ?? fallbackName(principal.email)
      })
      .onConflictDoUpdate({
        target: [users.authProvider, users.authSubject],
        set: {
          ...(principal.name ? { name: principal.name } : {}),
          ...(principal.avatarUrl ? { avatarUrl: principal.avatarUrl } : {}),
          email: principal.email,
          updatedAt: new Date()
        }
      })
      .returning({ id: users.id });
    return user.id;
  }
}
