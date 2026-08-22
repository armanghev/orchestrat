# Architecture

The current foundation provides a durable human organization/project hierarchy
without changing the application boundaries.

## Request flow

```text
Dashboard + Supabase user access token
  -> Fastify /api/v1 route
  -> Supabase JWT verification and local user resolution
  -> application service
  -> reusable membership check
  -> Drizzle query
  -> PostgreSQL
```

Routes validate shared Zod contracts from `@orchestrat/protocol` and delegate
to services under `apps/api/src/services`. PostgreSQL remains authoritative;
Supabase supplies human identity and browser/native sessions only.

## Database

`packages/db` contains the Drizzle schema, PostgreSQL client, seed command, and
reviewed SQL migrations. IDs are UUIDs. Organization slugs are globally unique;
project slugs are unique within their organization. Foreign keys cascade only
when the parent is deleted. The project status/archive constraint prevents
contradictory archival state.

The `users.auth_subject` column is the only addition to the master plan's user
fields. It is required to map a Supabase subject to a stable local UUID without
making a vendor ID the database primary key.

## Authorization

Organization membership is the access boundary. Membership grants access to
that organization's projects; the API resolves those relationships with joins
before every read or write. No client-supplied organization or project ID is
trusted by itself. Owners, admins, and members have progressively narrower
organization-management permissions.

Project-specific roles and invitations are intentionally deferred. Add a
project membership table only when the product needs access narrower than the
organization boundary.

## Authentication

The dashboard uses Supabase access tokens as Bearer tokens. The API verifies
the token's issuer, audience, expiry, and authenticated role, then creates the
corresponding local user on the first authenticated request using normalized
profile fields. Later requests resolve identity from PostgreSQL. Agent
authentication and task-claim routes are not implemented. The database contains
a claim schema for a future agent flow, but it is not an API contract.

Tasks are project-scoped and use a monotonically increasing `version` for
optimistic concurrency. Kanban positions are ordered within each status; moves
accept an optional `before_task_id` anchor. Comments and dependency edges are
separate project-local records. Archived projects allow task reads but reject
task writes.

Every response includes `x-request-id`. API errors use the shared structured
error envelope and include the same request ID.
