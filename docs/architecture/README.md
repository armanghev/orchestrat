# Architecture

Phase 2 adds the durable human project hierarchy without changing the Phase 1
application boundaries.

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
Supabase session grants supply durable human identity and persistent browser
sessions only.

## Database

`packages/db` contains the Drizzle schema, PostgreSQL client, seed command, and
reviewed SQL migrations. IDs are UUIDs. Slugs are unique globally for
organizations and within their parent for workspaces and projects. Foreign
keys cascade only when the parent is deleted. The project status/archive
constraint prevents contradictory archival state.

The `users.auth_subject` column is the only addition to the master plan's user
fields. It is required to map a Supabase subject to a stable local UUID without
making a vendor ID the database primary key.

## Authorization

Organization membership is the Phase 2 access boundary. Membership grants
access to that organization's workspaces and projects; the API resolves those
relationships with joins before every read or write. No client-supplied
organization, workspace, or project ID is trusted by itself.

Project-specific roles and invitations are intentionally deferred. Add a
project membership table only when the product needs access narrower than the
organization boundary.

## Authentication

The dashboard uses Supabase session grants as short-lived Bearer tokens. The API
verifies claims (role, issuer, audience, expiry) and creates the corresponding
local user on the first authenticated request using normalized profile fields.
Later requests resolve identity from PostgreSQL. Agent authentication is not part
of this phase.

Every response includes `x-request-id`. API errors use the shared structured
error envelope and include the same request ID.
