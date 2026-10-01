import {
  projectBranches,
  repositoryConnections,
  repositoryRefs,
  type Database
} from "@orchestrat/db";
import { branchNameSchema } from "@orchestrat/protocol";
import { and, desc, eq, isNull, ne } from "drizzle-orm";
import { insertProjectEvent } from "../agent-service.js";
import { defaultBranch, type BranchRow } from "../branch-context.js";
import type { BranchService } from "../branch-service.js";
import { updateConnection } from "./connection-status.js";
import type {
  ConnectionRow,
  MergedChange,
  ProviderAdapter,
  ProviderEvent,
  ProviderName,
  RemoteBranch
} from "./types.js";

// Provider branch state → Orchestrat branches (docs/project-branches.md
// §8.2, §8.7, §8.8). Events are hints: deletes are confirmed through the
// provider API, refs keep one row per generation of a name, and the default
// branch is never archived by anything a provider says.

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type RefRow = typeof repositoryRefs.$inferSelect;
type Signal = "event" | "reconcile" | "connect_snapshot";

export type MergeHandler = (
  connection: ConnectionRow,
  change: MergedChange,
  deliveryId: string | null
) => Promise<void>;

export class BranchSync {
  /** Set by the merge wiring (§8.6); merges are skipped until it is. */
  onMerged?: MergeHandler;

  constructor(
    private readonly db: Database,
    private readonly branches: BranchService,
    private readonly adapters: Map<ProviderName, ProviderAdapter>,
    private readonly now: () => Date = () => new Date()
  ) {}

  private adapter(connection: ConnectionRow) {
    const adapter = this.adapters.get(connection.provider);
    if (!adapter) throw new Error(`No ${connection.provider} adapter.`);
    return adapter;
  }

  /** Applies one delivery's events in order. */
  async apply(
    connection: ConnectionRow,
    events: ProviderEvent[],
    deliveryId: string | null
  ) {
    for (const event of events) {
      if (event.type === "ref_pushed")
        await this.pushed(
          connection,
          event.name,
          event.sha,
          "event",
          deliveryId
        );
      else if (event.type === "ref_deleted") {
        // Confirm before archiving anything (§8.2).
        const remote = await this.adapter(connection).getBranch(
          connection,
          event.name
        );
        await this.deleted(
          connection,
          event.name,
          event.beforeSha,
          remote,
          deliveryId
        );
      } else if (event.type === "default_branch_changed")
        await this.reconcile(connection);
      else if (event.type === "repository_renamed")
        await this.update(connection.id, {
          repositoryFullName: event.fullName,
          repositoryUrl: event.url
        });
      else if (event.type === "change_merged")
        await this.onMerged?.(connection, event.change, deliveryId);
      else if (event.type === "installation_deleted")
        await this.update(connection.id, {
          status: "disconnected",
          statusReason: "The app was uninstalled.",
          disconnectedAt: this.now()
        });
      else if (event.type === "authorization_revoked")
        await this.update(connection.id, {
          status: "needs_reauthorization",
          statusReason: "Access was revoked on the provider."
        });
      else if (event.type === "installation_suspended")
        await this.update(connection.id, {
          status: "suspended",
          statusReason: "The app is suspended on the provider."
        });
      else if (event.type === "installation_unsuspended") {
        await this.update(connection.id, {
          status: "active",
          statusReason: null
        });
        await this.reconcile({ ...connection, status: "active" });
      } else if (event.type === "reconcile") await this.reconcile(connection);
    }
    await this.update(connection.id, { lastEventAt: this.now() });
  }

  private async update(
    connectionId: string,
    values: Partial<typeof repositoryConnections.$inferInsert>
  ) {
    await updateConnection(this.db, connectionId, values, this.now());
  }

  private async locked<T>(
    connection: ConnectionRow,
    work: (tx: Transaction) => Promise<T>
  ) {
    return this.db.transaction(async (tx) => {
      await this.branches.lockActiveProject(tx, connection.projectId);
      return work(tx);
    });
  }

  private async activeRef(tx: Transaction, connectionId: string, name: string) {
    const [ref] = await tx
      .select()
      .from(repositoryRefs)
      .where(
        and(
          eq(repositoryRefs.connectionId, connectionId),
          eq(repositoryRefs.name, name),
          eq(repositoryRefs.state, "active")
        )
      )
      .limit(1);
    return ref ?? null;
  }

  /** A branch was created or pushed: same generation, or a new one. */
  async pushed(
    connection: ConnectionRow,
    name: string,
    sha: string | null,
    signal: Signal,
    deliveryId: string | null
  ) {
    await this.locked(connection, async (tx) => {
      const ref = await this.activeRef(tx, connection.id, name);
      if (ref) {
        const moved = sha !== null && sha !== ref.headSha;
        await tx
          .update(repositoryRefs)
          .set({ headSha: sha ?? ref.headSha, lastSeenAt: this.now() })
          .where(eq(repositoryRefs.id, ref.id));
        // Branches only snapshotted at connect get one on their first push.
        if (
          !ref.branchId &&
          (moved || ref.createdSignal !== "connect_snapshot")
        )
          await this.linkOrCreate(tx, connection, ref);
        return;
      }
      const [created] = await tx
        .insert(repositoryRefs)
        .values({
          projectId: connection.projectId,
          connectionId: connection.id,
          name,
          headSha: sha,
          firstSeenSha: sha,
          createdSignal: signal,
          createdDeliveryId: deliveryId
        })
        .returning();
      if (signal !== "connect_snapshot")
        await this.linkOrCreate(tx, connection, created!);
    });
  }

  /**
   * Links an active Orchestrat branch of the same name that no ref tracks
   * yet (created by the CLI, the dashboard, or the default), or creates one.
   */
  async linkOrCreate(
    tx: Transaction,
    connection: ConnectionRow,
    ref: RefRow
  ): Promise<BranchRow | null> {
    const [existing] = await tx
      .select()
      .from(projectBranches)
      .where(
        and(
          eq(projectBranches.projectId, connection.projectId),
          eq(projectBranches.name, ref.name),
          isNull(projectBranches.archivedAt)
        )
      )
      .limit(1);
    let branch: BranchRow | null = existing ?? null;
    if (branch) {
      const [tracked] = await tx
        .select({ id: repositoryRefs.id })
        .from(repositoryRefs)
        .where(
          and(
            eq(repositoryRefs.connectionId, connection.id),
            eq(repositoryRefs.branchId, branch.id),
            eq(repositoryRefs.state, "active"),
            ne(repositoryRefs.id, ref.id)
          )
        )
        .limit(1);
      if (tracked) branch = null;
    }
    if (!branch) {
      // Provider names Orchestrat can't store stay unlinked refs.
      if (!branchNameSchema.safeParse(ref.name).success || existing)
        return null;
      [branch] = await tx
        .insert(projectBranches)
        .values({
          projectId: connection.projectId,
          name: ref.name,
          isDefault: false,
          nameSource: "provider",
          createdVia: "provider",
          onboardingState: "pending"
        })
        .returning();
      await insertProjectEvent(tx, {
        projectId: connection.projectId,
        entityId: branch!.id,
        type: "branch.created",
        payload: { name: ref.name, created_via: "provider" }
      });
    }
    await tx
      .update(repositoryRefs)
      .set({ branchId: branch!.id })
      .where(eq(repositoryRefs.id, ref.id));
    return branch!;
  }

  /**
   * A branch was deleted, as far as the event says. `remote` is what the
   * provider answers now: a branch that still exists means the event was
   * stale, or the name was deleted and recreated (`beforeSha` matched).
   */
  async deleted(
    connection: ConnectionRow,
    name: string,
    beforeSha: string | null,
    remote: RemoteBranch | null,
    deliveryId: string | null
  ) {
    await this.locked(connection, async (tx) => {
      const ref = await this.activeRef(tx, connection.id, name);
      if (!ref) return;
      const matched =
        beforeSha !== null &&
        (ref.headSha === beforeSha || ref.firstSeenSha === beforeSha);
      if (remote && !matched) return;
      await this.endGeneration(tx, connection, ref, deliveryId);
      if (!remote) return;
      // Deleted and recreated: a new generation and a new branch.
      const [created] = await tx
        .insert(repositoryRefs)
        .values({
          projectId: connection.projectId,
          connectionId: connection.id,
          name,
          headSha: remote.sha,
          firstSeenSha: remote.sha,
          createdSignal: "event",
          createdDeliveryId: deliveryId
        })
        .returning();
      await this.linkOrCreate(tx, connection, created!);
    });
  }

  private async endGeneration(
    tx: Transaction,
    connection: ConnectionRow,
    ref: RefRow,
    deliveryId: string | null
  ) {
    await tx
      .update(repositoryRefs)
      .set({
        state: "deleted",
        deletedAt: this.now(),
        deletedDeliveryId: deliveryId
      })
      .where(eq(repositoryRefs.id, ref.id));
    if (!ref.branchId) return;
    const [branch] = await tx
      .select()
      .from(projectBranches)
      .where(eq(projectBranches.id, ref.branchId));
    // The default branch is never archived; it shows as missing instead.
    if (branch && !branch.isDefault && !branch.archivedAt)
      await this.branches.archiveInTransaction(tx, branch, {
        reason: "provider_deleted",
        userId: null
      });
  }

  /**
   * Re-reads the provider: the repository, every branch and merged changes
   * since the watermark (§8.8). Lost or out-of-order events converge here.
   */
  async reconcile(connection: ConnectionRow) {
    if (
      connection.status === "suspended" ||
      connection.status === "disconnected"
    )
      return;
    const adapter = this.adapter(connection);
    const repository = await adapter.getRepository(connection);
    const remote = await adapter.listBranches(connection);
    const byName = new Map(remote.map((branch) => [branch.name, branch]));
    const refs = await this.db
      .select()
      .from(repositoryRefs)
      .where(
        and(
          eq(repositoryRefs.connectionId, connection.id),
          eq(repositoryRefs.state, "active")
        )
      );
    await this.defaultChanged(
      connection,
      repository.defaultBranch,
      byName,
      refs
    );
    await this.update(connection.id, {
      repositoryFullName: repository.fullName,
      repositoryUrl: repository.url,
      providerDefaultBranch: repository.defaultBranch
    });
    const active = new Map(refs.map((ref) => [ref.name, ref]));
    for (const branch of remote) {
      const ref = active.get(branch.name);
      if (!ref || ref.headSha !== branch.sha)
        await this.pushed(
          connection,
          branch.name,
          branch.sha,
          "reconcile",
          null
        );
    }
    // The list is authoritative: a ref it lacks is confirmed deleted.
    for (const ref of refs)
      if (!byName.has(ref.name))
        await this.deleted(connection, ref.name, null, null, null);
    const state = connection.reconcileState as { merged_since?: string };
    const since = new Date(
      new Date(state.merged_since ?? connection.createdAt).getTime() - 3_600_000
    );
    const started = this.now();
    for (const change of await adapter.listMergedChanges(connection, since))
      await this.onMerged?.(connection, change, null);
    const maintained = (await adapter.maintain?.(connection)) ?? {};
    await this.update(connection.id, {
      ...maintained,
      status: connection.status === "error" ? "active" : connection.status,
      statusReason:
        connection.status === "error" ? null : connection.statusReason,
      lastReconciledAt: this.now(),
      reconcileState: {
        ...(connection.reconcileState as Record<string, unknown>),
        merged_since: started.toISOString()
      }
    });
  }

  /**
   * The provider's default moved (§8.2). When the Orchestrat default still
   * tracks the old one it follows: a rename (old name gone, same head)
   * renames it in place; otherwise the new default's branch becomes the
   * default. A default that tracked something else gets a notice instead.
   */
  private async defaultChanged(
    connection: ConnectionRow,
    next: string,
    remote: Map<string, RemoteBranch>,
    refs: RefRow[]
  ) {
    const previous = connection.providerDefaultBranch;
    if (previous === next) return;
    await this.locked(connection, async (tx) => {
      const current = await defaultBranch(tx, connection.projectId);
      const oldRef = refs.find((ref) => ref.name === previous);
      if (!oldRef || oldRef.branchId !== current.id) {
        await tx
          .update(repositoryConnections)
          .set({
            reconcileState: {
              ...(connection.reconcileState as Record<string, unknown>),
              default_notice: { from: previous, to: next }
            },
            updatedAt: this.now()
          })
          .where(eq(repositoryConnections.id, connection.id));
        return;
      }
      const renamed =
        !remote.has(previous) &&
        remote.get(next)?.sha !== undefined &&
        remote.get(next)?.sha === oldRef.headSha &&
        !refs.some((ref) => ref.name === next);
      if (renamed) {
        await tx
          .update(repositoryRefs)
          .set({ name: next, lastSeenAt: this.now() })
          .where(eq(repositoryRefs.id, oldRef.id));
        await tx
          .update(projectBranches)
          .set({ name: next, nameSource: "provider", updatedAt: this.now() })
          .where(eq(projectBranches.id, current.id));
        await insertProjectEvent(tx, {
          projectId: connection.projectId,
          entityId: current.id,
          type: "branch.renamed",
          payload: { from: previous, name: next }
        });
        return;
      }
      let ref = await this.activeRef(tx, connection.id, next);
      if (!ref) {
        [ref] = await tx
          .insert(repositoryRefs)
          .values({
            projectId: connection.projectId,
            connectionId: connection.id,
            name: next,
            headSha: remote.get(next)?.sha ?? null,
            firstSeenSha: remote.get(next)?.sha ?? null,
            createdSignal: "reconcile"
          })
          .returning();
      }
      const target =
        (ref!.branchId
          ? (
              await tx
                .select()
                .from(projectBranches)
                .where(eq(projectBranches.id, ref!.branchId))
            )[0]
          : null) ?? (await this.linkOrCreate(tx, connection, ref!));
      if (!target || target.archivedAt) return;
      await this.moveDefault(tx, connection.projectId, current, target);
    });
  }

  async moveDefault(
    tx: Transaction,
    projectId: string,
    from: BranchRow,
    to: BranchRow
  ) {
    if (from.id === to.id) return;
    const now = this.now();
    await tx
      .update(projectBranches)
      .set({ isDefault: false, updatedAt: now })
      .where(eq(projectBranches.id, from.id));
    await tx
      .update(projectBranches)
      .set({ isDefault: true, updatedAt: now })
      .where(eq(projectBranches.id, to.id));
    await insertProjectEvent(tx, {
      projectId,
      entityId: to.id,
      type: "branch.default_changed",
      payload: { from_branch_id: from.id, name: to.name }
    });
  }

  /** The newest deleted ref of a name whose head matches (§8.6). */
  async deletedRef(connectionId: string, name: string, sha: string | null) {
    if (!sha) return null;
    const rows = await this.db
      .select()
      .from(repositoryRefs)
      .where(
        and(
          eq(repositoryRefs.connectionId, connectionId),
          eq(repositoryRefs.name, name),
          eq(repositoryRefs.state, "deleted")
        )
      )
      .orderBy(desc(repositoryRefs.deletedAt));
    return (
      rows.find((ref) => ref.headSha === sha || ref.firstSeenSha === sha) ??
      null
    );
  }
}
