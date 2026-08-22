import { createHash, randomUUID } from "node:crypto";
import {
  apiIdempotencyKeys,
  projects,
  taskComments,
  taskDependencies,
  tasks,
  users,
  type Database
} from "@orchestrat/db";
import type {
  CreateTaskCommentRequest,
  CreateTaskDependencyRequest,
  CreateTaskRequest,
  MoveTaskRequest,
  TaskListQuery,
  UpdateTaskRequest
} from "@orchestrat/protocol";
import { idempotencyKeySchema } from "@orchestrat/protocol";
import { and, asc, count, eq, gt, inArray, or, sql } from "drizzle-orm";
import { ApiError } from "./api-error.js";
import { PermissionService } from "./permission-service.js";

const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const encode = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");
const cursorError = () =>
  new ApiError(400, "VALIDATION_ERROR", "The cursor is invalid.");
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const decodeTaskCursor = (value: string) => {
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8")
    ) as { position?: unknown; id?: unknown };
    if (
      typeof parsed.position !== "number" ||
      !Number.isInteger(parsed.position) ||
      parsed.position < 0 ||
      typeof parsed.id !== "string" ||
      !uuidPattern.test(parsed.id)
    )
      throw cursorError();
    return { position: parsed.position, id: parsed.id };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw cursorError();
  }
};
const decodeCommentCursor = (value: string) => {
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8")
    ) as { position?: unknown; id?: unknown };
    if (
      typeof parsed.position !== "string" ||
      Number.isNaN(Date.parse(parsed.position)) ||
      typeof parsed.id !== "string" ||
      !uuidPattern.test(parsed.id)
    )
      throw cursorError();
    return { position: parsed.position, id: parsed.id };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw cursorError();
  }
};
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

const taskJson = (task: typeof tasks.$inferSelect) => ({
  id: task.id,
  project_id: task.projectId,
  key: task.taskKey,
  title: task.title,
  description: task.description,
  priority: task.priority,
  status: task.status,
  position: task.position,
  version: task.version,
  created_by_user_id: task.createdByUserId,
  created_at: task.createdAt.toISOString(),
  updated_at: task.updatedAt.toISOString(),
  started_at: task.startedAt?.toISOString() ?? null,
  completed_at: task.completedAt?.toISOString() ?? null,
  cancelled_at: task.cancelledAt?.toISOString() ?? null
});

export class TaskService {
  private readonly permissions: PermissionService;
  constructor(private readonly db: Database) {
    this.permissions = new PermissionService(db);
  }

  private async access(userId: string, projectId: string, write = false) {
    const record = await this.permissions.projectAccess(userId, projectId);
    if (write && record.project.status === "archived")
      throw new ApiError(
        409,
        "PROJECT_ARCHIVED",
        "Archived projects are read-only."
      );
    return record.project;
  }

  private async taskAccess(userId: string, id: string, write = false) {
    const [task] = await this.db
      .select()
      .from(tasks)
      .where(eq(tasks.id, id))
      .limit(1);
    if (!task) throw new ApiError(404, "NOT_FOUND", "Task not found.");
    await this.access(userId, task.projectId, write);
    return task;
  }

  private async lockActiveProject(tx: Transaction, projectId: string) {
    const [project] = await tx
      .select()
      .from(projects)
      .where(eq(projects.id, projectId))
      .for("update");
    if (!project) throw new ApiError(404, "NOT_FOUND", "Project not found.");
    if (project.status === "archived")
      throw new ApiError(
        409,
        "PROJECT_ARCHIVED",
        "Archived projects are read-only."
      );
    return project;
  }

  async create(
    userId: string,
    projectId: string,
    input: CreateTaskRequest,
    key?: string
  ) {
    await this.access(userId, projectId, true);
    const idempotencyKey = idempotencyKeySchema.parse(key);
    const requestHash = hash(input);
    return this.db.transaction(async (tx) => {
      await this.lockActiveProject(tx, projectId);
      const [reserved] = await tx
        .insert(apiIdempotencyKeys)
        .values({
          userId,
          operation: "create_task",
          resourceId: projectId,
          idempotencyKey,
          requestHash,
          responseStatus: 0,
          responseBody: {}
        })
        .onConflictDoNothing()
        .returning();
      if (!reserved) {
        const [existing] = await tx
          .select()
          .from(apiIdempotencyKeys)
          .where(
            and(
              eq(apiIdempotencyKeys.userId, userId),
              eq(apiIdempotencyKeys.operation, "create_task"),
              eq(apiIdempotencyKeys.resourceId, projectId),
              eq(apiIdempotencyKeys.idempotencyKey, idempotencyKey)
            )
          );
        if (!existing || existing.requestHash !== requestHash)
          throw new ApiError(
            409,
            "IDEMPOTENCY_CONFLICT",
            "The idempotency key was already used with a different request."
          );
        return { status: existing.responseStatus, body: existing.responseBody };
      }
      const body = await (async () => {
        const [counter] = await tx
          .update(projects)
          .set({
            taskCounter: sql`${projects.taskCounter} + 1`,
            updatedAt: new Date()
          })
          .where(and(eq(projects.id, projectId), eq(projects.status, "active")))
          .returning({
            next: projects.taskCounter,
            prefix: projects.taskKeyPrefix
          });
        if (!counter)
          throw new ApiError(404, "NOT_FOUND", "Project not found.");
        const number = counter.next - 1;
        const [position] = await tx
          .select({ value: count() })
          .from(tasks)
          .where(
            and(
              eq(tasks.projectId, projectId),
              eq(tasks.status, input.status ?? "backlog")
            )
          );
        const [task] = await tx
          .insert(tasks)
          .values({
            id: randomUUID(),
            projectId,
            taskKey: `${counter.prefix}-${number}`,
            taskNumber: number,
            title: input.title,
            description: input.description ?? null,
            priority: input.priority ?? "none",
            status: input.status ?? "backlog",
            position: Number(position?.value ?? 0),
            createdByUserId: userId
          })
          .returning();
        return taskJson(task);
      })();
      await tx
        .update(apiIdempotencyKeys)
        .set({ responseStatus: 201, responseBody: body })
        .where(eq(apiIdempotencyKeys.id, reserved.id));
      return { status: 201, body };
    });
  }

  async list(userId: string, projectId: string, query: TaskListQuery) {
    await this.access(userId, projectId);
    const clauses = [eq(tasks.projectId, projectId)];
    if (query.status) clauses.push(eq(tasks.status, query.status));
    if (query.priority) clauses.push(eq(tasks.priority, query.priority));
    if (query.cursor) {
      const c = decodeTaskCursor(query.cursor);
      clauses.push(
        or(
          gt(tasks.position, c.position),
          and(eq(tasks.position, c.position), gt(tasks.id, c.id))
        )!
      );
    }
    const rows = await this.db
      .select()
      .from(tasks)
      .where(and(...clauses))
      .orderBy(asc(tasks.position), asc(tasks.id))
      .limit(query.limit + 1);
    const all = await this.db
      .select({ value: count() })
      .from(tasks)
      .where(
        and(
          eq(tasks.projectId, projectId),
          ...(query.status ? [eq(tasks.status, query.status)] : []),
          ...(query.priority ? [eq(tasks.priority, query.priority)] : [])
        )
      );
    const page = rows.slice(0, query.limit);
    const cards = await Promise.all(
      page.map(async (task) => {
        const [comments] = await this.db
          .select({ value: count() })
          .from(taskComments)
          .where(eq(taskComments.taskId, task.id));
        const [blockers] = await this.db
          .select({ value: count() })
          .from(taskDependencies)
          .innerJoin(tasks, eq(tasks.id, taskDependencies.dependsOnTaskId))
          .where(
            and(
              eq(taskDependencies.taskId, task.id),
              sql`${tasks.status} <> 'done'`
            )
          );
        return {
          ...taskJson(task),
          comment_count: Number(comments?.value ?? 0),
          unresolved_blocker_count: Number(blockers?.value ?? 0)
        };
      })
    );
    return {
      tasks: cards,
      total: Number(all[0]?.value ?? 0),
      next_cursor:
        rows.length > query.limit
          ? encode({ position: page.at(-1)!.position, id: page.at(-1)!.id })
          : null
    };
  }

  async get(userId: string, id: string) {
    const task = await this.taskAccess(userId, id);
    const [comments] = await this.db
      .select({ value: count() })
      .from(taskComments)
      .where(eq(taskComments.taskId, id));
    const [blockers] = await this.db
      .select({ value: count() })
      .from(taskDependencies)
      .innerJoin(tasks, eq(tasks.id, taskDependencies.dependsOnTaskId))
      .where(
        and(eq(taskDependencies.taskId, id), sql`${tasks.status} <> 'done'`)
      );
    return {
      ...taskJson(task),
      comment_count: Number(comments?.value ?? 0),
      unresolved_blocker_count: Number(blockers?.value ?? 0)
    };
  }

  async update(userId: string, id: string, input: UpdateTaskRequest) {
    const authorized = await this.taskAccess(userId, id, true);
    return this.db.transaction(async (tx) => {
      await this.lockActiveProject(tx, authorized.projectId);
      const [current] = await tx
        .select()
        .from(tasks)
        .where(eq(tasks.id, id))
        .for("update");
      if (!current || current.version !== input.expected_version)
        throw new ApiError(
          409,
          "TASK_VERSION_CONFLICT",
          "Task version is stale.",
          { current_version: current?.version }
        );
      const [task] = await tx
        .update(tasks)
        .set({
          title: input.title ?? current.title,
          description:
            input.description === undefined
              ? current.description
              : input.description,
          priority: input.priority ?? current.priority,
          version: current.version + 1,
          updatedAt: new Date()
        })
        .where(and(eq(tasks.id, id), eq(tasks.version, input.expected_version)))
        .returning();
      if (!task)
        throw new ApiError(
          409,
          "TASK_VERSION_CONFLICT",
          "Task version is stale."
        );
      return taskJson(task);
    });
  }

  async move(userId: string, id: string, input: MoveTaskRequest) {
    const authorized = await this.taskAccess(userId, id, true);
    return this.db.transaction(async (tx) => {
      // ponytail: project-row serialization is sufficient at current volume; use per-column/advisory locks if throughput matters.
      await this.lockActiveProject(tx, authorized.projectId);
      const [locked] = await tx
        .select()
        .from(tasks)
        .where(eq(tasks.id, id))
        .for("update");
      if (!locked || locked.version !== input.expected_version)
        throw new ApiError(
          409,
          "TASK_VERSION_CONFLICT",
          "Task version is stale.",
          { current_version: locked?.version }
        );
      const statuses = [locked.status, input.status].sort();
      const lockedColumns = await tx
        .select()
        .from(tasks)
        .where(
          and(
            eq(tasks.projectId, locked.projectId),
            inArray(tasks.status, statuses)
          )
        )
        .orderBy(asc(tasks.status), asc(tasks.position), asc(tasks.id))
        .for("update");
      const source = lockedColumns.filter(
        (task) => task.status === locked.status
      );
      const target =
        locked.status === input.status
          ? source
          : lockedColumns.filter((task) => task.status === input.status);
      const next = source.filter((task) => task.id !== id);
      const destination =
        locked.status === input.status
          ? next
          : target.filter((task) => task.id !== id);
      let index = destination.length;
      if (input.before_task_id) {
        index = destination.findIndex(
          (task) => task.id === input.before_task_id
        );
        if (index < 0)
          throw new ApiError(
            400,
            "VALIDATION_ERROR",
            "The anchor task is not in the target column."
          );
      }
      destination.splice(index, 0, locked);
      const now = new Date();
      const timestamp = {
        startedAt:
          input.status === "in_progress"
            ? locked.status === "in_progress"
              ? locked.startedAt
              : now
            : null,
        completedAt:
          input.status === "done"
            ? locked.status === "done"
              ? locked.completedAt
              : now
            : null,
        cancelledAt:
          input.status === "cancelled"
            ? locked.status === "cancelled"
              ? locked.cancelledAt
              : now
            : null
      };
      for (const [position, task] of destination.entries())
        await tx
          .update(tasks)
          .set({
            position,
            ...(task.id === id
              ? {
                  status: input.status,
                  version: locked.version + 1,
                  updatedAt: now,
                  ...timestamp
                }
              : {})
          })
          .where(eq(tasks.id, task.id));
      if (locked.status !== input.status)
        for (const [position, task] of next.entries())
          await tx.update(tasks).set({ position }).where(eq(tasks.id, task.id));
      const [moved] = await tx.select().from(tasks).where(eq(tasks.id, id));
      return taskJson(moved);
    });
  }

  async comments(userId: string, id: string, limit: number, cursor?: string) {
    await this.taskAccess(userId, id);
    const clauses = [eq(taskComments.taskId, id)];
    if (cursor) {
      const c = decodeCommentCursor(cursor);
      clauses.push(
        or(
          gt(taskComments.createdAt, new Date(c.position)),
          and(
            eq(taskComments.createdAt, new Date(c.position)),
            gt(taskComments.id, c.id)
          )
        )!
      );
    }
    const rows = await this.db
      .select({ comment: taskComments, user: users })
      .from(taskComments)
      .innerJoin(users, eq(users.id, taskComments.authorUserId))
      .where(and(...clauses))
      .orderBy(asc(taskComments.createdAt), asc(taskComments.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    return {
      comments: page.map(({ comment, user }) => ({
        id: comment.id,
        task_id: comment.taskId,
        author: {
          user_id: user.id,
          username: user.username,
          full_name: user.name,
          avatar_url: user.avatarUrl
        },
        body_markdown: comment.bodyMarkdown,
        created_at: comment.createdAt.toISOString()
      })),
      next_cursor:
        rows.length > limit
          ? encode({
              position: page.at(-1)!.comment.createdAt.toISOString(),
              id: page.at(-1)!.comment.id
            })
          : null
    };
  }

  async createComment(
    userId: string,
    id: string,
    input: CreateTaskCommentRequest,
    key?: string
  ) {
    const authorized = await this.taskAccess(userId, id, true);
    const idempotencyKey = idempotencyKeySchema.parse(key);
    const requestHash = hash(input);
    return this.db.transaction(async (tx) => {
      await this.lockActiveProject(tx, authorized.projectId);
      const [task] = await tx
        .select()
        .from(tasks)
        .where(eq(tasks.id, id))
        .for("update");
      if (!task) throw new ApiError(404, "NOT_FOUND", "Task not found.");
      const [reserved] = await tx
        .insert(apiIdempotencyKeys)
        .values({
          userId,
          operation: "create_task_comment",
          resourceId: id,
          idempotencyKey,
          requestHash,
          responseStatus: 0,
          responseBody: {}
        })
        .onConflictDoNothing()
        .returning();
      if (!reserved) {
        const [existing] = await tx
          .select()
          .from(apiIdempotencyKeys)
          .where(
            and(
              eq(apiIdempotencyKeys.userId, userId),
              eq(apiIdempotencyKeys.operation, "create_task_comment"),
              eq(apiIdempotencyKeys.resourceId, id),
              eq(apiIdempotencyKeys.idempotencyKey, idempotencyKey)
            )
          );
        if (!existing || existing.requestHash !== requestHash)
          throw new ApiError(
            409,
            "IDEMPOTENCY_CONFLICT",
            "The idempotency key was already used with a different request."
          );
        return { status: existing.responseStatus, body: existing.responseBody };
      }
      const [comment] = await tx
        .insert(taskComments)
        .values({
          id: randomUUID(),
          taskId: id,
          authorUserId: userId,
          bodyMarkdown: input.body_markdown
        })
        .returning();
      const [record] = await tx
        .select({ comment: taskComments, user: users })
        .from(taskComments)
        .innerJoin(users, eq(users.id, taskComments.authorUserId))
        .where(eq(taskComments.id, comment.id));
      const body = {
        id: record.comment.id,
        task_id: record.comment.taskId,
        author: {
          user_id: record.user.id,
          username: record.user.username,
          full_name: record.user.name,
          avatar_url: record.user.avatarUrl
        },
        body_markdown: record.comment.bodyMarkdown,
        created_at: record.comment.createdAt.toISOString()
      };
      await tx
        .update(apiIdempotencyKeys)
        .set({ responseStatus: 201, responseBody: body })
        .where(eq(apiIdempotencyKeys.id, reserved.id));
      return { status: 201, body };
    });
  }

  async dependencies(userId: string, id: string) {
    await this.taskAccess(userId, id);
    const [outgoing, incoming] = await Promise.all([
      this.db
        .select({ task: tasks })
        .from(taskDependencies)
        .innerJoin(tasks, eq(tasks.id, taskDependencies.dependsOnTaskId))
        .where(eq(taskDependencies.taskId, id)),
      this.db
        .select({ task: tasks })
        .from(taskDependencies)
        .innerJoin(tasks, eq(tasks.id, taskDependencies.taskId))
        .where(eq(taskDependencies.dependsOnTaskId, id))
    ]);
    return {
      depends_on: outgoing.map(({ task: value }) => taskJson(value)),
      blocks: incoming.map(({ task: value }) => taskJson(value))
    };
  }

  async addDependency(
    userId: string,
    id: string,
    input: CreateTaskDependencyRequest
  ) {
    const task = await this.taskAccess(userId, id, true);
    const blocker = await this.taskAccess(
      userId,
      input.depends_on_task_id,
      true
    );
    if (task.projectId !== blocker.projectId)
      throw new ApiError(
        400,
        "VALIDATION_ERROR",
        "Dependencies must stay within a project."
      );
    if (id === blocker.id)
      throw new ApiError(
        409,
        "TASK_DEPENDENCY_CYCLE",
        "A task cannot block itself."
      );
    return this.db.transaction(async (tx) => {
      // ponytail: project-row serialization makes graph validation atomic; use advisory locks if dependency throughput matters.
      await this.lockActiveProject(tx, task.projectId);
      const [current] = await tx
        .select()
        .from(tasks)
        .where(eq(tasks.id, id))
        .for("update");
      if (!current) throw new ApiError(404, "NOT_FOUND", "Task not found.");
      const [currentBlocker] = await tx
        .select()
        .from(tasks)
        .where(eq(tasks.id, blocker.id))
        .for("update");
      if (!currentBlocker)
        throw new ApiError(404, "NOT_FOUND", "Task not found.");
      const [existing] = await tx
        .select()
        .from(taskDependencies)
        .where(
          and(
            eq(taskDependencies.taskId, id),
            eq(taskDependencies.dependsOnTaskId, blocker.id)
          )
        )
        .limit(1);
      // Duplicate adds are idempotent no-ops, so expected_version is intentionally not enforced.
      if (existing) return taskJson(task);
      const edges = await tx
        .select()
        .from(taskDependencies)
        .where(eq(taskDependencies.projectId, task.projectId));
      const graph = new Map<string, string[]>();
      for (const edge of edges)
        graph.set(edge.taskId, [
          ...(graph.get(edge.taskId) ?? []),
          edge.dependsOnTaskId
        ]);
      const seen = new Set<string>();
      const visit = (value: string): boolean => {
        if (value === id) return true;
        if (seen.has(value)) return false;
        seen.add(value);
        return (graph.get(value) ?? []).some(visit);
      };
      if (visit(blocker.id))
        throw new ApiError(
          409,
          "TASK_DEPENDENCY_CYCLE",
          "The dependency would create a cycle."
        );
      const [updated] = await tx
        .update(tasks)
        .set({ version: current.version + 1, updatedAt: new Date() })
        .where(and(eq(tasks.id, id), eq(tasks.version, input.expected_version)))
        .returning();
      if (!updated)
        throw new ApiError(
          409,
          "TASK_VERSION_CONFLICT",
          "Task version is stale."
        );
      await tx.insert(taskDependencies).values({
        projectId: task.projectId,
        taskId: id,
        dependsOnTaskId: blocker.id
      });
      return taskJson(updated);
    });
  }

  async removeDependency(
    userId: string,
    id: string,
    dependsOnTaskId: string,
    expectedVersion: number
  ) {
    const task = await this.taskAccess(userId, id, true);
    return this.db.transaction(async (tx) => {
      await this.lockActiveProject(tx, task.projectId);
      const [current] = await tx
        .select()
        .from(tasks)
        .where(eq(tasks.id, id))
        .for("update");
      if (!current) throw new ApiError(404, "NOT_FOUND", "Task not found.");
      const [edge] = await tx
        .select()
        .from(taskDependencies)
        .where(
          and(
            eq(taskDependencies.taskId, id),
            eq(taskDependencies.dependsOnTaskId, dependsOnTaskId)
          )
        )
        .limit(1);
      // Removing a missing edge is an idempotent no-op, so expectedVersion is intentionally not enforced.
      if (!edge) return taskJson(task);
      const [updated] = await tx
        .update(tasks)
        .set({ version: current.version + 1, updatedAt: new Date() })
        .where(and(eq(tasks.id, id), eq(tasks.version, expectedVersion)))
        .returning();
      if (!updated)
        throw new ApiError(
          409,
          "TASK_VERSION_CONFLICT",
          "Task version is stale."
        );
      await tx
        .delete(taskDependencies)
        .where(
          and(
            eq(taskDependencies.taskId, id),
            eq(taskDependencies.dependsOnTaskId, dependsOnTaskId)
          )
        );
      return taskJson(updated);
    });
  }
}
