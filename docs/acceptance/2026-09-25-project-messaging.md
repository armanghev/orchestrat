# Project messaging acceptance and alpha rollout readiness

Date: 2026-09-28 UTC

Status: **feature source locally verified; the alpha database is migrated
through `0013` and its post-migration gates passed; messaging API and dashboard
deployment plus hosted end-to-end acceptance remain pending**. The additive
messaging schema and project-membership backfill are live in alpha. The hosted
API and dashboard remain on their prior sources, and the installed CLI does not
expose the messaging feature.

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

- API build, lint, and typecheck passed. The full API suite against the
  disposable PostgreSQL instance passed 96 tests with 2 existing opt-in skips.
- The database schema and RLS suite passed 15 tests, including the synthetic
  direct-access role denial check on a real PostgreSQL instance.
- Native notification destination tests passed 69 tests.
- CLI tests passed 74 tests. A packed `alpha.3` artifact also passed the local
  artifact verification path.
- SDK and MCP messaging checks passed 11 and 8 tests respectively.
- The dashboard build, lint, and typecheck passed. Its unit suite passed 336
  tests in 46 files, and the full committed-source browser integration suite
  exited `0` with 69 passes and 6 expected skips (2 phone-only cases outside
  the phone project, 2 waitlist cases, and 2 R2-dependent cases).

The dashboard messaging UI, realtime notification provider, project membership
controls, native chat destinations, SDK, MCP tools, and CLI contracts are
implemented in reviewed source. Commit `4fa07b7` contains the dashboard
workspace; it has not yet been deployed to alpha.

## Hosted alpha observations

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
  2026-09-28 migration preflight found 13 journal rows through
  `0012_document_folders`. The scoped rollout then applied only
  `0013_project_messaging`, bringing the journal to 14 rows.

The only hosted mutation in this rollout phase was the additive `0013`
migration and its insert into the newly created `project_members` table. No
environment value, deployment, alias, credential, agent, pre-existing table
row, or R2 object was changed.

### Supabase direct-access privacy gate

A read-only request to the alpha Supabase REST endpoint returned the expected
missing-API-key response, confirming that the Data API gateway is active.
Database metadata showed that `anon` and `authenticated` have `USAGE` on the
`public` schema and `SELECT`, `INSERT`, `UPDATE`, and `DELETE` privileges on
current public tables. The `postgres` default ACL grants those same table
privileges to both roles for newly created public tables.

The original `0012` and `0013` SQL did not enable RLS, which would have exposed
the six new tables through inherited Supabase grants and bypassed API
conversation authorization.

The applied `0013` migration enables RLS, without policies or `FORCE`, on
`document_folders`, `project_members`, `project_invitations`, `chats`,
`chat_participants`, and `chat_messages`. Keeping the safeguard in `0013`
protects databases that may already have applied `0012` without rewriting
published migration history. A disposable PostgreSQL test grants a synthetic
direct-access role full table privileges and proves that it sees no rows,
cannot insert, update, or delete, while the owner retains read and write
access. Post-migration metadata confirmed that all six rollout-gated tables are
owned by `postgres`, have RLS enabled, have no policies, and do not force RLS.

### Database rollout evidence — 2026-09-28

- Immediately before migration, the hosted journal contained 13 rows through
  `0012`; neither `project_members` nor `chats` existed.
- The source aggregate contained 6 expected project memberships across 6
  projects, with 0 projects lacking a member and 0 lacking an owner.
- The normal repository migrator ran once through Railway with the explicit
  production project, environment, and service identifiers shown below and
  reported `migrations applied successfully!`.
- The postcheck found 14 journal rows through `0013`, 6 expected and 6 actual
  `project_members` rows, 0 missing rows, 0 extra rows, 0 role mismatches, and
  0 projects without an owner.
- `document_folders`, `project_members`, `project_invitations`, `chats`,
  `chat_participants`, and `chat_messages` all passed the owner and RLS metadata
  gate described above.
- Railway remained on successful deployment
  `2b63e9dc-67cb-46cb-a7c5-830ceb0ba1c6` from source `f70b998`, with no staged
  deployment. `/health` and `/ready` both returned `200` after migration.

No application deployment was triggered. The messaging API and dashboard
remain pending until the reviewed commits are pushed and provider deployments
are verified.

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

A 2026-09-25 read-only hosted check showed 12 migrations through `0011`. The
2026-09-28 rollout preflight showed 13 migrations through `0012`, so `0012` had
been applied between those checks. The scoped rollout therefore applied only
`0013`.
The disposable database, archive, and temporary directory were removed after
the aggregate checks. This proves schema compatibility for these migrations;
it does **not** prove recovery of hosted row data. A PostgreSQL 17 restore
target should be used for a later data-bearing recovery drill so no
compatibility filtering is needed.

### Migration blast radius and minimum rollback scope

Both migrations are additive:

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
Neither migration changes R2 or existing document bodies, so an R2
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

The two accounts selected out of band for hosted acceptance both exist in
Supabase Auth, are confirmed, and are linked to application users. One uses its
existing linked GitHub identity; the other uses its existing email identity
with a magic link. They do not currently share an organization or project, so
the acceptance flow must use a new isolated organization and project followed
by a project invitation. The existing active CLI credential must remain
untouched; acceptance uses a newly authorized, disposable CLI credential and
two newly created agents.

Normal sign-in must use two separate browser profiles on
`https://app.orchestrat.dev`. Each callback or magic link must return in the
same profile that started sign-in so the origin-scoped PKCE and continuation
state remains available. No account email, credential, auth token, or session
value is stored in this record.

## Safe rollout sequence

1. **Completed 2026-09-28:** the full local dashboard build, lint, typecheck,
   unit, and browser integration gates passed against reviewed commit
   `4fa07b7`.
2. **Completed 2026-09-28:** the pre-migration aggregates were recorded and the
   authorized additive migration ran against alpha before any application
   deployment:

   ```sh
   railway run --no-local \
     --project fb1f935a-d229-4581-ae26-3e4d188c6329 \
     --environment a1cba632-0d69-4dcf-adf4-083cfc748e70 \
     --service 62a1f90e-6bb1-4186-bc09-a82918213a04 \
     pnpm --filter @orchestrat/db migrate
   ```

3. **Completed 2026-09-28:** the journal contained 14 rows through `0013`; the
   new tables, RLS metadata, project-membership backfill aggregates, `/health`,
   and `/ready` passed their postchecks.
4. Push the reviewed `main` commits. Wait for Railway to report the exact
   source SHA and recheck `/health` and `/ready`; then exercise human and agent
   REST, MCP inbox notices, authorization, and realtime reconnect behavior.
5. Build the unique Vercel deployment and verify its source SHA, static bundle,
   public configuration, API destination, routes, and messaging assets. Do not
   claim normal authenticated acceptance on the unique preview: the build uses
   `VITE_WEB_AUTH_CALLBACK_URL=https://app.orchestrat.dev/auth/callback`, and
   PKCE plus invitation and CLI continuation state are origin-scoped.
6. After the static artifact and configuration checks pass, promote it to the
   canonical alias:

   ```sh
   vercel alias set <verified-deployment-url> app.orchestrat.dev
   ```

7. Run normal authenticated PKCE and invitation acceptance only on the
   canonical `app.orchestrat.dev` origin, using the two separate browser
   profiles described above.
8. Install the verified packed messaging-capable CLI artifact and authorize a
   fresh disposable credential through the canonical dashboard. The currently
   deployed `f70b998` source and existing dashboard bundle do not contain this
   feature.
9. Run the full isolated two-human/two-agent flow, including cross-project
   notifications, live and replay deduplication, membership revocation, agent
   credential revocation, and notification-click navigation. Revoke only the
   newly created credential and agents during cleanup.

The database rollout is verified. Hosted project messaging remains unverified
until the API and dashboard deployments and the end-to-end acceptance steps
above are completed.
