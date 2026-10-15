import { randomUUID } from "node:crypto";
import { config } from "dotenv";
import { and, eq } from "drizzle-orm";
import { hashPassword } from "@orchestrat/auth";
import { createDatabase } from "./index.js";
import { parseSeedPassword } from "./seed-config.js";
import {
  instanceSettings,
  organizationMembers,
  organizations,
  projectBranches,
  projectMembers,
  projects,
  userPasswords,
  users
} from "./schema.js";

config({ path: "../../.env" });

const rawPassword = process.env.ORCHESTRAT_SEED_USER_PASSWORD;
const email = process.env.ORCHESTRAT_SEED_USER_EMAIL?.trim().toLowerCase();
const name = process.env.ORCHESTRAT_SEED_USER_NAME?.trim();
const databaseUrl = process.env.ORCHESTRAT_DATABASE_URL;

if (!databaseUrl || !rawPassword || !email || !name) {
  throw new Error(
    "Set ORCHESTRAT_DATABASE_URL and the ORCHESTRAT_SEED_* variables before seeding."
  );
}

const passwordHash = await hashPassword(parseSeedPassword(rawPassword));
const { db, pool } = createDatabase({ connectionString: databaseUrl });

try {
  const seeded = await db.transaction(async (tx) => {
    // A local admin account that signs in with the seed password.
    const id = randomUUID();
    const [user] = await tx
      .insert(users)
      .values({
        id,
        authProvider: "local",
        authSubject: id,
        email,
        name,
        isInstanceAdmin: true
      })
      .onConflictDoUpdate({
        target: users.email,
        set: { name, isInstanceAdmin: true, updatedAt: new Date() }
      })
      .returning();
    await tx
      .insert(userPasswords)
      .values({ userId: user.id, passwordHash })
      .onConflictDoUpdate({
        target: userPasswords.userId,
        set: { passwordHash, updatedAt: new Date() }
      });
    await tx
      .insert(instanceSettings)
      .values({ id: 1, bootstrappedBy: user.id })
      .onConflictDoNothing();

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

    // Access needs both memberships, and every project has a default branch.
    await tx
      .insert(projectMembers)
      .values({ projectId: activeProject.id, userId: user.id, role: "owner" })
      .onConflictDoNothing();
    await tx
      .insert(projectBranches)
      .values({
        projectId: activeProject.id,
        name: "main",
        isDefault: true,
        nameSource: "fallback",
        createdVia: "migration",
        onboardingState: "completed",
        onboardingCompletedAt: new Date()
      })
      .onConflictDoNothing();

    return {
      organization: activeOrganization.id,
      project: activeProject.id
    };
  });

  console.info(JSON.stringify(seeded, null, 2));
} finally {
  await pool.end();
}
