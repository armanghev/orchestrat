import { branchItemBaselines, type Database } from "@orchestrat/db";
import { and, eq, or } from "drizzle-orm";
import { sameFingerprint, type Fingerprint } from "./fingerprint.js";

// Baselines are the last state two branches agreed on for one item (spec
// §4.3, §9.3). They are stored under the sorted branch pair, so one row
// serves both merge directions.

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type Executor = Database | Transaction;
export type MergeItemType = "task" | "document" | "chat";
export type Baseline = { fingerprint: Fingerprint; updatedAt: Date };

export const sortedPair = (a: string, b: string) =>
  a < b ? { low: a, high: b } : { low: b, high: a };

export async function loadBaselines(
  db: Executor,
  a: string,
  b: string,
  itemType: MergeItemType
): Promise<Map<string, Baseline>> {
  const { low, high } = sortedPair(a, b);
  const rows = await db
    .select()
    .from(branchItemBaselines)
    .where(
      and(
        eq(branchItemBaselines.branchLowId, low),
        eq(branchItemBaselines.branchHighId, high),
        eq(branchItemBaselines.itemType, itemType)
      )
    );
  return new Map(
    rows.map((row) => [
      row.lineageKey,
      { fingerprint: row.fingerprint, updatedAt: row.updatedAt }
    ])
  );
}

export async function upsertBaseline(
  tx: Transaction,
  value: {
    projectId: string;
    a: string;
    b: string;
    itemType: MergeItemType;
    lineageKey: string;
    fingerprint: Fingerprint;
    runId: string | null;
  }
) {
  const { low, high } = sortedPair(value.a, value.b);
  const now = new Date();
  await tx
    .insert(branchItemBaselines)
    .values({
      projectId: value.projectId,
      branchLowId: low,
      branchHighId: high,
      itemType: value.itemType,
      lineageKey: value.lineageKey,
      fingerprint: value.fingerprint,
      lastRunId: value.runId,
      updatedAt: now
    })
    .onConflictDoUpdate({
      target: [
        branchItemBaselines.branchLowId,
        branchItemBaselines.branchHighId,
        branchItemBaselines.itemType,
        branchItemBaselines.lineageKey
      ],
      set: {
        fingerprint: value.fingerprint,
        lastRunId: value.runId,
        updatedAt: now
      }
    });
}

/**
 * Stacked branches (spec §9.3): when an item copied from `source` to
 * `target` still matches what `source` agreed with a third branch, the copy
 * agrees with that branch too. So main → feat1 → feat2 can later merge
 * feat2 → main without spurious conflicts.
 */
export async function inheritBaselines(
  tx: Transaction,
  value: {
    projectId: string;
    source: string;
    target: string;
    itemType: MergeItemType;
    lineageKey: string;
    fingerprint: Fingerprint;
    runId: string | null;
  }
) {
  const rows = await tx
    .select()
    .from(branchItemBaselines)
    .where(
      and(
        eq(branchItemBaselines.projectId, value.projectId),
        eq(branchItemBaselines.itemType, value.itemType),
        eq(branchItemBaselines.lineageKey, value.lineageKey),
        or(
          eq(branchItemBaselines.branchLowId, value.source),
          eq(branchItemBaselines.branchHighId, value.source)
        )
      )
    );
  for (const row of rows) {
    const other =
      row.branchLowId === value.source ? row.branchHighId : row.branchLowId;
    if (other === value.target) continue;
    if (!sameFingerprint(row.fingerprint, value.fingerprint)) continue;
    await upsertBaseline(tx, {
      projectId: value.projectId,
      a: value.target,
      b: other,
      itemType: value.itemType,
      lineageKey: value.lineageKey,
      fingerprint: value.fingerprint,
      runId: value.runId
    });
  }
}
