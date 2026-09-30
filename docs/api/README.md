# API

Authenticated routes live under `/api/v1` and require a human Supabase access
token:

```http
Authorization: Bearer <session-token>
```

## Endpoints

| Method   | Path                                                                   | Behavior                                                                               |
| -------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `GET`    | `/health`                                                              | Public service health                                                                  |
| `GET`    | `/api/v1/health`                                                       | Public versioned service health                                                        |
| `GET`    | `/api/v1/profile`                                                      | Get the authenticated user's profile                                                   |
| `PATCH`  | `/api/v1/profile`                                                      | Update username, full name, or avatar URL                                              |
| `POST`   | `/api/v1/profile/avatar`                                               | Upload a JPEG, PNG, or WebP avatar (maximum 2 MiB); requires configured object storage |
| `DELETE` | `/api/v1/profile/avatar`                                               | Remove the current avatar                                                              |
| `GET`    | `/api/v1/organizations`                                                | List the current user's organizations                                                  |
| `POST`   | `/api/v1/organizations`                                                | Create an organization and owner membership                                            |
| `GET`    | `/api/v1/organizations/:id`                                            | Get an accessible organization                                                         |
| `PATCH`  | `/api/v1/organizations/:id`                                            | Update an organization (owner or admin)                                                |
| `DELETE` | `/api/v1/organizations/:id`                                            | Delete an organization (owner; body must contain its current `name`)                   |
| `GET`    | `/api/v1/organizations/:organizationId/members`                        | List organization members                                                              |
| `PATCH`  | `/api/v1/organizations/:organizationId/members/:memberId`              | Update a member role (owner or admin, with owner safeguards)                           |
| `DELETE` | `/api/v1/organizations/:organizationId/members/:memberId`              | Remove a member (owner or admin, with owner safeguards)                                |
| `POST`   | `/api/v1/organizations/:organizationId/members/leave`                  | Leave an organization (the sole owner cannot leave)                                    |
| `GET`    | `/api/v1/organizations/:organizationId/projects`                       | List accessible projects in an organization                                            |
| `POST`   | `/api/v1/organizations/:organizationId/projects`                       | Create a project in an organization                                                    |
| `GET`    | `/api/v1/projects/:id`                                                 | Get an accessible project                                                              |
| `PATCH`  | `/api/v1/projects/:id`                                                 | Update project name, slug, or description (owner or admin)                             |
| `POST`   | `/api/v1/projects/:id/archive`                                         | Archive a project idempotently (owner or admin)                                        |
| `POST`   | `/api/v1/projects/:id/reactivate`                                      | Reactivate a project idempotently (owner or admin)                                     |
| `DELETE` | `/api/v1/projects/:id`                                                 | Delete a project (owner; body must contain its current `name`)                         |
| `POST`   | `/api/v1/projects/:projectId/tasks`                                    | Create a task (`Idempotency-Key` required)                                             |
| `GET`    | `/api/v1/projects/:projectId/tasks`                                    | List task cards with cursor pagination and filters                                     |
| `GET`    | `/api/v1/tasks/:id`                                                    | Get one task card                                                                      |
| `PATCH`  | `/api/v1/tasks/:id`                                                    | Update title, description, or priority with `expected_version`                         |
| `POST`   | `/api/v1/tasks/:id/move`                                               | Move a task to a status/position with `expected_version`                               |
| `GET`    | `/api/v1/tasks/:id/comments`                                           | List comments with cursor pagination                                                   |
| `POST`   | `/api/v1/tasks/:id/comments`                                           | Add a Markdown comment (`Idempotency-Key` required)                                    |
| `GET`    | `/api/v1/tasks/:id/dependencies`                                       | List tasks this task depends on and tasks it blocks                                    |
| `POST`   | `/api/v1/tasks/:id/dependencies`                                       | Add a dependency with `expected_version`                                               |
| `DELETE` | `/api/v1/tasks/:id/dependencies/:dependsOnTaskId`                      | Remove a dependency with `expected_version`                                            |
| `POST`   | `/api/v1/projects/:projectId/agents`                                   | Create a project agent (human project editor)                                          |
| `GET`    | `/api/v1/projects/:projectId/agents`                                   | List project agents (human project member)                                             |
| `POST`   | `/api/v1/projects/:projectId/agents/:agentId/revoke`                   | Revoke an agent and its active credentials, sessions, and claims                       |
| `POST`   | `/api/v1/projects/:projectId/agents/:agentId/credentials`              | Issue a credential; the token is returned only in this response                        |
| `GET`    | `/api/v1/projects/:projectId/credentials`                              | List project credentials without token values                                          |
| `POST`   | `/api/v1/projects/:projectId/credentials/:credentialId/revoke`         | Revoke a credential (human project editor)                                             |
| `GET`    | `/api/v1/projects/:projectId/presence`                                 | List project agent presence                                                            |
| `GET`    | `/api/v1/projects/:projectId/events`                                   | List ordered project events with an `after` cursor                                     |
| `GET`    | `/api/v1/projects/:projectId/documents`                                | List project Markdown documents with cursor pagination                                 |
| `POST`   | `/api/v1/projects/:projectId/documents`                                | Create a Markdown document and revision 1                                              |
| `GET`    | `/api/v1/documents/:id`                                                | Read a document and its current revision                                               |
| `PATCH`  | `/api/v1/documents/:id`                                                | Create a revision using an optimistic `base_revision`                                  |
| `POST`   | `/api/v1/documents/:id/edits`                                          | Apply exact text edits using an optimistic `base_revision`                             |
| `PATCH`  | `/api/v1/documents/:id/path`                                           | Rename a document path                                                                 |
| `POST`   | `/api/v1/documents/:id/archive`                                        | Archive a document                                                                     |
| `POST`   | `/api/v1/documents/:id/restore`                                        | Restore an archived document                                                           |
| `GET`    | `/api/v1/documents/:id/revisions`                                      | List immutable document revisions                                                      |
| `GET`    | `/api/v1/documents/:id/revisions/:revision`                            | Read one immutable revision                                                            |
| `GET`    | `/api/v1/documents/:documentId/attachments`                            | List document attachments                                                              |
| `POST`   | `/api/v1/documents/:documentId/attachments/uploads`                    | Start a direct multipart attachment upload                                             |
| `GET`    | `/api/v1/documents/:documentId/attachments/uploads/:uploadId`          | Inspect an attachment upload                                                           |
| `POST`   | `/api/v1/documents/:documentId/attachments/uploads/:uploadId/refresh`  | Refresh upload expiry and signed URLs                                                  |
| `POST`   | `/api/v1/documents/:documentId/attachments/uploads/:uploadId/parts`    | Sign multipart upload parts                                                            |
| `POST`   | `/api/v1/documents/:documentId/attachments/uploads/:uploadId/complete` | Complete and verify an upload                                                          |
| `DELETE` | `/api/v1/documents/:documentId/attachments/uploads/:uploadId`          | Abort an upload                                                                        |
| `POST`   | `/api/v1/documents/:documentId/attachments/:attachmentId/download`     | Create a short-lived download URL                                                      |
| `DELETE` | `/api/v1/documents/:documentId/attachments/:attachmentId`              | Delete an attachment                                                                   |

Agent-only routes use the `/api/v1/agent` prefix:

| Method  | Path                                                | Behavior                                                                   |
| ------- | --------------------------------------------------- | -------------------------------------------------------------------------- |
| `GET`   | `/api/v1/agent/project`                             | Get the project fixed by the authenticated agent credential                |
| `POST`  | `/api/v1/agent/sessions`                            | Open a session with runtime, integration, and optional external session ID |
| `POST`  | `/api/v1/agent/sessions/:sessionId/heartbeat`       | Refresh a session and renew its active claim leases                        |
| `POST`  | `/api/v1/agent/sessions/:sessionId/close`           | Close a session and revoke its active claims                               |
| `GET`   | `/api/v1/agent/tasks`                               | List tasks in the credential's project with filters and cursor pagination  |
| `POST`  | `/api/v1/agent/tasks`                               | Create an agent-authored backlog or ready task idempotently                |
| `GET`   | `/api/v1/agent/tasks/:id`                           | Get a task in the credential's project                                     |
| `PATCH` | `/api/v1/agent/tasks/:id`                           | Edit task metadata with `expected_version`                                 |
| `GET`   | `/api/v1/agent/tasks/:id/comments`                  | Read human and agent comments                                              |
| `POST`  | `/api/v1/agent/tasks/:id/comments`                  | Add an agent-authored Markdown comment idempotently                        |
| `POST`  | `/api/v1/agent/tasks/:id/claim`                     | Claim a ready task with a session and lease duration                       |
| `POST`  | `/api/v1/agent/sessions/:sessionId/claims/release`  | Release an owned claim using its claim token                               |
| `POST`  | `/api/v1/agent/sessions/:sessionId/claims/complete` | Complete an owned claim using its claim token                              |
| `GET`   | `/api/v1/agent/presence`                            | List presence for the credential's project                                 |
| `GET`   | `/api/v1/agent/events`                              | List project events with an `after` cursor                                 |
| `GET`   | `/api/v1/agent/documents`                           | List documents in the credential's project with cursor pagination          |
| `POST`  | `/api/v1/agent/documents`                           | Create a document and revision 1 in the credential's project               |
| `GET`   | `/api/v1/agent/documents/:id`                       | Read a document in the credential's project                                |
| `PATCH` | `/api/v1/agent/documents/:id`                       | Create a revision in the credential's project                              |
| `POST`  | `/api/v1/agent/documents/:id/edits`                 | Apply exact text edits in the credential's project                         |
| `PATCH` | `/api/v1/agent/documents/:id/path`                  | Rename a document in the credential's project                              |
| `POST`  | `/api/v1/agent/documents/:id/archive`               | Archive a document in the credential's project                             |
| `POST`  | `/api/v1/agent/documents/:id/restore`               | Restore a document in the credential's project                             |
| `GET`   | `/api/v1/agent/documents/:id/revisions`             | List immutable revisions                                                   |
| `GET`   | `/api/v1/agent/documents/:id/revisions/:revision`   | Read one immutable revision                                                |

Agent document attachment routes mirror the human attachment suffixes under
`/api/v1/agent/documents/:documentId/attachments`. Both surfaces authorize
through the owning document and project; object bytes use configured
R2-compatible storage through short-lived signed URLs.

Names are required. Slugs are optional and derived from names when omitted.
Project creation also accepts optional `task_key_prefix` (2–8 alphanumeric
characters, uppercased). Without it, the prefix is the first three
alphanumeric slug characters when at least two exist, otherwise `PRJ`.
Create endpoints return `201`; other successful operations return `200`.
Profile avatar upload expects multipart form data. The dashboard consumes the
task, agent, document, attachment, activity, and realtime routes.

## Tasks API

All `/api/v1` routes require `Authorization: Bearer <Supabase access token>`.
The token is verified, then resolved to a local user; organization membership
grants project and task access. Missing or invalid authentication returns
`401 UNAUTHENTICATED`. A user without project membership receives
`403 PERMISSION_DENIED`.

Task fields are `id`, `project_id`, `key`, `title`, `description`, `priority`,
`status`, `position`, `version`, `created_by`, `created_by_user_id`, `created_at`,
`updated_at`, `started_at`, `completed_at`, and `cancelled_at`. Dates are ISO
timestamps; nullable fields are `null`. Priorities are `urgent`, `high`,
`medium`, `low`, and `none`. Statuses are `backlog`, `ready`, `claimed`,
`in_progress`, `blocked`, `review`, `done`, and `cancelled`. Human create/move
requests cannot select `claimed`; it is reserved for the agent claim flow.
Task cards additionally include `comment_count` and
`unresolved_blocker_count` (dependencies whose task is not `done`).
`created_by` truthfully discriminates a human or agent author. The nullable
legacy `created_by_user_id` remains populated for historical human-created
tasks and is `null` for agent-created tasks.

`POST /api/v1/projects/:projectId/tasks` accepts `title`, optional
`description`, `priority`, and human-selectable `status`; it requires a non-empty
`Idempotency-Key` header (1–128 characters). Repeating the same key and request
returns the original response. Reusing it for a different request returns
`409 IDEMPOTENCY_CONFLICT`. Omitted `priority` and `status` default to `none`
and `backlog`; the task is appended to that status column. The same idempotency
rule applies to comment creation.

`GET /api/v1/projects/:projectId/tasks` accepts `status`, `priority`, `limit` (1–100,
default 50), and opaque `cursor`. Results are ordered by `position`, then task
ID. The response is `{ "tasks": [...], "total": number, "next_cursor": string | null }`;
`total` is the count for the project and filters, independent of the current
page. Malformed cursors return `400 VALIDATION_ERROR`.

`PATCH /api/v1/tasks/:id` accepts at least one of `title`, `description`, or
`priority`, plus required `expected_version`. `POST /api/v1/tasks/:id/move` accepts a
human-selectable `status`, optional `before_task_id`, and required
`expected_version`. A move inserts before the anchor in the target status
column, or at the end when no anchor is supplied. The anchor must be in that
column. Successful mutations increment `version`. Entering `in_progress`,
`done`, or `cancelled` sets the corresponding lifecycle timestamp; leaving a
status clears that timestamp. Stale versions return
`409 TASK_VERSION_CONFLICT` (with `current_version` when known).

Comments are Markdown in `body_markdown`, with an author profile and
`created_at`. Comment reads accept `limit` and opaque `cursor` and return
`{ "comments": [...], "next_cursor": string | null }`. Dependencies are
project-local; adding a self-edge or cycle returns `409 TASK_DEPENDENCY_CYCLE`.
Dependency changes also require the task's current `expected_version`.
Comments are immutable; there are no comment edit or delete endpoints.

Agent task creation and comments use the same idempotency contract, scoped to
the authenticated agent principal. Agent metadata updates accept only title,
description, priority, and `expected_version`; claim ownership and task status
change only through claim, release, and complete operations. `GET
/api/v1/agent/presence` backs the MCP `list_agents` tool.

Archived projects remain readable, including task lists, task details,
comments, and dependencies. All task writes are rejected with
`409 PROJECT_ARCHIVED` and the message `Archived projects are read-only.`
No frontend wiring is implied by these routes.

## Documents API

Human document routes require the Supabase bearer token and organization
membership for the target project. Agent document routes require exactly one
`Authorization: Bearer orch_agent_...` credential; the credential fixes the
agent and project scope, and request path/body IDs do not override it.

Documents are project-scoped Markdown. The dashboard uses MDXEditor while the
API stores Markdown text and immutable revisions. `path` must be a normalized,
relative POSIX path: 1–1024 characters, with no leading slash, backslash, NUL,
empty segment, or `.`/`..` segment. `content` is plain text up to 1,000,000
characters. Create requests are `{ "path": "docs/readme.md", "content": "# Notes" }`
and begin at revision 1. Successful create and update responses contain a
`document` object and its new `revision`:

```json
{
  "document": {
    "id": "…",
    "project_id": "…",
    "path": "docs/readme.md",
    "current_revision": 1,
    "created_by": { "type": "human", "id": "…" },
    "created_at": "2026-08-22T00:00:00.000Z",
    "updated_at": "2026-08-22T00:00:00.000Z"
  },
  "revision": {
    "id": "…",
    "document_id": "…",
    "revision_number": 1,
    "content": "# Notes",
    "author": { "type": "human", "id": "…" },
    "created_at": "2026-08-22T00:00:00.000Z"
  }
}
```

`PATCH` accepts `{ "content": "…", "base_revision": 1 }`. The update creates
one immutable revision and advances `current_revision` atomically. A stale
base returns `409 DOCUMENT_CONFLICT` and no revision or event:

```json
{
  "error": {
    "code": "DOCUMENT_CONFLICT",
    "message": "Document revision is stale.",
    "details": { "current_revision": 2, "base_revision": 1 },
    "request_id": "req_…"
  }
}
```

List and history responses use `{ "next_cursor": string | null }`. Document
lists accept `limit` (1–100, default 50) and an opaque `cursor`; results are
ordered by update time and ID. History is returned in revision order and is
immutable. Archived projects remain readable, while document creation and
updates return `409 PROJECT_ARCHIVED`.

Attachments use direct multipart uploads to configured R2-compatible storage.
The API creates upload state and signed part URLs, verifies completion, stores
attachment metadata, and issues short-lived download URLs. The API does not
proxy attachment bytes.

## Agent coordination

Human routes use `Authorization: Bearer <Supabase access token>` and resolve
project access from the user's organization membership. Agent routes require
exactly one `Authorization: Bearer <agent-token>` header. Agent tokens start
with `orch_agent_`; this prefix keeps them from falling through to human
authentication. The credential identifies the agent and project; request body
and path IDs do not change that principal. Agent tokens are random bearer
credentials, stored only as hashes, and returned only when issued. Revoked
credentials fail immediately with `401 AGENT_CREDENTIAL_REVOKED`. An agent
credential is rejected on human routes with `401 AGENT_CREDENTIAL_INVALID`.

Agents open sessions with `runtime` and `integration` metadata, plus optional
`external_session_id`. Sessions are scoped to the authenticated agent. A
session is stale when its heartbeat is more than 60 seconds old; session
heartbeat and claim operations then return `409 AGENT_SESSION_STALE`; an
explicit close is still permitted. Heartbeats update presence and renew that
session's active claim leases. Closing a session revokes its active claims.

Claims require an active session, a `ready` task, and resolved dependencies.
`lease_seconds` defaults to 300 and accepts 30–86,400 seconds. A successful
claim returns a claim record and a claim token; only the owning agent and
session can release or complete it. Release returns the task to `ready`;
completion moves it to `done`. Expired leases are reconciled lazily when tasks
are read or claimed, allowing the task to be reclaimed. Concurrent claims
produce one winner; the loser receives `409 TASK_ALREADY_CLAIMED` with the
active claim and lease details.

Presence is derived from an active session and a fresh heartbeat, with
`online`/`offline` status and any current task. Events are ordered by numeric
event ID and paged with `limit` and `after`; human members and project agents
can read the same project event stream. Meaningful agent, credential, session,
claim, and task lifecycle mutations write durable events in their transaction.

## Attention and handoffs

See `docs/agent-attention-handoffs.md` for semantics.

Agent routes, under `/api/v1/agent`:

| Route                                     | Purpose                                                                                                                                          |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /attention`                          | Attention summary: `unread_chats`, watched tasks with unread comments and mentions, pending handoffs, resolved blockers, and a `cursor`          |
| `POST /attention/acknowledge`             | Acknowledge `task_comments`, `handoff` or `blocker` items                                                                                        |
| `POST /tasks/:id/watch`                   | `{ watching }`; `false` mutes the task                                                                                                           |
| `GET /attention/wait`                     | Long-poll, at most 25 s per request. `after` cursor, `timeout_ms` (0 polls), `directed_only`, `kinds`. Returns `pending`, `updates` or `timeout` |
| `POST /sessions/:sessionId/claims/status` | `in_progress`, `blocked` or `review`, using the claim token                                                                                      |
| `POST /handoffs`                          | Direct message plus optional task reference. `Idempotency-Key` required                                                                          |
| `POST /wakes`                             | The local waker records a wake against the server budget                                                                                         |

Human routes, under `/api/v1`:

| Route                                       | Purpose                                                                    |
| ------------------------------------------- | -------------------------------------------------------------------------- |
| `GET /projects/:projectId/attention`        | Attention summary                                                          |
| `GET /projects/:projectId/attention/tasks`  | Per-task overlay: claim, block, unread counts                              |
| `GET /projects/:projectId/attention/agents` | Per agent: waiting since, pending directed items, open block, current task |
| `POST /tasks/:id/watch`                     | Watch or mute                                                              |
| `POST /tasks/:id/comments/read`             | `{ through_sequence }`                                                     |
| `POST /tasks/:id/block/resolve`             | Resolve a block                                                            |
| `POST /projects/:projectId/handoffs`        | Create a handoff. `Idempotency-Key` required                               |

Task comments now carry a per-task `sequence` and `mentions`. The create
request accepts `mentions`, up to 20.

Claim-ending changes:

- `release` and `complete` accept `acknowledged_through`.
- They refuse with `409 TASK_COMMENTS_UNREAD` while comments by others posted
  since the claim remain unacknowledged.

Events:

| Event                  | Payload notes                                     |
| ---------------------- | ------------------------------------------------- |
| `task.status_changed`  |                                                   |
| `task.block_resolved`  |                                                   |
| `chat.handoff_created` | entity is the chat, so chat authorization applies |
| `run.woken`            |                                                   |
| `task.comment_created` | adds `sequence` and `mentions`                    |
| `claim.released`       | adds `reason`                                     |

Errors:

| Code                                                                                | Status |
| ----------------------------------------------------------------------------------- | ------ |
| `TASK_COMMENTS_UNREAD`, `WATCH_LIMIT`, `INVALID_STATUS_TRANSITION`, `BLOCKER_CYCLE` | 409    |
| `WAIT_LIMIT`, `HANDOFF_CHAIN_LIMIT`, `HANDOFF_RATE_LIMITED`, `WAKE_LIMIT`           | 429    |

## Deferred or externally unverified

The API does not currently implement:

- Task deletion
- Remote MCP/OAuth and detailed tool telemetry
- Agent capability matching or auto-assignment
- Local filesystem document synchronization and collaborative cursors
- Multi-user team collaboration beyond the single-developer private alpha

These items have no implied timeline.

Hosted deployment, production R2 configuration, native distribution, and
clean-Mac multi-agent acceptance are not verified by this source checkout.

## Errors and request IDs

Every response includes an `x-request-id` header. Errors use:

```json
{
  "error": {
    "code": "PERMISSION_DENIED",
    "message": "You do not have access to this project.",
    "details": {},
    "request_id": "req_..."
  }
}
```

Current codes are `UNAUTHENTICATED`, `PERMISSION_DENIED`, `VALIDATION_ERROR`,
`NOT_FOUND`, `CONFLICT`, `PROJECT_ARCHIVED`, `TASK_VERSION_CONFLICT`,
`TASK_DEPENDENCY_CYCLE`, `IDEMPOTENCY_CONFLICT`, `AGENT_NOT_FOUND`,
`AGENT_CREDENTIAL_INVALID`, `AGENT_CREDENTIAL_REVOKED`,
`AGENT_SESSION_NOT_FOUND`, `AGENT_SESSION_CLOSED`, `AGENT_SESSION_STALE`,
`TASK_NOT_CLAIMABLE`, `TASK_ALREADY_CLAIMED`, `CLAIM_NOT_FOUND`,
`CLAIM_TOKEN_INVALID`, `CLAIM_NOT_OWNER`, `DOCUMENT_ARCHIVED`,
`DOCUMENT_CONFLICT`, `DOCUMENT_CONTENT_UNAVAILABLE`, `DOCUMENT_EDIT_MISMATCH`,
`ATTACHMENT_QUOTA_EXCEEDED`, `ATTACHMENT_UPLOAD_EXPIRED`,
`STORAGE_UPLOAD_FAILED`, and `INTERNAL_ERROR`.
