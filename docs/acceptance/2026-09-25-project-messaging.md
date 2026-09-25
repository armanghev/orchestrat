# Project messaging acceptance and alpha rollout readiness

Date: 2026-09-25 UTC

Status: **backend implemented and locally verified; dashboard integration in
progress; hosted rollout not run**. This record contains read-only hosted
observations and local disposable recovery checks. It does not claim that
migrations `0012` or `0013`, the messaging API, the dashboard, or a
messaging-capable CLI have been deployed to alpha.

## Local acceptance

The local messaging acceptance checks cover:

- Human-to-human, human-to-agent, and agent-to-agent messages in both
  directions.
- Direct-chat canonicalization, concurrent sends, ordered pagination, unread
  and mention counts, and explicit read acknowledgment.
- Project isolation and rejection of forged participants, mentions, document
  references, revoked agents, and revoked credentials.
- Agent-only observation, joining and sticky privacy, membership removal, and
  stable document references after document renames.
- The absence of message-edit, message-delete, and chat-delete operations.

Checks run locally:

- `pnpm --filter @orchestrat/api lint`
- `pnpm --filter @orchestrat/api typecheck`
- `pnpm --filter @orchestrat/api build`
- `node --test apps/api/dist/routes/chats-adversarial.test.js` — 1 pass
- `node --test apps/api/dist/routes/chats.test.js` — 1 pass
- `pnpm --filter @orchestrat/api test:postgres` against a disposable local
  PostgreSQL instance — 14 pass and 1 existing R2 opt-in skip
- Full API suite — 82 pass and 2 existing opt-in skips

## Read-only hosted alpha observations

- Railway project `orchestrat-api` uses project
  `fb1f935a-d229-4581-ae26-3e4d188c6329`, production environment
  `a1cba632-0d69-4dcf-adf4-083cfc748e70`, and service
  `62a1f90e-6bb1-4186-bc09-a82918213a04`.
- The API is one `us-west2` replica built from GitHub `main` with
  `deploy/Dockerfile.api`. Railway has no pre-deploy migration command and no
  watch-path restriction, so a push to `main` can deploy the API before a
  separately run database migration.
- The active Railway deployment is healthy at source `f70b998`; both
  `https://api.orchestrat.dev/health` and `/ready` returned `200` during the
  audit.
- The Vercel dashboard project is `orchestrat-dashboard`
  (`prj_UT6MIivZ9e80TolQ2XKTJUYJq0jn`), rooted at `apps/dashboard` and connected
  to GitHub `main`. Its latest Ready production artifact was also built from
  `f70b998`.
- `app.orchestrat.dev` is pinned to an older `89e10cc` deployment. Its delivered
  bundle points to the alpha API and auth callback but does not contain the
  messaging contract. This pinned alias is a useful release gate.
- Railway and the dashboard use the same healthy Supabase alpha project. The
  hosted Drizzle journal contains 12 migrations through `0011`; repository
  migrations `0012_document_folders` and `0013_project_messaging` are pending.

No remote resource, environment value, deployment, alias, database row, or
migration was changed during this assessment.

### Supabase direct-access privacy gate

A read-only request to the alpha Supabase REST endpoint returned the expected
missing-API-key response, confirming that the Data API gateway is active.
Database metadata showed that `anon` and `authenticated` have `USAGE` on the
`public` schema and `SELECT`, `INSERT`, `UPDATE`, and `DELETE` privileges on
current public tables. The `postgres` default ACL grants those same table
privileges to both roles for newly created public tables.

All 20 existing public tables have row-level security enabled. They have no
policies, do not force RLS, and are owned by `postgres`; the `postgres` API
connection therefore retains owner access while direct Data API roles see no
rows and cannot write. The original pending `0012` and `0013` SQL did not
enable RLS, which would have exposed the six new tables through inherited
Supabase grants and bypassed API conversation authorization.

The pending `0013` migration now enables RLS, without policies or `FORCE`, on
`document_folders`, `project_members`, `project_invitations`, `chats`,
`chat_participants`, and `chat_messages`. Keeping the safeguard in `0013`
protects databases that may already have applied `0012` without rewriting
published migration history. A disposable PostgreSQL test grants a synthetic
direct-access role full table privileges and proves that it sees no rows,
cannot insert, update, or delete, while the owner retains read and write
access. No hosted schema was changed by this verification.

## Recovery evidence

### Schema-only restore and migration rehearsal

The Supabase alpha database runs PostgreSQL 17. A PostgreSQL 17 `pg_dump`
custom archive containing only the `public` and `drizzle` schemas was created
with mode `0600`; it contained no table rows. It was restored into an isolated
database on the disposable local PostgreSQL 14.23 cluster.

PostgreSQL 17's dump output included `SET transaction_timeout = 0`, which
PostgreSQL 14 does not recognize. The rehearsal removed only that session
setting before restore; it did not alter schema SQL. The restored schema had
the expected 20 `public` tables and one `drizzle` table. Because a schema-only
archive has no migration-history rows, the disposable database received a
local-only sentinel representing the verified hosted `0011` state. The normal
Drizzle migrator then applied `0012` and `0013` successfully and created
`project_members`, `project_invitations`, `chats`, `chat_participants`, and
`chat_messages`.

A fresh read-only hosted check still showed 12 migrations through `0011`.
The disposable database, archive, and temporary directory were removed after
the aggregate checks. This proves schema compatibility for these migrations;
it does **not** prove recovery of hosted row data. A PostgreSQL 17 restore
target should be used for a later data-bearing recovery drill so no
compatibility filtering is needed.

### Migration blast radius and minimum rollback scope

Both pending migrations are additive:

- `0012` creates `document_folders`, its foreign key, and its unique index.
- `0013` creates the project-membership, invitation, chat, participant, and
  message tables, their constraints, and their indexes.
- The only data statement inserts into the new `project_members` table by
  selecting from unchanged `projects` and `organization_members` rows with
  `ON CONFLICT DO NOTHING`.
- Neither migration updates or deletes an existing application row. They do
  not change document bodies or R2 objects.

For an application rollback, the previous API can run while these additive
tables remain in place. This repository uses forward-only migrations, so the
safe database response is a reviewed forward repair rather than an improvised
down migration. The backfill is reproducible from the unchanged source tables.
A full hosted-data export is therefore not required solely to make `0012` and
`0013` reversible.

A narrower data-bearing archive of `projects`, `organization_members`, and the
Drizzle migration journal would cover the source state used by the backfill.
It is still sensitive because it contains project metadata, user identifiers,
and roles, and it would not provide general disaster recovery. It was not
attempted. Before migration, aggregate counts of source memberships and the
expected backfill should be recorded; afterward, the journal and backfilled
row counts should match those aggregates.

The runbook's R2 backup requirement applies before a document-storage cutover.
Neither pending migration changes R2 or existing document bodies, so an R2
backup is not a gate for this messaging rollout.

### Data-recovery drill requiring explicit approval

Automatic approval review rejected a proposed full hosted logical export. The
rejected action would have injected the Railway database URL into a temporary
`postgres:17` container and run `pg_dump --format=custom --no-owner
--no-privileges`, writing the entire alpha database to
`/private/tmp/orchestrat-alpha-recovery.Fe5jTD/alpha.dump`. The review reason
was that copying the whole hosted alpha database could expose sensitive user
and organization data locally without sufficiently explicit authorization for
that payload and destination. No full-data archive was created, and the action
was not retried or narrowed to bypass the rejection.

If a full logical recovery drill is desired after local implementation work is
complete, obtain explicit user approval for this exact scope:

- Export the complete hosted alpha PostgreSQL database with PostgreSQL 17 to
  `/private/tmp/orchestrat-alpha-messaging-backup-20260925/alpha-pre-messaging.dump`.
- Create the directory with mode `0700` and the custom-format archive with mode
  `0600`. Do not print connection values, rows, identities, or tokens.
- Restore into a disposable PostgreSQL 17 database or container named
  `orchestrat_alpha_messaging_restore_20260925` and verify only aggregate
  schema and row counts.
- Delete the restore target, archive, and directory immediately after the
  checks, in the same operator session, with a hard maximum lifetime of two
  hours.

This approval would validate general hosted-data recovery. It is an optional
higher-assurance check for this additive rollout, not a substitute for
provider-managed backups. The Supabase organization is currently on the Free
plan, so provider daily backups and PITR are not available for this project.

## Hosted acceptance prerequisites

Read-only aggregate checks found two signed-in Supabase accounts, two linked
application users, and two organization-member humans. There are five
projects and enough active agents for a two-agent test, but no project
currently has both signed-in humans. After migration, the second existing
signed-in account must be explicitly invited or added to the selected project.
No identities, credentials, or tokens were retained in this record.

## Safe rollout sequence

1. Finish dashboard work and re-run the complete local package, API,
   PostgreSQL, dashboard, MCP, CLI, and native checks against the exact reviewed
   commits.
2. Record pre-migration aggregate counts. Before pushing `main`, run the
   separate migration job against alpha:

   ```sh
   railway run --no-local \
     --project fb1f935a-d229-4581-ae26-3e4d188c6329 \
     --environment a1cba632-0d69-4dcf-adf4-083cfc748e70 \
     --service 62a1f90e-6bb1-4186-bc09-a82918213a04 \
     pnpm --filter @orchestrat/db migrate
   ```

3. Verify 14 migration-history rows, the new tables and constraints, the
   project-membership backfill aggregates, and `/ready` before deploying
   application code.
4. Push the reviewed `main` commits. Wait for Railway to report the exact
   source SHA and recheck `/health` and `/ready`; then exercise human and agent
   REST, MCP inbox notices, authorization, and realtime reconnect behavior.
5. Build and verify the unique Vercel deployment URL. Move
   `app.orchestrat.dev` only after that artifact passes authenticated messaging
   checks:

   ```sh
   vercel alias set <verified-deployment-url> app.orchestrat.dev
   ```

6. Publish or install a messaging-capable CLI artifact only after its packed
   bundle passes the local and hosted API contract checks. The currently
   deployed `f70b998` source and existing dashboard bundle do not contain this
   feature.
7. Add the second signed-in human to the acceptance project and run the full
   two-human/two-agent flow, including cross-project notifications, live and
   replay deduplication, membership revocation, agent credential revocation,
   and notification-click navigation.

Until these steps are recorded, hosted project messaging remains unverified.
