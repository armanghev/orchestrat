import {
  chatMessages,
  chatParticipants,
  chats,
  type Database
} from "@orchestrat/db";
import { asc, eq } from "drizzle-orm";
import type { Baseline, Executor } from "./baselines.js";
import {
  changedFields,
  fingerprintOf,
  sameFingerprint,
  type Fingerprint
} from "./fingerprint.js";
import { lineageOf } from "./task-items.js";

// Chats and messages in the merge engine (docs/project-branches.md §9.6).
// Copies never widen who can read a conversation, and imported messages are
// history, not news: no events, notices or unread counts.

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type ChatRow = typeof chats.$inferSelect;
type ParticipantRow = typeof chatParticipants.$inferSelect;
export type MessageRow = typeof chatMessages.$inferSelect;

export type ChatSide = {
  chats: ChatRow[];
  byLineage: Map<string, ChatRow>;
  byDirectKey: Map<string, ChatRow>;
  participants: Map<string, ParticipantRow[]>;
  messages: Map<string, MessageRow[]>;
};

const group = <T, K>(rows: T[], keyOf: (row: T) => K) => {
  const map = new Map<K, T[]>();
  for (const row of rows)
    map.set(keyOf(row), [...(map.get(keyOf(row)) ?? []), row]);
  return map;
};

export async function loadChatSide(
  db: Executor,
  branchId: string
): Promise<ChatSide> {
  const rows = await db
    .select()
    .from(chats)
    .where(eq(chats.branchId, branchId))
    .orderBy(asc(chats.createdAt), asc(chats.id));
  const participants = await db
    .select()
    .from(chatParticipants)
    .where(eq(chatParticipants.branchId, branchId));
  const messages = await db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.branchId, branchId))
    .orderBy(asc(chatMessages.chatId), asc(chatMessages.sequence));
  return {
    chats: rows,
    byLineage: new Map(rows.map((row) => [lineageOf(row), row])),
    byDirectKey: new Map(
      rows.filter((row) => row.directKey).map((row) => [row.directKey!, row])
    ),
    participants: group(participants, (row) => row.chatId),
    messages: group(messages, (row) => row.chatId)
  };
}

export const chatValues = (chat: ChatRow) => ({ name: chat.name ?? null });

const refOf = (row: ParticipantRow) =>
  row.userId ? `human:${row.userId}` : `agent:${row.agentId}`;

/**
 * Who can read a chat: its participants, plus every project human when no
 * human is in it (observer mode).
 */
export function audience(side: ChatSide, chat: ChatRow) {
  const refs = new Set((side.participants.get(chat.id) ?? []).map(refOf));
  if (!chat.hasHuman) refs.add("*humans");
  return refs;
}

const within = (inner: Set<string>, outer: Set<string>) =>
  [...inner].every(
    (ref) =>
      outer.has(ref) || (ref.startsWith("human:") && outer.has("*humans"))
  );

export type ChatPlanItem = {
  lineage: string;
  baselineKey: string;
  source: ChatRow;
  target: ChatRow | null;
  outcome:
    "copy" | "apply" | "unchanged" | "keep_target" | "conflict" | "skipped";
  reason: "changed_on_both" | "audience_would_widen" | null;
  fields: string[];
  sourceFingerprint: Fingerprint;
  targetFingerprint: Fingerprint | null;
  /** Source messages the target lacks, in source order. */
  messages: MessageRow[];
};

export function planChats(input: {
  selection: "all" | string[];
  source: ChatSide;
  target: ChatSide;
  baselines: Map<string, Baseline>;
  sourceIsLow: boolean;
}): ChatPlanItem[] {
  const { source, target } = input;
  const roots =
    input.selection === "all"
      ? source.chats
      : input.selection
          .map((lineage) => source.byLineage.get(lineage))
          .filter((row): row is ChatRow => Boolean(row));
  const items: ChatPlanItem[] = [];
  for (const chat of roots) {
    const lineage = lineageOf(chat);
    let match = target.byLineage.get(lineage) ?? null;
    // Direct messages also match by their participant pair.
    const pair = chat.directKey ? target.byDirectKey.get(chat.directKey) : null;
    if (!match && pair && !source.byLineage.has(lineageOf(pair))) match = pair;
    const s = fingerprintOf(chatValues(chat));
    const base = {
      lineage,
      baselineKey: match && !input.sourceIsLow ? lineageOf(match) : lineage,
      source: chat,
      target: match,
      sourceFingerprint: s
    };
    const sourceMessages = source.messages.get(chat.id) ?? [];
    if (!match) {
      items.push({
        ...base,
        outcome: "copy",
        reason: null,
        fields: [],
        targetFingerprint: null,
        messages: sourceMessages
      });
      continue;
    }
    const t = fingerprintOf(chatValues(match));
    // Appending to an existing chat must not show messages to anyone the
    // source conversation didn't include. Direct messages always pass.
    if (
      !chat.directKey &&
      !within(audience(target, match), audience(source, chat))
    ) {
      items.push({
        ...base,
        outcome: "skipped",
        reason: "audience_would_widen",
        fields: [],
        targetFingerprint: t,
        messages: []
      });
      continue;
    }
    const present = new Set(
      (target.messages.get(match.id) ?? []).map(lineageOf)
    );
    const messages = sourceMessages.filter(
      (message) => !present.has(lineageOf(message))
    );
    const b = input.baselines.get(base.baselineKey)?.fingerprint;
    const changedSource = changedFields(s, b);
    const changedTarget = changedFields(t, b);
    const outcome = (
      value: Pick<ChatPlanItem, "outcome" | "reason" | "fields">
    ) => items.push({ ...base, ...value, targetFingerprint: t, messages });
    if (sameFingerprint(s, t))
      outcome({ outcome: "unchanged", reason: null, fields: [] });
    else if (b && changedTarget.length === 0)
      outcome({ outcome: "apply", reason: null, fields: changedSource });
    else if (b && changedSource.length === 0)
      outcome({ outcome: "keep_target", reason: null, fields: [] });
    else
      outcome({
        outcome: "conflict",
        reason: "changed_on_both",
        fields: changedFields(s, t)
      });
  }
  return items;
}

type DocumentRef = { id: string; path: string };

/** Document references follow lineage to the target's copy when it has one. */
export const remapRefs = (
  refs: DocumentRef[],
  targetDocuments: Map<string, { id: string; path: string }>
) =>
  refs.map((ref) => {
    const mapped = targetDocuments.get(ref.id);
    return mapped ? { id: mapped.id, path: mapped.path } : ref;
  });

/**
 * A new copy keeps participants, `has_human` and message sequences, and
 * everyone has read it all: copies bring history, not unread news.
 */
export async function insertChatCopy(
  tx: Transaction,
  value: {
    source: ChatRow;
    lineage: string;
    targetBranchId: string;
    participants: ParticipantRow[];
    messages: MessageRow[];
    documentRefs: Map<string, { id: string; path: string }>;
    now: Date;
  }
) {
  const { source } = value;
  const [copy] = await tx
    .insert(chats)
    .values({
      projectId: source.projectId,
      branchId: value.targetBranchId,
      originId: value.lineage,
      kind: source.kind,
      name: source.name,
      directKey: source.directKey,
      hasHuman: source.hasHuman,
      creatorType: source.creatorType,
      creatorUserId: source.creatorUserId,
      creatorAgentId: source.creatorAgentId,
      lastSequence: source.lastSequence,
      createdAt: source.createdAt,
      updatedAt: source.updatedAt
    })
    .returning();
  for (const participant of value.participants)
    await tx.insert(chatParticipants).values({
      projectId: source.projectId,
      branchId: value.targetBranchId,
      chatId: copy!.id,
      userId: participant.userId,
      agentId: participant.agentId,
      lastReadSequence: source.lastSequence,
      joinedAt: participant.joinedAt
    });
  await insertMessages(tx, {
    chat: copy!,
    messages: value.messages,
    keepSequences: true,
    documentRefs: value.documentRefs,
    now: value.now
  });
  return copy!;
}

/** Appends messages; returns the chat's new last sequence. */
export async function insertMessages(
  tx: Transaction,
  value: {
    chat: ChatRow;
    messages: MessageRow[];
    keepSequences: boolean;
    documentRefs: Map<string, { id: string; path: string }>;
    now: Date;
  }
) {
  let sequence = value.chat.lastSequence;
  for (const message of value.messages) {
    if (!value.keepSequences) sequence += 1;
    await tx.insert(chatMessages).values({
      projectId: value.chat.projectId,
      branchId: value.chat.branchId,
      chatId: value.chat.id,
      originId: lineageOf(message),
      sequence: value.keepSequences ? message.sequence : sequence,
      authorType: message.authorType,
      authorUserId: message.authorUserId,
      authorAgentId: message.authorAgentId,
      authorName: message.authorName,
      bodyMarkdown: message.bodyMarkdown,
      mentions: message.mentions,
      documentRefs: remapRefs(
        message.documentRefs as DocumentRef[],
        value.documentRefs
      ),
      createdAt: message.createdAt,
      importedAt: value.now
    });
  }
  return sequence;
}
