# API

Authenticated routes live under `/api/v1` and require a human Supabase access
token:

```http
Authorization: Bearer <session-token>
```

## Endpoints

| Method   | Path                                                      | Behavior                                                                               |
| -------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `GET`    | `/health`                                                 | Public service health                                                                  |
| `GET`    | `/api/v1/health`                                          | Public versioned service health                                                        |
| `GET`    | `/api/v1/profile`                                         | Get the authenticated user's profile                                                   |
| `PATCH`  | `/api/v1/profile`                                         | Update username, full name, or avatar URL                                              |
| `POST`   | `/api/v1/profile/avatar`                                  | Upload a JPEG, PNG, or WebP avatar (maximum 2 MiB); requires configured object storage |
| `DELETE` | `/api/v1/profile/avatar`                                  | Remove the current avatar                                                              |
| `GET`    | `/api/v1/organizations`                                   | List the current user's organizations                                                  |
| `POST`   | `/api/v1/organizations`                                   | Create an organization and owner membership                                            |
| `GET`    | `/api/v1/organizations/:id`                               | Get an accessible organization                                                         |
| `PATCH`  | `/api/v1/organizations/:id`                               | Update an organization (owner or admin)                                                |
| `DELETE` | `/api/v1/organizations/:id`                               | Delete an organization (owner; body must contain its current `name`)                   |
| `GET`    | `/api/v1/organizations/:organizationId/members`           | List organization members                                                              |
| `PATCH`  | `/api/v1/organizations/:organizationId/members/:memberId` | Update a member role (owner or admin, with owner safeguards)                           |
| `DELETE` | `/api/v1/organizations/:organizationId/members/:memberId` | Remove a member (owner or admin, with owner safeguards)                                |
| `POST`   | `/api/v1/organizations/:organizationId/members/leave`     | Leave an organization (the sole owner cannot leave)                                    |
| `GET`    | `/api/v1/organizations/:organizationId/projects`          | List accessible projects in an organization                                            |
| `POST`   | `/api/v1/organizations/:organizationId/projects`          | Create a project in an organization                                                    |
| `GET`    | `/api/v1/projects/:id`                                    | Get an accessible project                                                              |
| `PATCH`  | `/api/v1/projects/:id`                                    | Update project name, slug, or description (owner or admin)                             |
| `POST`   | `/api/v1/projects/:id/archive`                            | Archive a project idempotently (owner or admin)                                        |
| `POST`   | `/api/v1/projects/:id/reactivate`                         | Reactivate a project idempotently (owner or admin)                                     |
| `DELETE` | `/api/v1/projects/:id`                                    | Delete a project (owner; body must contain its current `name`)                         |
| `POST`   | `/api/v1/projects/:projectId/tasks`                       | Create a task (`Idempotency-Key` required)                                             |
| `GET`    | `/api/v1/projects/:projectId/tasks`                       | List task cards with cursor pagination and filters                                     |
| `GET`    | `/api/v1/tasks/:id`                                       | Get one task card                                                                      |
| `PATCH`  | `/api/v1/tasks/:id`                                       | Update title, description, or priority with `expected_version`                         |
| `POST`   | `/api/v1/tasks/:id/move`                                  | Move a task to a status/position with `expected_version`                               |
| `GET`    | `/api/v1/tasks/:id/comments`                              | List comments with cursor pagination                                                   |
| `POST`   | `/api/v1/tasks/:id/comments`                              | Add a Markdown comment (`Idempotency-Key` required)                                    |
| `GET`    | `/api/v1/tasks/:id/dependencies`                          | List tasks this task depends on and tasks it blocks                                    |
| `POST`   | `/api/v1/tasks/:id/dependencies`                          | Add a dependency with `expected_version`                                               |
| `DELETE` | `/api/v1/tasks/:id/dependencies/:dependsOnTaskId`         | Remove a dependency with `expected_version`                                            |

Names are required. Slugs are optional and derived from names when omitted.
Project creation also accepts optional `task_key_prefix` (2–8 alphanumeric
characters, uppercased). Without it, the prefix is the first three
alphanumeric slug characters when at least two exist, otherwise `PRJ`.
Create endpoints return `201`; other successful operations return `200`.
Profile avatar upload expects multipart form data. The dashboard is not yet
wired to these task routes.

## Tasks API

All `/api/v1` routes require `Authorization: Bearer <Supabase access token>`.
The token is verified, then resolved to a local user; organization membership
grants project and task access. Missing or invalid authentication returns
`401 UNAUTHENTICATED`. A user without project membership receives
`403 PERMISSION_DENIED`.

Task fields are `id`, `project_id`, `key`, `title`, `description`, `priority`,
`status`, `position`, `version`, `created_by_user_id`, `created_at`,
`updated_at`, `started_at`, `completed_at`, and `cancelled_at`. Dates are ISO
timestamps; nullable fields are `null`. Priorities are `urgent`, `high`,
`medium`, `low`, and `none`. Statuses are `backlog`, `ready`, `claimed`,
`in_progress`, `blocked`, `review`, `done`, and `cancelled`. Human create/move
requests cannot select `claimed`; it is reserved for a future agent-claim
flow. Task cards additionally include `comment_count` and
`unresolved_blocker_count` (dependencies whose task is not `done`).

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

Archived projects remain readable, including task lists, task details,
comments, and dependencies. All task writes are rejected with
`409 PROJECT_ARCHIVED` and the message `Archived projects are read-only.`
There are currently no task-claim or task-delete endpoints, despite the
database containing a claim schema. No frontend wiring is implied by these
routes.

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
`TASK_DEPENDENCY_CYCLE`, `IDEMPOTENCY_CONFLICT`, and `INTERNAL_ERROR`.
