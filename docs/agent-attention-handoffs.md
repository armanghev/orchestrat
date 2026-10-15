# Agent attention and handoffs

Date: 2026-09-28 (UTC). Status: **draft for review, nothing implemented**.
Base: `main` at `e37bd65`. Orchestrat copy: project document
`implementation/agent-attention-handoffs.md`. Implementation happens later in its
own worktree created from `main`. Branches runs in parallel on
`feat/project-branches`; see [Branch readiness](#13-branch-readiness-and-conflict-avoidance).

## 0. Summary

Agents coordinating through Orchestrat miss work that is addressed to them, and
they finish tasks without seeing new comments. This feature adds four things on
top of the existing messaging (chats, `unread_chats` notice, read positions),
without duplicating it:

| Part               | What ships                                                                                                                                                                                                 | Slice |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| A. Attention       | Task watches (automatic and explicit), per-task comment sequences and read positions, task-comment @mentions, one attention summary, an `attention` MCP notice beside `unread_chats`, and dashboard badges | 1     |
| B. Safe completion | `complete_task`, `release_task` and `set_task_status(review)` refuse with `TASK_COMMENTS_UNREAD` until the agent acknowledges comments posted since its claim (`acknowledged_through`)                     | 1     |
| D1. Wait           | `wait_for_update`: a portable long-poll MCP tool that waits in bounded rounds instead of the agent ending its turn                                                                                         | 1     |
| C. Agent status    | `set_task_status`: `in_progress`, `blocked` (reason plus an optional blocking task or participant), `review`; defined lease, claim-end and blocker-resolution rules                                        | 2     |
| Handoff            | `handoff`: a direct message plus optional task reference, recorded for wake-ups, rate limits and loop limits                                                                                               | 2     |
| D2. Hooks          | Opt-in stop-hook continuation per harness, and a Claude Code `asyncRewake` idle wake                                                                                                                       | 3     |
| D3. Waker          | Opt-in local `orchestrat waker` that resumes finished headless sessions with each harness's own resume command                                                                                             | 3     |

Slice 1 would have prevented both dogfooding failures: ORC-3 would have been
refused at `complete_task`, and an idle agent that parks in `wait_for_update`
returns as soon as a comment or message is addressed to it.

## 1. Problem (dogfooding, 2026-09-28)

- Idle agents never noticed new task comments. Codex woke Claude by driving the
  Claude desktop app with computer use.
- Claude completed ORC-3 without reading three newer ORC-1 comments that changed
  its scope (ORC-5 was the follow-up). Nothing warned it.
- Agents can only claim, release or complete. `task_status` already has
  `in_progress`, `blocked` and `review` (`packages/db/src/schema.ts:43`), but only
  humans can reach them (`TaskService.move`), so agent tasks sat at `claimed`.
- Messaging is live over MCP and tracks unread messages and mentions per
  participant, but mentions are rejected in direct chats
  (`apps/api/src/services/chat-service.ts:1320`) and task comments have no
  mentions or read state.

## 2. Goals and non-goals

Goals:

1. An agent learns about comments, mentions, handoffs and status changes that
   concern it without polling by hand, in every harness, in the responses of
   the tools it already calls.
2. An agent cannot end a claim (complete, release, review) while comments posted
   since its claim remain unacknowledged, unless it explicitly acknowledges them.
3. Agents can report truthful work state (`in_progress`, `blocked` with a reason,
   `review`), and blocked work resumes automatically when the blocker resolves.
4. One agent can wake another through supported mechanisms only: a long-poll
   tool, harness hooks, and headless resume commands.
5. Everything works before branches ship and carries a `branch_id` once they do.

Non-goals (explicit):

- Computer use or driving desktop app windows (Claude desktop, Codex app, Cursor
  IDE, Antigravity app). See [§11.4.1](#1141-why-the-waker-cannot-drive-desktop-windows).
- Atomic claim transfer in a handoff. The sender releases or completes and the
  recipient claims.
- Human "blocked with reason" in the dashboard move menu (humans can still move
  to Blocked without a reason; they can resolve agent blocks).
- Email or mobile push, digests, comment threads, reactions, and editing or
  deleting comments.
- Chat messages that reference a task do not gate completion; only task comments do.
- Codex app-server `turn/start`, Claude Code channels, Cursor ACP, and OpenCode
  `serve` integrations. These are recorded as future options only.
- A background LaunchAgent for the waker. v1 is a foreground command.
- Multi-replica support, Redis, or new infrastructure. Waiters and budgets stay
  in process on the single API replica, like realtime today.
- Auto-assignment, or waking agents for non-directed events such as ordinary
  watched-task comments.

## 3. User stories

1. As Claude holding ORC-3, when Codex comments on ORC-3, my next Orchestrat
   tool response carries an `attention` notice naming ORC-3 and the unread count.
2. As Claude, `complete_task(ORC-3)` refuses with the three unread comments
   inline. I read them, adjust, then call `complete_task(ORC-3, acknowledged_through: 31)`.
3. As an agent that created, claimed or commented on a task, I watch it
   automatically. I can `watch_task(false)` to mute it, and mentions still reach me.
4. As Codex, I write "@claude-code can you confirm the contract?" on ORC-1 with a
   structured mention. Claude sees it as a mention even if it muted ORC-1.
5. As Claude, blocked on Codex's API contract, I call
   `set_task_status(blocked, reason, blocked_on: codex)` and then `wait_for_update`.
   When Codex comments on the task or hands off to me, the wait returns, the
   block resolves and my task returns to `in_progress`.
6. As Claude, blocked on ORC-4, when ORC-4 completes my task leaves `blocked`
   automatically and I get a `blocker_resolved` item.
7. As Codex, I `handoff(to: claude-code, task: ORC-7, "contract is in the doc")`.
   Claude's wait returns immediately. If Claude's Claude Code session is idle
   with the opt-in rewake hook, it wakes. If Claude's headless run has ended and
   the waker is enabled, the waker resumes it.
8. As an agent about to end my turn with a pending handoff (opt-in stop hook),
   my harness keeps me going once with a short reason naming the item. It does
   not block again for the same item.
9. As Arman, the Tasks sidebar item shows my unread comments and mentions, the
   task sheet shows who holds the claim, why it is blocked and a **New** divider,
   and I can watch, resolve a blocker or ping an agent.
10. As Arman, the Agents page shows "Blocked on ORC-4", "Waiting for updates" or
    "2 pending items" per agent.
11. As Arman, two agents cannot ping each other forever: handoff chains stop at a
    hop limit, and wakes and handoffs are rate limited.
12. As an agent in any harness, `wait_for_update` never exceeds my client's tool
    timeout, and it returns a clear "nothing happened" result.

## 4. Concepts and decisions

- **Comment sequence.** `task_comments.sequence` is a per-task, gap-free,
  1-based counter assigned under the existing task row lock in
  `createCommentAs`. It mirrors `chat_messages.sequence`. Timestamps are not
  used as cursors: `created_at` is the transaction start time, so a comment that
  waited on the project lock could commit after a later-stamped one.
- **Watch.** A `task_watches` row per actor and task, in state `watching` or
  `muted`, with `last_read_sequence` and `claim_baseline_sequence`.
  - Automatic watches: creating the task, claiming it, commenting on it, being
    mentioned in its comments, or receiving a handoff that references it.
  - Muting is sticky: automatic rules never re-enable a muted watch.
  - Mentions surface even when muted.
- **Read position.** `last_read_sequence` advances only by explicit
  acknowledgment: `acknowledge_attention`, the human "read" call when comments
  are visible in the dashboard, or `acknowledged_through` on a claim-ending call.
  Reading through `list_task_comments` does not mark anything read, the same as
  `check_messages`. **Posting a comment does not advance the author's read
  position** either, so an agent cannot bypass the completion guard by commenting.
- **Claim baseline.** `claim_task` records the task's current maximum comment
  sequence on the claimant's watch row. The completion guard counts only
  comments by others with a sequence above both the baseline and the read
  position. Older unread comments still appear as attention, but they do not block.
- **Directed items.** These are the items that justify interrupting or waking an
  agent:
  - unread direct-chat messages from others;
  - unread mentions (chat or task comment);
  - pending handoffs;
  - unread comments on tasks the agent currently claims;
  - resolved blockers the agent has not yet seen.

  Ordinary watched-task comments are attention but not directed.

- **Decision: direct chats accept @mentions.** Remove the 400 at
  `chat-service.ts:1320`. Mentions are still validated against participants,
  and every unread direct message already counts as directed. This removes an
  error agents hit in practice and keeps one mention rule everywhere.
  `mention_count` keeps its literal meaning.
- **Handoff.** A direct-chat message (reusing messaging for delivery, unread
  state and notifications) plus a `handoffs` row that carries the task
  reference, chain id and hop number. A handoff is pending while the
  recipient's `chat_participants.last_read_sequence` is below the message
  sequence, so there is no second read state to keep in sync.
- **Block.** A `task_blocks` row recording the reason, an optional blocking task,
  an optional blocking participant (agent or human), and a resolution.
  Blocks are runtime state, separate from planning-time `task_dependencies`
  (which gate claiming).

## 5. Database (migration `0015_agent_attention.sql`)

Reserved number `0015`. All DDL is hand-written. Every new table has RLS
enabled and no policies. The migration has no reference to branch tables.

```sql
-- task comments: sequence + structured mentions
ALTER TABLE "task_comments" ADD COLUMN "sequence" integer;
ALTER TABLE "task_comments" ADD COLUMN "mentions" jsonb DEFAULT '[]'::jsonb NOT NULL;
-- backfill (window function; pg-mem skips this statement, see §16)
UPDATE "task_comments" c SET "sequence" = s.rn FROM (
  SELECT "id", row_number() OVER (PARTITION BY "task_id" ORDER BY "created_at", "id") AS rn
  FROM "task_comments") s WHERE c."id" = s."id";
ALTER TABLE "task_comments" ALTER COLUMN "sequence" SET NOT NULL;
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_sequence_positive" CHECK ("sequence" > 0);
CREATE UNIQUE INDEX "task_comments_task_sequence_unique" ON "task_comments" ("task_id","sequence");

CREATE TABLE "task_watches" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL,
  "task_id" uuid NOT NULL,
  "user_id" uuid,
  "agent_id" uuid,
  "state" text DEFAULT 'watching' NOT NULL,          -- watching | muted
  "reason" text NOT NULL,                             -- created | claimed | commented | mentioned | handoff | explicit
  "last_read_sequence" integer DEFAULT 0 NOT NULL,
  "claim_baseline_sequence" integer,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "task_watches_actor_consistent" CHECK (("user_id" IS NOT NULL AND "agent_id" IS NULL) OR ("agent_id" IS NOT NULL AND "user_id" IS NULL)),
  CONSTRAINT "task_watches_state_valid" CHECK ("state" IN ('watching','muted')),
  CONSTRAINT "task_watches_read_nonnegative" CHECK ("last_read_sequence" >= 0),
  CONSTRAINT "task_watches_user_unique" UNIQUE ("task_id","user_id"),
  CONSTRAINT "task_watches_agent_unique" UNIQUE ("task_id","agent_id")
);
-- FKs: (project_id,task_id)->tasks CASCADE; (project_id,agent_id)->agents CASCADE;
--      (project_id,user_id)->project_members CASCADE (same shape as chat_participants)
-- Indexes: (project_id, agent_id), (project_id, user_id)

CREATE TABLE "task_blocks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL,
  "task_id" uuid NOT NULL,
  "created_by_type" "document_author_type" NOT NULL,
  "created_by_user_id" uuid, "created_by_agent_id" uuid,
  "claim_id" uuid,                                    -- claim active when blocked (informational)
  "reason" text NOT NULL,                             -- 1..500 chars, validated in protocol
  "blocking_task_id" uuid,
  "blocked_on_user_id" uuid, "blocked_on_agent_id" uuid,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "resolved_at" timestamptz,
  "resolution" text,  -- blocking_task_done | blocking_task_cancelled | participant_responded | status_changed | moved_by_human | resolved_by_human | released
  "resolved_by_user_id" uuid, "resolved_by_agent_id" uuid,
  "resolution_seen_at" timestamptz,
  CONSTRAINT "task_blocks_reason_not_blank" CHECK (btrim("reason") <> ''),
  CONSTRAINT "task_blocks_not_self" CHECK ("blocking_task_id" IS NULL OR "blocking_task_id" <> "task_id"),
  CONSTRAINT "task_blocks_on_single" CHECK ("blocked_on_user_id" IS NULL OR "blocked_on_agent_id" IS NULL),
  CONSTRAINT "task_blocks_resolution_consistent" CHECK (("resolved_at" IS NULL AND "resolution" IS NULL) OR ("resolved_at" IS NOT NULL AND "resolution" IS NOT NULL))
);
-- FKs: (project_id,task_id)->tasks CASCADE; (project_id,blocking_task_id)->tasks CASCADE
--      (same as task_dependencies); agent FKs to (project_id, agents.id); user FKs to users
-- CREATE UNIQUE INDEX task_blocks_one_open_per_task ON task_blocks(task_id) WHERE resolved_at IS NULL;
-- CREATE INDEX task_blocks_open_blocking_task_idx ON task_blocks(project_id, blocking_task_id) WHERE resolved_at IS NULL;
-- CREATE INDEX task_blocks_open_blocked_on_idx ON task_blocks(project_id, blocked_on_agent_id) WHERE resolved_at IS NULL;
-- CREATE INDEX task_blocks_creator_idx ON task_blocks(project_id, created_by_agent_id);

CREATE TABLE "handoffs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL,
  "chat_id" uuid NOT NULL,
  "message_id" uuid NOT NULL,
  "message_sequence" integer NOT NULL,
  "from_user_id" uuid, "from_agent_id" uuid,
  "to_user_id" uuid, "to_agent_id" uuid,
  "task_id" uuid,
  "chain_id" uuid NOT NULL,
  "hop" integer DEFAULT 0 NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "handoffs_from_single" CHECK (("from_user_id" IS NULL) <> ("from_agent_id" IS NULL)),
  CONSTRAINT "handoffs_to_single" CHECK (("to_user_id" IS NULL) <> ("to_agent_id" IS NULL)),
  CONSTRAINT "handoffs_hop_nonnegative" CHECK ("hop" >= 0),
  CONSTRAINT "handoffs_message_unique" UNIQUE ("message_id")
);
-- FKs: (project_id,chat_id)->chats CASCADE; message_id->chat_messages CASCADE;
--      (project_id,task_id)->tasks CASCADE; agent/user FKs as above
-- Indexes: (project_id,to_agent_id,created_at), (project_id,to_user_id,created_at),
--          (project_id,from_agent_id,created_at), (chain_id)

-- Backfill watches so day one is not a flood: task creators, commenters and active
-- claimants get a watch with last_read_sequence = current max sequence.
ALTER TABLE "task_watches" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "task_blocks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "handoffs" ENABLE ROW LEVEL SECURITY;
```

Migration ordering hazard (verified in `drizzle-orm/pg-core/dialect.js:57-62`):
the migrator reads the newest applied `created_at` once, then applies only
journal entries whose `when` is greater. If `0015` is applied to a database
before `0014`, a `0014` with a smaller `when` is skipped silently. Rule: **the
second-merged migration's `_journal.json` `when` must exceed the first-merged
one's**, whatever its number. The rebase checkpoint (ATT-13) tests this.

## 6. Protocol and SDK

New file `packages/protocol/src/attention.ts`. It imports only `zod` and
re-declares its four primitives (`id`, `date`, `markdown`, `participantRef`).
`index.ts` keeps its primitives private, and a two-way import would hit a TDZ
error: `export *` evaluates `attention.ts` before `index.ts`'s body. The
schemas are:

- `attentionSummarySchema`: `{ cursor, branch_id: string|null, unread_chats (same shape as inboxSummary), tasks[], handoffs[], blockers_resolved[], truncated }`.
  - `tasks[]`: `{ task_id, key, title, status, watching, claimed_by_you, unread_count, mention_count, blocking_unread_count, last_read_sequence, latest_sequence, unread[≤5]: { sequence, author, excerpt(≤280), created_at, mentions_you } }`.
  - `handoffs[]`: `{ handoff_id, from, chat_id, message_id, sequence, task|null, excerpt, created_at, hop }`.
  - `blockers_resolved[]`: `{ block_id, task, resolution, resolved_at }`.
- `acknowledgeAttentionRequestSchema`: `{ items[1..50] }` of `{type:'task_comments', task_id, through_sequence}`, `{type:'handoff', handoff_id}` (advances the chat read position) or `{type:'blocker', block_id}`.
- `taskWatchRequestSchema` `{ watching: boolean }` and `taskWatchSchema`.
- `setTaskStatusRequestSchema`: `{ claim_token, status: in_progress|blocked|review, reason?(1..500), blocked_on?: participantRef, blocking_task_id?, acknowledged_through? }`.
  - `blocked` requires `reason`.
  - `blocked_on` and `blocking_task_id` are only allowed with `blocked`.
  - Response `{ task: {id,status,version}, claim: claim|null, block: block|null }`.
- `waitQuerySchema`: `{ after?: cursor, timeout_ms: 0..25000, kinds?: csv, directed_only?: bool, branch_id? }`.
- `waitEventSchema`: `{ kind, event_id, occurred_at, actor, task|null, chat_id?, message_id?, comment_sequence?, handoff_id?, from_status?, to_status?, excerpt?, branch_id: null }`.
  - `kind` is one of `direct_message | mention | task_comment | claim_released | status_changed | blocker_resolved | handoff`.
- `waitResponseSchema`: `{ status: 'pending'|'updates'|'timeout', events[≤50], cursor, attention }`.
- `createHandoffRequestSchema`: `{ to: participantRef, body_markdown (1..4000), task_id? }`, plus response.
- `recordWakeRequestSchema`: `{ integration, handoff_id|null }` (waker only).
- `unreadCommentsErrorDetailsSchema`: `{ task_id, latest_sequence, total_unread, unread[≤10] }`.
- Task-attention overlay for the dashboard: `{ task_id, watching, unread_count, mention_count, claim: {agent_id,name,status,lease_expires_at}|null, block|null }`.

Edits to `packages/protocol/src/index.ts` (additive, details in §13):

- `createTaskCommentRequestSchema` gains `mentions` (≤20). Use an inline
  object, because `participantRefSchema` is declared later (L1142) and
  referencing it at L460 would throw at module evaluation.
- `taskCommentSchema` gains `sequence` and `mentions`.
- `claimMutationRequestSchema` gains `acknowledged_through`.
- One `export * from "./attention.js"` line at the end.

The MCP `add_task_comment` input spreads `createTaskCommentRequestSchema.shape`,
so it gains `mentions` with no MCP edit.

SDK: new `packages/sdk/src/attention.ts` exporting `class AttentionApi`. It takes
a bound request function and provides `summary`, `acknowledge`, `watch`,
`setStatus`, `wait(query, signal)`, `handoff(input, key)` and `recordWake`.
`AgentApiClient` gains one field, `readonly attention = new AttentionApi(this.request.bind(this))`,
plus one `export *`. `releaseClaim` and `completeClaim` already parse
`claimMutationRequestSchema`, so `acknowledged_through` flows through unchanged.

## 7. API

New files:

- `apps/api/src/services/attention-service.ts`: summary, acknowledge, watch,
  overlays, directed events, and handoff.
- `apps/api/src/services/attention-hooks.ts`: transaction-scoped hooks called
  from existing services.
- `apps/api/src/services/task-status-service.ts`: `set_task_status` and block
  resolution.
- `apps/api/src/services/attention-wait-hub.ts`: in-memory long-poll waiters.
- `apps/api/src/routes/attention.ts`: `agentAttentionRoutes` and
  `humanAttentionRoutes`.

Services follow house style: classes with paired human and agent methods,
hand-mapped snake_case JSON, `ApiError`, project-row `FOR UPDATE` on writes, and
events via `insertProjectEvent` inside the transaction.

Agent routes (`/api/v1/agent`):

| Method | Path                                 | Purpose                                                                 |
| ------ | ------------------------------------ | ----------------------------------------------------------------------- |
| GET    | `/attention`                         | Attention summary including `unread_chats` (one request per MCP notice) |
| POST   | `/attention/acknowledge`             | Acknowledge items                                                       |
| PUT    | `/tasks/:id/watch`                   | Watch or mute                                                           |
| GET    | `/attention/wait`                    | Long-poll (≤25 s per request; `timeout_ms=0` polls without waiting)     |
| POST   | `/sessions/:sessionId/claims/status` | Set status using the claim token                                        |
| POST   | `/handoffs`                          | Create a handoff (`Idempotency-Key` required)                           |
| POST   | `/wakes`                             | Waker records a wake; the server enforces the wake budget               |

Human routes (`/api/v1`):

| Method | Path                                    | Purpose                                                      |
| ------ | --------------------------------------- | ------------------------------------------------------------ |
| GET    | `/projects/:projectId/attention`        | The human's summary (badges)                                 |
| GET    | `/projects/:projectId/attention/tasks`  | Per-task overlay for the board and sheet                     |
| GET    | `/projects/:projectId/attention/agents` | Per-agent: waiting since, pending directed count, open block |
| PUT    | `/tasks/:id/watch`                      | Watch or mute                                                |
| POST   | `/tasks/:id/comments/read`              | `{ through_sequence }` when comments are visible             |
| POST   | `/tasks/:id/block/resolve`              | Resolve an open block (`resolved_by_human`)                  |
| POST   | `/projects/:projectId/handoffs`         | Ping an agent from the dashboard                             |

The summary is read on every MCP tool call under the bridge's 1 s notice
budget, so it must stay cheap:

- **Queries:** four indexed queries. The chat inbox reuses `ChatService`, the
  task query is watches joined to `task_comments` on `sequence > last_read`, the
  handoff query joins `chat_participants`, and the last reads open blocks.
- **Locking:** reads take no project row lock. Per-statement snapshots are
  enough for a notice.

Transaction hooks in `attention-hooks.ts` are the only way existing services
touch attention:

- `onTaskCreated`, `onTaskClaimed`, `onTaskCommentCreated`, `onClaimEnded`,
  `onTaskMoved`, `onTaskClosed`.
- `assertCommentsAcknowledged`, `nextCommentSequence`, `resolveCommentMentions`.
- `resetsToReadyOnClaimEnd`, `hasActiveClaim`.

Each existing file gets one import plus one call per site. The full list is in §13.

## 8. Safe completion (B)

Inside `TaskClaimService.mutate`, after the task row is locked:

1. `unread` = comments on the task with `sequence > max(watch.last_read_sequence, watch.claim_baseline_sequence)`
   and not authored by this agent.
2. If `unread` is empty, proceed.
3. Otherwise, if `acknowledged_through` is absent or less than the maximum
   unread sequence, throw `409 TASK_COMMENTS_UNREAD`. Details carry up to 10
   comments with excerpts, `latest_sequence` and `total_unread`. The claim,
   task and read position stay unchanged, and no event is written.
4. If `acknowledged_through` is greater than the task's current maximum
   sequence, return `400 VALIDATION_ERROR`.
5. Otherwise set `last_read_sequence = max(last_read, acknowledged_through)` in
   the same transaction and proceed.

Applies to `complete_task`, `release_task` and `set_task_status(review)`.
Lease expiry, session close and revocation stay unguarded, since nothing can
wait on them. The comment and completion transactions both lock the project
row, so a comment either commits first (and blocks) or commits after completion.
Real-Postgres tests prove this (§16). The MCP bridge keeps the local claim token
on 409 (it already only drops it on success), and `mapMcpError` passes the
details through.

## 9. Agent status (C)

`set_task_status` requires the caller's active claim (token plus session, same
checks as release). It goes through a new appended
`TaskClaimService.withActiveClaim(...)` method so ownership checks are not
duplicated.

| From \ to     | `in_progress`                        | `blocked`               | `review`                               |
| ------------- | ------------------------------------ | ----------------------- | -------------------------------------- |
| `claimed`     | yes (`started_at` set if null)       | yes, opens a block      | yes, guard; ends claim                 |
| `in_progress` | no-op                                | yes, opens a block      | yes, guard; ends claim                 |
| `blocked`     | yes, resolves block `status_changed` | replaces the open block | yes, guard; resolves block; ends claim |

What each status does to the claim and lease:

- **`in_progress` and `blocked`:** the claim stays active. Heartbeats renew it
  as today. `wait_for_update` runs inside the MCP bridge, whose 20 s heartbeat
  keeps running, so a blocked agent that waits keeps its claim.
- **`review`:** ends the claim. It is recorded as `released` with
  `release_reason = 'submitted_for_review'`. The task moves to `review`, and the
  bridge drops the local token. A human then moves it to `done`, or back to
  `ready` with a comment, which the former claimant sees because it watches the
  task. Review tasks are not claimable, the same as today.
- **Involuntary claim end** (lease expiry, session close, agent revoke):
  - `claimed` and `in_progress` go to `ready`. Today only `claimed` does
    (`task-claim-service.ts:305`, `agent-service.ts:316,797`).
  - **`blocked` stays `blocked`** with its block open, so a session that ends
    while waiting does not lose the block. Nobody can claim a blocked task until
    it is unblocked.
- **Voluntary release** (`release_task`) keeps today's behaviour: the task
  goes to `ready`. An open block is resolved as `released`, and the guard
  applies.
- **Humans:** `TaskService.move` rejects any task with an active claim, not
  only `claimed` (`task-service.ts:484`). Moving a task out of `blocked`
  resolves its block (`moved_by_human`).

Blocker resolution runs inside the triggering transaction:

- **Triggers:**
  - The blocking task reaches `done` (agent completion or human move), or
    `cancelled`.
  - The `blocked_on` participant comments on the blocked task, or hands off to
    the blocker's creator with that task.
  - A human clicks **Resolve blocker**, or the claimant changes status.
- **Effects:**
  - The task goes to `in_progress` if a claim is active, otherwise to `ready`.
  - Events: `task.block_resolved` and `task.status_changed`.
  - The creator gets a `blocker_resolved` attention item until it acknowledges
    it, sets a status, or claims the task again (`resolution_seen_at`).
- **Validation:**
  - The blocking task must be in the same project, and not the task itself.
    A direct two-task cycle is rejected (409).
  - `blocked_on` must be a message candidate, and not the agent itself.

## 10. Wait for update (D1)

**Server** (`GET /agent/attention/wait`):

- **Cursor:** an opaque `after` holding a `project_events.id`.
  - Within a project, event ids follow commit order, because every write locks
    the project row before inserting its event.
  - Without `after`, if **directed** items are pending, the call returns at
    once with `status: pending`, the summary, and a cursor at the current
    maximum event id (level-triggered). Plain unread watched-task comments do
    not trigger this, so an agent that never acknowledges them cannot spin.
    Otherwise it waits from the current maximum.
- **Classification:** events with `id > after` (≤500 scanned) are classified
  for the calling agent:
  - `chat.message_created`: `direct_message` in direct chats where it
    participates, or `mention`.
  - `chat.handoff_created`: `handoff`, when it is the recipient.
  - `task.comment_created`: `mention`, or `task_comment` when it watches the task.
  - `claim.released`, `claim.expired`, `claim.revoked`: `claim_released` on
    watched tasks.
  - `task.status_changed`, `task.moved`, `claim.completed`: `status_changed` on
    watched tasks.
  - `task.block_resolved`: `blocker_resolved`, for blocks it created.
  - Its own actions are skipped, and chat privacy follows `listEvents`.
  - The returned cursor is the last id scanned, so events are never rescanned.
- **Waking:** `AttentionWaitHub` keeps per-project waiter sets in memory.
  `app.ts`'s realtime publisher callback calls `waits.notify(envelope)` after
  commit, never for rolled-back work. Woken waiters re-run the classification
  (debounced 250 ms), with a 5 s fallback re-check. No DB connection is held
  while waiting.
- **Other behaviour:** the request aborts when the client disconnects.
  `timeout_ms` is clamped to 25 s, which suits the Railway proxy and progress
  cadence.
- **Limits:** 3 concurrent waits per agent and 50 per project (429
  `WAIT_LIMIT`).
- **Dashboard:** the hub records `waiting_since` per agent for "Waiting for
  updates".

**MCP tool** `wait_for_update({ cursor?, max_wait_seconds?, directed_only? })`:

- **Rounds:** loops server rounds of ≤25 s until an event arrives, the budget
  is spent, or `ctx.mcpReq.signal` aborts.
- **Progress:** between rounds it sends `notifications/progress` when the client
  supplied `_meta.progressToken` (SDK v2 `ctx.mcpReq.notify`). This resets
  OpenCode's timeout and Claude Code's idle timer. It does not extend Codex,
  Cursor CLI or Claude Code wall-clock limits (§11.2).
- **Results:**
  - `{status:"updates", events, cursor, attention}`.
  - `{status:"no_updates", waited_seconds, cursor, next_step}`. `next_step`
    says to call again with the cursor or end the turn, and that hooks, if
    installed, will surface new work.
- **Budget:** the total per call is the integration default below. The agent may
  pass up to 1800 s, and the tool clamps to the integration's safe ceiling.

| Integration      | Default per call                                         | Ceiling | Basis                                                                                                                                             |
| ---------------- | -------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| claude-code      | 110 s                                                    | 1800 s  | Stays under the 2-minute auto-backgrounding of main-conversation MCP calls; wall-clock is about 28 h; stdio idle is 30 min and progress resets it |
| codex            | 600 s if setup wrote `tool_timeout_sec = 660`, else 50 s | 600 s   | Docs say the default is 60 s, source (0.158) says 300 s; progress is ignored                                                                      |
| cursor           | 50 s                                                     | 50 s    | CLI/ACP MCP calls are fixed at 60 s, and progress does not extend them. The IDE allows about 60 min but the bridge cannot tell the two apart yet  |
| antigravity      | 150 s, or 600 s if setup wrote `timeoutSeconds: 660`     | 600 s   | The observed default is about 3 min; `timeoutSeconds` is per server (release note, not docs)                                                      |
| opencode         | 600 s                                                    | 1800 s  | Progress resets the timer (`resetTimeoutOnProgress: true`)                                                                                        |
| other or unknown | 50 s                                                     | 50 s    | Safe under a 60 s client                                                                                                                          |

`orchestrat mcp` passes `--wait-budget-seconds` when setup wrote a matching
client timeout. Otherwise the bridge uses the default above.

## 11. Handoffs, hooks and the waker (D)

### 11.1 Handoff (`handoff` MCP tool, `POST /agent/handoffs`)

`{ to, message, task_id?, idempotency_key }`. Steps:

1. Get or create the direct chat via `ChatService`, which already canonicalizes
   direct chats.
2. Send the message via `ChatService.sendAgent`, using an idempotency key
   derived from the handoff key.
3. In a second transaction, insert the `handoffs` row (idempotent on
   `message_id`), auto-watch the task for the recipient, resolve a matching
   `blocked_on` block, and emit `chat.handoff_created` (entity `chat`, so chat
   privacy authorization applies unchanged). `payload.participant = to`, so the
   realtime envelope sets `affected_participant` and the dashboard can notify a
   human recipient.

If step 3 fails, a retry with the same key finds the existing message and
completes. No `chat-service.ts` refactor is needed. The message body starts
with `**Handoff** · ORC-7 <title>`, so it stays meaningful even without the row.

Chain and loop limits:

- **Chain inheritance:** a handoff inherits `chain_id` and `hop + 1` from the
  sender's most recent incoming handoff in the last 60 min, unless a human
  messaged or mentioned the sender after it. Otherwise it starts a new chain at
  hop 0. Human-sent handoffs always start new chains.
- **Limits** (all 429, messages that tell the agent to ask a human):
  - hop ≤ 4 (`HANDOFF_CHAIN_LIMIT`);
  - 20 per sender per hour;
  - 6 per sender→recipient pair per hour;
  - 200 per project per hour (`HANDOFF_RATE_LIMITED`).
- Counts come from `handoffs` rows under the project lock, so they survive
  restarts, unlike `FixedWindowRateLimit`.

### 11.2 Harness capabilities (researched 2026-09-27; sources in §17)

| Harness     | Continue at end of turn (sync)                                                                                                                                                                                   | Wake an idle open session                                                                                                                                                                                                                                              | Headless resume                                                                                                                                 | MCP tool timeout                                                                                                                                               |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code | `Stop` hook: `{"decision":"block","reason"}` or exit 2. `stop_hook_active` input; built-in cap of 8 consecutive continuations (`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`) [cc-hooks]                                     | **Yes.** `"async": true, "asyncRewake": true` command hook: exit 2 "wakes Claude immediately even when the session is idle". Timeout still enforced. Hooks fire in terminal, IDE extensions, Desktop and cloud. In `-p`, async hooks are killed at teardown [cc-hooks] | `claude -p --resume <id> "…"`, `--continue`, `--fork-session` [cc-cli]. Resuming a session open elsewhere interleaves transcripts [cc-sessions] | `MCP_TOOL_TIMEOUT` about 28 h; per-server `timeout`; stdio idle 30 min, which progress resets; auto-backgrounded after 2 min in the main conversation [cc-mcp] |
| Codex       | `Stop` hook: `decision:"block"` + `reason` becomes a continuation prompt; exit 2 also works; `stop_hook_active`; **no documented cap**. New or changed hooks must be trusted in `/hooks`, hash-pinned [ox-hooks] | No. "Finishing a background hook doesn't start a new turn" [ox-hooks]. App-server `turn/start` only reaches threads loaded in an app-server you connect to [ox-as]                                                                                                     | `codex exec resume <SESSION_ID> "…"`, `--last` [ox-exec]. Hook `session_id` equals the root thread id (source)                                  | `tool_timeout_sec`: docs say 60, source (0.158) says 300; progress is only logged [ox-mcp][ox-rmcp]                                                            |
| Cursor      | `stop` hook returns `followup_message`, submitted as the next user message; `loop_limit` default 5 with `loop_count` input; fires when the agent loop ends (every turn) [C1]. Firing under `agent -p` UNVERIFIED | No                                                                                                                                                                                                                                                                     | `agent --resume <chatId> -p "…"` [C2]. IDE chats cannot be resumed from the CLI (separate stores) [C5]                                          | CLI/ACP fixed at 60 s, progress does not extend it; IDE about 60 min [C6]                                                                                      |
| Antigravity | `Stop` hook `{"decision":"continue","reason"}`; flat entries only; 30 s default hook timeout; continuation cap exists (key UNVERIFIED); hook regressions in CLI 1.2.1/1.2.2 [A1][A2][A9][A11]                    | No                                                                                                                                                                                                                                                                     | `agy -p "…" --conversation <id>` [A3]. The CLI can only clone desktop conversations [A4]                                                        | About 3 min default; per-server `timeoutSeconds` (1.1.16 release) [A6][A7]                                                                                     |
| OpenCode    | No blocking stop. A plugin can watch `session.status` idle and call `client.session.promptAsync` [O1][O3][O6]                                                                                                    | Same plugin (interactive TUI). `opencode run` exits on first idle [O5]                                                                                                                                                                                                 | `opencode run --session <id> "…"` [O4]                                                                                                          | `mcp.<name>.timeout` ?? `experimental.mcp_timeout` ?? 60 s; **progress resets** [O9][O10]                                                                      |

Existing-behaviour finding: Cursor `stop` and Antigravity `Stop` fire every
turn [C1][A1], but `cursor-hooks.ts` and `antigravity-hooks.ts` map them to
`session.ended`, so lifecycle sessions close each turn. MCP sessions, which hold
claims, are unaffected. ATT-10 keeps that mapping for compatibility and adds the
continuation output in the same process.

### 11.3 Stop-hook continuation (D2), opt-in per harness

`orchestrat setup --auto-continue <integration>` (and config
`attention.continue_on_stop`) installs or extends Stop entries. The hook flow:

1. Parse the payload.
2. Read local state `~/.orchestrat/hooks/stop-state.json`, keyed by integration
   and external session id, holding `{cursor, blocks[]}`. Written with
   `safe-files`, pruned after 7 days.
3. Call `GET /agent/attention/wait?timeout_ms=0&directed_only=true&after=<cursor>`
   with a 2 s budget. On the session's first Stop, omit `after` for the
   level snapshot.
4. If there are new directed items, and there have been fewer than 3 blocks in
   30 min for this session, continue using the harness's own mechanism (below)
   and record the cursor. Otherwise allow the stop.
5. **Fail open** on any error, timeout or missing credential.

The reason text is a fixed template of counts, task keys and actor names, never
message bodies. For example: "Orchestrat: 1 handoff from codex (ORC-7), 2 unread
comments on your claimed task ORC-3. Call get_attention and handle them. If your
user asked you to stop, reply briefly and end your turn; Orchestrat will not
block again for these items."

| Harness     | Mechanism                                                                                                                                                                                                | Loop guard                                                                                                                        |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code | Exit 2 with the reason on stderr (documented for Stop; avoids JSON schema drift)                                                                                                                         | `stop_hook_active` plus our dedupe; the built-in cap of 8 is a backstop                                                           |
| Codex       | Exit 2 with stderr (or `{"decision":"block","reason"}`)                                                                                                                                                  | `stop_hook_active` plus our dedupe; **no built-in cap**, so our budget is the only one. Users must trust the new hook in `/hooks` |
| Cursor      | `{"followup_message": reason}` on the existing `stop` entry; setup sets `loop_limit: 2`                                                                                                                  | `loop_count` plus our dedupe. User-level hooks win `followup_message` merges [C1]                                                 |
| Antigravity | `{"decision":"continue","reason"}` on the existing `Stop` entry                                                                                                                                          | Our dedupe plus the built-in cap. Treat as best effort given 1.2.x regressions                                                    |
| OpenCode    | Setup installs `~/.config/opencode/plugins/orchestrat.ts`, which on `session.status` idle shells out to `orchestrat hook opencode --event idle`, then calls `client.session.promptAsync` with the reason | The plugin counts per session, max 3 per 30 min. Interactive only                                                                 |

**Claude Code idle wake (opt-in `--rewake`).** A second Stop entry,
`{"type":"command","command":"orchestrat hook claude-code --event Stop --watch","async":true,"asyncRewake":true,"timeout":3600}`:

- It long-polls wait rounds for directed events for up to 55 min.
- On one, it exits 2 with the template on stderr, which wakes the idle session
  in the terminal, IDE or Desktop app.
- One watcher per session, via a lock file. A newer Stop supersedes the older
  watcher, and `SessionEnd` kills it.
- It never runs in `-p`, where the docs say async hooks are killed at teardown.

This is the supported replacement for waking Claude with computer use.

Optional, cheap: a Claude `SessionStart` hook returns `additionalContext` with
an attention digest, so resumed or new sessions see pending handoffs at once.

### 11.4 Local waker (D3), opt-in

`orchestrat waker enable | disable | status | run [--once] [--dry-run]`, run in
the foreground (no daemon in v1).

- **Consent:** `enable` needs a TTY and an explicit confirmation. It shows, per
  agent (project, integration, working directory), the exact argv template, the
  limits, and that runs use the harness's normal permission settings. It never
  adds `--dangerously-*` flags. Config lives in `~/.orchestrat/config.json` under `waker`.
- **Trigger:** handoffs only by default (`wake_on: ["handoff"]`). Direct
  messages and mentions are opt-in. Other events never trigger a wake. It skips
  agents with an online MCP session, whose live agent sees the item via
  `wait_for_update` or hooks.
- **What it resumes:** sessions the waker itself started, identified by the
  session id from each harness's JSON output.
  - The first wake for an agent starts a **new headless session** in the
    configured working directory, unless `resume_foreign_sessions: true` allows
    resuming the last hook-recorded session.
  - Desktop-originated sessions are never resumed: Cursor and Antigravity CLIs
    cannot attach to them [C5][A4], and Claude interleaves transcripts [cc-sessions].
- **Commands** (spawned with an argv array, no shell; the prompt is a fixed
  template and never a message body):

  | Harness     | Command                                                      |
  | ----------- | ------------------------------------------------------------ |
  | Claude Code | `claude -p --resume <id> --output-format json "<prompt>"`    |
  | Codex       | `codex exec resume <id> --json "<prompt>"`                   |
  | Cursor      | `agent --resume <id> -p --output-format json "<prompt>"`     |
  | Antigravity | `agy -p "<prompt>" --conversation <id> --output-format json` |
  | OpenCode    | `opencode run --session <id> --format json "<prompt>"`       |

  Exact flag spellings are verified in ATT-11 against each installed CLI's
  `--help`.

- **Budgets:**
  - Local: at least 5 min between wakes per agent, 6 per hour, 20 per day,
    and one running process per agent (killed after 30 min).
  - Server: `POST /agent/wakes` records `run.woken` and returns 429 above
    12 per hour or 30 per day per agent, or on a second wake for the same
    (chain, recipient).
- **Loop protection:** directed-only triggers, handoff hop and pair limits, one
  wake per chain per recipient, and server budgets. An A→B→A ping cycle
  therefore ends at hop 4, or earlier at the pair limit.
- **Logs:** `~/.orchestrat/logs/waker.log` (rotated), plus `run.woken` in Activity.

#### 11.4.1 Why the waker cannot drive desktop windows

- The desktop apps expose no supported, authenticated API to inject a turn into
  an open conversation. Cursor states IDE and CLI chats live in separate stores
  [C5]. The Antigravity CLI can only clone desktop conversations [A4]. Codex
  app-server reaches only threads loaded in a server you connect to [ox-as].
- Resuming the same session headlessly while a GUI holds it interleaves or forks
  the transcript [cc-sessions].
- Driving a GUI is computer use, which is out of scope, brittle and unsafe.

For desktop sessions, the supported paths are:

- Claude Code's `asyncRewake` hook (§11.3);
- `wait_for_update` while the agent is still active;
- the dashboard's native notification to the human.

## 12. MCP tools and notices

New module `packages/mcp/src/attention-tools.ts` with
`registerAttentionTools(host)`. `host` is a small object exposing `server`,
`call`, `activeClient`, `requireSession`, `claims` and `integration`, built by a
new private `attentionHost()` in `McpBridge`.

| Tool                    | Input                                                                                 | Notes                                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `get_attention`         | `{}`                                                                                  | Full summary with excerpts                                                                                  |
| `acknowledge_attention` | `{ items[] }`                                                                         | Task comments, handoffs, blockers. Chats keep `acknowledge_messages`                                        |
| `watch_task`            | `{ task_id, watching }`                                                               | `watching:false` mutes; mentions still surface                                                              |
| `set_task_status`       | `{ task_id, status, reason?, blocked_on?, blocking_task_id?, acknowledged_through? }` | Uses the local claim token; `review` drops it on success                                                    |
| `wait_for_update`       | `{ cursor?, max_wait_seconds?, directed_only? }`                                      | §10. Description: "Call this instead of ending your turn when you are blocked or waiting on another agent." |
| `handoff`               | `{ to, message, task_id?, idempotency_key }`                                          | §11.1                                                                                                       |

Changed tools:

- `complete_task` and `release_task` gain `acknowledged_through`, and return
  `TASK_COMMENTS_UNREAD` details.
- `add_task_comment` gains `mentions` through the protocol shape.
- `send_message` allows mentions in direct chats (server change only).

That makes 35 tools, up from 29.

Notices: `call()` reads `GET /agent/attention` once. It emits the existing
`{"notice":{"type":"unread_chats",…}}` block **unchanged**, plus when non-empty:

```json
{
  "notice": {
    "type": "attention",
    "tasks": [
      {
        "task_id": "…",
        "key": "ORC-3",
        "unread_comments": 3,
        "mentions": 1,
        "claimed_by_you": true,
        "latest_sequence": 31
      }
    ],
    "handoffs": [
      {
        "handoff_id": "…",
        "from": { "type": "agent", "name": "codex" },
        "task_key": "ORC-7"
      }
    ],
    "blockers_resolved": [],
    "hint": "Read with get_attention; acknowledge with acknowledge_attention.",
    "branch_id": null
  }
}
```

Each list is capped at 5. On 404 from an older API, the bridge falls back to
`getInbox` and remembers that for the process. The 1 s budget is unchanged.

## 13. Branch readiness and conflict avoidance

Branch readiness:

- **No dependency on branch tables.** Watches, blocks and handoffs hang off
  tasks and chats, so they inherit branch scope when those tables gain
  `branch_id`.
- **One scoping seam.** Every attention read goes through
  `attentionBranchScope(branchId)` in `attention-service.ts`, a no-op returning
  `branch_id: null` before branches.
  - After branches, it filters by `tasks.branch_id` / `chats.branch_id`, and
    defaults to the MCP session's pinned branch.
  - The wait, summary and handoff schemas already carry an optional or nullable
    `branch_id`.
- **Events:** attention event payloads omit `branch_id` until known.
  Protocol fields are optional and nullable, so no contract change is needed
  later.
- **Branch imports** that copy task comments must set `sequence` (copy it when
  the whole thread is copied, otherwise renumber) and `mentions`. The rebase
  checkpoint verifies this.
- **Follow-up migration (not 0015):** add a nullable `handoffs.branch_id` only
  if branches keeps direct chats unscoped.

Hotspot edits: append-only, one import plus one call per site.

| File                                           | Exact change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/db/src/schema.ts`                    | `taskComments` (L229–273): add `sequence`, `mentions`, a unique index and a check. Append `taskWatches`, `taskBlocks`, `handoffs` (`.enableRLS()`) at the end of the file                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `packages/db/drizzle/meta/_journal.json`       | Append one `0015_agent_attention` entry; `when` must exceed any already-merged migration's                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `packages/db/drizzle/0015_agent_attention.sql` | New                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `apps/api/src/services/task-claim-service.ts`  | `claim()`: after the `claim.created` event (L131–141), `await onTaskClaimed(tx, …)`. `release()`/`complete()` (L162–176): pass `input.acknowledged_through`. `mutate()` (L184–259): new optional `acknowledgedThrough` param; after the task lock (L222–227) `await assertCommentsAcknowledged(tx, …)`; after the task update (L238–246) `await onClaimEnded(tx, …)`. `expireClaim()` L305: predicate becomes `resetsToReadyOnClaimEnd(task?.status)`. Append public `withActiveClaim()` at the end of the class                                                                                                                             |
| `apps/api/src/services/agent-service.ts`       | `revokeAgentInTransaction()` L316 and `closeSessionInTransaction()` L797: the same one-line predicate change, plus one import                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `apps/api/src/services/task-service.ts`        | `createAs()` after `task.created` (L242–249): `await onTaskCreated(tx, …)`. `move()` L484: guard becomes `locked.status === "claimed" \|\| await hasActiveClaim(tx, id)`; after `task.moved` (L567–573): `await onTaskMoved(tx, …)`. `createCommentAs()` insert values (L710–727): `sequence: await nextCommentSequence(tx, id)`, `mentions: await resolveCommentMentions(tx, projectId, input.mentions)`; `task.comment_created` payload (L729–735) adds `sequence` and `mentions`, then `await onTaskCommentCreated(tx, …)`. JSON mappers in the response body (L743–757) and `commentsProject()` (L605–625) add `sequence` and `mentions` |
| `apps/api/src/services/chat-service.ts`        | `sendAs()` L1320–1325: delete the direct-chat mention rejection                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `apps/api/src/app.ts`                          | Import attention classes and routes. After L116: `const attention = new AttentionService(db, chats); const waits = new AttentionWaitHub(attention);`. Publisher L107–109 becomes `(event, audience) => { waits.notify(event); return realtimeRegistry.publish(event, audience); }`. After L303: `api.register(humanAttentionRoutes, { attention })`. After L339: `api.register(agentAttentionRoutes, { attention, waits, claims })`                                                                                                                                                                                                          |
| `apps/api/src/realtime/realtime.ts`            | No change. The `task`, `claim`, `chat` and `run` entity types already exist, and `payload.mentions`/`payload.participant` already map into the envelope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `packages/protocol/src/index.ts`               | `taskCommentSchema` (L424–445): add `sequence`, `mentions`. `createTaskCommentRequestSchema` (L460–462): add inline `mentions`. `claimMutationRequestSchema` (L686–688): add `acknowledged_through`. End of file: `export * from "./attention.js";`                                                                                                                                                                                                                                                                                                                                                                                          |
| `packages/sdk/src/index.ts`                    | One import, one `readonly attention = …` field in `AgentApiClient`, one `export * from "./attention.js"`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `packages/mcp/src/index.ts`                    | `Client` Pick (L23–56): add `"attention"`. `mapMcpError`: add a `TASK_COMMENTS_UNREAD` details case. Release/complete loop (L368–396): add the `acknowledged_through` input and pass it through. `call()` (L686–713): `readInbox` becomes `readAttention` (both notices, with inbox fallback). End of `registerTools()`: `registerAttentionTools(this.attentionHost())`                                                                                                                                                                                                                                                                      |
| Dashboard task views                           | `routes/_authenticated.projects.$projectId.tasks.tsx`: `TaskDetail` L796 `claimed` derives from the attention overlay's `claim`; mount `<TaskAttentionPanel>` inside the sheet (L550–632) and `<TaskAttentionBadge>` on board cards (around L440–510). `realtime/project-realtime.tsx` L47: add notification types. `components/app-shell/context-sidebar.tsx` L99/L216: Tasks badge. New code lives in `features/attention/*`                                                                                                                                                                                                               |

## 14. Realtime events and dashboard UX

Events (`project_events` rows, published after commit):

| Type                              | Payload (additive)                                                                   | Consumer                                                               |
| --------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| `task.comment_created` (existing) | adds `sequence`, `mentions[]`                                                        | Envelope `mentions` notifies mentioned humans; invalidates the overlay |
| `task.status_changed`             | `from_status`, `to_status`, `claim_id`, `block?: {id, blocked_on, blocking_task_id}` | Board, sheet, Agents, notifications (blocked, review)                  |
| `task.block_resolved`             | `block_id`, `resolution`, `to_status`                                                | Board, sheet, wait                                                     |
| `claim.released` (existing)       | adds `reason` (`agent_release` \| `submitted_for_review`)                            | Wait (`claim_released`)                                                |
| `chat.handoff_created`            | `message_id`, `handoff_id`, `participant` (to), `task_id`, `hop`                     | Chat-authorized realtime, human notification, wait                     |
| `run.woken`                       | `integration`, `handoff_id`, `hop`                                                   | Activity                                                               |

Watches and read positions emit no events. They are private and fetched by the
viewer, like chat acknowledgment today.

Dashboard (follows DESIGN.md: shadcn primitives, status paired with label or
dot, orange only for active context, all four data states):

- **Sidebar:** Tasks gets an unread badge like Messages, with an aria-label such
  as "3 unread task comments, 1 mention".
- **Board and list cards:** a small unread-count dot for tasks the human
  watches. Blocked cards gain one `text-xs text-muted-foreground` line:
  "Blocked · waiting on codex" or "Blocked by ORC-4". The existing StatusBadge
  mapping stays (info: claimed/in progress, destructive: blocked, warning: review).
- **Task sheet:**
  - A claim line: "Claimed by claude-code · in progress · lease 4 min".
  - A blocked callout (muted region with a destructive dot and label) showing
    reason, blocker link, since, and **Resolve blocker** (outline button with a
    confirm dialog).
  - A watch toggle (ghost button with a Bell icon, `aria-pressed`).
  - A **New** divider at the human's read position; the read call fires when
    the list is visible.
  - The composer gets @mention autocomplete, reusing the chat composer's
    candidate picker.
  - **Ping** opens a dialog: recipient select, message, task prefilled.
- **Agents page:** a status line per agent ("Working on ORC-3 · in progress",
  "Blocked on ORC-4", "Waiting for updates", "2 pending items"), refreshed every
  30 s, plus a **Ping** button.
- **Native notifications:** mention of the human, handoff to the human,
  `blocked` ("claude-code is blocked on ORC-3"), and `review` ("ORC-3 is ready
  for review").
- **Activity:** copy for the new event types.
- **Accessibility:** Playwright and axe on the task sheet, Agents page and
  sidebar badge, in both themes and at 390 px.

## 15. Security and abuse limits

- **Scope:**
  - Every agent query is scoped to `principal.projectId`. Human routes use
    `PermissionService.projectAccess`.
  - Watches, blocks and handoffs validate task, chat and participant membership
    in the project.
  - Mentions must be message candidates (project members plus active agents).
    Revoked agents are rejected.
- **Privacy:**
  - Wait classification and attention reuse chat participant checks, and
    handoff events use chat authorization.
  - Excerpts are limited to what the viewer can already read.
- **Size limits:** mentions ≤ 20 per comment, block reason ≤ 500, handoff body
  ≤ 4000, excerpts ≤ 280, attention lists ≤ 5 in notices and ≤ 50 in
  `get_attention`, and ≤ 1000 watches per actor per project (automatic watches
  stop beyond; explicit watches return 409 `WATCH_LIMIT`).
- **Rate limits:**
  - Waits: 3 per agent and 50 per project concurrently, 25 s per request.
  - Handoffs (§11.1) and wakes (§11.4).
- **Prompt injection:**
  - Hook reasons and waker prompts are fixed templates holding only counts,
    task keys and names.
  - Message and comment bodies reach an agent only through tools it calls, as
    data.
  - The waker spawns an argv array with no shell.
- **Local:**
  - The waker and hooks use existing Keychain credentials and never print
    tokens. State files are written with `safe-files` (no symlinks, bounded size).
  - Hooks fail open, so a broken Orchestrat never traps an agent.
- **Database:** RLS enabled on the three new tables, with no policies (Supabase
  Data API exposure rule).
- **Truthful authorship:** status changes are authored by the agent. System
  resolutions record the causing actor and resolution, and Activity never
  presents a system change as a human one.

## 16. Test plan

**pg-mem (default suite):**

- **Fixture:** `apps/api/src/test/pg-mem-migrations.ts` skips the `0015`
  window-function backfill statement and the `ENABLE ROW LEVEL SECURITY`
  statements, as it does today. The backfill runs only on real Postgres.
- **`routes/attention.test.ts`:**
  - comment `sequence` is contiguous;
  - mention validation: non-candidate, cross-project and revoked agent rejected;
  - direct-chat mentions are accepted;
  - automatic watch rules and sticky mute;
  - summary counts exclude own comments, and muted tasks still show mentions;
  - the human summary and overlays.
- **The completion guard:**
  - 409 details;
  - an `acknowledged_through` that is too low gives 409, one above the maximum
    gives 400, and success advances the read position;
  - comments before the claim do not block, and own comments do not block;
  - the same rules for release and review.
- **Status:**
  - the transition table and invalid transitions;
  - `blocked` needs a reason;
  - `blocked_on` and blocking-task validation, including self and two-task cycles.
- **Claim end:**
  - expiry, close and revoke send `in_progress` to `ready`;
  - `blocked` stays `blocked`.
- **Blocker resolution:**
  - by agent completion, a human move to done or cancelled, a `blocked_on`
    comment, a handoff, human resolve, or a human moving the task out of blocked;
  - the resulting status is `in_progress` or `ready`, and the events are correct.
- **`TaskService.move`** rejects tasks with an active claim in any status.
- **Handoffs:**
  - direct-chat reuse, the handoff row, pending state derived from the read
    position, retry idempotency;
  - chain inheritance and reset by a human message;
  - hop, pair, sender and project limits.
- **Wait:**
  - `pending` without a cursor, and timeout with a cursor;
  - each kind wakes;
  - own actions, non-participant chats and unwatched tasks are ignored;
  - `timeout_ms=0`, the 429 concurrency limit, cleanup on disconnect;
  - no wake on a rolled-back transaction (publisher runs only after commit).
- **Other suites:**
  - **SDK** (`index.test.ts`): parsing the attention API.
  - **MCP** (`attention-tools.test.ts`, `index.test.ts`):
    - the attention notice alongside `unread_chats`, and the 404 fallback;
    - wait rounds, progress notifications only when a token is present, the
      budget clamp per integration, and abort;
    - `complete_task` passes `acknowledged_through`, keeps the token on 409 and
      surfaces details;
    - `set_task_status(review)` drops the token.
  - **CLI:**
    - Stop decisions per harness, from recorded payload fixtures.
    - The loop guards: `stop_hook_active`, Cursor `loop_count`, dedupe state,
      budget, fail-open on timeout and 5xx.
    - Setup writes the Stop, rewake and OpenCode plugin entries only when opted
      in, and removes them cleanly. Codex gets `tool_timeout_sec`; Cursor keeps
      its per-turn `stop` handling.
    - Rewake: watcher lock, supersession, and exit 2 on an event.
    - Waker: the consent gate, budgets, one process per agent, and argv
      construction with no shell. It refuses when an MCP session is online and
      never resumes desktop sessions by default.

**Real Postgres (`ORCHESTRAT_TEST_POSTGRES_URL`), new `operations/attention.integration.test.ts`:**

- **Concurrency and rollback:**
  - 20 concurrent comments on one task yield sequences 1..20 with no gaps or
    duplicates.
  - Comment vs `complete_task` race, run 50 times: never "completed" while a
    comment by another author with a sequence below completion commit remains
    unacknowledged.
  - `set_task_status` vs lease expiry vs session close; two concurrent
    completions of the same blocking task resolve a block exactly once.
  - A guard failure rolls back fully: claim active, read position unchanged,
    no events.
  - Handoff limits under concurrent senders.
- **Migration:**
  - `0015` applies on a database at `0013`, and after `0014` once branches
    exists.
  - The backfill numbers existing comments and creates read watches.
  - `packages/db/src/rls.integration.test.ts` includes the new tables.
- **Existing suites:** the claim and session concurrency tests in
  `postgres-acceptance.integration.test.ts` run unchanged and green.

**Multi-agent simulation** (`scripts/acceptance/attention-simulation.mjs`,
modelled on `mcp-live-acceptance.mjs`). It runs against a local API and real
Postgres, with two `orchestrat mcp` bridges (agents A and B) over stdio:

1. A claims T and sets `in_progress`. B comments on T. A's next tool response
   has the attention notice. A's `complete_task` gets 409, then succeeds with
   `acknowledged_through`.
2. A claims U and sets `blocked` (`blocked_on: B`), then calls
   `wait_for_update`. B hands off to A with U. A's wait returns `handoff` within
   2 s, the block resolves, and U is `in_progress`.
3. A waits with a 50 s budget and nothing happens: `no_updates` arrives in 50 s
   ± 2 s with a cursor. A second wait with that cursor catches an event
   committed in between.
4. Stop hook: pipe a recorded Claude `Stop` payload into
   `orchestrat hook claude-code --event Stop` with a pending handoff and get
   exit 2 and the template. Repeat with `stop_hook_active: true` and no new
   items, and get exit 0. Do the same for Codex, Cursor and Antigravity fixtures.
5. Waker with fake harness binaries on `PATH` that record argv and print JSON
   session ids: one handoff gives exactly one resume with the expected argv. A
   second handoff inside 5 min is deferred. A→B→A ping chain stops at hop 4 with
   429, and the waker logs "budget".
6. **Real-harness smoke, manual.** Recorded as NOT RUN until done:
   - `claude -p --resume`, `codex exec resume`;
   - Claude Desktop `asyncRewake` wake;
   - Cursor IDE `followup_message`.

The evidence goes in a dated acceptance record, with explicit NOT RUN
boundaries.

## 17. Research sources and unknowns

Sources (checked 2026-09-27):

- **Claude Code.** I re-read the hooks and MCP pages for the Stop decision,
  `stop_hook_active`, the cap of 8, `asyncRewake` idle wake, async teardown in
  `-p`, the ~28 h/idle timeouts and auto-backgrounding.
  - [cc-hooks] https://code.claude.com/docs/en/hooks
  - [cc-mcp] https://code.claude.com/docs/en/mcp
  - [cc-cli] https://code.claude.com/docs/en/cli-reference
  - [cc-sessions] https://code.claude.com/docs/en/sessions
- **Codex.** I re-read the hooks page for block, `stop_hook_active`, no
  documented cap, hash trust and "background hook doesn't start a new turn".
  - [ox-hooks] https://learn.chatgpt.com/docs/hooks (redirect from developers.openai.com/codex/hooks)
  - [ox-exec] https://learn.chatgpt.com/docs/non-interactive-mode
  - [ox-mcp] https://learn.chatgpt.com/docs/extend/mcp
  - [ox-as] https://learn.chatgpt.com/docs/app-server
  - [ox-rmcp] https://github.com/openai/codex/blob/rust-v0.158.0/codex-rs/codex-mcp/src/rmcp_client.rs (source: 300 s default; progress only logged in `rmcp-client/src/logging_client_handler.rs`)
- **Cursor.** I re-read the hooks page for `followup_message`, `loop_limit`
  (default 5), `loop_count` and per-loop firing.
  - [C1] https://cursor.com/docs/hooks
  - [C2] https://cursor.com/docs/cli/reference/parameters
  - [C5] https://forum.cursor.com/t/local-ide-agent-chats-and-the-agent-cli-still-use-separate-session-stores/165486
  - [C6] https://forum.cursor.com/t/agent-acp-mcp-tools-call-times-out-at-60s-with-no-way-to-configure-it/163925
- **Antigravity:**
  - [A1] https://antigravity.google/docs/hooks
  - [A2] https://antigravity.google/changelog
  - [A3] https://antigravity.google/docs/cli/headless
  - [A4] https://antigravity.google/docs/cli/commands/resume
  - [A6] https://github.com/google-antigravity/antigravity-cli/issues/780
  - [A7] https://github.com/google-antigravity/antigravity-cli/releases/tag/1.1.16
  - [A9] https://github.com/google-antigravity/antigravity-cli/issues/1008
  - [A11] https://github.com/google-antigravity/antigravity-cli/issues/925
- **OpenCode:**
  - [O1] https://opencode.ai/docs/plugins
  - [O3] `packages/schema/src/session-status-event.ts` in github.com/anomalyco/opencode
  - [O4] https://opencode.ai/docs/cli
  - [O5] `packages/opencode/src/cli/cmd/run.ts`
  - [O6] https://opencode.ai/docs/server
  - [O9] `packages/opencode/src/mcp/catalog.ts`
  - [O10] `packages/opencode/src/mcp/index.ts`
- **MCP spec:** progress "MAY" reset timeouts, and a request needs
  `_meta.progressToken`.
  - https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle#timeouts
  - https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/progress
- **Repository:** `@modelcontextprotocol/server` 2.0.0 tool context exposes
  `ctx.mcpReq._meta`, `ctx.mcpReq.notify` and `ctx.mcpReq.signal`
  (`createMcpHandler-*.d.mts` `BaseContext`).

Items marked [A*], [O*], [C2] and [C5]/[C6] come from a research pass and were
not re-read line by line. Their UNVERIFIED items are listed below.

Unknowns (honest list):

1. Whether Cursor's `stop` or `followup_message` fires under `agent -p`, and
   Cursor's default hook timeout.
2. Whether the Cursor IDE honours progress, and whether the bridge can tell the
   IDE from the CLI via `clientInfo`, which would allow longer IDE waits.
3. The Antigravity Stop continuation-cap key, the default MCP timeout of the
   2.0 app, whether progress extends it, and whether 1.2.x hook regressions are
   fixed.
4. Whether hook ids equal resume ids for Antigravity (`conversationId`) and
   CLI-originated Cursor chats (inferred for Claude Code, source-confirmed for
   Codex root threads).
5. Codex's real default `tool_timeout_sec` (docs say 60, source says 300).
   Setup writes an explicit value.
6. Whether Codex hooks fire in the desktop app and IDE extension. This is
   inferred from app-server hook notifications.
7. Whether OpenCode plugins load in the OpenCode desktop app, and what happens
   to a follow-up under `opencode run`.
8. Whether `claude --resume` from the waker conflicts with a session that the
   Claude Desktop app still has open (the docs say transcripts interleave).
   Mitigation: resume only waker-owned sessions.
9. Whether Claude Code's 2-minute auto-backgrounding of a long
   `wait_for_update` behaves well (it would allow longer waits without token
   cost). The 110 s default avoids it until measured.
10. The maximum `timeout` Claude Code accepts for an `asyncRewake` hook. None is
    documented; we use 3600 s.

## 18. Rollout

Release order:

1. Verify.
2. Migrate the hosted database to `0015` via `railway run` **before** pushing
   `main`.
3. Push `main`, so the API is deployed.
4. Deploy the dashboard.
5. Pack, verify and publish the CLI `alpha`.

Compatibility:

- Old CLIs keep working: new request fields are optional, and new response
  fields are stripped by zod.
- New CLIs fall back to `getInbox` on 404.
- Stop hooks, rewake and the waker are opt-in and off by default.
- Codex users must trust the new hook in `/hooks`.

Nothing in this plan is deployed, published or migrated without separate
authorization.

## 19. Decisions (answered by Arman, 2026-09-28)

1. **Intrusive wake-ups are opt-in.** Stop-hook continuation, Claude
   `asyncRewake` and the waker are all off by default, for every harness.
2. **Review ends the claim.** The task moves to `review`, and the claim is
   released with `submitted_for_review`.
3. **Blocked survives session end.** The task stays `blocked`, and it returns
   to `ready` (or `in_progress` if claimed) automatically when the blocker
   resolves.
4. **Waker scope is as recommended:**
   - wake on handoffs only;
   - start a fresh headless session on an agent's first wake;
   - after that, resume only waker-owned sessions;
   - never resume desktop-originated sessions.
5. **Loop limits are as proposed:**
   - hop ≤ 4;
   - 6 handoffs per agent pair per hour and 20 per sender per hour;
   - 12 wakes per agent per hour and 30 per day;
   - 3 concurrent waits per agent.

   These are server constants, so tuning them after dogfooding is a one-line
   change.

6. **Delivery is one merge at the end.** Slices are build order only. All
   work stays on the attention branch until ORC-19 passes, then merges to
   `main` once, after ORC-13.
   - If `feat/project-branches` merges first, the attention branch rebases onto
     `main` right away, running ORC-13 then, and again just before the final
     merge. This keeps the long-lived branch from drifting.
   - Migration `0015` ships in that single merge.

## 20. Implementation tasks (Orchestrat, backlog)

Sizes are agent-time: S ≤ ½ day, M ≈ 1 day, L ≈ 2–3 days. Dependencies are
written in each task description; add them as formal task dependencies in the
dashboard if you want claim gating.

| Key    | Task                                                                 | Slice | Size | Depends on                                                   |
| ------ | -------------------------------------------------------------------- | ----- | ---- | ------------------------------------------------------------ |
| ORC-6  | Attention 01 · DB: migration 0015                                    | 1     | M    | none                                                         |
| ORC-7  | Attention 02 · Protocol + SDK contracts                              | 1     | M    | none                                                         |
| ORC-8  | Attention 03 · API: attention service, auto-watch, mentions, summary | 1     | L    | ORC-6, ORC-7                                                 |
| ORC-9  | Attention 04 · Safe completion guard                                 | 1     | M    | ORC-8                                                        |
| ORC-10 | Attention 05 · MCP notice + get/acknowledge/watch tools              | 1     | M    | ORC-8                                                        |
| ORC-11 | Attention 06 · `wait_for_update`                                     | 1     | L    | ORC-8, ORC-10                                                |
| ORC-12 | Attention 07 · Dashboard: task attention                             | 1     | M    | ORC-8                                                        |
| ORC-13 | Attention 08 · Rebase checkpoint with `feat/project-branches`        | gate  | M    | the first merge of either feature                            |
| ORC-14 | Attention 09 · Agent status and blockers                             | 2     | L    | ORC-9 (ORC-11 soft)                                          |
| ORC-15 | Attention 10 · Handoff/ping                                          | 2     | M    | ORC-8, ORC-11 (ORC-14 soft)                                  |
| ORC-16 | Attention 11 · Dashboard: status, blockers, Ping                     | 2     | M    | ORC-12, ORC-14, ORC-15                                       |
| ORC-17 | Attention 12 · CLI stop hooks, Claude rewake, timeouts               | 3     | L    | ORC-11, ORC-15                                               |
| ORC-18 | Attention 13 · Local waker                                           | 3     | M    | ORC-15, ORC-17                                               |
| ORC-19 | Attention 14 · Simulation, real-Postgres suite, docs                 | all   | M    | phased: ORC-9/ORC-11, then ORC-14/ORC-15, then ORC-17/ORC-18 |

Build order: slice 1 (ORC-6 ∥ ORC-7 → ORC-8 → ORC-9 ∥ ORC-10 ∥ ORC-12 → ORC-11),
then slice 2, then slice 3, then ORC-19 → ORC-13 → one merge to `main`.
