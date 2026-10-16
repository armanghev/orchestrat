import {
  branchMergeRuns,
  projectBranches,
  repositoryRefs,
  type Database
} from "@orchestrat/db";
import { and, eq, isNull } from "drizzle-orm";
import type { MergeEngine } from "../merges/engine.js";
import type { BranchSync } from "./branch-sync.js";
import type { ConnectionRow, MergedChange } from "./types.js";

// A merged pull or merge request merges the branches in Orchestrat too.
// Conflicts become decisions and the target is kept; provider automation never
// resolves them.

const DELETED_SOURCE_WINDOW_MS = 7 * 24 * 3_600_000;

export class ProviderMerges {
  constructor(
    private readonly db: Database,
    private readonly engine: MergeEngine,
    private readonly sync: BranchSync,
    private readonly now: () => Date = () => new Date()
  ) {}

  async handle(connection: ConnectionRow, change: MergedChange) {
    const dedupeKey = `${connection.provider}:${connection.providerRepositoryId}:merge:${change.number}:${change.mergedAt}`;
    const target = await this.target(connection, change.baseRef);
    if (!target) return;
    const provider = {
      provider: connection.provider,
      changeNumber: change.number,
      changeUrl: change.url,
      headSha: change.headSha,
      mergeSha: change.mergeSha
    };
    // A fork's branch isn't ours; the run records that it was skipped.
    if (change.fromFork)
      return this.skip(connection, target, dedupeKey, provider, "fork");
    const source = await this.source(connection, change);
    if (!source || source === target)
      return this.skip(
        connection,
        target,
        dedupeKey,
        provider,
        source ? "same_branch" : "no_source_branch"
      );
    await this.engine.apply(connection.projectId, {
      sourceBranchId: source,
      targetBranchId: target,
      kind: "merge",
      trigger: "provider_merge",
      userId: null,
      dedupeKey,
      provider
    });
  }

  private async activeRef(connectionId: string, name: string) {
    const [ref] = await this.db
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

  /**
   * The head branch: its active ref; else a recently deleted generation with
   * the merged head (providers often delete the head before announcing the
   * merge); else an active Orchestrat branch of that name nothing tracks.
   */
  private async source(connection: ConnectionRow, change: MergedChange) {
    const active = await this.activeRef(connection.id, change.headRef);
    if (active?.branchId) return active.branchId;
    const deleted = await this.sync.deletedRef(
      connection.id,
      change.headRef,
      change.headSha
    );
    if (
      deleted?.branchId &&
      deleted.deletedAt &&
      this.now().getTime() - deleted.deletedAt.getTime() <=
        DELETED_SOURCE_WINDOW_MS
    )
      return deleted.branchId;
    const [untracked] = await this.db
      .select({ id: projectBranches.id })
      .from(projectBranches)
      .where(
        and(
          eq(projectBranches.projectId, connection.projectId),
          eq(projectBranches.name, change.headRef),
          isNull(projectBranches.archivedAt)
        )
      )
      .limit(1);
    if (!untracked) return null;
    const [tracked] = await this.db
      .select({ id: repositoryRefs.id })
      .from(repositoryRefs)
      .where(
        and(
          eq(repositoryRefs.branchId, untracked.id),
          eq(repositoryRefs.state, "active")
        )
      )
      .limit(1);
    return tracked ? null : untracked.id;
  }

  /** The base branch: its linked branch, or one linked or created now. */
  private async target(connection: ConnectionRow, name: string) {
    const ref = await this.activeRef(connection.id, name);
    if (ref?.branchId) return ref.branchId;
    await this.sync.pushed(
      connection,
      name,
      ref?.headSha ?? null,
      "event",
      null
    );
    return (await this.activeRef(connection.id, name))?.branchId ?? null;
  }

  private async skip(
    connection: ConnectionRow,
    target: string,
    dedupeKey: string,
    provider: {
      provider: ConnectionRow["provider"];
      changeNumber: string;
      changeUrl: string | null;
      headSha: string | null;
      mergeSha: string | null;
    },
    reason: "no_source_branch" | "same_branch" | "fork"
  ) {
    const [existing] = await this.db
      .select({ id: branchMergeRuns.id })
      .from(branchMergeRuns)
      .where(
        and(
          eq(branchMergeRuns.projectId, connection.projectId),
          eq(branchMergeRuns.dedupeKey, dedupeKey)
        )
      )
      .limit(1);
    if (existing) return;
    // Skipped runs have no source to name, so they point at the target.
    await this.db.insert(branchMergeRuns).values({
      projectId: connection.projectId,
      sourceBranchId: target,
      targetBranchId: target,
      kind: "merge",
      trigger: "provider_merge",
      status: "skipped",
      skipReason: reason,
      dedupeKey,
      provider: provider.provider,
      providerChangeNumber: provider.changeNumber,
      providerChangeUrl: provider.changeUrl,
      providerHeadSha: provider.headSha,
      providerMergeSha: provider.mergeSha,
      appliedAt: this.now()
    });
  }
}
