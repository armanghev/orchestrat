# Agent attention and handoffs: implementation plan

Status: in progress. Spec: `docs/agent-attention-handoffs.md` (authoritative;
§19 decisions are final). Worktree `../orchestrat-attention`,
branch `feat/agent-attention` from `main` `e37bd65`. There is **one merge to
`main` at the end**, and only with Arman's go-ahead.

Guardrails for every agent:

- Edit only files your work package owns (tables below).
- Never touch the main checkout, `../orchestrat-branches` or
  `~/.codex/worktrees`.
- No `git commit`, `push`, `stash`, `reset` or `checkout`.
- No deploys, no hosted or shared database migrations, no npm publish.
- Follow house style: services are classes with paired human/agent methods,
  JSON is mapped to snake_case by hand, errors are `ApiError`, writes take a
  project-row `FOR UPDATE` lock, and events go through `insertProjectEvent`
  inside the transaction. New tables enable RLS.

## Environment and commands

- Build: `pnpm turbo build --filter='!@orchestrat/landing'`.
  - One package: `pnpm --filter @orchestrat/<pkg> build`.
  - Backend tests run on `dist`, so build before testing.
- Tests:
  - `pnpm --filter @orchestrat/<pkg> test`.
  - API: `node --test dist/routes/*.test.js ...` via the package script.
  - Real Postgres:
    `source <scratchpad>/test-env.sh`
    sets `ORCHESTRAT_TEST_POSTGRES_URL` to local dev-postgres. Tests create and
    drop their own databases.
- Lint and typecheck: `pnpm --filter @orchestrat/<pkg> lint` and `... typecheck`.
- Dashboard: `pnpm --filter @orchestrat/dashboard test` (vitest), and
  `cd apps/dashboard && pnpm exec playwright test` (WebKit, mocked API at
  `https://api.orchestrat.test`).
- Baseline (e37bd65), all green:

  | Suite            | Result                  |
  | ---------------- | ----------------------- |
  | API              | 98 pass, 2 opt-in skips |
  | DB               | 15                      |
  | Protocol         | 12                      |
  | SDK              | 11                      |
  | MCP              | 8                       |
  | CLI              | 74                      |
  | Dashboard vitest | 337                     |
  | Playwright       | 69 pass, 6 skipped      |

## Final shared contract

Implement exactly these names. If the real code forces a change, keep the
name, make the smallest change, and report it.

### DB (`packages/db`)

- Migration `drizzle/0015_agent_attention.sql`.
- `_journal.json` entry:
  `{ "idx": 15, "version": "7", "when": 1790600000000, "tag": "0015_agent_attention", "breakpoints": true }`.
- `schema.ts`:
  - `taskComments` gains:
    - `sequence: integer("sequence").notNull()`, with unique index
      `task_comments_task_sequence_unique (task_id, sequence)` and check
      `task_comments_sequence_positive`;
    - `mentions: jsonb("mentions").$type<{type:"human"|"agent";id:string;name:string}[]>().default([]).notNull()`.
  - Append at the end of the file: `taskWatches`, `taskBlocks`, `handoffs`,
    matching spec §5 (column names identical), each with `.enableRLS()`.
- The migration backfills comment sequences with
  `row_number() OVER (PARTITION BY task_id ORDER BY created_at, id)`. It also
  backfills watches for task creators, commenters and active-claim agents,
  with `reason` set to `created`, `commented` or `claimed` and
  `last_read_sequence` set to the task's current max sequence (0 if none).
- `apps/api/src/test/pg-mem-migrations.ts` skips statements pg-mem cannot
  parse (the window-function backfill, the watch backfill if needed). The real
  Postgres suite covers them.

### Protocol (`packages/protocol/src/attention.ts`)

This file imports only `zod` and never imports `index.ts`. `index.ts` may
import from it.

`attentionErrorCodeSchema`: `z.enum`

| Code                        | HTTP status |
| --------------------------- | ----------- |
| `TASK_COMMENTS_UNREAD`      | 409         |
| `WATCH_LIMIT`               | 409         |
| `INVALID_STATUS_TRANSITION` | 409         |
| `BLOCKER_CYCLE`             | 409         |
| `WAIT_LIMIT`                | 429         |
| `HANDOFF_CHAIN_LIMIT`       | 429         |
| `HANDOFF_RATE_LIMITED`      | 429         |
| `WAKE_LIMIT`                | 429         |

Schemas, with types exported as `z.infer`. `?` marks an optional field and
`|null` a nullable one:

- **Shared shapes**
  - `attentionParticipantRefSchema`: `{type: "human"|"agent", id}`
  - `attentionActorSchema`: `{type, id, name}`
  - `attentionTaskRefSchema`: `{id, key, title}`
- **Summary**
  - `attentionTaskItemSchema`: `{task_id, key, title, status, watching, claimed_by_you, unread_count, mention_count, blocking_unread_count, last_read_sequence, latest_sequence, unread: [{sequence, author: actor, excerpt, created_at, mentions_you}]}`
  - `attentionHandoffItemSchema`: `{handoff_id, from: actor, chat_id, message_id, sequence, task: taskRef|null, excerpt, created_at, hop}`
  - `attentionBlockerItemSchema`: `{block_id, task: taskRef, resolution, resolved_at}`
  - `attentionSummarySchema`: `{cursor: string, branch_id: string|null, unread_chats: [{chat_id, unread_count, mention_count}], tasks, handoffs, blockers_resolved, truncated}`
- **Acknowledge, watch, read**
  - `acknowledgeAttentionItemSchema`: discriminated union on `type`:
    - `task_comments {task_id, through_sequence ≥0}`
    - `handoff {handoff_id}`
    - `blocker {block_id}`
  - `acknowledgeAttentionRequestSchema`: `{items: min1 max50}`
  - `acknowledgeAttentionResponseSchema`: `{acknowledged: number}`
  - `taskWatchRequestSchema`: `{watching: boolean}`
  - `taskWatchSchema`: `{task_id, state: "watching"|"muted", reason, last_read_sequence}`
  - `markCommentsReadRequestSchema`: `{through_sequence ≥0}`; responds with `taskWatchSchema`
- **Status and blocks**
  - `taskBlockSchema`: `{id, task_id, reason, blocking_task: taskRef|null, blocked_on: actor|null, created_by: actor, created_at, resolved_at|null, resolution|null}`
  - `agentTaskStatusSchema`: enum `in_progress | blocked | review`
  - `setTaskStatusRequestSchema`: `{claim_token, status, reason?(1..500), blocked_on?: participantRef, blocking_task_id?, acknowledged_through?}`
    - `blocked` requires `reason`.
    - `blocked_on` and `blocking_task_id` are only allowed with `blocked`.
  - `setTaskStatusResponseSchema`: `{task: {id, key, status, version}, claim: {id, status, lease_expires_at}|null, block: taskBlock|null}`
- **Wait**
  - `waitEventKindSchema`: enum `direct_message | mention | task_comment | claim_released | status_changed | blocker_resolved | handoff`
  - `waitQuerySchema`:
    - `after?`: string of digits
    - `timeout_ms`: coerce int 0..25000, default 25000
    - `directed_only`: `"true"`/`"false"`/bool, default false
    - `kinds?`: csv string transformed to a kind array
    - `branch_id?`: uuid
  - `waitEventSchema`: `{kind, event_id: int, occurred_at, actor: actor|null, task: taskRef|null, chat_id?, message_id?, comment_sequence?, handoff_id?, from_status?, to_status?, excerpt?, branch_id: string|null}`
  - `waitResponseSchema`: `{status: "pending"|"updates"|"timeout", events: max50, cursor: string, attention: attentionSummary}`
- **Handoffs and wakes**
  - `createHandoffRequestSchema`: `{to: participantRef, body_markdown (trim 1..4000), task_id?}`
  - `handoffSchema`: `{id, chat_id, message_id, message_sequence, from: actor, to: actor, task: taskRef|null, chain_id, hop, created_at}`
  - `createHandoffResponseSchema`: `{handoff}`
  - `recordWakeRequestSchema`: `{integration: string 1..64, handoff_id: uuid|null}`
  - `recordWakeResponseSchema`: `{wake_event_id: int}`
- **Error details and overlays**
  - `unreadCommentsErrorDetailsSchema`: `{task_id, latest_sequence, total_unread, unread: max10 [{sequence, author: actor, excerpt, created_at}]}`
  - `taskAttentionOverlaySchema`: `{task_id, watching, unread_count, mention_count, claim: {agent_id, agent_name, status, lease_expires_at}|null, block: taskBlock|null}`
  - `taskAttentionOverlaysResponseSchema`: `{tasks}`
  - `agentAttentionSchema`: `{agent_id, waiting_since: string|null, pending_directed_count, open_block: {task: taskRef, reason}|null, current_task: {id, key, title, status}|null}`
  - `agentAttentionResponseSchema`: `{agents}`

Edits to `packages/protocol/src/index.ts`:

- Top: `import { attentionErrorCodeSchema } from "./attention.js";` and add it
  to the `errorCodeSchema` union.
- `taskCommentSchema`: add `sequence: z.number().int().positive()` and
  `mentions: z.array(z.object({type: z.enum(["human","agent"]), id: idSchema, name: z.string()}))`.
- `createTaskCommentRequestSchema`: add
  `mentions: z.array(z.object({type: z.enum(["human","agent"]), id: idSchema})).max(20).default([])`.
  Use an inline object; `participantRefSchema` is declared later and would
  throw a TDZ error.
- `claimMutationRequestSchema`: add
  `acknowledged_through: z.number().int().nonnegative().optional()`.
- End of file: `export * from "./attention.js";`.

### SDK (`packages/sdk/src/attention.ts`)

`export class AttentionApi`. Its constructor takes the client's request
function; `index.ts` passes `this.request.bind(this)` typed as a
`RequestFn`. All paths are relative to `/api/v1/agent`:

| Method                           | HTTP | Path                                  |
| -------------------------------- | ---- | ------------------------------------- |
| `summary(signal?)`               | GET  | `/attention`                          |
| `acknowledge(input)`             | POST | `/attention/acknowledge`              |
| `watch(taskId, watching)`        | POST | `/tasks/:id/watch`                    |
| `setStatus(sessionId, input)`    | POST | `/sessions/:sessionId/claims/status`  |
| `wait(query, signal?)`           | GET  | `/attention/wait?...`                 |
| `handoff(input, idempotencyKey)` | POST | `/handoffs`, `idempotency-key` header |
| `recordWake(input)`              | POST | `/wakes`                              |

`AgentApiClient` gains `readonly attention: AttentionApi`, plus
`export * from "./attention.js"`. There is no PUT; watch uses POST.

### API (`apps/api/src`)

Services:

- **`services/attention-hooks.ts`** (wave 2). Transaction-scoped functions,
  `Actor = {type:"human"|"agent"; id:string}`:
  - `nextCommentSequence(tx, taskId): Promise<number>`
  - `resolveCommentMentions(tx, projectId, refs): Promise<{type,id,name}[]>`.
    Allows project members plus active agents, deduplicated, at most 20. Anything
    else fails with 400 `VALIDATION_ERROR`.
  - `ensureWatch(tx, {projectId, taskId, actor, reason, lastReadSequence?})`.
    Inserts if missing and never un-mutes. Automatic watches are skipped past
    1000 watches per actor per project.
  - `onTaskCreated(tx, {projectId, taskId, actor})`
  - `onTaskClaimed(tx, {projectId, taskId, agentId})`: watch, set
    `claim_baseline_sequence` to the current max, and set
    `resolution_seen_at` on this agent's resolved blocks for the task.
  - `onTaskCommentCreated(tx, {projectId, taskId, sequence, actor, mentions})`:
    watch the commenter without advancing its read position, and watch the
    mentioned actors with `lastReadSequence = sequence - 1`.
- **`services/attention-guard.ts`** (wave 2):
  `assertCommentsAcknowledged(tx, {projectId, taskId, agentId, acknowledgedThrough?})`
  implements spec §8.
- **`services/task-block-hooks.ts`** (wave 3):
  - `resetsToReadyOnClaimEnd(status): boolean` (`claimed`, `in_progress`)
  - `hasActiveClaim(tx, taskId): Promise<boolean>`
  - `onClaimEnded(tx, {projectId, taskId, agentId, outcome: "released"|"completed"})`
  - `onTaskMoved(tx, {projectId, taskId, fromStatus, toStatus, userId})`
  - `resolveBlocksOnParticipantResponse(tx, {projectId, taskId, participant: Actor})`
  - `resolveBlock(tx, block, {resolution, resolvedBy?: Actor})`: moves the task
    to `in_progress` if a claim is active, else `ready`, and emits events.
- **`services/attention-service.ts`** (wave 2): `class AttentionService`,
  `constructor(db: Database, chats: ChatService)`. Methods:
  - `summaryAgent(principal, opts?: {branchId?: string|null})`: the
    `attentionSummary`, including `unread_chats` from `chats.inboxAgent`, the
    `handoffs` items (from the `handoffs` table, pending while the recipient's
    `chat_participants.last_read_sequence` is below `message_sequence`) and
    the `blockers_resolved` items.
  - `summaryHuman(userId, projectId)`
  - `acknowledgeAgent(principal, input)`: handles all three item types; a
    handoff advances the chat read position through `message_sequence`.
  - `watchAgent(principal, taskId, watching)` and `watchHuman(userId, taskId, watching)`
  - `markReadHuman(userId, taskId, through)`
  - `taskOverlaysHuman(userId, projectId)`
  - `agentAttentionHuman(userId, projectId, waitingSince: Map<string, Date>)`
  - `currentCursor(projectId): Promise<string>` (max `project_events.id`)
  - `attentionBranchScope(branchId)`: no-op seam, returns `null`.
- **`services/attention-events.ts`** (wave 3):
  `classifyEventsSince(db, principal, after: number, opts: {directedOnly, kinds?, limit}) → {events, cursor}`.
- **`services/attention-wait-hub.ts`**: `class AttentionWaitHub`,
  `constructor(attention: AttentionService, db: Database)`.
  - Methods: `notify(envelope)`, `wait(principal, query, signal): Promise<WaitResponse>`,
    `waitingSince(projectId): Map<agentId, Date>`.
  - Wave 2 creates a stub (`notify` is a no-op, `wait` throws 501); wave 3
    implements it.
- **`services/task-status-service.ts`**: `class TaskStatusService`,
  `constructor(db, claims: TaskClaimService)`. Methods:
  `setStatus(principal, sessionId, input)`, `resolveBlockHuman(userId, taskId)`.
  Wave 2 stubs it; wave 3 implements it.
- **`services/handoff-service.ts`**: `class HandoffService`,
  `constructor(db, chats: ChatService)`. Methods:
  `createAgent(principal, input, key)`, `createHuman(userId, projectId, input, key)`,
  `recordWake(principal, input)`. Wave 2 stubs it; wave 3 implements it.
- **`TaskClaimService`** (wave 3) gains a public method appended at the end of
  the class:
  `withActiveClaim<T>(principal, sessionId, token, fn: (tx, ctx: {claim, task, now}) => Promise<T>)`.

Routes:

- **`routes/attention.ts`** (wave 2) exports:
  - `agentAttentionRoutes(app, opts: {attention, waits, statuses, handoffs})`
  - `humanAttentionRoutes(app, opts)`

  Each registers its own core handlers, then registers the sub-plugins from
  `routes/attention-wait.ts` (`agentWaitRoutes`, `humanWaitRoutes`),
  `routes/attention-status.ts` (`agentStatusRoutes`, `humanStatusRoutes`) and
  `routes/attention-handoffs.ts` (`agentHandoffRoutes`, `humanHandoffRoutes`).
  Wave 2 creates those three files as empty plugins; wave 3 fills them.

- **Agent routes** (`/api/v1/agent`):

  | Method and path                               | File     |
  | --------------------------------------------- | -------- |
  | `GET /attention`                              | core     |
  | `POST /attention/acknowledge`                 | core     |
  | `POST /tasks/:id/watch`                       | core     |
  | `GET /attention/wait`                         | wait     |
  | `POST /sessions/:sessionId/claims/status`     | status   |
  | `POST /handoffs` (`Idempotency-Key` required) | handoffs |
  | `POST /wakes`                                 | handoffs |

- **Human routes** (`/api/v1`):

  | Method and path                                          | File     |
  | -------------------------------------------------------- | -------- |
  | `GET /projects/:projectId/attention`                     | core     |
  | `GET /projects/:projectId/attention/tasks`               | core     |
  | `POST /tasks/:id/watch`                                  | core     |
  | `POST /tasks/:id/comments/read`                          | core     |
  | `GET /projects/:projectId/attention/agents`              | wait     |
  | `POST /tasks/:id/block/resolve`                          | status   |
  | `POST /projects/:projectId/handoffs` (`Idempotency-Key`) | handoffs |

`app.ts` (wave 2, final wiring):

```ts
const attention = new AttentionService(db, chats);
const waits = new AttentionWaitHub(attention, db);
const statuses = new TaskStatusService(db, claims);
const handoffs = new HandoffService(db, chats);
```

- The publisher becomes
  `(event, audience) => { waits.notify(event); return realtimeRegistry.publish(event, audience); }`.
  `waits` is declared after `db`; the closure runs later, the same pattern as
  `chats` in `realtimeRegistry`.
- The human block adds
  `api.register(humanAttentionRoutes, { attention, waits, statuses, handoffs })`.
- The agent block adds
  `api.register(agentAttentionRoutes, { attention, waits, statuses, handoffs })`.

Hotspot call sites follow spec §13 exactly.

Events:

| Event                  | Payload                                                                             |
| ---------------------- | ----------------------------------------------------------------------------------- |
| `task.comment_created` | adds `sequence` and `mentions: [{type, id}]`                                        |
| `task.status_changed`  | `{from_status, to_status, claim_id, block?: {id, blocked_on, blocking_task_id}}`    |
| `task.block_resolved`  | `{block_id, resolution, to_status}`                                                 |
| `claim.released`       | adds `reason: "agent_release" \| "submitted_for_review"`                            |
| `chat.handoff_created` | entity = chat id; `{message_id, handoff_id, participant: {type, id}, task_id, hop}` |
| `run.woken`            | entity = agent id; `{integration, handoff_id, hop}`                                 |

### MCP (`packages/mcp`)

- `src/attention-tools.ts` (wave 2):
  - Exports
    `type AttentionToolHost = { server: McpServer; call: McpBridge["call"]-like; client(): {attention: AttentionApi; ...}; requireSession(): string; claims: ClaimTokenStore; integration: string; waitBudgetSeconds?: number }`.
  - `registerAttentionTools(host)` registers `get_attention`,
    `acknowledge_attention` and `watch_task`, then calls
    `registerWaitTool(host)` (`src/wait-tool.ts`), `registerStatusTool(host)`
    (`src/status-tool.ts`) and `registerHandoffTool(host)`
    (`src/handoff-tool.ts`).
  - Wave 2 creates those three files as no-op stubs; wave 3 fills them.
- `index.ts` (wave 2):
  - `BridgeOptions.waitBudgetSeconds?: number`.
  - The `Client` Pick adds `"attention"`.
  - A private `attentionHost()`, and a `registerAttentionTools(this.attentionHost())`
    call at the end of `registerTools()`.
  - `complete_task`/`release_task` gain `acknowledged_through`.
  - `mapMcpError` passes `TASK_COMMENTS_UNREAD` details through.
  - `call()` makes one `attention.summary()` request, emits the unchanged
    `unread_chats` notice plus the `attention` notice (lists of at most 5),
    and on a 404 falls back to `getInbox`, remembering that per process.
  - `startStdioBridge` passes the option through.
- Tools:
  - `wait_for_update {cursor?, max_wait_seconds?, directed_only?}`
  - `set_task_status {task_id, status, reason?, blocked_on?, blocking_task_id?, acknowledged_through?}`:
    uses the local claim token and drops it when `review` succeeds.
  - `handoff {to, message, task_id?, idempotency_key}`
- `wait_for_update` budgets:

  | Integration | Default wait                                | Maximum |
  | ----------- | ------------------------------------------- | ------- |
  | claude-code | 110 s                                       | 1800 s  |
  | codex       | 50 s, or `waitBudgetSeconds` capped at 600  | 600 s   |
  | cursor      | 50 s                                        | 50 s    |
  | antigravity | 150 s, or `waitBudgetSeconds` capped at 600 | 600 s   |
  | opencode    | 600 s                                       | 1800 s  |
  | other       | 50 s                                        | 50 s    |
  - It waits in rounds of at most 25 s.
  - Between rounds it sends `notifications/progress` only when
    `ctx.mcpReq._meta?.progressToken` is present, and it aborts on
    `ctx.mcpReq.signal`.

### CLI (`apps/cli`)

- `main.ts` (owned by the cli-hooks agent in wave 3):
  - `orchestrat mcp --wait-budget-seconds <n>` passes `waitBudgetSeconds`.
  - `hook <claude-code|codex> --event Stop [--watch]`, and
    `hook opencode --event idle`.
  - `setup ... --auto-continue --rewake`.
  - `waker <enable|disable|status|run> [--once] [--dry-run]` dispatches to
    `runWakerCommand(args: string[], ctx: { home: string; cwd: string; api: string; credentials: CredentialReader }): Promise<number>`,
    exported by `src/waker.ts`.
- `config.ts` must preserve and type the `attention` key
  (`{continue_on_stop?: ConfigurableIntegration[]; rewake?: boolean}`) and the
  `waker` key (an opaque record, validated by `waker.ts`), so other commands
  never drop them.
- New files: `src/stop-hooks.ts`, `src/opencode-plugin.ts`, `src/waker.ts`.

### Dashboard (`apps/dashboard/src`)

- `features/attention/*`: query options and keys under `["attention", projectId, ...]`,
  plus `TaskAttentionBadge`, `TaskAttentionPanel` (wave 2), `BlockedCallout`,
  `PingDialog` and `AgentAttentionLine` (wave 3).
- API calls go through the existing `lib/api/client.ts` pattern.
- `TaskDetail` derives `claimed` from the overlay's `claim`.
- Follow DESIGN.md.

## Waves and file ownership

Concurrent agents in a wave never own the same file.

**Wave 1 (parallel)**

| Agent     | WP    | Owns                                                       |
| --------- | ----- | ---------------------------------------------------------- |
| db        | ORC-6 | `packages/db/**`, `apps/api/src/test/pg-mem-migrations.ts` |
| contracts | ORC-7 | `packages/protocol/**`, `packages/sdk/**`                  |

Gate: build; protocol, sdk and db tests; API pg-mem suite still green; the
migration applied on real Postgres from a 0013 database with comments.

**Wave 2 (parallel)**

| Agent          | WP                 | Owns                                                                                                                                                                                                                                                                   |
| -------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| api-core       | ORC-8 + ORC-9 API  | `apps/api/src/{app.ts, services/attention-*.ts, services/task-status-service.ts (stub), services/handoff-service.ts (stub), services/task-service.ts, services/task-claim-service.ts, services/chat-service.ts, routes/attention*.ts, routes/*.test.ts for attention}` |
| mcp            | ORC-10 + ORC-9 MCP | `packages/mcp/**`                                                                                                                                                                                                                                                      |
| dash-attention | ORC-12             | `apps/dashboard/**`                                                                                                                                                                                                                                                    |

Gate: full build, lint and typecheck; API, MCP and dashboard tests; real
Postgres guard race and rollback tests.

**Wave 3 (parallel)**

| Agent       | WP     | Owns                                                                                                                                                                                                               |
| ----------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| wait        | ORC-11 | `apps/api/src/services/{attention-wait-hub.ts, attention-events.ts}`, `routes/attention-wait.ts` (+ test), `packages/mcp/src/wait-tool.ts` (+ test)                                                                |
| status      | ORC-14 | `apps/api/src/services/{task-status-service.ts, task-block-hooks.ts, task-claim-service.ts, agent-service.ts, task-service.ts}`, `routes/attention-status.ts` (+ test), `packages/mcp/src/status-tool.ts` (+ test) |
| handoff     | ORC-15 | `apps/api/src/services/handoff-service.ts`, `routes/attention-handoffs.ts` (+ test), `packages/mcp/src/handoff-tool.ts` (+ test). Calls `resolveBlocksOnParticipantResponse` from the status agent                 |
| cli-hooks   | ORC-17 | `apps/cli/**` except `waker*`                                                                                                                                                                                      |
| waker       | ORC-18 | `apps/cli/src/waker.ts`, `apps/cli/src/waker.test.ts`                                                                                                                                                              |
| dash-status | ORC-16 | `apps/dashboard/**`                                                                                                                                                                                                |

Gate: the full suite, including real Postgres, then an adversarial review
(spec conformance, concurrency, security/privacy) and a fix loop.

**Wave 4**

| Agent      | WP     | Owns                                                                                                                                                |
| ---------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| acceptance | ORC-19 | `scripts/acceptance/attention-simulation.mjs`, `apps/api/src/operations/attention.integration.test.ts`, `docs/agent-setup.md`, `docs/api/README.md` |

After that: the final full gate and the ORC-13 checkpoint. `feat/project-branches`
has not merged, so the checkpoint covers the migration ordering check and the
full suite only.

## Per-WP acceptance

Each WP implements its spec sections, with the tests listed in spec §16:

| WP                | Spec sections  |
| ----------------- | -------------- |
| ORC-6             | §5             |
| ORC-7             | §6             |
| ORC-8             | §4, §7         |
| ORC-9             | §8             |
| ORC-10            | §12            |
| ORC-11            | §10            |
| ORC-12 and ORC-16 | §14            |
| ORC-14            | §9             |
| ORC-15            | §11.1          |
| ORC-17            | §11.3          |
| ORC-18            | §11.4          |
| ORC-19            | §16 simulation |

Each agent finishes by running its package's build, typecheck, lint and tests,
and reports the exact results and every deviation from this contract.
