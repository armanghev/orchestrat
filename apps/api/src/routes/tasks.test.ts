import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import type { HumanAuth } from "@orchestrat/auth";
import {
  createDatabase,
  organizationMembers,
  taskComments,
  users
} from "@orchestrat/db";
import { eq } from "drizzle-orm";
import { DataType, newDb } from "pg-mem";
import { buildApp } from "../app.js";

const bearer = (subject: string) => ({ authorization: `Bearer ${subject}` });

async function fixture() {
  const memory = newDb();
  memory.public.registerFunction({
    implementation: randomUUID,
    impure: true,
    name: "gen_random_uuid",
    returns: DataType.uuid
  });
  memory.public.registerFunction({
    args: [DataType.text],
    implementation: (value) => value.trim(),
    name: "btrim",
    returns: DataType.text
  });
  memory.public.registerFunction({
    args: [DataType.text, DataType.text, DataType.text, DataType.text],
    implementation: (value, pattern, replacement) =>
      value.replace(new RegExp(pattern, "g"), replacement),
    name: "regexp_replace",
    returns: DataType.text
  });
  memory.public.registerFunction({
    args: [DataType.text],
    implementation: (value) => value.length,
    name: "length",
    returns: DataType.integer
  });
  memory.public.registerFunction({
    args: [DataType.text, DataType.integer],
    implementation: (value, length) => value.slice(0, length),
    name: "left",
    returns: DataType.text
  });
  const adapter = memory.adapters.createPg();
  const pool = new adapter.Pool();
  const patchClient = (client: any) => {
    const query = client.query.bind(client);
    client.query = async (config: any, ...args: any[]) => {
      if (typeof config !== "object") return query(config, ...args);
      const supported = { ...config };
      const arrayMode = supported.rowMode === "array";
      delete supported.rowMode;
      delete supported.types;
      const result = await query(supported, ...args);
      return arrayMode
        ? {
            ...result,
            rows: result.rows.map((row: object) => Object.values(row))
          }
        : result;
    };
    return client;
  };
  patchClient(pool);
  const connect = pool.connect.bind(pool);
  pool.connect = (async () =>
    patchClient(await connect())) as typeof pool.connect;
  const migrations = new URL(
    "../../../../packages/db/drizzle/",
    import.meta.url
  );
  for (const name of (await readdir(migrations))
    .filter((value) => value.endsWith(".sql"))
    .sort()) {
    const migration = await readFile(new URL(name, migrations), "utf8");
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.includes("projects_task_key_prefix_format")) continue;
      if (statement.trim()) await pool.query(statement);
    }
  }
  const subjects = {
    alice: "550e8400-e29b-41d4-a716-446655440000",
    bob: "9a787b7b-84c1-4d76-83a4-0f76997e5981",
    carol: "f47ac10b-58cc-4372-a567-0e02b2c3d479"
  };
  const auth: HumanAuth = {
    async authenticate(request) {
      const value = [...(request.headers as Iterable<[string, string]>)]
        .find(([name]) => name.toLowerCase() === "authorization")?.[1]
        ?.replace(/^Bearer\s+/, "");
      const subject = value
        ? subjects[value as keyof typeof subjects]
        : undefined;
      if (!subject || !value) return null;
      return {
        authSubject: subject,
        avatarUrl: null,
        email: `${value}@example.com`,
        name: value,
        provider: "supabase",
        username: value
      };
    }
  };
  const { db } = createDatabase(
    pool as unknown as Parameters<typeof createDatabase>[0]
  );
  const app = buildApp({ allowedOrigins: [], auth, db });
  return { app, db, pool, subjects };
}

async function workspace(prefix?: string) {
  const state = await fixture();
  const { app, db, subjects } = state;
  const organization = (
    await app.inject({
      method: "POST",
      url: "/api/v1/organizations",
      headers: bearer("alice"),
      payload: { name: `Tasks ${randomUUID()}` }
    })
  ).json();
  await db
    .insert(users)
    .values({
      id: subjects.bob,
      authProvider: "supabase",
      authSubject: subjects.bob,
      name: "bob",
      email: "bob@example.com"
    })
    .onConflictDoNothing();
  await db.insert(organizationMembers).values({
    organizationId: organization.id,
    userId: subjects.bob,
    role: "member"
  });
  const project = (
    await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organization.id}/projects`,
      headers: bearer("alice"),
      payload: {
        name: `Kanban ${randomUUID()}`,
        ...(prefix ? { task_key_prefix: prefix } : {})
      }
    })
  ).json();
  return { ...state, organization, project };
}

async function code(
  response: { statusCode: number; json(): any },
  status: number,
  expected: string
) {
  assert.equal(response.statusCode, status);
  assert.equal(response.json().error.code, expected);
}

async function createTask(
  app: any,
  projectId: string,
  title: string,
  key: string,
  input: Record<string, unknown> = {}
) {
  const response = await app.inject({
    method: "POST",
    url: `/api/v1/projects/${projectId}/tasks`,
    headers: { ...bearer("bob"), "idempotency-key": key },
    payload: { title, ...input }
  });
  assert.equal(response.statusCode, 201);
  return response.json();
}

test("tasks API supports Kanban lifecycle, idempotency, comments, dependencies, and read-only archives", async () => {
  const { app, db, pool, subjects } = await fixture();
  try {
    assert.equal(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/projects/00000000-0000-4000-8000-000000000000/tasks"
        })
      ).statusCode,
      401
    );
    const organization = (
      await app.inject({
        method: "POST",
        url: "/api/v1/organizations",
        headers: bearer("alice"),
        payload: { name: "Tasks" }
      })
    ).json();
    await db
      .insert(users)
      .values({
        id: subjects.bob,
        authProvider: "supabase",
        authSubject: subjects.bob,
        name: "bob",
        email: "bob@example.com"
      })
      .onConflictDoNothing();
    await db.insert(organizationMembers).values({
      organizationId: organization.id,
      userId: subjects.bob,
      role: "member"
    });
    const project = (
      await app.inject({
        method: "POST",
        url: `/api/v1/organizations/${organization.id}/projects`,
        headers: bearer("alice"),
        payload: { name: "Kanban", task_key_prefix: "KB" }
      })
    ).json();
    const firstResponse = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/tasks`,
      headers: { ...bearer("alice"), "idempotency-key": "task-1" },
      payload: { title: "First" }
    });
    assert.equal(firstResponse.statusCode, 201);
    const first = firstResponse.json();
    assert.equal(first.key, "KB-1");
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/projects/${project.id}/tasks`,
          headers: bearer("alice"),
          payload: { title: "Missing key" }
        })
      ).json().error.code,
      "VALIDATION_ERROR"
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/projects/${project.id}/tasks`,
          headers: { ...bearer("carol"), "idempotency-key": "no-access" },
          payload: { title: "Denied" }
        })
      ).json().error.code,
      "PERMISSION_DENIED"
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/projects/${project.id}/tasks`,
          headers: { ...bearer("alice"), "idempotency-key": "task-1" },
          payload: { title: "First" }
        })
      ).json().id,
      first.id
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/projects/${project.id}/tasks`,
          headers: { ...bearer("alice"), "idempotency-key": "task-1" },
          payload: { title: "Different" }
        })
      ).json().error.code,
      "IDEMPOTENCY_CONFLICT"
    );
    const second = (
      await app.inject({
        method: "POST",
        url: `/api/v1/projects/${project.id}/tasks`,
        headers: { ...bearer("bob"), "idempotency-key": "task-2" },
        payload: { title: "Second", status: "ready" }
      })
    ).json();
    assert.equal(second.status, "ready");
    const comment = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${first.id}/comments`,
      headers: { ...bearer("bob"), "idempotency-key": "comment-1" },
      payload: { body_markdown: "hello" }
    });
    assert.equal(comment.statusCode, 201);
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/tasks/${first.id}/comments`,
          headers: { ...bearer("bob"), "idempotency-key": "comment-1" },
          payload: { body_markdown: "changed" }
        })
      ).json().error.code,
      "IDEMPOTENCY_CONFLICT"
    );
    assert.equal(
      (
        await app.inject({
          method: "GET",
          url: `/api/v1/projects/${project.id}/tasks?cursor=bad`,
          headers: bearer("bob")
        })
      ).json().error.code,
      "VALIDATION_ERROR"
    );
    assert.equal(
      (
        await app.inject({
          method: "GET",
          url: `/api/v1/tasks/${first.id}/comments?cursor=bad`,
          headers: bearer("bob")
        })
      ).json().error.code,
      "VALIDATION_ERROR"
    );
    const detail = (
      await app.inject({
        method: "GET",
        url: `/api/v1/tasks/${first.id}`,
        headers: bearer("bob")
      })
    ).json();
    assert.equal(detail.comment_count, 1);
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/tasks/${first.id}/dependencies`,
          headers: bearer("bob"),
          payload: { depends_on_task_id: second.id, expected_version: 1 }
        })
      ).statusCode,
      200
    );
    const moved = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${first.id}/move`,
      headers: bearer("bob"),
      payload: { status: "in_progress", expected_version: 2 }
    });
    assert.equal(moved.statusCode, 200);
    assert.ok(moved.json().started_at);
    assert.equal(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/v1/tasks/${first.id}`,
          headers: bearer("bob"),
          payload: { title: "Updated", expected_version: 1 }
        })
      ).json().error.code,
      "TASK_VERSION_CONFLICT"
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/tasks/${first.id}/move`,
          headers: bearer("bob"),
          payload: { status: "claimed", expected_version: 3 }
        })
      ).json().error.code,
      "VALIDATION_ERROR"
    );
    assert.equal(
      (
        await app.inject({
          method: "GET",
          url: `/api/v1/projects/${project.id}/tasks?status=in_progress&limit=1`,
          headers: bearer("bob")
        })
      ).json().tasks.length,
      1
    );
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/archive`,
      headers: bearer("alice")
    });
    assert.equal(
      (
        await app.inject({
          method: "GET",
          url: `/api/v1/projects/${project.id}/tasks`,
          headers: bearer("bob")
        })
      ).statusCode,
      200
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/projects/${project.id}/tasks`,
          headers: { ...bearer("bob"), "idempotency-key": "archived" },
          payload: { title: "Nope" }
        })
      ).json().error.code,
      "PROJECT_ARCHIVED"
    );
    for (const request of [
      {
        method: "PATCH",
        url: `/api/v1/tasks/${first.id}`,
        payload: { title: "Nope", expected_version: 3 }
      },
      {
        method: "POST",
        url: `/api/v1/tasks/${first.id}/move`,
        payload: { status: "done", expected_version: 3 }
      },
      {
        method: "POST",
        url: `/api/v1/tasks/${first.id}/comments`,
        payload: { body_markdown: "Nope" }
      },
      {
        method: "POST",
        url: `/api/v1/tasks/${first.id}/dependencies`,
        payload: { depends_on_task_id: second.id, expected_version: 3 }
      },
      {
        method: "DELETE",
        url: `/api/v1/tasks/${first.id}/dependencies/${second.id}`,
        payload: { expected_version: 3 }
      }
    ]) {
      const response = await app.inject({
        method: request.method as "PATCH" | "POST" | "DELETE",
        url: request.url,
        headers: { ...bearer("bob"), "idempotency-key": "archived-comment" },
        payload: request.payload
      });
      assert.equal(response.json().error.code, "PROJECT_ARCHIVED");
    }
    for (const url of [
      `/api/v1/tasks/${first.id}/comments/${first.id}`,
      `/api/v1/tasks/${first.id}/claim`,
      `/api/v1/tasks/${first.id}`
    ]) {
      const response = await app.inject({
        method: url.endsWith(first.id) ? "DELETE" : "PATCH",
        url,
        headers: bearer("bob"),
        payload: {}
      });
      assert.equal(response.statusCode, 404);
    }
    assert.equal(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/v1/tasks/${first.id}`,
          headers: bearer("bob")
        })
      ).statusCode,
      404
    );
  } finally {
    await app.close();
    await pool.end();
  }
});

test("task keys use custom, derived, and PRJ prefixes", async () => {
  const custom = await workspace("ops");
  const derived = await workspace();
  const fallback = await workspace("PRJ");
  try {
    assert.equal(
      (await createTask(custom.app, custom.project.id, "Custom", "custom")).key,
      "OPS-1"
    );
    assert.match(
      (await createTask(derived.app, derived.project.id, "Derived", "derived"))
        .key,
      /^[A-Z0-9]{2,3}-1$/
    );
    assert.equal(
      (
        await createTask(
          fallback.app,
          fallback.project.id,
          "Fallback",
          "fallback"
        )
      ).key,
      "PRJ-1"
    );
  } finally {
    await Promise.all([
      custom.app.close(),
      derived.app.close(),
      fallback.app.close()
    ]);
    await Promise.all([
      custom.pool.end(),
      derived.pool.end(),
      fallback.pool.end()
    ]);
  }
});

test("task reads require membership and list exposes cursor, filters, totals, and card counts", async () => {
  const { app, project, pool, subjects } = await workspace("QA");
  try {
    await code(
      await app.inject({
        method: "GET",
        url: `/api/v1/projects/${project.id}/tasks`,
        headers: bearer("carol")
      }),
      403,
      "PERMISSION_DENIED"
    );
    const first = await createTask(app, project.id, "Urgent", "list-1", {
      priority: "urgent"
    });
    await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${first.id}/comments`,
      headers: { ...bearer("bob"), "idempotency-key": "list-comment" },
      payload: { body_markdown: "card" }
    });
    await createTask(app, project.id, "Low", "list-2", { priority: "low" });
    const page = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${project.id}/tasks?limit=1&priority=urgent`,
      headers: bearer("bob")
    });
    assert.equal(page.statusCode, 200);
    assert.equal(page.json().total, 1);
    assert.equal(page.json().tasks[0].comment_count, 1);
    assert.equal(page.json().next_cursor, null);
    const all = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${project.id}/tasks?limit=1`,
      headers: bearer("bob")
    });
    assert.equal(all.json().total, 2);
    assert.ok(all.json().next_cursor);
    const second = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${project.id}/tasks?limit=1&cursor=${all.json().next_cursor}`,
      headers: bearer("bob")
    });
    assert.equal(second.statusCode, 200);
    assert.equal(second.json().tasks.length, 1);
    assert.notEqual(second.json().tasks[0].id, all.json().tasks[0].id);
    assert.equal(subjects.alice, "550e8400-e29b-41d4-a716-446655440000");
  } finally {
    await app.close();
    await pool.end();
  }
});

test("task lifecycle sets and clears timestamps and supports anchored moves", async () => {
  const { app, project, pool } = await workspace("MOVE");
  try {
    const first = await createTask(app, project.id, "First", "move-1");
    const second = await createTask(app, project.id, "Second", "move-2");
    const third = await createTask(app, project.id, "Third", "move-3", {
      status: "ready"
    });
    let response = await app.inject({
      method: "PATCH",
      url: `/api/v1/tasks/${first.id}`,
      headers: bearer("bob"),
      payload: { title: "Renamed", expected_version: 1 }
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().title, "Renamed");
    response = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${first.id}/move`,
      headers: bearer("bob"),
      payload: { status: "in_progress", expected_version: 2 }
    });
    assert.ok(response.json().started_at);
    response = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${first.id}/move`,
      headers: bearer("bob"),
      payload: { status: "done", expected_version: 3 }
    });
    assert.ok(response.json().completed_at);
    assert.equal(response.json().started_at, null);
    response = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${first.id}/move`,
      headers: bearer("bob"),
      payload: { status: "backlog", expected_version: 4 }
    });
    assert.equal(response.json().completed_at, null);
    response = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${second.id}/move`,
      headers: bearer("bob"),
      payload: {
        status: "ready",
        before_task_id: third.id,
        expected_version: 1
      }
    });
    assert.equal(response.statusCode, 200);
    const ready = (
      await app.inject({
        method: "GET",
        url: `/api/v1/projects/${project.id}/tasks?status=ready`,
        headers: bearer("bob")
      })
    ).json().tasks;
    assert.deepEqual(
      ready.map((task: any) => task.id),
      [second.id, third.id]
    );
    await code(
      await app.inject({
        method: "POST",
        url: `/api/v1/tasks/${second.id}/move`,
        headers: bearer("bob"),
        payload: { status: "claimed", expected_version: 2 }
      }),
      400,
      "VALIDATION_ERROR"
    );
  } finally {
    await app.close();
    await pool.end();
  }
});

test("comments paginate chronologically and idempotency replays the same payload", async () => {
  const { app, project, pool, db } = await workspace("COM");
  try {
    const task = await createTask(app, project.id, "Comments", "comments");
    const one = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${task.id}/comments`,
      headers: { ...bearer("bob"), "idempotency-key": "comment-replay" },
      payload: { body_markdown: "one" }
    });
    const replay = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${task.id}/comments`,
      headers: { ...bearer("bob"), "idempotency-key": "comment-replay" },
      payload: { body_markdown: "one" }
    });
    assert.equal(replay.statusCode, 201);
    assert.equal(replay.json().id, one.json().id);
    const second = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${task.id}/comments`,
      headers: { ...bearer("bob"), "idempotency-key": "comment-two" },
      payload: { body_markdown: "two" }
    });
    const tie = new Date("2026-01-01T00:00:00.000Z");
    await db
      .update(taskComments)
      .set({ createdAt: tie })
      .where(eq(taskComments.id, one.json().id));
    await db
      .update(taskComments)
      .set({ createdAt: tie })
      .where(eq(taskComments.id, second.json().id));
    const page = await app.inject({
      method: "GET",
      url: `/api/v1/tasks/${task.id}/comments?limit=1`,
      headers: bearer("bob")
    });
    assert.equal(page.json().comments.length, 1);
    assert.ok(page.json().next_cursor);
    const next = await app.inject({
      method: "GET",
      url: `/api/v1/tasks/${task.id}/comments?limit=1&cursor=${page.json().next_cursor}`,
      headers: bearer("bob")
    });
    assert.equal(next.json().comments.length, 1);
    assert.notEqual(next.json().comments[0].id, page.json().comments[0].id);
    await code(
      await app.inject({
        method: "POST",
        url: `/api/v1/tasks/${task.id}/comments`,
        headers: { ...bearer("bob"), "idempotency-key": "comment-replay" },
        payload: { body_markdown: "changed" }
      }),
      409,
      "IDEMPOTENCY_CONFLICT"
    );
  } finally {
    await app.close();
    await pool.end();
  }
});

test("dependencies reject self, cross-project, multi-edge cycles, and stale deletes", async () => {
  const left = await workspace("DEP");
  try {
    const a = await createTask(left.app, left.project.id, "A", "dep-a");
    const b = await createTask(left.app, left.project.id, "B", "dep-b");
    const c = await createTask(left.app, left.project.id, "C", "dep-c");
    const outsideProject = (
      await left.app.inject({
        method: "POST",
        url: `/api/v1/organizations/${left.organization.id}/projects`,
        headers: bearer("alice"),
        payload: { name: `Other ${randomUUID()}`, task_key_prefix: "OUT" }
      })
    ).json();
    const outside = await createTask(
      left.app,
      outsideProject.id,
      "Outside",
      "dep-out"
    );
    await code(
      await left.app.inject({
        method: "POST",
        url: `/api/v1/tasks/${a.id}/dependencies`,
        headers: bearer("bob"),
        payload: { depends_on_task_id: a.id, expected_version: 1 }
      }),
      409,
      "TASK_DEPENDENCY_CYCLE"
    );
    await code(
      await left.app.inject({
        method: "POST",
        url: `/api/v1/tasks/${a.id}/dependencies`,
        headers: bearer("bob"),
        payload: { depends_on_task_id: outside.id, expected_version: 1 }
      }),
      400,
      "VALIDATION_ERROR"
    );
    await left.app.inject({
      method: "POST",
      url: `/api/v1/tasks/${a.id}/dependencies`,
      headers: bearer("bob"),
      payload: { depends_on_task_id: b.id, expected_version: 1 }
    });
    await left.app.inject({
      method: "POST",
      url: `/api/v1/tasks/${b.id}/dependencies`,
      headers: bearer("bob"),
      payload: { depends_on_task_id: c.id, expected_version: 1 }
    });
    await code(
      await left.app.inject({
        method: "POST",
        url: `/api/v1/tasks/${c.id}/dependencies`,
        headers: bearer("bob"),
        payload: { depends_on_task_id: a.id, expected_version: 1 }
      }),
      409,
      "TASK_DEPENDENCY_CYCLE"
    );
    const duplicate = await left.app.inject({
      method: "POST",
      url: `/api/v1/tasks/${a.id}/dependencies`,
      headers: bearer("bob"),
      payload: { depends_on_task_id: b.id, expected_version: 2 }
    });
    assert.equal(duplicate.statusCode, 200);
    assert.equal(duplicate.json().version, 2);
    const duplicateWithStaleVersion = await left.app.inject({
      method: "POST",
      url: `/api/v1/tasks/${a.id}/dependencies`,
      headers: bearer("bob"),
      payload: { depends_on_task_id: b.id, expected_version: 1 }
    });
    assert.equal(duplicateWithStaleVersion.statusCode, 200);
    assert.equal(duplicateWithStaleVersion.json().version, 2);
    const missing = await left.app.inject({
      method: "DELETE",
      url: `/api/v1/tasks/${a.id}/dependencies/${c.id}`,
      headers: bearer("bob"),
      payload: { expected_version: 99 }
    });
    assert.equal(missing.statusCode, 200);
    assert.equal(missing.json().version, 2);
    await code(
      await left.app.inject({
        method: "DELETE",
        url: `/api/v1/tasks/${a.id}/dependencies/${b.id}`,
        headers: bearer("bob"),
        payload: { expected_version: 1 }
      }),
      409,
      "TASK_VERSION_CONFLICT"
    );
  } finally {
    await left.app.close();
    await left.pool.end();
  }
});

test("unresolved blockers remain for cancelled tasks and clear when done", async () => {
  const { app, project, pool } = await workspace("BLOCK");
  try {
    const blocker = await createTask(app, project.id, "Blocker", "blocker");
    const blocked = await createTask(app, project.id, "Blocked", "blocked");
    await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${blocked.id}/dependencies`,
      headers: bearer("bob"),
      payload: { depends_on_task_id: blocker.id, expected_version: 1 }
    });
    assert.equal(
      (
        await app.inject({
          method: "GET",
          url: `/api/v1/tasks/${blocked.id}`,
          headers: bearer("bob")
        })
      ).json().unresolved_blocker_count,
      1
    );
    await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${blocker.id}/move`,
      headers: bearer("bob"),
      payload: { status: "cancelled", expected_version: 1 }
    });
    assert.equal(
      (
        await app.inject({
          method: "GET",
          url: `/api/v1/tasks/${blocked.id}`,
          headers: bearer("bob")
        })
      ).json().unresolved_blocker_count,
      1
    );
    await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${blocker.id}/move`,
      headers: bearer("bob"),
      payload: { status: "done", expected_version: 2 }
    });
    assert.equal(
      (
        await app.inject({
          method: "GET",
          url: `/api/v1/tasks/${blocked.id}`,
          headers: bearer("bob")
        })
      ).json().unresolved_blocker_count,
      0
    );
  } finally {
    await app.close();
    await pool.end();
  }
});
