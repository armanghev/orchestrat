import assert from "node:assert/strict";
import test from "node:test";
import { organizationMembers, projectInvitations, users } from "@orchestrat/db";
import { and, eq } from "drizzle-orm";
import { fixture } from "../test/fixture.js";

const bearer = (user: "alice" | "bob") => ({
  authorization: `Bearer ${user}`
});

test("project membership is explicit and invitations are single-use", async (t) => {
  const { app, db } = await fixture();
  t.after(() => app.close());

  const organization = (
    await app.inject({
      method: "POST",
      url: "/api/v1/organizations",
      headers: bearer("alice"),
      payload: { name: "Messaging" }
    })
  ).json();
  const project = (
    await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organization.id}/projects`,
      headers: bearer("alice"),
      payload: { name: "Private alpha" }
    })
  ).json();
  assert.equal(project.role, "owner");

  await app.inject({
    method: "GET",
    url: "/api/v1/profile",
    headers: bearer("bob")
  });
  const [bob] = await db
    .select()
    .from(users)
    .where(eq(users.email, "bob@example.com"));
  assert.ok(bob);
  await db.insert(organizationMembers).values({
    organizationId: organization.id,
    userId: bob.id,
    role: "member"
  });

  const organizationOnly = await app.inject({
    method: "GET",
    url: `/api/v1/projects/${project.id}`,
    headers: bearer("bob")
  });
  assert.equal(organizationOnly.statusCode, 403);

  const invite = await app.inject({
    method: "POST",
    url: `/api/v1/projects/${project.id}/invitations`,
    headers: bearer("alice")
  });
  assert.equal(invite.statusCode, 201);
  const inviteBody = invite.json();
  assert.match(inviteBody.token, /^[A-Za-z0-9_-]{43}$/);
  const [stored] = await db
    .select()
    .from(projectInvitations)
    .where(eq(projectInvitations.id, inviteBody.invitation.id));
  assert.notEqual(stored?.tokenHash, inviteBody.token);

  const accepted = await app.inject({
    method: "POST",
    url: "/api/v1/project-invitations/accept",
    headers: bearer("bob"),
    payload: { token: inviteBody.token }
  });
  assert.equal(accepted.statusCode, 200);
  assert.equal(accepted.json().project.role, "member");

  const replay = await app.inject({
    method: "POST",
    url: "/api/v1/project-invitations/accept",
    headers: bearer("bob"),
    payload: { token: inviteBody.token }
  });
  assert.equal(replay.statusCode, 200);

  const differentRedeemer = await app.inject({
    method: "POST",
    url: "/api/v1/project-invitations/accept",
    headers: bearer("alice"),
    payload: { token: inviteBody.token }
  });
  assert.equal(differentRedeemer.statusCode, 409);

  const list = await app.inject({
    method: "GET",
    url: `/api/v1/projects/${project.id}/members`,
    headers: bearer("bob")
  });
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().members.length, 2);

  const memberCannotInvite = await app.inject({
    method: "POST",
    url: `/api/v1/projects/${project.id}/invitations`,
    headers: bearer("bob")
  });
  assert.equal(memberCannotInvite.statusCode, 403);

  const expired = await app.inject({
    method: "POST",
    url: `/api/v1/projects/${project.id}/invitations`,
    headers: bearer("alice")
  });
  const expiredBody = expired.json();
  await db
    .update(projectInvitations)
    .set({ expiresAt: new Date(0) })
    .where(eq(projectInvitations.id, expiredBody.invitation.id));
  const expiredAccept = await app.inject({
    method: "POST",
    url: "/api/v1/project-invitations/accept",
    headers: bearer("bob"),
    payload: { token: expiredBody.token }
  });
  assert.equal(expiredAccept.statusCode, 409);

  const revoked = await app.inject({
    method: "POST",
    url: `/api/v1/projects/${project.id}/invitations`,
    headers: bearer("alice")
  });
  const revokedBody = revoked.json();
  const revoke = await app.inject({
    method: "POST",
    url: `/api/v1/projects/${project.id}/invitations/${revokedBody.invitation.id}/revoke`,
    headers: bearer("alice")
  });
  assert.equal(revoke.statusCode, 200);
  const revokedAccept = await app.inject({
    method: "POST",
    url: "/api/v1/project-invitations/accept",
    headers: bearer("bob"),
    payload: { token: revokedBody.token }
  });
  assert.equal(revokedAccept.statusCode, 409);

  const bobOwner = await app.inject({
    method: "PATCH",
    url: `/api/v1/projects/${project.id}/members/${bob.id}`,
    headers: bearer("alice"),
    payload: { role: "owner" }
  });
  assert.equal(bobOwner.statusCode, 200);
  const alice = (
    await db.select().from(users).where(eq(users.email, "alice@example.com"))
  )[0]!;
  const aliceMember = await app.inject({
    method: "PATCH",
    url: `/api/v1/projects/${project.id}/members/${alice.id}`,
    headers: bearer("alice"),
    payload: { role: "member" }
  });
  assert.equal(aliceMember.statusCode, 200);

  const removeSoleProjectOwner = await app.inject({
    method: "DELETE",
    url: `/api/v1/organizations/${organization.id}/members/${bob.id}`,
    headers: bearer("alice")
  });
  assert.equal(removeSoleProjectOwner.statusCode, 409);
  const [stillMember] = await db
    .select()
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.organizationId, organization.id),
        eq(organizationMembers.userId, bob.id)
      )
    );
  assert.ok(stillMember);

  const removedProject = (
    await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organization.id}/projects`,
      headers: bearer("alice"),
      payload: { name: "Removed member access" }
    })
  ).json();
  const addedToRemovedProject = await app.inject({
    method: "POST",
    url: `/api/v1/projects/${removedProject.id}/members`,
    headers: bearer("alice"),
    payload: { user_id: bob.id }
  });
  assert.equal(addedToRemovedProject.statusCode, 201);
  const removed = await app.inject({
    method: "DELETE",
    url: `/api/v1/projects/${removedProject.id}/members/${bob.id}`,
    headers: bearer("alice")
  });
  assert.equal(removed.statusCode, 200);

  const documentsAfterRemoval = await app.inject({
    method: "GET",
    url: `/api/v1/projects/${removedProject.id}/documents`,
    headers: bearer("bob")
  });
  assert.equal(documentsAfterRemoval.statusCode, 403);
  const realtimeAfterRemoval = await app.inject({
    method: "POST",
    url: "/api/v1/realtime/tickets",
    headers: bearer("bob"),
    payload: { project_id: removedProject.id }
  });
  assert.equal(realtimeAfterRemoval.statusCode, 403);
});
