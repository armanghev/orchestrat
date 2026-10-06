import { randomUUID } from "node:crypto";
import { organizationMembers, users, type Database } from "@orchestrat/db";
import { eq } from "drizzle-orm";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { fixture } from "./fixture.js";

type Method = "GET" | "POST" | "PATCH" | "DELETE";
type Headers = Record<string, string>;
// Named through fastify: CI's fresh install can't name light-my-request's
// type from the inferred return of the helpers below (TS2742).
type Response = Promise<LightMyRequestResponse>;

/**
 * A project owned by alice with bob as a plain member, plus helpers to call
 * the human and agent APIs. Shared by the branch suites.
 */
export async function workspace(options: Parameters<typeof fixture>[0] = {}) {
  const { app, db } = await fixture(options);
  return workspaceOn(app, db);
}

/** The same workspace on an app built elsewhere (the real-Postgres suites). */
export async function workspaceOn(app: FastifyInstance, db: Database) {
  const human =
    (token: string) =>
    (
      method: Method,
      url: string,
      payload?: unknown,
      headers: Headers = {}
    ): Response =>
      app.inject({
        method,
        url: `/api/v1${url}`,
        headers: { authorization: `Bearer ${token}`, ...headers },
        ...(payload === undefined ? {} : { payload: payload as object })
      });
  const alice = human("alice");
  const bob = human("bob");
  const organization = (
    await alice("POST", "/organizations", {
      name: `Branches ${randomUUID().slice(0, 8)}`
    })
  ).json();
  const project = (
    await alice("POST", `/organizations/${organization.id}/projects`, {
      name: "Primary",
      task_key_prefix: "ORC"
    })
  ).json();
  await bob("GET", "/profile");
  const [aliceUser] = await db
    .select()
    .from(users)
    .where(eq(users.email, "alice@example.com"));
  const [bobUser] = await db
    .select()
    .from(users)
    .where(eq(users.email, "bob@example.com"));
  await db.insert(organizationMembers).values({
    organizationId: organization.id,
    userId: bobUser!.id,
    role: "member"
  });
  const added = await alice("POST", `/projects/${project.id}/members`, {
    user_id: bobUser!.id
  });
  if (added.statusCode !== 201) throw new Error(added.body);

  const createAgent = async (name: string, projectId = project.id) => {
    const agent = (
      await alice("POST", `/projects/${projectId}/agents`, { name })
    ).json();
    const credential = (
      await alice(
        "POST",
        `/projects/${projectId}/agents/${agent.id}/credentials`
      )
    ).json();
    const token = credential.token as string;
    const call = (
      method: Method,
      url: string,
      payload?: unknown,
      headers: Headers = {}
    ): Response =>
      app.inject({
        method,
        url: `/api/v1/agent${url}`,
        headers: { authorization: `Bearer ${token}`, ...headers },
        ...(payload === undefined ? {} : { payload: payload as object })
      });
    return { agent, token, call };
  };

  return {
    app,
    db,
    organization,
    project,
    alice,
    bob,
    aliceUser: aliceUser!,
    bobUser: bobUser!,
    createAgent
  };
}
