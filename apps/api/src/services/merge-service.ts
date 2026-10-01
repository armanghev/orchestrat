import {
  branchMergeDecisions,
  branchMergeRuns,
  chats,
  documentAttachments,
  documentRevisions,
  documents,
  tasks,
  type Database
} from "@orchestrat/db";
import type {
  Decision,
  DecisionsQuery,
  MergeApplyRequest,
  MergeChoice,
  MergePreviewRequest,
  MergeRunsQuery
} from "@orchestrat/protocol";
import { and, desc, eq, lt, max, ne, or } from "drizzle-orm";
import { insertProjectEvent } from "./agent-service.js";
import { ApiError } from "./api-error.js";
import { assertBranchWritable, findProjectBranch } from "./branch-context.js";
import type { BranchService } from "./branch-service.js";
import { upsertBaseline } from "./merges/baselines.js";
import { rewriteRefs } from "./merges/document-items.js";
import { MergeEngine, runJson } from "./merges/engine.js";
import {
  changedFields,
  digest,
  fingerprintOf,
  sameFingerprint,
  type Fingerprint
} from "./merges/fingerprint.js";
import { activeClaim } from "./task-block-hooks.js";
import { applyTaskValues, lineageOf, taskValues } from "./merges/task-items.js";
import { PermissionService } from "./permission-service.js";

// Imports, merges and the "Needs your decision" list for people
// (docs/project-branches.md §6.6, §6.7, §9.8, §9.9).

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type DecisionRow = typeof branchMergeDecisions.$inferSelect;
type SourceSnapshot = {
  values: Record<string, unknown>;
  baseline_key: string;
  revision_id?: string;
  body_sha256?: string;
};

const cursorError = () =>
  new ApiError(400, "VALIDATION_ERROR", "The cursor is invalid.");
const encodeCursor = (row: { createdAt: Date; id: string }) =>
  Buffer.from(
    JSON.stringify({ createdAt: row.createdAt.toISOString(), id: row.id })
  ).toString("base64url");
const decodeCursor = (value: string) => {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    const createdAt = new Date(parsed.createdAt);
    if (Number.isNaN(createdAt.getTime()) || typeof parsed.id !== "string")
      throw cursorError();
    return { createdAt, id: parsed.id as string };
  } catch {
    throw cursorError();
  }
};

export function decisionJson(row: DecisionRow): Decision {
  const source = row.sourceSnapshot as SourceSnapshot;
  const target = row.targetSnapshot as { values?: Record<string, unknown> };
  return {
    id: row.id,
    project_id: row.projectId,
    run_id: row.runId,
    source_branch_id: row.sourceBranchId,
    target_branch_id: row.targetBranchId,
    item_type: row.itemType,
    lineage_key: row.lineageKey,
    source_item_id: row.sourceItemId,
    target_item_id: row.targetItemId,
    label: row.label,
    reason: row.reason,
    fields: row.fields,
    source_values: {
      ...source.values,
      ...(source.revision_id ? { revision_id: source.revision_id } : {})
    },
    target_values: target.values ?? {},
    status: row.status,
    resolved_by_user_id: row.resolvedByUserId,
    resolved_at: row.resolvedAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString()
  };
}

/** The source fingerprint a decision was recorded against. */
function sourceFingerprint(decision: DecisionRow): Fingerprint {
  const snapshot = decision.sourceSnapshot as SourceSnapshot;
  if (decision.itemType !== "document") return fingerprintOf(snapshot.values);
  return {
    ...fingerprintOf({
      path: snapshot.values.path,
      archived: snapshot.values.archived
    }),
    body: snapshot.body_sha256!
  };
}

export class MergeService {
  private readonly permissions: PermissionService;
  constructor(
    private readonly db: Database,
    private readonly engine: MergeEngine,
    private readonly branches: BranchService
  ) {
    this.permissions = new PermissionService(db);
  }

  async preview(userId: string, projectId: string, input: MergePreviewRequest) {
    // The same rules as apply: merges and imports into the default need an
    // owner or admin, and nothing can land on an archived branch (§6.7).
    const target = await findProjectBranch(
      this.db,
      projectId,
      input.target_branch_id
    );
    if (input.kind === "merge" || target?.isDefault)
      await this.permissions.projectEditor(userId, projectId);
    else await this.permissions.projectAccess(userId, projectId);
    if (target) assertBranchWritable(target, { branchId: target.id });
    return {
      preview: await this.engine.preview(projectId, {
        sourceBranchId: input.source_branch_id,
        targetBranchId: input.target_branch_id,
        kind: input.kind,
        selection: input.selection
      })
    };
  }

  async apply(
    userId: string,
    projectId: string,
    input: MergeApplyRequest,
    key?: string
  ) {
    if (!key)
      throw new ApiError(
        400,
        "VALIDATION_ERROR",
        "An Idempotency-Key header is required."
      );
    // Members import into working branches. A merge, an import into the
    // default branch and archiving the source need an owner or admin.
    const target = await findProjectBranch(
      this.db,
      projectId,
      input.target_branch_id
    );
    if (input.kind === "merge" || target?.isDefault || input.archive_source)
      await this.permissions.projectEditor(userId, projectId);
    else await this.permissions.projectAccess(userId, projectId);
    return this.engine.apply(projectId, {
      sourceBranchId: input.source_branch_id,
      targetBranchId: input.target_branch_id,
      kind: input.kind,
      selection: input.selection,
      choices: input.choices,
      previewFingerprint: input.preview_fingerprint,
      archiveSource: input.archive_source,
      completeOnboarding: input.complete_onboarding,
      trigger: "dashboard",
      userId,
      idempotencyKey: key
    });
  }

  async runs(userId: string, projectId: string, query: MergeRunsQuery) {
    await this.permissions.projectAccess(userId, projectId);
    const clauses = [eq(branchMergeRuns.projectId, projectId)];
    if (query.branch_id)
      clauses.push(
        or(
          eq(branchMergeRuns.targetBranchId, query.branch_id),
          eq(branchMergeRuns.sourceBranchId, query.branch_id)
        )!
      );
    if (query.cursor) {
      const cursor = decodeCursor(query.cursor);
      clauses.push(
        or(
          lt(branchMergeRuns.createdAt, cursor.createdAt),
          and(
            eq(branchMergeRuns.createdAt, cursor.createdAt),
            lt(branchMergeRuns.id, cursor.id)
          )
        )!
      );
    }
    const rows = await this.db
      .select()
      .from(branchMergeRuns)
      .where(and(...clauses))
      .orderBy(desc(branchMergeRuns.createdAt), desc(branchMergeRuns.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    return {
      runs: page.map(runJson),
      next_cursor: rows.length > query.limit ? encodeCursor(page.at(-1)!) : null
    };
  }

  async decisions(userId: string, projectId: string, query: DecisionsQuery) {
    await this.permissions.projectAccess(userId, projectId);
    const rows = await this.db
      .select()
      .from(branchMergeDecisions)
      .where(
        and(
          eq(branchMergeDecisions.projectId, projectId),
          query.branch_id
            ? eq(branchMergeDecisions.targetBranchId, query.branch_id)
            : undefined,
          query.status
            ? eq(branchMergeDecisions.status, query.status)
            : undefined
        )
      )
      .orderBy(
        desc(branchMergeDecisions.createdAt),
        desc(branchMergeDecisions.id)
      );
    return { decisions: rows.map(decisionJson) };
  }

  /**
   * Owners and admins settle a decision (spec §9.8). use_target keeps the
   * target and records the source state as agreed; use_source applies the
   * recorded source values when the target hasn't changed since.
   */
  async resolve(
    userId: string,
    projectId: string,
    decisionId: string,
    choice: MergeChoice
  ) {
    await this.permissions.projectEditor(userId, projectId);
    const outcome = await this.db.transaction(async (tx) => {
      await this.branches.lockActiveProject(tx, projectId);
      const [decision] = await tx
        .select()
        .from(branchMergeDecisions)
        .where(
          and(
            eq(branchMergeDecisions.id, decisionId),
            eq(branchMergeDecisions.projectId, projectId)
          )
        )
        .for("update");
      if (!decision)
        throw new ApiError(404, "NOT_FOUND", "Decision not found.");
      if (decision.status !== "open")
        throw new ApiError(
          409,
          "CONFLICT",
          "This decision is already settled.",
          {
            reason: "decision_closed",
            status: decision.status
          }
        );
      const target = await this.branches.lockBranch(
        tx,
        projectId,
        decision.targetBranchId
      );
      assertBranchWritable(target, { branchId: target.id });
      const source = sourceFingerprint(decision);
      if (choice === "use_target")
        return {
          decision: await this.settle(tx, decision, "resolved_target", userId)
        };

      const current = await this.currentTarget(tx, decision);
      // A claimed task is never modified; settle it after the claim ends.
      const claimedTask = "task" in current ? current.task : undefined;
      if (claimedTask && (await activeClaim(tx, claimedTask.id)))
        throw new ApiError(
          409,
          "TASK_ALREADY_CLAIMED",
          "The task is claimed on its branch. Try again when the claim ends.",
          { task_id: claimedTask.id }
        );
      if (!sameFingerprint(current.fingerprint, decision.targetFingerprint)) {
        // The target moved on. If it now matches the source, there is
        // nothing left to decide; otherwise refresh and ask again.
        if (sameFingerprint(current.fingerprint, source))
          return {
            decision: await this.settle(tx, decision, "resolved_source", userId)
          };
        const [refreshed] = await tx
          .update(branchMergeDecisions)
          .set({
            targetSnapshot: { values: current.values },
            targetFingerprint: current.fingerprint,
            fields: changedFields(source, current.fingerprint)
          })
          .where(eq(branchMergeDecisions.id, decision.id))
          .returning();
        return { stale: decisionJson(refreshed!) };
      }
      await this.applySource(tx, decision, current, userId);
      return {
        decision: await this.settle(tx, decision, "resolved_source", userId)
      };
    });
    // The refreshed decision is saved before the 409 goes out.
    if ("stale" in outcome)
      throw new ApiError(
        409,
        "BRANCH_DECISION_STALE",
        "The target changed since this decision was recorded.",
        { decision: outcome.stale }
      );
    return { decision: outcome.decision };
  }

  private async settle(
    tx: Transaction,
    decision: DecisionRow,
    status: "resolved_source" | "resolved_target",
    userId: string
  ) {
    const snapshot = decision.sourceSnapshot as SourceSnapshot;
    await upsertBaseline(tx, {
      projectId: decision.projectId,
      a: decision.sourceBranchId,
      b: decision.targetBranchId,
      itemType: decision.itemType,
      lineageKey: snapshot.baseline_key,
      fingerprint: sourceFingerprint(decision),
      runId: decision.runId
    });
    const [settled] = await tx
      .update(branchMergeDecisions)
      .set({ status, resolvedByUserId: userId, resolvedAt: new Date() })
      .where(eq(branchMergeDecisions.id, decision.id))
      .returning();
    await insertProjectEvent(tx, {
      projectId: decision.projectId,
      branchId: decision.targetBranchId,
      actorUserId: userId,
      entityId: decision.id,
      type: "decision.resolved",
      payload: {
        decision_id: decision.id,
        choice: status === "resolved_source" ? "use_source" : "use_target"
      }
    });
    return decisionJson(settled!);
  }

  // The target item's current values and fingerprint, compared the way the
  // engine compares them.
  private async currentTarget(tx: Transaction, decision: DecisionRow) {
    if (decision.itemType === "task") {
      const [task] = await tx
        .select()
        .from(tasks)
        .where(eq(tasks.id, decision.targetItemId))
        .for("update");
      if (!task) throw new ApiError(404, "NOT_FOUND", "Task not found.");
      const values = taskValues(task);
      return { values, fingerprint: fingerprintOf(values), task };
    }
    if (decision.itemType === "chat") {
      const [chat] = await tx
        .select()
        .from(chats)
        .where(eq(chats.id, decision.targetItemId))
        .for("update");
      if (!chat) throw new ApiError(404, "NOT_FOUND", "Chat not found.");
      const values = { name: chat.name ?? null };
      return { values, fingerprint: fingerprintOf(values), chat };
    }
    const [document] = await tx
      .select()
      .from(documents)
      .where(eq(documents.id, decision.targetItemId))
      .for("update");
    if (!document) throw new ApiError(404, "NOT_FOUND", "Document not found.");
    const [revision] = await tx
      .select()
      .from(documentRevisions)
      .where(
        and(
          eq(documentRevisions.documentId, document.id),
          eq(documentRevisions.revisionNumber, document.currentRevision)
        )
      );
    const attachments = await tx
      .select()
      .from(documentAttachments)
      .where(eq(documentAttachments.documentId, document.id));
    const lineage = new Map(attachments.map((row) => [row.id, lineageOf(row)]));
    const values = {
      path: document.path,
      archived: document.archivedAt !== null
    };
    return {
      values,
      fingerprint: {
        ...fingerprintOf(values),
        body: digest(rewriteRefs(revision?.contentMarkdown ?? "", lineage))
      },
      document,
      attachments
    };
  }

  private async applySource(
    tx: Transaction,
    decision: DecisionRow,
    current: Awaited<ReturnType<MergeService["currentTarget"]>>,
    userId: string
  ) {
    const snapshot = decision.sourceSnapshot as SourceSnapshot;
    const fields = changedFields(
      sourceFingerprint(decision),
      current.fingerprint
    );
    const now = new Date();
    if ("task" in current && current.task) {
      const [end] = await tx
        .select({ value: max(tasks.position) })
        .from(tasks)
        .where(
          and(
            eq(tasks.branchId, current.task.branchId),
            eq(
              tasks.status,
              snapshot.values.status as typeof tasks.$inferSelect.status
            ),
            ne(tasks.id, current.task.id)
          )
        );
      const updated = await applyTaskValues(tx, {
        target: current.task,
        values: snapshot.values as ReturnType<typeof taskValues>,
        fields,
        position: () => (end?.value ?? -1) + 1,
        now
      });
      await insertProjectEvent(tx, {
        projectId: decision.projectId,
        branchId: decision.targetBranchId,
        actorUserId: userId,
        entityId: updated.id,
        type: "task.updated",
        payload: { fields, decision_id: decision.id }
      });
      return;
    }
    if ("chat" in current && current.chat) {
      await tx
        .update(chats)
        .set({ name: snapshot.values.name as string | null })
        .where(eq(chats.id, current.chat.id));
      return;
    }
    const document = current.document!;
    const set: Partial<typeof documents.$inferInsert> = { updatedAt: now };
    if (fields.includes("path")) {
      const [taken] = await tx
        .select({ id: documents.id })
        .from(documents)
        .where(
          and(
            eq(documents.branchId, document.branchId),
            eq(documents.path, snapshot.values.path as string),
            ne(documents.id, document.id)
          )
        );
      if (taken)
        throw new ApiError(
          409,
          "CONFLICT",
          "Another document on this branch uses that path.",
          { reason: "path_taken" }
        );
      set.path = snapshot.values.path as string;
    }
    if (fields.includes("archived"))
      set.archivedAt = snapshot.values.archived
        ? (document.archivedAt ?? now)
        : null;
    if (fields.includes("body")) {
      // Source revisions are immutable, so the snapshot still holds.
      const [revision] = await tx
        .select()
        .from(documentRevisions)
        .where(eq(documentRevisions.id, snapshot.revision_id!));
      if (!revision)
        throw new ApiError(
          503,
          "DOCUMENT_CONTENT_UNAVAILABLE",
          "The source revision is unavailable."
        );
      const sourceAttachments = await tx
        .select()
        .from(documentAttachments)
        .where(eq(documentAttachments.documentId, revision.documentId));
      const targetByLineage = new Map(
        (current.attachments ?? []).map((row) => [lineageOf(row), row.id])
      );
      const refs = new Map<string, string>();
      for (const attachment of sourceAttachments) {
        const mapped = targetByLineage.get(lineageOf(attachment));
        if (mapped) refs.set(attachment.id, mapped);
      }
      set.currentRevision = document.currentRevision + 1;
      await tx.insert(documentRevisions).values({
        projectId: document.projectId,
        branchId: document.branchId,
        documentId: document.id,
        originId: lineageOf(revision),
        revisionNumber: document.currentRevision + 1,
        contentMarkdown: rewriteRefs(revision.contentMarkdown, refs),
        authorType: revision.authorType,
        authorUserId: revision.authorUserId,
        authorAgentId: revision.authorAgentId,
        createdAt: now
      });
    }
    const [updated] = await tx
      .update(documents)
      .set(set)
      .where(eq(documents.id, document.id))
      .returning();
    await insertProjectEvent(tx, {
      projectId: decision.projectId,
      branchId: decision.targetBranchId,
      actorUserId: userId,
      entityId: updated!.id,
      type: "document.updated",
      payload: {
        path: updated!.path,
        revision: updated!.currentRevision,
        decision_id: decision.id
      }
    });
  }
}
