import {
  branchMergeDecisions,
  projectBranches,
  projects,
  repositoryConnections,
  repositoryRefs,
  type Database
} from "@orchestrat/db";
import type {
  Branch,
  BranchListQuery,
  BranchOnboardingRequest,
  CreateBranchRequest,
  RegisterBranchRequest
} from "@orchestrat/protocol";
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull
} from "drizzle-orm";
import {
  insertProjectEvent,
  type AgentPrincipal,
  type AgentService,
  type Transaction
} from "./agent-service.js";
import { ApiError } from "./api-error.js";
import {
  assertBranchWritable,
  defaultBranch,
  findProjectBranch,
  type BranchRow
} from "./branch-context.js";
import { PermissionService } from "./permission-service.js";

type Executor = Database | Transaction;
type Actor = { type: "human"; id: string } | { type: "agent"; id: string };

const date = (value: Date | null) => value?.toISOString() ?? null;
const isUniqueViolation = (error: unknown) =>
  (error as { code?: string }).code === "23505" ||
  (error as { message?: string }).message?.includes(
    "project_branches_active_name_unique"
  ) === true;
const nameTaken = (name: string) =>
  new ApiError(409, "BRANCH_NAME_TAKEN", "An active branch has that name.", {
    name
  });

export function branchJson(
  branch: BranchRow,
  extras: {
    provider: Branch["provider"];
    openDecisionCount: number;
  } = { provider: null, openDecisionCount: 0 }
): Branch {
  return {
    id: branch.id,
    project_id: branch.projectId,
    name: branch.name,
    is_default: branch.isDefault,
    name_source: branch.nameSource,
    created_via: branch.createdVia,
    created_by: branch.createdByType
      ? branch.createdByType === "human"
        ? { type: "human", id: branch.createdByUserId! }
        : { type: "agent", id: branch.createdByAgentId! }
      : null,
    onboarding_state: branch.onboardingState,
    onboarding_choice: branch.onboardingChoice,
    archived_at: date(branch.archivedAt),
    archived_reason: branch.archivedReason,
    provider: extras.provider,
    open_decision_count: extras.openDecisionCount,
    created_at: branch.createdAt.toISOString(),
    updated_at: branch.updatedAt.toISOString()
  };
}

/** Provider tracking state and open decisions for a set of branches. */
async function branchExtras(
  tx: Executor,
  projectId: string,
  rows: BranchRow[]
) {
  const ids = rows.map((row) => row.id);
  const extras = new Map<
    string,
    { provider: Branch["provider"]; openDecisionCount: number }
  >(ids.map((id) => [id, { provider: null, openDecisionCount: 0 }]));
  if (!ids.length) return extras;
  const decisions = await tx
    .select({ branchId: branchMergeDecisions.targetBranchId, value: count() })
    .from(branchMergeDecisions)
    .where(
      and(
        eq(branchMergeDecisions.projectId, projectId),
        inArray(branchMergeDecisions.targetBranchId, ids),
        eq(branchMergeDecisions.status, "open")
      )
    )
    .groupBy(branchMergeDecisions.targetBranchId);
  for (const row of decisions)
    extras.get(row.branchId)!.openDecisionCount = Number(row.value);
  const [connection] = await tx
    .select()
    .from(repositoryConnections)
    .where(
      and(
        eq(repositoryConnections.projectId, projectId),
        isNull(repositoryConnections.disconnectedAt)
      )
    )
    .limit(1);
  if (!connection) return extras;
  const refs = await tx
    .select()
    .from(repositoryRefs)
    .where(
      and(
        eq(repositoryRefs.connectionId, connection.id),
        inArray(repositoryRefs.branchId, ids)
      )
    )
    .orderBy(desc(repositoryRefs.firstSeenAt));
  for (const row of rows) {
    const linked = refs.filter((ref) => ref.branchId === row.id);
    const active = linked.find((ref) => ref.state === "active");
    extras.get(row.id)!.provider = {
      provider: connection.provider,
      state: active ? "tracked" : linked.length ? "missing" : "untracked",
      head_sha: (active ?? linked[0])?.headSha ?? null
    };
  }
  return extras;
}

export class BranchService {
  private readonly permissions: PermissionService;

  constructor(
    private readonly db: Database,
    private readonly agents: AgentService
  ) {
    this.permissions = new PermissionService(db);
  }

  async list(userId: string, projectId: string, query: BranchListQuery) {
    await this.permissions.projectAccess(userId, projectId);
    return this.listProject(projectId, query);
  }

  async listForAgent(principal: AgentPrincipal, query: BranchListQuery) {
    return this.listProject(principal.projectId, query);
  }

  async get(userId: string, projectId: string, branchId: string) {
    await this.permissions.projectAccess(userId, projectId);
    return this.getProject(projectId, branchId);
  }

  async getForAgent(principal: AgentPrincipal, branchId: string) {
    return this.getProject(principal.projectId, branchId);
  }

  async create(userId: string, projectId: string, input: CreateBranchRequest) {
    await this.permissions.projectAccess(userId, projectId);
    return this.createAs({ type: "human", id: userId }, projectId, input.name);
  }

  /**
   * Registers the checkout's Git branch for the CLI: returns the active branch
   * with that name or creates it. A name whose newest generation was deleted on
   * the provider is refused unless force_new.
   */
  /**
   * `beforeCreate` runs only when registration would create a branch; it
   * throws to refuse (the per-credential rate limit).
   */
  async registerForAgent(
    principal: AgentPrincipal,
    input: RegisterBranchRequest,
    beforeCreate: () => void = () => undefined
  ) {
    const actor: Actor = { type: "agent", id: principal.agentId };
    return this.db.transaction(async (tx) => {
      await this.lockActiveProject(tx, principal.projectId);
      if (input.git_default_branch)
        await this.applyLocalDefaultName(
          tx,
          principal.projectId,
          input.git_default_branch,
          actor
        );
      const active = await this.activeByName(
        tx,
        principal.projectId,
        input.name
      );
      if (active)
        return {
          branch: await this.json(tx, principal.projectId, active),
          created: false
        };
      if (!input.force_new) {
        const [latest] = await tx
          .select()
          .from(projectBranches)
          .where(
            and(
              eq(projectBranches.projectId, principal.projectId),
              eq(projectBranches.name, input.name),
              isNotNull(projectBranches.archivedAt)
            )
          )
          .orderBy(desc(projectBranches.archivedAt))
          .limit(1);
        if (latest?.archivedReason === "provider_deleted")
          throw new ApiError(
            409,
            "BRANCH_ARCHIVED",
            "This branch was deleted on the provider and is archived.",
            {
              branch_id: latest.id,
              archived_at: latest.archivedAt!.toISOString()
            }
          );
      }
      beforeCreate();
      const branch = await this.insertBranch(
        tx,
        principal.projectId,
        input.name,
        actor,
        "cli"
      );
      return {
        branch: await this.json(tx, principal.projectId, branch),
        created: true
      };
    });
  }

  async setDefault(userId: string, projectId: string, branchId: string) {
    await this.permissions.projectEditor(userId, projectId);
    return this.db.transaction(async (tx) => {
      await this.lockActiveProject(tx, projectId);
      const branch = await this.lockBranch(tx, projectId, branchId);
      if (branch.isDefault) return this.json(tx, projectId, branch);
      assertBranchWritable(branch, { branchId });
      const previous = await defaultBranch(tx, projectId);
      await tx
        .update(projectBranches)
        .set({ isDefault: false, updatedAt: new Date() })
        .where(eq(projectBranches.id, previous.id));
      const [updated] = await tx
        .update(projectBranches)
        .set({ isDefault: true, updatedAt: new Date() })
        .where(eq(projectBranches.id, branch.id))
        .returning();
      await insertProjectEvent(tx, {
        projectId,
        actorUserId: userId,
        entityId: branch.id,
        type: "branch.default_changed",
        payload: { from_branch_id: previous.id, name: branch.name }
      });
      return this.json(tx, projectId, updated!);
    });
  }

  async archive(userId: string, projectId: string, branchId: string) {
    await this.permissions.projectEditor(userId, projectId);
    return this.db.transaction(async (tx) => {
      await this.lockActiveProject(tx, projectId);
      const branch = await this.lockBranch(tx, projectId, branchId);
      if (branch.isDefault)
        throw new ApiError(
          409,
          "CONFLICT",
          "The default branch cannot be archived. Choose another default first.",
          { reason: "default_branch" }
        );
      const archived = await this.archiveInTransaction(tx, branch, {
        reason: "manual",
        userId
      });
      return this.json(tx, projectId, archived);
    });
  }

  /**
   * Archives a branch inside the caller's transaction (manual archive and
   * provider deletion). Idempotent; the default branch is never archived.
   */
  async archiveInTransaction(
    tx: Transaction,
    branch: BranchRow,
    options: {
      reason: "provider_deleted" | "manual" | "replaced_on_connect";
      userId?: string | null;
    }
  ) {
    if (branch.archivedAt || branch.isDefault) return branch;
    const now = new Date();
    const [archived] = await tx
      .update(projectBranches)
      .set({
        archivedAt: now,
        archivedReason: options.reason,
        archivedByUserId: options.userId ?? null,
        updatedAt: now
      })
      .where(eq(projectBranches.id, branch.id))
      .returning();
    const closed = await this.agents.closeBranchSessions(
      tx,
      branch.projectId,
      branch.id,
      now
    );
    await insertProjectEvent(tx, {
      projectId: branch.projectId,
      actorUserId: options.userId ?? null,
      entityId: branch.id,
      type: "branch.archived",
      payload: {
        name: branch.name,
        reason: options.reason,
        closed_sessions: closed
      }
    });
    return archived!;
  }

  async completeOnboarding(
    userId: string,
    projectId: string,
    branchId: string,
    input: BranchOnboardingRequest
  ) {
    await this.permissions.projectAccess(userId, projectId);
    return this.db.transaction(async (tx) => {
      await this.lockActiveProject(tx, projectId);
      const branch = await this.lockBranch(tx, projectId, branchId);
      assertBranchWritable(branch, { branchId });
      if (branch.onboardingState === "completed")
        throw new ApiError(
          409,
          "CONFLICT",
          "Branch setup is already complete.",
          {
            reason: "onboarding_completed"
          }
        );
      const updated = await this.markOnboarded(tx, branch, input.choice, {
        type: "human",
        id: userId
      });
      return this.json(tx, projectId, updated);
    });
  }

  /** Shared with imports: records the onboarding choice once. */
  async markOnboarded(
    tx: Transaction,
    branch: BranchRow,
    choice: "blank" | "import_all" | "selected",
    actor: Actor | null
  ) {
    if (branch.onboardingState === "completed") return branch;
    const now = new Date();
    const [updated] = await tx
      .update(projectBranches)
      .set({
        onboardingState: "completed",
        onboardingChoice: choice,
        onboardingCompletedAt: now,
        updatedAt: now
      })
      .where(eq(projectBranches.id, branch.id))
      .returning();
    await insertProjectEvent(tx, {
      projectId: branch.projectId,
      ...(actor?.type === "human"
        ? { actorUserId: actor.id }
        : actor
          ? { actorAgentId: actor.id }
          : {}),
      entityId: branch.id,
      type: "branch.onboarding_completed",
      payload: { choice }
    });
    return updated!;
  }

  async json(tx: Executor, projectId: string, branch: BranchRow) {
    const extras = await branchExtras(tx, projectId, [branch]);
    return branchJson(branch, extras.get(branch.id));
  }

  private async listProject(projectId: string, query: BranchListQuery) {
    const rows = await this.db
      .select()
      .from(projectBranches)
      .where(
        and(
          eq(projectBranches.projectId, projectId),
          query.include_archived
            ? undefined
            : isNull(projectBranches.archivedAt),
          query.name ? eq(projectBranches.name, query.name) : undefined
        )
      )
      .orderBy(
        desc(projectBranches.isDefault),
        asc(projectBranches.archivedAt),
        desc(projectBranches.updatedAt),
        asc(projectBranches.id)
      );
    if (!rows.some((row) => row.isDefault) && !query.name) {
      // Lazily repair a project the pre-branches API created (see branch-context).
      rows.unshift(await defaultBranch(this.db, projectId));
    }
    // Active branches first, default first among them.
    rows.sort(
      (a, b) =>
        Number(Boolean(a.archivedAt)) - Number(Boolean(b.archivedAt)) ||
        Number(b.isDefault) - Number(a.isDefault)
    );
    const extras = await branchExtras(this.db, projectId, rows);
    return {
      branches: rows.map((row) => branchJson(row, extras.get(row.id)))
    };
  }

  private async getProject(projectId: string, branchId: string) {
    const branch = await findProjectBranch(this.db, projectId, branchId);
    if (!branch)
      throw new ApiError(404, "BRANCH_NOT_FOUND", "Branch not found.", {
        branch_id: branchId
      });
    return { branch: await this.json(this.db, projectId, branch) };
  }

  private async createAs(actor: Actor, projectId: string, name: string) {
    try {
      return await this.db.transaction(async (tx) => {
        await this.lockActiveProject(tx, projectId);
        if (await this.activeByName(tx, projectId, name)) throw nameTaken(name);
        const branch = await this.insertBranch(
          tx,
          projectId,
          name,
          actor,
          actor.type === "human" ? "dashboard" : "agent"
        );
        return { branch: await this.json(tx, projectId, branch) };
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw nameTaken(name);
      throw error;
    }
  }

  private async insertBranch(
    tx: Transaction,
    projectId: string,
    name: string,
    actor: Actor,
    createdVia: "dashboard" | "cli" | "agent"
  ) {
    const [branch] = await tx
      .insert(projectBranches)
      .values({
        projectId,
        name,
        isDefault: false,
        nameSource: createdVia === "cli" ? "cli" : "user",
        createdVia,
        createdByType: actor.type,
        ...(actor.type === "human"
          ? { createdByUserId: actor.id }
          : { createdByAgentId: actor.id }),
        onboardingState: "pending"
      })
      .returning();
    await insertProjectEvent(tx, {
      projectId,
      ...(actor.type === "human"
        ? { actorUserId: actor.id }
        : { actorAgentId: actor.id }),
      entityId: branch!.id,
      type: "branch.created",
      payload: { name, created_via: createdVia }
    });
    return branch!;
  }

  /**
   * The CLI reports the checkout's default branch (refs/remotes/origin/HEAD).
   * Without a connected repository, a default still named by the "main"
   * fallback takes that name.
   */
  private async applyLocalDefaultName(
    tx: Transaction,
    projectId: string,
    name: string,
    actor: Actor
  ) {
    const current = await defaultBranch(tx, projectId);
    if (current.nameSource !== "fallback" || current.name === name) return;
    const [connection] = await tx
      .select({ id: repositoryConnections.id })
      .from(repositoryConnections)
      .where(
        and(
          eq(repositoryConnections.projectId, projectId),
          isNull(repositoryConnections.disconnectedAt)
        )
      )
      .limit(1);
    if (connection) return;
    if (await this.activeByName(tx, projectId, name)) return;
    await tx
      .update(projectBranches)
      .set({ name, nameSource: "cli", updatedAt: new Date() })
      .where(eq(projectBranches.id, current.id));
    await insertProjectEvent(tx, {
      projectId,
      ...(actor.type === "human"
        ? { actorUserId: actor.id }
        : { actorAgentId: actor.id }),
      entityId: current.id,
      type: "branch.renamed",
      payload: { from: current.name, to: name, source: "cli" }
    });
  }

  private async activeByName(tx: Executor, projectId: string, name: string) {
    const [branch] = await tx
      .select()
      .from(projectBranches)
      .where(
        and(
          eq(projectBranches.projectId, projectId),
          eq(projectBranches.name, name),
          isNull(projectBranches.archivedAt)
        )
      )
      .limit(1);
    return branch ?? null;
  }

  async lockBranch(tx: Transaction, projectId: string, branchId: string) {
    const [branch] = await tx
      .select()
      .from(projectBranches)
      .where(
        and(
          eq(projectBranches.projectId, projectId),
          eq(projectBranches.id, branchId)
        )
      )
      .for("update");
    if (!branch)
      throw new ApiError(404, "BRANCH_NOT_FOUND", "Branch not found.", {
        branch_id: branchId
      });
    return branch;
  }

  async lockActiveProject(tx: Transaction, projectId: string) {
    const [project] = await tx
      .select({ status: projects.status })
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
  }
}
