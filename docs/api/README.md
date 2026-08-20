# API

Phase 2 domain routes live under `/api/v1` and require a human Supabase access JWT:

```http
Authorization: Bearer <session-token>
```

## Endpoints

| Method  | Path                                               | Behavior                                    |
| ------- | -------------------------------------------------- | ------------------------------------------- |
| `GET`   | `/health`                                          | Public service health                       |
| `GET`   | `/api/v1/health`                                   | Public versioned service health             |
| `GET`   | `/api/v1/organizations`                            | List the current user's organizations       |
| `POST`  | `/api/v1/organizations`                            | Create an organization and owner membership |
| `GET`   | `/api/v1/organizations/:id`                        | Get an accessible organization              |
| `GET`   | `/api/v1/organizations/:organizationId/workspaces` | List workspaces                             |
| `POST`  | `/api/v1/organizations/:organizationId/workspaces` | Create a workspace                          |
| `GET`   | `/api/v1/workspaces/:id`                           | Get an accessible workspace                 |
| `GET`   | `/api/v1/workspaces/:workspaceId/projects`         | List projects                               |
| `POST`  | `/api/v1/workspaces/:workspaceId/projects`         | Create a project                            |
| `GET`   | `/api/v1/projects/:id`                             | Get an accessible project                   |
| `PATCH` | `/api/v1/projects/:id`                             | Update project name, slug, or description   |
| `POST`  | `/api/v1/projects/:id/archive`                     | Archive a project idempotently              |

Names are required. Slugs are optional and derived from names when omitted.
Create endpoints return `201`; other successful operations return `200`.

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
