import { createHash, randomUUID } from "node:crypto";
import {
  apiIdempotencyKeys,
  agents,
  projects,
  taskComments,
  taskDependencies,
  tasks,
  users,
  type Database
} from "@orchestrat/db";
import type {
  AgentBulkCreateTasksRequest,
  AgentBulkUpdateTasksRequest,
  AgentUpdateTaskRequest,
  CreateTaskCommentRequest,
  CreateTaskDependencyRequest,
  CreateTaskRequest,
  HumanTaskStatus,
  MoveTaskRequest,
  TaskListQuery,
  UpdateTaskRequest
} from "@orchestrat/protocol";
import type { AgentPrincipal } from "./agent-service.js";
import { idempotencyKeySchema } from "@orchestrat/protocol";
import { and, asc, count, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { ApiError } from "./api-error.js";
import { assertCommentsAcknowledged } from "./attention-guard.js";
import {
  assertEntityBranch,
  resolveBranch,
  type BranchSelector
} from "./branch-context.js";
import { insertProjectEvent } from "./agent-service.js";
import {
  nextCommentSequence,
  onTaskCommentCreated,
  onTaskCreated,
  resolveCommentMentions
} from "./attention-hooks.js";
import { PermissionService } from "./permission-service.js";
import {
  activeClaim,
  hasActiveClaim,
  onTaskMoved,
  resolveBlocksOnParticipantResponse
} from "./task-block-hooks.js";
import { TaskClaimService } from "./task-claim-service.js";

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
  branch_id: task.branchId,
  key: task.taskKey,
  title: task.title,
  description: task.description,
  priority: task.priority,
  status: task.status,
  position: task.position,
  version: task.version,
  created_by: {
    type: task.createdByType,
    id: task.createdByUserId ?? task.createdByAgentId!
  },
  created_by_user_id: task.createdByUserId,
  created_at: task.createdAt.toISOString(),
  updated_at: task.updatedAt.toISOString(),
  started_at: task.startedAt?.toISOString() ?? null,
  completed_at: task.completedAt?.toISOString() ?? null,
  cancelled_at: task.cancelledAt?.toISOString() ?? null
});
type Actor = { type: "human"; id: string } | { type: "agent"; id: string };
const agentIdOf = (actor: Actor) =>
  actor.type === "agent" ? actor.id : undefined;
const actorValues = (actor: Actor) => ({
  userId: actor.type === "human" ? actor.id : null,
  agentId: actor.type === "agent" ? actor.id : null
});
const eventActor = (actor: Actor) => ({
  actorUserId: actor.type === "human" ? actor.id : null,
  actorAgentId: actor.type === "agent" ? actor.id : null
});
// task.updated lists the request's keys; status and acknowledgements are not
// field edits (a move records its own task.moved).
const updatedFieldNames = (input: object) =>
  Object.keys(input).filter(
    (key) => key !== "status" && key !== "acknowledged_through"
  );
const actorClause = (actor: Actor) =>
  actor.type === "human"
    ? and(
        eq(apiIdempotencyKeys.userId, actor.id),
        isNull(apiIdempotencyKeys.agentId)
      )!
    : and(
        eq(apiIdempotencyKeys.agentId, actor.id),
        isNull(apiIdempotencyKeys.userId)
      )!;

// Bulk operations re-raise an item's error with its index, so the caller can
// tell which item rolled the batch back. The code stays the single-item one.
const bulkItem = async <T>(
  index: number,
  identity: { task_id?: string; title?: string },
  run: () => Promise<T>
) => {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    throw new ApiError(
      error.statusCode,
      error.code,
      `tasks[${index}]: ${error.message}`,
      { ...error.details, index, ...identity }
    );
  }
};
type TaskFields = Pick<UpdateTaskRequest, "title" | "description" | "priority">;
type CheckedEdit = {
  current: typeof tasks.$inferSelect;
  move: HumanTaskStatus | undefined;
};
const editedFields = (input: TaskFields) =>
  input.title !== undefined ||
  input.description !== undefined ||
  input.priority !== undefined;

export class TaskService {
  private readonly permissions: PermissionService;
  private readonly claims: TaskClaimService;
  constructor(private readonly db: Database) {
    this.permissions = new PermissionService(db);
    this.claims = new TaskClaimService(db);
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

  // Runs a task-creating operation once per (actor, operation, branch, key).
  // A replay with the same body returns the stored response; a different body
  // conflicts. The reservation rolls back with the transaction on failure.
  private async createIdempotent(
    actor: Actor,
    projectId: string,
    operation: "create_task" | "create_tasks",
    input: unknown,
    key: string | undefined,
    selector: BranchSelector | undefined,
    run: (tx: Transaction, branchId: string) => Promise<unknown>
  ) {
    const idempotencyKey = idempotencyKeySchema.parse(key);
    const requestHash = hash(input);
    const conflict = () =>
      new ApiError(
        409,
        "IDEMPOTENCY_CONFLICT",
        "The idempotency key was already used with a different request."
      );
    return this.db.transaction(async (tx) => {
      await this.lockActiveProject(tx, projectId);
      const branch = await resolveBranch(tx, projectId, selector, {
        write: true,
        agentId: agentIdOf(actor)
      });
      // Keys are scoped to the branch. Before branches they were scoped to the
      // project, so a retry that spans the deploy still replays on the default.
      if (branch.isDefault && operation === "create_task") {
        const [legacy] = await tx
          .select()
          .from(apiIdempotencyKeys)
          .where(
            and(
              actorClause(actor),
              eq(apiIdempotencyKeys.operation, operation),
              eq(apiIdempotencyKeys.resourceId, projectId),
              eq(apiIdempotencyKeys.idempotencyKey, idempotencyKey)
            )
          );
        if (legacy) {
          if (legacy.requestHash !== requestHash) throw conflict();
          return { status: legacy.responseStatus, body: legacy.responseBody };
        }
      }
      const [reserved] = await tx
        .insert(apiIdempotencyKeys)
        .values({
          ...actorValues(actor),
          operation,
          resourceId: branch.id,
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
              actorClause(actor),
              eq(apiIdempotencyKeys.operation, operation),
              eq(apiIdempotencyKeys.resourceId, branch.id),
              eq(apiIdempotencyKeys.idempotencyKey, idempotencyKey)
            )
          );
        if (!existing || existing.requestHash !== requestHash) throw conflict();
        return { status: existing.responseStatus, body: existing.responseBody };
      }
      const body = await run(tx, branch.id);
      await tx
        .update(apiIdempotencyKeys)
        .set({ responseStatus: 201, responseBody: body })
        .where(eq(apiIdempotencyKeys.id, reserved.id));
      return { status: 201, body };
    });
  }

  // Allocates the next task key, so callers creating several tasks in one
  // transaction get keys in call order.
  private async insertTask(
    tx: Transaction,
    actor: Actor,
    projectId: string,
    branchId: string,
    input: CreateTaskRequest
  ) {
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
    if (!counter) throw new ApiError(404, "NOT_FOUND", "Project not found.");
    const number = counter.next - 1;
    const [position] = await tx
      .select({ value: count() })
      .from(tasks)
      .where(
        and(
          eq(tasks.branchId, branchId),
          eq(tasks.status, input.status ?? "backlog")
        )
      );
    const [task] = await tx
      .insert(tasks)
      .values({
        id: randomUUID(),
        projectId,
        branchId,
        taskKey: `${counter.prefix}-${number}`,
        taskNumber: number,
        title: input.title,
        description: input.description ?? null,
        priority: input.priority ?? "none",
        status: input.status ?? "backlog",
        position: Number(position?.value ?? 0),
        createdByType: actor.type,
        createdByUserId: actor.type === "human" ? actor.id : null,
        createdByAgentId: actor.type === "agent" ? actor.id : null
      })
      .returning();
    await insertProjectEvent(tx, {
      projectId,
      actorUserId: actor.type === "human" ? actor.id : null,
      actorAgentId: actor.type === "agent" ? actor.id : null,
      entityId: task.id,
      branchId,
      type: "task.created",
      payload: { status: task.status }
    });
    await onTaskCreated(tx, { projectId, taskId: task.id, actor });
    return taskJson(task);
  }

  private async createAs(
    actor: Actor,
    projectId: string,
    input: CreateTaskRequest,
    key?: string,
    selector?: BranchSelector
  ) {
    return this.createIdempotent(
      actor,
      projectId,
      "create_task",
      input,
      key,
      selector,
      (tx, branchId) => this.insertTask(tx, actor, projectId, branchId, input)
    );
  }

  async create(
    userId: string,
    projectId: string,
    input: CreateTaskRequest,
    key?: string,
    selector?: BranchSelector
  ) {
    await this.access(userId, projectId, true);
    return this.createAs(
      { type: "human", id: userId },
      projectId,
      input,
      key,
      selector
    );
  }

  async createForAgent(
    principal: AgentPrincipal,
    input: CreateTaskRequest,
    key?: string
  ) {
    return this.createAs(
      { type: "agent", id: principal.agentId },
      principal.projectId,
      input,
      key,
      principal.branch
    );
  }

  // All-or-nothing: one transaction, keys allocated in input order, and one
  // idempotency record for the whole batch.
  async createManyForAgent(
    principal: AgentPrincipal,
    input: AgentBulkCreateTasksRequest,
    key?: string
  ) {
    const actor: Actor = { type: "agent", id: principal.agentId };
    return this.createIdempotent(
      actor,
      principal.projectId,
      "create_tasks",
      input,
      key,
      principal.branch,
      async (tx, branchId) => {
        const created = [];
        for (const [index, item] of input.tasks.entries())
          created.push(
            await bulkItem(index, { title: item.title }, () =>
              this.insertTask(tx, actor, principal.projectId, branchId, item)
            )
          );
        return { tasks: created };
      }
    );
  }

  async list(
    userId: string,
    projectId: string,
    query: TaskListQuery,
    selector?: BranchSelector
  ) {
    await this.access(userId, projectId);
    const branch = await resolveBranch(this.db, projectId, selector);
    return this.listProject(projectId, branch.id, query);
  }

  private async listProject(
    projectId: string,
    branchId: string,
    query: TaskListQuery
  ) {
    await this.claims.reconcileExpired(projectId);
    const clauses = [eq(tasks.branchId, branchId)];
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
          eq(tasks.branchId, branchId),
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
    return this.getProject(task.projectId, id);
  }

  private async getProject(projectId: string, id: string) {
    await this.claims.reconcileExpired(projectId, id);
    const [current] = await this.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, id), eq(tasks.projectId, projectId)))
      .limit(1);
    if (!current) throw new ApiError(404, "NOT_FOUND", "Task not found.");
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
      ...taskJson(current),
      comment_count: Number(comments?.value ?? 0),
      unresolved_blocker_count: Number(blockers?.value ?? 0)
    };
  }

  async listForAgent(principal: AgentPrincipal, query: TaskListQuery) {
    const branch = await resolveBranch(
      this.db,
      principal.projectId,
      principal.branch,
      { agentId: principal.agentId }
    );
    return this.listProject(principal.projectId, branch.id, query);
  }

  async getForAgent(principal: AgentPrincipal, id: string) {
    return this.getProject(principal.projectId, id);
  }

  // Edits fields and, for agents, moves an unclaimed task, as one version
  // bump. The caller holds the project lock inside `tx`.
  private async editLocked(
    tx: Transaction,
    actor: Actor,
    projectId: string,
    id: string,
    input: UpdateTaskRequest | AgentUpdateTaskRequest,
    selector?: BranchSelector
  ) {
    const checked = await this.checkEdit(
      tx,
      actor,
      projectId,
      id,
      input,
      selector
    );
    return this.applyEdit(tx, actor, checked, input);
  }

  // Every check an edit can fail, before it writes. Bulk updates check all
  // items first, so a failing item never follows a half-applied batch.
  private async checkEdit(
    tx: Transaction,
    actor: Actor,
    projectId: string,
    id: string,
    input: UpdateTaskRequest | AgentUpdateTaskRequest,
    selector?: BranchSelector
  ): Promise<CheckedEdit> {
    const [current] = await tx
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, id), eq(tasks.projectId, projectId)))
      .for("update");
    if (!current) throw new ApiError(404, "NOT_FOUND", "Task not found.");
    await assertEntityBranch(tx, projectId, current.branchId, selector, {
      actor: actor.type,
      write: true,
      agentId: agentIdOf(actor),
      notFound: "Task not found."
    });
    if (current.version !== input.expected_version)
      throw new ApiError(
        409,
        "TASK_VERSION_CONFLICT",
        "Task version is stale.",
        { current_version: current.version }
      );
    const status = "status" in input ? input.status : undefined;
    const move =
      status !== undefined && status !== current.status ? status : undefined;
    if (move)
      await this.assertAgentMayMove(tx, actor, projectId, current, {
        status: move,
        acknowledged_through:
          "acknowledged_through" in input
            ? input.acknowledged_through
            : undefined
      });
    return { current, move };
  }

  private async applyEdit(
    tx: Transaction,
    actor: Actor,
    { current, move }: CheckedEdit,
    input: UpdateTaskRequest | AgentUpdateTaskRequest
  ) {
    if (editedFields(input))
      await insertProjectEvent(tx, {
        projectId: current.projectId,
        ...eventActor(actor),
        entityId: current.id,
        branchId: current.branchId,
        type: "task.updated",
        payload: { fields: updatedFieldNames(input) }
      });
    if (move)
      return taskJson(
        await this.moveLocked(tx, actor, current, { status: move }, input)
      );
    // Moving to the current column is not a move; nothing else changed.
    if (!editedFields(input)) return taskJson(current);
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
      .where(
        and(eq(tasks.id, current.id), eq(tasks.version, input.expected_version))
      )
      .returning();
    if (!task)
      throw new ApiError(
        409,
        "TASK_VERSION_CONFLICT",
        "Task version is stale."
      );
    return taskJson(task);
  }

  // Agent moves follow the human rules (any column, never a claimed task) plus
  // two agent ones: the agent's own claim must use the claim tools, and review
  // or done needs acknowledged comments, like complete_task.
  private async assertAgentMayMove(
    tx: Transaction,
    actor: Actor,
    projectId: string,
    task: typeof tasks.$inferSelect,
    input: { status: HumanTaskStatus; acknowledged_through?: number }
  ) {
    const claim = await activeClaim(tx, task.id);
    if (claim && claim.agentId === actor.id)
      throw new ApiError(
        409,
        "TASK_NOT_CLAIMABLE",
        "This agent holds the claim on this task. Use set_task_status, complete_task or release_task to change its status.",
        { reason: "own_claim", claim_id: claim.id, task_id: task.id }
      );
    if (claim || task.status === "claimed")
      throw new ApiError(
        409,
        "TASK_NOT_CLAIMABLE",
        "Claimed tasks can only be changed by their owning agent.",
        {
          reason: "claimed",
          task_id: task.id,
          ...(claim
            ? {
                claim_id: claim.id,
                agent_id: claim.agentId,
                session_id: claim.sessionId
              }
            : {})
        }
      );
    if (
      actor.type === "agent" &&
      (input.status === "review" || input.status === "done")
    )
      await assertCommentsAcknowledged(tx, {
        projectId,
        taskId: task.id,
        agentId: actor.id,
        acknowledgedThrough: input.acknowledged_through
      });
  }

  async update(userId: string, id: string, input: UpdateTaskRequest) {
    const authorized = await this.taskAccess(userId, id, true);
    return this.db.transaction(async (tx) => {
      await this.lockActiveProject(tx, authorized.projectId);
      return this.editLocked(
        tx,
        { type: "human", id: userId },
        authorized.projectId,
        id,
        input
      );
    });
  }

  async updateForAgent(
    principal: AgentPrincipal,
    id: string,
    input: AgentUpdateTaskRequest
  ) {
    // Settle lapsed leases first so an expired claim does not block the move.
    if (input.status !== undefined)
      await this.claims.reconcileExpired(principal.projectId, id);
    return this.db.transaction(async (tx) => {
      await this.lockActiveProject(tx, principal.projectId);
      return this.editLocked(
        tx,
        { type: "agent", id: principal.agentId },
        principal.projectId,
        id,
        input,
        principal.branch
      );
    });
  }

  // All-or-nothing: every item is checked before any is written, and the
  // transaction rolls back anything a later failure would leave behind.
  async updateManyForAgent(
    principal: AgentPrincipal,
    input: AgentBulkUpdateTasksRequest
  ) {
    if (input.tasks.some((item) => item.status !== undefined))
      await this.claims.reconcileExpired(principal.projectId);
    const actor: Actor = { type: "agent", id: principal.agentId };
    return this.db.transaction(async (tx) => {
      await this.lockActiveProject(tx, principal.projectId);
      const checked: CheckedEdit[] = [];
      for (const [index, { task_id, ...item }] of input.tasks.entries())
        checked.push(
          await bulkItem(index, { task_id }, () =>
            this.checkEdit(
              tx,
              actor,
              principal.projectId,
              task_id,
              item,
              principal.branch
            )
          )
        );
      const updated = [];
      for (const [index, { task_id, ...item }] of input.tasks.entries())
        updated.push(
          await bulkItem(index, { task_id }, () =>
            this.applyEdit(tx, actor, checked[index]!, item)
          )
        );
      return { tasks: updated };
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
      await assertEntityBranch(
        tx,
        authorized.projectId,
        locked.branchId,
        undefined,
        { actor: "human", write: true, notFound: "Task not found." }
      );
      if (locked.status === "claimed" || (await hasActiveClaim(tx, id)))
        throw new ApiError(
          409,
          "TASK_NOT_CLAIMABLE",
          "Claimed tasks can only be changed by their owning agent."
        );
      return taskJson(
        await this.moveLocked(tx, { type: "human", id: userId }, locked, input)
      );
    });
  }

  // Reorders the source and target columns and moves the locked task, with
  // any field edits, in one version bump. Callers have checked the version
  // and that the task is not claimed.
  private async moveLocked(
    tx: Transaction,
    actor: Actor,
    locked: typeof tasks.$inferSelect,
    input: Pick<MoveTaskRequest, "status" | "before_task_id">,
    fields: TaskFields = {}
  ) {
    const id = locked.id;
    const statuses = [locked.status, input.status].sort();
    const lockedColumns = await tx
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.branchId, locked.branchId),
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
      index = destination.findIndex((task) => task.id === input.before_task_id);
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
                ...(fields.title === undefined ? {} : { title: fields.title }),
                ...(fields.description === undefined
                  ? {}
                  : { description: fields.description }),
                ...(fields.priority === undefined
                  ? {}
                  : { priority: fields.priority }),
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
    await insertProjectEvent(tx, {
      projectId: locked.projectId,
      ...eventActor(actor),
      entityId: moved.id,
      branchId: moved.branchId,
      type: "task.moved",
      payload: { from_status: locked.status, to_status: input.status }
    });
    await onTaskMoved(tx, {
      projectId: locked.projectId,
      taskId: id,
      fromStatus: locked.status,
      toStatus: input.status,
      actor
    });
    return moved;
  }

  private async commentsProject(
    projectId: string,
    id: string,
    limit: number,
    cursor?: string
  ) {
    const [task] = await this.db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.id, id), eq(tasks.projectId, projectId)))
      .limit(1);
    if (!task) throw new ApiError(404, "NOT_FOUND", "Task not found.");
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
      .leftJoin(users, eq(users.id, taskComments.authorUserId))
      .where(and(...clauses))
      .orderBy(asc(taskComments.createdAt), asc(taskComments.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    return {
      comments: page.map(({ comment, user }) => ({
        id: comment.id,
        task_id: comment.taskId,
        author: {
          type: comment.authorType,
          id: comment.authorUserId ?? comment.authorAgentId!,
          user_id: comment.authorUserId,
          agent_id: comment.authorAgentId,
          username: user?.username ?? null,
          full_name: comment.authorName,
          avatar_url: user?.avatarUrl ?? null
        },
        body_markdown: comment.bodyMarkdown,
        sequence: comment.sequence,
        mentions: comment.mentions,
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

  async comments(userId: string, id: string, limit: number, cursor?: string) {
    const task = await this.taskAccess(userId, id);
    return this.commentsProject(task.projectId, id, limit, cursor);
  }

  async commentsForAgent(
    principal: AgentPrincipal,
    id: string,
    limit: number,
    cursor?: string
  ) {
    return this.commentsProject(principal.projectId, id, limit, cursor);
  }

  private async createCommentAs(
    actor: Actor,
    projectId: string,
    id: string,
    input: CreateTaskCommentRequest,
    key?: string,
    selector?: BranchSelector
  ) {
    const idempotencyKey = idempotencyKeySchema.parse(key);
    const requestHash = hash(input);
    return this.db.transaction(async (tx) => {
      await this.lockActiveProject(tx, projectId);
      const [task] = await tx
        .select()
        .from(tasks)
        .where(and(eq(tasks.id, id), eq(tasks.projectId, projectId)))
        .for("update");
      if (!task) throw new ApiError(404, "NOT_FOUND", "Task not found.");
      await assertEntityBranch(tx, projectId, task.branchId, selector, {
        actor: actor.type,
        write: true,
        agentId: agentIdOf(actor),
        notFound: "Task not found."
      });
      const [reserved] = await tx
        .insert(apiIdempotencyKeys)
        .values({
          ...actorValues(actor),
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
              actorClause(actor),
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
          projectId,
          branchId: task.branchId,
          taskId: id,
          authorType: actor.type,
          authorUserId: actor.type === "human" ? actor.id : null,
          authorAgentId: actor.type === "agent" ? actor.id : null,
          authorName:
            actor.type === "human"
              ? (
                  await tx
                    .select({ name: users.name })
                    .from(users)
                    .where(eq(users.id, actor.id))
                    .limit(1)
                )[0]!.name
              : (
                  await tx
                    .select({ name: agents.name })
                    .from(agents)
                    .where(eq(agents.id, actor.id))
                    .limit(1)
                )[0]!.name,
          bodyMarkdown: input.body_markdown,
          sequence: await nextCommentSequence(tx, id),
          mentions: await resolveCommentMentions(tx, projectId, input.mentions)
        })
        .returning();
      const mentionRefs = comment.mentions.map(({ type, id }) => ({
        type,
        id
      }));
      await insertProjectEvent(tx, {
        projectId,
        actorUserId: actor.type === "human" ? actor.id : null,
        actorAgentId: actor.type === "agent" ? actor.id : null,
        entityId: comment.id,
        branchId: comment.branchId,
        type: "task.comment_created",
        payload: {
          task_id: id,
          sequence: comment.sequence,
          mentions: mentionRefs
        }
      });
      await onTaskCommentCreated(tx, {
        projectId,
        taskId: id,
        sequence: comment.sequence,
        actor,
        mentions: mentionRefs
      });
      await resolveBlocksOnParticipantResponse(tx, {
        projectId,
        taskId: id,
        participant: actor
      });
      const [record] = await tx
        .select({ comment: taskComments, user: users })
        .from(taskComments)
        .leftJoin(users, eq(users.id, taskComments.authorUserId))
        .where(eq(taskComments.id, comment.id));
      const body = {
        id: record.comment.id,
        task_id: record.comment.taskId,
        author: {
          type: record.comment.authorType,
          id: record.comment.authorUserId ?? record.comment.authorAgentId!,
          user_id: record.comment.authorUserId,
          agent_id: record.comment.authorAgentId,
          username: record.user?.username ?? null,
          full_name: record.comment.authorName,
          avatar_url: record.user?.avatarUrl ?? null
        },
        body_markdown: record.comment.bodyMarkdown,
        sequence: record.comment.sequence,
        mentions: record.comment.mentions,
        created_at: record.comment.createdAt.toISOString()
      };
      await tx
        .update(apiIdempotencyKeys)
        .set({ responseStatus: 201, responseBody: body })
        .where(eq(apiIdempotencyKeys.id, reserved.id));
      return { status: 201, body };
    });
  }

  async createComment(
    userId: string,
    id: string,
    input: CreateTaskCommentRequest,
    key?: string
  ) {
    const task = await this.taskAccess(userId, id, true);
    return this.createCommentAs(
      { type: "human", id: userId },
      task.projectId,
      id,
      input,
      key
    );
  }

  async createCommentForAgent(
    principal: AgentPrincipal,
    id: string,
    input: CreateTaskCommentRequest,
    key?: string
  ) {
    return this.createCommentAs(
      { type: "agent", id: principal.agentId },
      principal.projectId,
      id,
      input,
      key,
      principal.branch
    );
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
    if (task.branchId !== blocker.branchId)
      throw new ApiError(
        400,
        "VALIDATION_ERROR",
        "Dependencies must stay within a branch.",
        { reason: "cross_branch" }
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
      await assertEntityBranch(
        tx,
        task.projectId,
        current.branchId,
        undefined,
        {
          actor: "human",
          write: true,
          notFound: "Task not found."
        }
      );
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
        .where(eq(taskDependencies.branchId, current.branchId));
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
        branchId: current.branchId,
        taskId: id,
        dependsOnTaskId: blocker.id
      });
      await insertProjectEvent(tx, {
        projectId: task.projectId,
        actorUserId: userId,
        entityId: id,
        branchId: current.branchId,
        type: "task.dependency_added",
        payload: { depends_on_task_id: blocker.id }
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
      await assertEntityBranch(
        tx,
        task.projectId,
        current.branchId,
        undefined,
        {
          actor: "human",
          write: true,
          notFound: "Task not found."
        }
      );
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
      await insertProjectEvent(tx, {
        projectId: task.projectId,
        actorUserId: userId,
        entityId: id,
        branchId: current.branchId,
        type: "task.dependency_removed",
        payload: { depends_on_task_id: dependsOnTaskId }
      });
      return taskJson(updated);
    });
  }
}
