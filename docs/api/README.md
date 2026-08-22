# API

Authenticated routes live under `/api/v1` and require a human Supabase access
token:

```http
Authorization: Bearer <session-token>
```

## Endpoints

| Method | Path | Behavior |
| --- | --- | --- |
| `GET` | `/health` | Public service health |
| `GET` | `/api/v1/health` | Public versioned service health |
| `GET` | `/api/v1/profile` | Get the authenticated user's profile |
| `PATCH` | `/api/v1/profile` | Update username, full name, or avatar URL |
| `POST` | `/api/v1/profile/avatar` | Upload a JPEG, PNG, or WebP avatar (maximum 2 MiB); requires configured object storage |
| `DELETE` | `/api/v1/profile/avatar` | Remove the current avatar |
| `GET` | `/api/v1/organizations` | List the current user's organizations |
| `POST` | `/api/v1/organizations` | Create an organization and owner membership |
| `GET` | `/api/v1/organizations/:id` | Get an accessible organization |
| `PATCH` | `/api/v1/organizations/:id` | Update an organization (owner or admin) |
| `DELETE` | `/api/v1/organizations/:id` | Delete an organization (owner; body must contain its current `name`) |
| `GET` | `/api/v1/organizations/:organizationId/members` | List organization members |
| `PATCH` | `/api/v1/organizations/:organizationId/members/:memberId` | Update a member role (owner or admin, with owner safeguards) |
| `DELETE` | `/api/v1/organizations/:organizationId/members/:memberId` | Remove a member (owner or admin, with owner safeguards) |
| `POST` | `/api/v1/organizations/:organizationId/members/leave` | Leave an organization (the sole owner cannot leave) |
| `GET` | `/api/v1/organizations/:organizationId/projects` | List accessible projects in an organization |
| `POST` | `/api/v1/organizations/:organizationId/projects` | Create a project in an organization |
| `GET` | `/api/v1/projects/:id` | Get an accessible project |
| `PATCH` | `/api/v1/projects/:id` | Update project name, slug, or description (owner or admin) |
| `POST` | `/api/v1/projects/:id/archive` | Archive a project idempotently (owner or admin) |
| `POST` | `/api/v1/projects/:id/reactivate` | Reactivate a project idempotently (owner or admin) |
| `DELETE` | `/api/v1/projects/:id` | Delete a project (owner; body must contain its current `name`) |

Names are required. Slugs are optional and derived from names when omitted.
Create endpoints return `201`; other successful operations return `200`.
Profile avatar upload expects multipart form data. The API does not currently
provide task, agent, document, message, activity, MCP, hook, or realtime
endpoints.

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

Current codes are `UNAUTHENTICATED`, `PERMISSION_DENIED`,
`VALIDATION_ERROR`, `NOT_FOUND`, `CONFLICT`, and `INTERNAL_ERROR`.
