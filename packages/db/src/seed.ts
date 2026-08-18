import { randomUUID } from "node:crypto";
import { config } from "dotenv";
import { and, eq } from "drizzle-orm";
import { createDatabase } from "./index.js";
import { parseSeedAuthSubject } from "./seed-config.js";
import {
  organizationMembers,
  organizations,
  projects,
  users
} from "./schema.js";

config({ path: "../../.env" });

const rawAuthSubject = process.env.ORCHESTRAT_SEED_AUTH_SUBJECT;
const email = process.env.ORCHESTRAT_SEED_USER_EMAIL?.trim().toLowerCase();
const name = process.env.ORCHESTRAT_SEED_USER_NAME?.trim();
const databaseUrl = process.env.ORCHESTRAT_DATABASE_URL;

if (!databaseUrl || !rawAuthSubject || !email || !name) {
  throw new Error(
    "Set ORCHESTRAT_DATABASE_URL and the ORCHESTRAT_SEED_* variables before seeding."
  );
}

const authSubject = parseSeedAuthSubject(rawAuthSubject);
const { db, pool } = createDatabase({ connectionString: databaseUrl });

try {
  const seeded = await db.transaction(async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({
        id: randomUUID(),
        authProvider: "supabase",
        authSubject,
        email,
        name
      })
      .onConflictDoUpdate({
        target: [users.authProvider, users.authSubject],
        set: { email, name, updatedAt: new Date() }
      })
      .returning();

    const [organization] = await tx
      .insert(organizations)
      .values({ id: randomUUID(), name: "Local organization", slug: "local" })
      .onConflictDoNothing({ target: organizations.slug })
      .returning();
    const activeOrganization =
      organization ??
      (await tx.query.organizations.findFirst({
        where: eq(organizations.slug, "local")
      }))!;

    await tx
      .insert(organizationMembers)
      .values({
        organizationId: activeOrganization.id,
        userId: user.id,
        role: "owner"
      })
      .onConflictDoNothing();

    const [project] = await tx
      .insert(projects)
      .values({
        id: randomUUID(),
        organizationId: activeOrganization.id,
        name: "Demo project",
        slug: "demo"
      })
      .onConflictDoNothing()
      .returning();
    const activeProject =
      project ??
      (await tx.query.projects.findFirst({
        where: and(
          eq(projects.organizationId, activeOrganization.id),
          eq(projects.slug, "demo")
        )
      }))!;

    return {
      organization: activeOrganization.id,
      project: activeProject.id
    };
  });

  console.info(JSON.stringify(seeded, null, 2));
} finally {
  await pool.end();
}
