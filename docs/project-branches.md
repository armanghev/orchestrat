# Project branches

Status: **built on `feat/project-branches`, not merged or deployed.** Verified locally against simulated providers; live providers (ORC-44) and the hosted rollout (ORC-45) are pending. Written 2026-09-27 against `main` at `e37bd65`; quick review the same day (hotspot names checked against the code, new SQL probed on pg-mem 3.0.14, `retainSearchParams` and `useBlocker` confirmed in the installed TanStack Router).

Companion documents:

- [Provider setup for local testing](project-branches-provider-setup.md): how to register the GitHub App, the GitLab OAuth app and the Cursor Origin app, with every environment variable.
- Orchestrat document `implementation/project-branches.md`: a copy of this spec.

Paths are relative to the repository root. `file:line` citations refer to `e37bd65`.

---

## 1. Summary

A project gets **branches**. Each branch holds its own tasks (with comments and dependencies), documents (with folders, revisions and attachments), chats (with participants and messages) and agent participation (sessions, claims, presence, lifecycle activity). Organizations, projects, members, roles, agents and agent credentials stay project-wide.

Branches follow Git:

- **Created** from a connected provider (GitHub, GitLab.com, Cursor Origin) when a branch is created or pushed, or by the local CLI when an agent works in a checkout (including unpushed branches). Members can also create them in the dashboard.
- **Merged** when a provider PR/MR is merged. The source branch's Orchestrat work is merged into the actual target branch automatically. Non-conflicting items apply; items changed on both sides keep the target version and go to a **Needs your decision** list with *Use source* / *Use target*.
- **Archived** when the provider branch is deleted: read-only, hidden by default, nothing deleted.
- Owners and admins can also merge and archive by hand, and change the default branch.

Every existing project gets a default branch in migration `0016`. All existing rows move onto it with their IDs unchanged. Any request that does not name a branch resolves to the default branch, so the published CLI (`0.1.0-alpha.2`/`alpha.3`) and its MCP keep working without changes.

### 1.1 Key decisions

| # | Decision | Why |
|---|---|---|
| D1 | Branch-scoped rows get `branch_id NOT NULL` plus composite FKs `(branch_id, parent_id) → parent(branch_id, id)` | Same-branch integrity is enforced by the database, like same-project integrity today (`packages/db/src/schema.ts:259-263,289-298`). |
| D2 | Lineage via a nullable `origin_id` on copyable rows. `NULL` means "this row is the root"; the logical key is `coalesce(origin_id, id)`. | Existing insert sites stay untouched; only the merge engine sets it. |
| D3 | `projects.task_counter` stays project-wide; task key uniqueness moves to `(branch_id, task_key)` | New tasks get project-unique numbers. Copies keep their origin's key, so `ORC-12` is the same logical task on every branch. |
| D4 | One engine does imports, automatic merges and manual merges. It uses a three-way comparison against stored per-field **baselines**. | Repeats don't re-conflict, and there's one set of rules to test. |
| D5 | Items changed on both sides keep the **target** version as a whole and create a decision. There is no partial apply and no hand editing. | This is the requirement, and it is the simplest safe rule. |
| D6 | Chats: participants are never merged. Messages are appended only when the target audience is a subset of the source audience. `has_human` is copied verbatim. Imported messages and comments carry `imported_at` and never count as unread. | "Never widen who can see a chat"; no historical notifications. |
| D7 | Agents pick a branch with the header `X-Orchestrat-Branch-Id` or through their session. Sessions pin the branch. An explicit branch that disagrees with the session returns 409. Humans pass `?branch_id=` on collection routes. Entity routes take the branch from the row. | Old clients send nothing and land on the default branch. Header and query are additive. |
| D8 | Every branch write keeps the existing **project-row `FOR UPDATE` lock** | It keeps `project_events.id` order equal to commit order, which realtime catch-up relies on (`apps/api/src/realtime/realtime.ts:116`, `apps/dashboard/src/realtime/project-realtime.tsx:374`), and it guards `task_counter`. |
| D9 | `project_events.branch_id` is nullable (`NULL` = project-wide). There is still one websocket per project, and the envelope gains `branch_id`. | A single monotonic sequence per socket. The parallel attention feature can filter on `branch_id`. |
| D10 | Webhooks go into a durable **inbox**: verify the signature, insert, return 2xx fast. An in-process worker processes the inbox, with backoff and periodic reconcile. | GitHub does not retry failed deliveries ([docs](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries)). Never lose an event, and add no new infrastructure. |
| D11 | Provider state lives in `repository_refs` (one row per provider-branch **generation**), separate from `project_branches`. Archived branches never reactivate. | Delete-then-recreate produces a new branch and never revives stale state. |
| D12 | Migration `0016` is one file. It includes a temporary plpgsql trigger that fills `branch_id` for inserts from the **old** API during the rollout window, and a later migration drops it. | The hosted DB is migrated before the new API deploys. |
| D13 | Only humans who are owners or admins resolve decisions, merge, archive or change the default | Requirement, plus the earlier attempt's lesson that automated credentials must not approve data merges. |

---

## 2. User stories

**Owner or admin (Arman)**

1. I connect my GitHub, GitLab.com or Cursor Origin repository in project settings. My existing Orchestrat work stays on the branch that tracks the provider's default branch, even when that branch isn't called `main`.
2. When I push a new branch, an Orchestrat branch with the same name appears. My agents can start working in it right away.
3. When I merge a PR, the tasks, documents and chats from that branch show up on the target branch. Anything changed on both sides is waiting for me under **Needs your decision**, with the target version kept until I choose.
4. When a branch is deleted on the provider, its Orchestrat branch becomes read-only and hidden, and nothing is lost.
5. I can merge or archive a branch by hand, and change the default branch, even with a repository connected.
6. I switch branches from the breadcrumb (`org / project / branch / page`), and every page follows, including Overview.

**Member**

7. I can create a branch and work in it. On my first visit I choose to start blank, import everything from another branch, or pick items.
8. When I import, the dependencies my tasks need come along, and each conflict asks me to pick *source* or *target*. If something changed while I was looking, the preview refreshes and keeps my selections.
9. Imported chats keep their authors, timestamps and participants. Nobody is shown history they couldn't see before, and nothing old shows up as unread.

**Agent (via CLI or MCP)**

10. When I start in a checkout on `feat/login`, my session is pinned to the `feat/login` Orchestrat branch. If that branch doesn't exist yet it is created, even if it was never pushed.
11. I can call `list_branches` and `select_branch`. Switching closes my session and opens a new one. If the close fails, I keep my claims and can retry.
12. My claims belong to my session's branch. I can't claim or edit a task on another branch by passing a different branch ID.

**Old client (published CLI alpha.2/alpha.3)**

13. Everything keeps working exactly as before, against the default branch.

**Provider automation**

14. A webhook that fails to process is retried, and events the provider never delivered are found by the periodic reconcile.

---

## 3. Concepts

| Term | Meaning |
|---|---|
| **Branch** | A row in `project_branches`. Its `name` is a Git branch name. |
| **Default branch** | Exactly one per project. Legacy (branchless) requests use it. It is the default import source and the default target shown in the UI. |
| **Active / archived** | Archived branches (`archived_at` set) are read-only, hidden from the selector by default, and never reactivate. |
| **Generation** | One lifetime of a provider branch name, from creation to deletion. A recreated name is a new generation, linked to a new Orchestrat branch. |
| **Lineage key** | `coalesce(origin_id, id)`. It identifies "the same logical item" across branches. |
| **Baseline** | For one logical item and one pair of branches, the per-field fingerprints of the last state both branches agreed on. |
| **Merge run** | One execution of the engine, of kind `import` or `merge`. A merge run is triggered by the dashboard or by a provider merge. |
| **Decision** | An item changed on both sides during a merge. The target is kept until an owner or admin picks *use source* or *use target*. |

---

## 4. Data model

All new tables follow the conventions of `0012`/`0013`: inline `CHECK`s, FKs added with `ALTER TABLE … ADD CONSTRAINT`, snake_case names, and `ALTER TABLE … ENABLE ROW LEVEL SECURITY` with no policies (`packages/db/drizzle/0013_project_messaging.sql:99-104`). In `schema.ts` they are declared with `.enableRLS()`.

### 4.1 New table `project_branches`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK default `gen_random_uuid()` | |
| `project_id` | uuid NN → `projects` ON DELETE CASCADE | |
| `name` | text NN | Git branch name, stored verbatim (see §4.6 for validation). |
| `is_default` | boolean NN default false | |
| `name_source` | text NN | `fallback`, `cli`, `provider` or `user`. Controls automatic renames of the default branch (§8.7). |
| `created_via` | text NN | `migration`, `dashboard`, `cli`, `agent` or `provider`. |
| `created_by_type` | `document_author_type` NULL | Same author pattern as `tasks` (`schema.ts:189-222`). NULL for migration and provider rows. |
| `created_by_user_id` | uuid NULL → users RESTRICT | |
| `created_by_agent_id` | uuid NULL | Composite FK `(project_id, created_by_agent_id) → agents(project_id, id)`. |
| `onboarding_state` | text NN default `pending` | `pending` or `completed`. The migration and the project's first branch use `completed`. |
| `onboarding_choice` | text NULL | `blank`, `import_all` or `selected`. |
| `onboarding_completed_at` | timestamptz NULL | |
| `archived_at` | timestamptz NULL | |
| `archived_reason` | text NULL | `provider_deleted`, `manual` or `replaced_on_connect`. |
| `archived_by_user_id` | uuid NULL → users SET NULL | |
| `created_at`, `updated_at` | timestamptz NN default now() | |

Constraints and indexes:

- `project_branches_project_id_id_unique` UNIQUE (project_id, id): the target for every composite FK.
- `project_branches_active_name_unique` UNIQUE (project_id, name) WHERE archived_at IS NULL. Names are unique among active branches only; archived generations keep their name.
- `project_branches_one_default` UNIQUE (project_id) WHERE is_default.
- `project_branches_default_active` CHECK (NOT is_default OR archived_at IS NULL).
- `project_branches_archive_consistent` CHECK ((archived_at IS NULL) = (archived_reason IS NULL)).
- `project_branches_name_not_blank`, and CHECKs on the enumerated text columns (`IN (…)`, which pg-mem supports; not a regex).
- `project_branches_created_by_consistent`, the same shape as `tasks_author_consistent`.
- Index `project_branches_project_archived_idx` (project_id, archived_at, updated_at).
- RLS enabled.

Why `is_default` and not `projects.default_branch_id`: a pointer would create a circular FK. That needs a deferrable constraint, which pg-mem does not support (`r_code_tests_ops` probe: `DEFERRABLE INITIALLY DEFERRED` unsupported).

### 4.2 Existing tables that become branch-scoped

For every table below, add `branch_id uuid NOT NULL` and the FK `<table>_branch_project_fk (project_id, branch_id) → project_branches(project_id, id) ON DELETE CASCADE`. `project_id` stays; every agent and author FK depends on it.

| Table | Same-branch FKs and uniques added | Uniques re-scoped (drop → create) | Lineage columns |
|---|---|---|---|
| `tasks` | `tasks_branch_id_id_unique (branch_id, id)` | `tasks_project_key_unique` → `tasks_branch_key_unique (branch_id, task_key)`; `tasks_project_number_unique` → `tasks_branch_number_unique (branch_id, task_number)`; index `tasks_project_board_order_idx` → `tasks_branch_board_order_idx (branch_id, status, position, id)` | `origin_id uuid NULL`; `tasks_branch_origin_unique (branch_id, origin_id) WHERE origin_id IS NOT NULL` |
| `task_comments` | `task_comments_task_branch_fk (branch_id, task_id) → tasks(branch_id, id)` CASCADE | — | `origin_id`, `imported_at timestamptz NULL`; partial unique as above |
| `task_dependencies` | `task_dependencies_task_branch_fk (branch_id, task_id)`, `task_dependencies_blocker_branch_fk (branch_id, depends_on_task_id)` → tasks(branch_id, id) CASCADE | index `task_dependencies_branch_task_idx (branch_id, task_id)` | — (edges are identified by their endpoints' lineage keys) |
| `task_claims` | `task_claims_task_branch_fk (branch_id, task_id) → tasks(branch_id, id)`; `task_claims_session_branch_fk (branch_id, session_id) → agent_sessions(branch_id, id)` CASCADE | — | never copied |
| `agent_sessions` | `agent_sessions_branch_id_id_unique (branch_id, id)` | index `agent_sessions_branch_agent_status_idx (branch_id, agent_id, status)` | never copied |
| `documents` | `documents_branch_id_id_unique (branch_id, id)` | `documents_project_path_unique` → `documents_branch_path_unique (branch_id, path)`; `documents_project_updated_idx` → `documents_branch_updated_idx (branch_id, updated_at, id)` | `origin_id` + partial unique |
| `document_folders` | — | `document_folders_project_path_unique` → `document_folders_branch_path_unique (branch_id, path)` | — (the natural key is the path) |
| `document_revisions` | `document_revisions_document_branch_fk (branch_id, document_id) → documents(branch_id, id)` CASCADE | — | `origin_id` + partial unique |
| `document_attachments` | `document_attachments_document_branch_fk` as above | — | `origin_id` + partial unique |
| `document_attachment_uploads` | `document_attachment_uploads_document_branch_fk` as above | — | — |
| `chats` | `chats_branch_id_id_unique (branch_id, id)` | `chats_direct_pair_unique` → `chats_branch_direct_pair_unique (branch_id, direct_key)`; `chats_project_updated_idx` → `chats_branch_updated_idx (branch_id, updated_at)` | `origin_id` + partial unique |
| `chat_participants` | `chat_participants_chat_branch_fk (branch_id, chat_id) → chats(branch_id, id)` CASCADE | — | never copied independently; copied with a new chat only |
| `chat_messages` | `chat_messages_chat_branch_fk` as above | — | `origin_id`, `imported_at` + partial unique |

Other existing tables:

- **`project_events`**:
  - add `branch_id uuid NULL` with FK `project_events_branch_project_fk`;
  - index `project_events_project_branch_id_idx (project_id, branch_id, id)`.
  - `NULL` means a project-wide event: `agent.*`, `credential.*`, `branch.*`, `repository.*`, membership. Every other event carries its branch.
- **`agent_lifecycle_events`**: no column. The branch comes from `session_id`. The idempotency scope `(project_id, agent_id, idempotency_key)` stays, which is safe because hook keys hash a payload that now includes the session ID, and the session ID includes the branch (§7.4).
- **`api_idempotency_keys`**: no schema change. `create_task` and `create_chat` change `resource_id` from the project ID to the **branch ID** (§6.5).
- **Unchanged and project-wide:** `projects` (`task_counter` stays), `users`, organizations, `project_members`, `project_invitations`, `agents`, `agent_credentials` and the `cli_*` tables.

Storage keys do not change. They are derived from `(project_id, document_id, row_id)` (`apps/api/src/services/document-service.ts:175-177`, `attachment-service.ts:101-103`), and IDs are preserved, so no object moves.

### 4.3 Merge-engine tables

**`branch_merge_runs`**: one row per import or merge.

| Column | Notes |
|---|---|
| `id` uuid PK, `project_id` NN | |
| `source_branch_id`, `target_branch_id` | uuid NN; both FK `(project_id, x) → project_branches` |
| `kind` | `import` or `merge` |
| `trigger` | `dashboard` or `provider_merge` |
| `status` | `applied`, `applied_with_decisions`, `skipped` or `failed` |
| `skip_reason` | text NULL: `no_source_branch`, `fork`, `same_branch`, `source_empty` |
| `dedupe_key` | text NULL; `branch_merge_runs_dedupe_unique (project_id, dedupe_key) WHERE dedupe_key IS NOT NULL` |
| `idempotency_key`, `request_hash` | text NULL; used for dashboard applies |
| `provider`, `provider_change_number`, `provider_change_url`, `provider_head_sha`, `provider_merge_sha` | nullable |
| `selection` | jsonb NN default `{}`: which lineage keys were selected, and the conflict choices |
| `result` | jsonb NN default `{}`: counts per item type and outcome, plus skipped items with reasons |
| `created_by_type`, `created_by_user_id` | NULL for provider runs |
| `created_at`, `applied_at` | |

**`branch_item_baselines`**: the last agreed state for one logical item between two branches.

| Column | Notes |
|---|---|
| `project_id` | NN |
| `branch_low_id`, `branch_high_id` | The two branch IDs in sorted order, so a baseline serves both merge directions. CHECK `branch_low_id < branch_high_id`. |
| `item_type` | `task`, `document` or `chat`. Only mutable items need baselines; comments, revisions, attachments and messages are immutable and are matched by lineage alone. |
| `lineage_key` | uuid NN |
| `fingerprint` | jsonb NN, `{field: sha256}` (§9.3) |
| `last_run_id` | uuid NULL |
| `updated_at` | |

PK `(branch_low_id, branch_high_id, item_type, lineage_key)`. Index `(project_id, item_type, lineage_key)`.

`lineage_key` is the lineage key of the item **on the `branch_low_id` side**. For lineage matches both sides share it anyway. For natural-key matches (same document path or DM pair, different lineage), this gives one deterministic key that works in both merge directions. Decisions (below) use the **target** item's lineage key.

**`branch_merge_decisions`**: the "Needs your decision" list.

| Column | Notes |
|---|---|
| `id` uuid PK, `project_id`, `run_id` | |
| `source_branch_id`, `target_branch_id` | |
| `item_type` | `task`, `document` or `chat` |
| `lineage_key` | |
| `target_item_id`, `source_item_id` | uuid NN |
| `reason` | `changed_on_both`, `added_on_both` (natural-key collision), `path_collision` or `target_claimed` |
| `fields` | text[] NN: the fields that differ |
| `source_snapshot` | jsonb NN: source values at merge time (for documents, a revision reference plus hash, see §9.7) |
| `target_snapshot` | jsonb NN |
| `target_fingerprint` | jsonb NN: the target's fingerprint (§9.3) when the decision was recorded. Used as the staleness check at resolution, for every item type. |
| `status` | `open`, `resolved_source`, `resolved_target` or `superseded` |
| `resolved_by_user_id`, `resolved_at`, `created_at` | |

`branch_merge_decisions_open_unique (target_branch_id, item_type, lineage_key) WHERE status = 'open'`: a later merge of the same item supersedes the older open decision.

All three tables have RLS enabled.

### 4.4 Repository tables

**`repository_connections`**: one primary repository per project.

| Column | Notes |
|---|---|
| `id` uuid PK, `project_id` NN | |
| `provider` | `github`, `gitlab` or `origin` |
| `provider_repository_id` | text NN: the stable numeric or opaque ID (GitHub `repository.id`, GitLab project `id`, Origin `repo_…`). Names are never used as keys. |
| `repository_full_name`, `repository_url` | refreshed from payloads and reconcile |
| `provider_default_branch` | text NN |
| `installation_id` | text NULL: the GitHub installation ID or the Origin installation ID |
| `gitlab_hook_id` | text NULL |
| `access_token_ciphertext`, `refresh_token_ciphertext`, `token_expires_at` | GitLab only |
| `webhook_secret_ciphertext` | GitLab `signing_token` |
| `connected_by_user_id` | → users |
| `provider_account_id` | The verified provider user ID of the person who authorized |
| `status` | `active`, `needs_reauthorization`, `suspended`, `error` or `disconnected` |
| `status_reason` | text NULL |
| `last_event_at`, `last_reconciled_at` | |
| `reconcile_state` | jsonb NN default `{}`: watermarks such as `merged_since` and the GitHub delivery cursor |
| `created_at`, `updated_at`, `disconnected_at` | |

Constraints:
- `repository_connections_one_active_per_project` UNIQUE (project_id) WHERE disconnected_at IS NULL.
- `repository_connections_one_active_per_repo` UNIQUE (provider, provider_repository_id) WHERE disconnected_at IS NULL. For now one repository backs at most one Orchestrat project (open question Q3).
- Index `(provider, installation_id)`.

**`repository_connection_attempts`**: short-lived authorization state, modeled on `cli_authorization_attempts` (`apps/api/src/services/cli-authorization-service.ts:23-195`).

| Column | Notes |
|---|---|
| `id` | text PK `ra_<24B base64url>` |
| `project_id`, `user_id`, `provider` | |
| `state_hash` | text NN UNIQUE: sha256 of the random `state` (≥128 bits) |
| `pkce_verifier_ciphertext` | GitHub and GitLab |
| `status` | `pending`, `authorized`, `consumed`, `expired` or `failed` |
| `provider_user_id`, `installation_id` | |
| `user_token_ciphertext` | GitHub user token or GitLab token pair, held only until the connection is created, then wiped |
| `receipt_jti` | text NULL UNIQUE: Origin replay protection |
| `return_path`, `error_code` | |
| `expires_at` | 15 min |
| `created_at`, `consumed_at` | |

**`repository_refs`**: provider-side branch state, one row per **generation**.

| Column | Notes |
|---|---|
| `id` uuid PK, `project_id`, `connection_id` | → repository_connections CASCADE |
| `name` | text NN |
| `head_sha` | text NULL |
| `first_seen_sha` | text NULL |
| `branch_id` | uuid NULL: the linked Orchestrat branch |
| `state` | `active` or `deleted` |
| `created_signal` | `event`, `reconcile` or `connect_snapshot` |
| `first_seen_at`, `last_seen_at`, `deleted_at` | |
| `created_delivery_id`, `deleted_delivery_id` | text NULL |

Constraints: `repository_refs_active_name_unique (connection_id, name) WHERE state = 'active'`; index `(connection_id, name, deleted_at)`.

**`repository_webhook_deliveries`**: the inbox.

| Column | Notes |
|---|---|
| `id` uuid PK | |
| `provider` | |
| `delivery_id` | text NN; UNIQUE (provider, delivery_id) |
| `connection_id` | uuid NULL, resolved at receipt |
| `event_type` | text NN |
| `installation_id` | text NULL |
| `payload` | jsonb NN; stored only after the signature is verified |
| `status` | `pending`, `processing`, `applied`, `ignored` or `failed` |
| `attempts` | int NN default 0 |
| `next_attempt_at` | |
| `last_error` | text NULL, bounded to 1000 chars, never containing secrets |
| `received_at`, `processed_at` | |

Index `(status, next_attempt_at, received_at)`.

All four tables have RLS enabled.

### 4.5 Invariants

1. Exactly one active default branch per project.
2. Every branch-scoped row's `branch_id` belongs to its `project_id`.
3. Parent and child rows share `branch_id` (comments, dependencies, claims, revisions, attachments, uploads, participants, messages).
4. At most one row per logical item per branch: `(branch_id, origin_id)` is partially unique. The engine never copies a row into a branch that already holds its root.
5. `task_number`s are unique per branch, and `projects.task_counter` exceeds every number (unchanged).
6. An archived branch has no active sessions or active claims (enforced by the archive path, §6.7).
7. At most one active provider ref per `(connection, name)`, and at most one active Orchestrat branch per `(project, name)`.

### 4.6 Branch name validation (`branchNameSchema`)

- 1–255 characters.
- No ASCII control characters, space, `~ ^ : ? * [ \`.
- Does not start with `-` or `/`, does not end with `/` or `.lock`, contains no `..`, `//` or `@{`, and is not exactly `@`.

This is a subset of `git check-ref-format`, and every ref the provider sends passes it. `slugSchema` can't be reused because it forbids `/` (`packages/protocol/src/index.ts:106-110`).

---

## 5. Migration `0016_project_branches.sql` and backfill

> **Renumbered 2026-09-30.** Branches originally reserved `0014`, but attention merged to `main` first with `0015` (journal `when` `1790600000000`). Per §15.2, the second-merged migration needs a larger `when`, and a number after `0015` keeps the file order identical in the test harnesses (sorted by name) and in drizzle (journal order). So branches uses **`0016`**; `0014` stays unused.

Branches own **only** migration number `0016`. Attention owns `0015`. Every table in §4 lands in this one file. Until the feature is merged, the file may be amended; after any amendment, local databases must be recreated, because drizzle never re-runs an applied migration.

### 5.1 Statement order

Each statement is separated by `--> statement-breakpoint`, in the style of `0013`.

1. `CREATE TABLE "project_branches"` with inline CHECKs.
2. **Backfill:** `INSERT INTO "project_branches" ("id","project_id","name","is_default","name_source","created_via","onboarding_state","onboarding_completed_at","created_at","updated_at") SELECT gen_random_uuid(), "id", 'main', true, 'fallback', 'migration', 'completed', now(), "created_at", now() FROM "projects";`
3. For each of the 13 scoped tables:
   1. `ALTER TABLE t ADD COLUMN "branch_id" uuid;`
   2. `UPDATE t SET "branch_id" = b."id" FROM "project_branches" AS b WHERE b."project_id" = t."project_id" AND b."is_default";`
   3. `ALTER TABLE t ALTER COLUMN "branch_id" SET NOT NULL;`
   
   Backfills use `UPDATE … FROM`. pg-mem can't run correlated subqueries in `SET` (probe in `r_code_tests_ops`).
4. `ALTER TABLE "project_events" ADD COLUMN "branch_id" uuid;`, then `UPDATE … FROM` for rows whose `type` is not `agent.%` or `credential.%`, so historical task, doc, chat, session and claim events land on the default branch.
5. Add `origin_id` and `imported_at` columns (nullable, no backfill).
6. Create the merge-engine and repository tables (§4.3 and §4.4).
7. Add the new unique constraints and indexes, then the composite FKs. They are added after the backfill, so validation sees complete data.
8. `DROP INDEX` the project-scoped uniques and indexes listed in §4.2.
9. `ALTER TABLE … ENABLE ROW LEVEL SECURITY` for each new table, one statement per table, so the existing pg-mem filter regex matches (`apps/api/src/test/pg-mem-migrations.ts:13-16`).
10. **Rollout-window shim (Postgres only):**
    - `CREATE FUNCTION "orchestrat_fill_default_branch"() RETURNS trigger LANGUAGE plpgsql AS $$ … $$`. When `NEW.branch_id IS NULL` it sets it to the project's default branch.
    - One `CREATE TRIGGER "orchestrat_fill_default_branch_<table>" BEFORE INSERT ON <table> FOR EACH ROW EXECUTE FUNCTION "orchestrat_fill_default_branch"()` per scoped table.
    - This lets the **old** API, which never sets `branch_id`, keep inserting between the hosted migration and the new deploy.
    - `pg-mem-migrations.ts` gains a filter for statements containing `orchestrat_fill_default_branch`, the same technique as the `0005` DO-block filter (`:4-9`).
    - A real-Postgres test proves the shim works.

**Journal:** append `{ "idx": 16, "version": "7", "when": 1790700000000, "tag": "0016_project_branches", "breakpoints": true }`.
- `when` is greater than attention's `0015` (`1790600000000`). See §15.2 for the ordering hazard.
- Update `packages/db/src/schema.test.ts:57-63`, which asserts the last journal tag.

### 5.2 Why the old API survives the window

The old API's queries still work during the gap:
- Only one branch exists per project.
- The re-scoped unique indexes still raise `23505` on the same collisions.
- The old code's only `ON CONFLICT` target with explicit columns is `agent_lifecycle_events (project_id, agent_id, idempotency_key)` (`apps/api/src/services/agent-service.ts:527-533`), and that index is unchanged.
- `document-service.ts:46-52` falls back to matching the index name `documents_project_path_unique`, but only after checking `code === "23505"`, so the rename is harmless.

The trigger covers inserts. The alternative, a short maintenance window with no trigger, is open question Q1.

### 5.3 Application-side changes that ship with 0016

- `ProjectService.createProject` (`apps/api/src/services/project-service.ts:446-487`) inserts the default branch (`name` from §8.7, `created_via 'dashboard'`, `onboarding_state 'completed'`) in the same transaction.
- `packages/db/src/seed.ts:66-83` creates the default branch. The seed also still lacks a `project_members` row; fix that at the same time.
- **Boot repair:** on start, the API runs `INSERT INTO project_branches … SELECT … FROM projects p WHERE NOT EXISTS (default branch for p)`. This catches projects the old API created during the window. It is idempotent and pg-mem compatible.

### 5.4 Cleanup migration (later, number TBD, after `0016`)

Once the new API is live and verified on the hosted DB, drop the trigger and function. New code always sets `branch_id` explicitly; leaving the trigger in place would silently put a code path that forgets `branch_id` onto the default branch. The migration number is allocated when it is written, after attention's `0015`, e.g. `0017_drop_branch_fill_shim`. Tracked as task **Branches 27 (ORC-46)**.

### 5.5 Backfill verification (real Postgres)

Extend `apps/api/src/operations/postgres-acceptance.integration.test.ts` using its pre-migration seeding hook (`:82-126`). Before `0016_`, insert:
- two projects with tasks, comments, dependencies, an active claim and session, documents with revisions, a folder, an attachment row, a DM, a group chat with messages and read positions, and events of every family.

Then assert:
- exactly one default branch per project, named `main` with `name_source 'fallback'`;
- per table, `count(*)` equals the count on the default branch, and `branch_id IS NULL` returns 0;
- IDs, task keys, document paths, DM keys and read positions are unchanged;
- agent and credential events have NULL `branch_id`, and all others have the default;
- inserting a `tasks` row **without** `branch_id` (simulating the old API) succeeds and lands on the default branch;
- RLS is enabled on every new table (extend `packages/db/src/rls.integration.test.ts:8-15` and its fixtures, which must now create a default branch).

---

## 6. API semantics

### 6.1 Resolving the branch for a request

A new module `apps/api/src/services/branch-context.ts` provides every rule below. It also exposes `lockBranch(tx, projectId, branchId, {write})`, which runs after the existing project lock.

**Humans (`/api/v1`, Supabase JWT)**

| Route kind | Rule |
|---|---|
| Collection or create under `/projects/:projectId/…` (tasks, documents, document-folders, chats, inbox, presence, events). `message-candidates` stays project-wide: it lists people, not branch data. | Optional query `branch_id` (uuid). If absent, the **default** branch. Unknown or foreign → 404 `BRANCH_NOT_FOUND`. |
| Entity routes (`/tasks/:id…`, `/documents/:id…`, `/documents/:documentId/attachments…`, `/chats/:id…`) | The branch is the row's `branch_id`. A `branch_id` query that disagrees → 404 `NOT_FOUND`, the same as a wrong project today. |
| Writes to an archived branch | 409 `BRANCH_ARCHIVED`. |
| Body references to other entities (`depends_on_task_id`, `before_task_id`, message `document_ids`) | Must be on the same branch, otherwise 400 `VALIDATION_ERROR` with `details.reason = "cross_branch"`. This mirrors today's cross-project check (`apps/api/src/services/task-service.ts:827-832`). |

**Agents (`/api/v1/agent`, `orch_agent_` bearer)**

Precedence, evaluated in `resolveAgentBranch(principal, request, entity?)`:

1. **Pinned session.** If the request names a session (the path `:sessionId`, the claim body `session_id`, or the new header `X-Orchestrat-Session-Id`), the branch is the session's `branch_id`. If `X-Orchestrat-Branch-Id` is also present and differs → **409 `BRANCH_MISMATCH`**. The session is never overridden.
2. **Entity.** For entity routes, the branch is the entity's. If a session or header branch is also known and differs → 409 `BRANCH_MISMATCH`, or, on paths old clients use, the compatible code in §6.4.
3. **Header.** `X-Orchestrat-Branch-Id: <uuid>`.
4. **Default branch.**

The header name and the session header are new. CORS reflects request headers already (`@fastify/cors` default `allowedHeaders: null`), and dashboards don't send them.

### 6.2 Sessions, claims, hooks and presence

- **`POST /agent/sessions`**:
  - It accepts an optional `branch_id` in the body (the schema is not strict: `packages/protocol/src/index.ts:590-594`) or the header.
  - The session row stores `branch_id`; the response adds `branch_id`.
  - Opening on an archived branch → 409 `BRANCH_ARCHIVED`.
- **Claims:**
  - The task must be on the session's branch. Otherwise the error is **409 `TASK_NOT_CLAIMABLE` with `details.reason = "branch_mismatch"`**, an existing code, so old clients parse it.
  - Heartbeat, release and complete are unchanged, because the session and claim carry the branch.
- **Lifecycle hooks (`POST /agent/hooks/lifecycle`):**
  - The body schema is strict (`packages/protocol/src/index.ts:607-622`) and stays unchanged; the branch travels in `X-Orchestrat-Branch-Id`.
  - `session.started` inserts the session on that branch. If the named session already exists on a *different* branch → 409 `AGENT_SESSION_CLOSED` (an existing code). New CLIs never hit this, because their deterministic session IDs include the branch (§7.4).
  - `session.ended` closes the named session **and** any other active session of the same agent with the same `external_session_id`. This covers a checkout that switched branches mid-conversation.
- **Presence (`GET /agent/presence`, `GET /projects/:id/presence`):**
  - Still lists **every** active project agent; old `orchestrat doctor` relies on this (`apps/cli/src/diagnostics.ts:90-97`).
  - Each entry gains `branch_id` (the session's branch, or null when offline).
  - Humans can pass `branch_id` to mark agents on other branches as `offline` for that branch view, with `other_branch_id` set.
- **Closing sessions on archive:** archiving a branch, manually or on provider deletion, closes every active session on it through `closeSessionInTransaction` (`agent-service.ts:764-822`), with reason `branch_archived`. That revokes their claims and returns tasks to `ready`.

### 6.3 Events, activity and inbox

- `insertProjectEvent` (`agent-service.ts:94-119`) gains `branchId?: string | null`. Every branch-scoped event passes it.
- **`GET /projects/:id/events`** and **`GET /agent/events`**:
  - The default returns events of the resolved branch plus project-wide events (`branch_id IS NULL`).
  - The human route also accepts `all_branches=true`, which the dashboard's realtime catch-up needs so it keeps one monotonic cursor (`project-realtime.tsx:281-353`).
  - Cursors stay the global `id`.
- **Inbox (`GET /agent/inbox`, `GET /projects/:id/inbox`):**
  - Scoped to the resolved branch.
  - The human route accepts `all_branches=true` and returns `branch_id` per chat, for per-branch unread dots in the selector.
  - Unread and mention counts exclude messages with `imported_at IS NOT NULL` (the predicate at `chat-service.ts:368-406` and the inbox SQL at `:1528-1575`), and so does `unread_only` message listing.
  - The query must stay within the MCP's 1 s notice budget (`packages/mcp/src/index.ts:723`). The index `chat_messages (chat_id, sequence)` already exists, and `imported_at` is filtered in the same pass.

### 6.4 Error codes and old clients

New codes go into a new `branchErrorCodeSchema`, joined into the union at `packages/protocol/src/index.ts:74-79`:

- `BRANCH_NOT_FOUND`
- `BRANCH_ARCHIVED`
- `BRANCH_MISMATCH`
- `BRANCH_NAME_TAKEN`
- `BRANCH_PREVIEW_STALE`
- `BRANCH_DECISION_STALE`
- `REPOSITORY_NOT_CONFIGURED`
- `REPOSITORY_AUTHORIZATION_INVALID`
- `REPOSITORY_CONNECTION_EXISTS`

The alpha.2/alpha.3 SDK parses errors against a **closed** enum and turns unknown codes into `INTERNAL_ERROR` (`packages/sdk/src/index.ts:722-737`). So:

- New codes are returned **only** when the request carried an explicit branch signal (`branch_id` query, `X-Orchestrat-Branch-Id`, `X-Orchestrat-Session-Id`), or on routes old clients never call (all `/branches`, `/merges`, `/repository` routes).
- On paths an old client can reach without a branch signal, reuse existing codes with a `details.reason`:
  - claim on the wrong branch → `TASK_NOT_CLAIMABLE`;
  - write to an archived branch through an entity route → `CONFLICT`, `reason: "branch_archived"`;
  - cross-branch reference → `VALIDATION_ERROR`, `reason: "cross_branch"`.
- `app.ts:205-215` maps any unhandled `23505` to a slug/email message. Branch creation must catch its own unique violation and return `BRANCH_NAME_TAKEN`.

### 6.5 Idempotency

- `create_task` and `create_chat` reserve with `resource_id = branchId`.
- **Legacy fallback:** when the resolved branch is the default, the reserve step first looks up an existing row with `resource_id = projectId` and the same principal, operation and key. If found, it replays the row. This covers a client retry that spans the deploy, since the keys were cached against the project (`task-service.ts:168-200`, `chat-service.ts:639-646`).
- `create_task_comment` (task ID) and `send_chat_message` (chat ID) are already branch-specific.
- Dashboard import and merge applies use `Idempotency-Key` with `resource_id = target branch` and operation `branch_apply`.

### 6.6 Permissions

| Action | Owner | Admin | Member | Agent | Provider automation |
|---|:-:|:-:|:-:|:-:|:-:|
| View branches (incl. archived) | ✓ | ✓ | ✓ | ✓ | — |
| Create branch | ✓ | ✓ | ✓ | ✓ (register, §6.8) | ✓ |
| Work in an active branch (tasks, docs, chats) | ✓ | ✓ | ✓ | ✓ | — |
| Import into a non-default branch | ✓ | ✓ | ✓ | — | — |
| Import into the default branch (counts as a merge) | ✓ | ✓ | — | — | — |
| Merge (manual) | ✓ | ✓ | — | — | ✓ (on PR/MR merged) |
| Archive | ✓ | ✓ | — | — | ✓ (on provider delete) |
| Set default branch | ✓ | ✓ | — | — | ✓ (default rename, §8.7) |
| Resolve a decision | ✓ | ✓ | view only | — | — |
| Connect or disconnect a repository, Sync now | ✓ | ✓ | view status | — | — |

- Checks use `PermissionService.projectEditor` (`apps/api/src/services/permission-service.ts:118-127`), re-checked inside the transaction as `ProjectMembershipService.editorContext` does (`project-membership-service.ts:395-422`).
- Agent credentials stay project-wide, so any agent can select any active branch of its project. There is no per-branch ACL (a non-goal).

### 6.7 Routes

All paths are under `/api/v1`. JSON is snake_case. Request and response schemas live in the new `packages/protocol/src/branches.ts` and `packages/protocol/src/repository.ts`, re-exported from `index.ts`.

**Branch object** (`branchSchema`):

`{ id, project_id, name, is_default, archived_at, archived_reason, created_via, onboarding_state, provider: { provider, state: "tracked"|"missing"|"untracked", head_sha } | null, open_decision_count, created_at, updated_at }`

**Human routes**

| Method and path | Who | Request | Response | Errors |
|---|---|---|---|---|
| GET `/projects/:projectId/branches?include_archived=` | member | — | `{ branches: Branch[] }` (active first, default first) | 403 |
| POST `/projects/:projectId/branches` | member | `{ name }` | 201 `{ branch }` | 409 `BRANCH_NAME_TAKEN`, 409 `PROJECT_ARCHIVED` |
| GET `/projects/:projectId/branches/:branchId` | member | — | `{ branch }` | 404 `BRANCH_NOT_FOUND` |
| POST `/projects/:projectId/branches/:branchId/default` | owner/admin | `{}` | `{ branch }` | 409 `BRANCH_ARCHIVED` |
| POST `/projects/:projectId/branches/:branchId/archive` | owner/admin | `{}` | `{ branch }` | 409 `CONFLICT` reason `default_branch` |
| POST `/projects/:projectId/branches/:branchId/onboarding` | member | `{ choice: "blank" }` | `{ branch }` | 409 when already completed |
| POST `/projects/:projectId/merges/preview` | member¹ | `{ source_branch_id, target_branch_id, kind: "import"\|"merge", selection?: Selection }` | `{ preview: Preview }` (§9.5) | 404, 409 `BRANCH_ARCHIVED` (target) |
| POST `/projects/:projectId/merges` (Idempotency-Key) | member¹ | `{ source_branch_id, target_branch_id, kind, selection, choices: {lineage_key: "use_source"\|"use_target"}, preview_fingerprint, archive_source?: boolean, complete_onboarding?: boolean }` | 201 `{ run: MergeRun }` | 409 `BRANCH_PREVIEW_STALE` + `{ preview }`, 400 missing choice |
| GET `/projects/:projectId/merges?branch_id=` | member | — | `{ runs: MergeRun[], next_cursor }` | |
| GET `/projects/:projectId/decisions?branch_id=&status=open` | member | — | `{ decisions: Decision[] }` | |
| POST `/projects/:projectId/decisions/:decisionId/resolve` | owner/admin (human) | `{ choice: "use_source"\|"use_target" }` | `{ decision }` | 409 `BRANCH_DECISION_STALE` + refreshed decision (target changed since the merge), 409 `CONFLICT` when already resolved, 409 `TASK_ALREADY_CLAIMED` (target claimed) |
| GET `/projects/:projectId/repository` | member | — | `{ repository: Connection\|null, providers: [{ provider, configured, unavailable_reason }] }` | |
| POST `/projects/:projectId/repository/authorizations` | owner/admin | `{ provider, return_path? }` | `{ authorization_id, authorize_url, expires_at }` | 409 `REPOSITORY_CONNECTION_EXISTS`, 400 `REPOSITORY_NOT_CONFIGURED` |
| POST `/projects/:projectId/repository/authorizations/:id/github-installation` | owner/admin, same user | `{ installation_id }` (from the Setup URL, **untrusted**) | `{ next: "pick_repository" }` when the attempt's user token is still valid and `GET /user/installations` lists the ID; otherwise `{ next: "authorize", authorize_url }` (a fresh GitHub web flow with PKCE, after which the ID is checked the same way) | 409 `REPOSITORY_AUTHORIZATION_INVALID` when the ID isn't listed for the user |
| GET `/projects/:projectId/repository/authorizations/:id/repositories` | same user | — | `{ repositories: [{ provider_repository_id, full_name, default_branch, eligible, ineligible_reason }] }` | 409 `REPOSITORY_AUTHORIZATION_INVALID` |
| POST `/projects/:projectId/repository` | owner/admin, same user | `{ authorization_id, provider_repository_id, default_branch_mapping: { mode: "rename_default"\|"use_existing", branch_id? }, create_existing_branches: boolean }` | 201 `{ repository }` | 409 exists |
| POST `/projects/:projectId/repository/sync` | owner/admin | `{}` | 202 `{ queued: true }` | |
| GET `/projects/:projectId/repository/deliveries?status=failed` | owner/admin | — | `{ deliveries: [{ id, event_type, received_at, attempts, last_error }] }` | |
| POST `/projects/:projectId/repository/deliveries/:id/retry` | owner/admin | `{}` | `{ delivery }` | |
| POST `/projects/:projectId/repository/hook/reenable` | owner/admin | `{}` | 202 `{ queued: true }` (GitLab: a test delivery wakes a disabled project hook, then a reconcile refreshes its health) | 409 `CONFLICT` reason `no_hook` for providers without a project hook |
| DELETE `/projects/:projectId/repository` | owner/admin | — | 204 | |

¹ Import into the default branch, and `kind: "merge"`, require owner/admin.

**Public routes (no auth; outside both auth scopes, like `cliAuthorizationPublicRoutes` at `apps/api/src/app.ts:244-249`)**

| Method and path | Purpose |
|---|---|
| GET `/repository/callback/github` | GitHub web-flow callback (`code`, `state`) |
| GET `/repository/callback/gitlab` | GitLab OAuth callback (`code`, `state`) |
| GET `/repository/callback/origin` | Origin install redirect (`installation_receipt`) |
| POST `/webhooks/github` | GitHub App webhooks |
| POST `/webhooks/gitlab/:connectionId` | GitLab project hook (per-connection signing token) |
| POST `/webhooks/origin` | Origin app webhooks |

- Callbacks finish by redirecting (302) to `${ORCHESTRAT_DASHBOARD_URL}/projects/<id>/settings?repository_authorization=<id>` or `…&repository_error=<code>`.
- The GitHub **Setup URL** points at a dashboard route (§11.8), not the API, because whether GitHub echoes `state` on the Setup URL is undocumented.

**Agent routes (`/api/v1/agent`)**

| Method and path | Request | Response |
|---|---|---|
| GET `/branches?include_archived=&name=` | — | `{ branches }` |
| POST `/branches/register` | `{ name, git_default_branch?: string, head_sha?: string, force_new?: boolean }` | 200 `{ branch, created: boolean }`. If only archived generations exist and the newest was archived with `provider_deleted` → 409 `BRANCH_ARCHIVED` `{ branch_id, archived_at }` |
| GET `/project` (changed) | — | adds `default_branch_id`, plus `branch` (the resolved branch) |
| POST `/sessions` (changed) | adds optional `branch_id` | session adds `branch_id` |

Existing agent routes resolve the branch per §6.1. Agents cannot archive, merge, import or set the default.

### 6.8 Registration by the CLI or an agent

`POST /agent/branches/register` returns the active branch with that name, or creates it (`created_via 'cli'`, `onboarding_state 'pending'`, author = agent).

The "only archived" case returns 409 instead of silently creating a blank branch with the name of a branch the provider deleted. The CLI then explains it (§7.3). An explicit `orchestrat branch create <name>` sends `force_new: true` to create a fresh generation anyway.

`git_default_branch` feeds default-branch naming (§8.7).

---

## 7. Agents: SDK, MCP and CLI

### 7.1 SDK (`packages/sdk`)

- `AgentApiClientOptions` (`packages/sdk/src/index.ts:108-113`) gains `branchId?: string` and `sessionHeader?: boolean`.
- `request()` (`:665-737`) adds `x-orchestrat-branch-id` when `branchId` is set, and `x-orchestrat-session-id` when a session is open and `sessionHeader` is true. That is the only change inside the hot path.
- New methods live in `packages/sdk/src/branches.ts`, re-exported:
  - `listBranches({ includeArchived?, name? })`
  - `registerBranch({ name, gitDefaultBranch?, headSha?, forceNew? })`
  - `getBranch(id)`
  - `withBranch(branchId): AgentApiClient`, which returns an immutable copy.
- `openSession` passes `branch_id`.
- Protocol response schemas gain optional `branch_id`, so old parsers strip it harmlessly.

### 7.2 MCP (`packages/mcp`)

**New tools** (the exact list in `scripts/acceptance/verify-cli-alpha.sh:18-31,130-140` gains two names):

| Tool | Input | Behavior |
|---|---|---|
| `list_branches` | `{ include_archived?: boolean }` | Active branches with `is_default`, `is_current` and the provider state. |
| `select_branch` | `{ branch?: string /* id or name */, follow_checkout?: boolean, create?: boolean }` | Switch the session's branch. With `follow_checkout: true`, go back to following the Git checkout. |

**`select_branch` algorithm.** It extends the `selectProject` pattern (`packages/mcp/src/index.ts:661-684`) and fixes its partial-failure bug.

1. Resolve the target: a UUID → `getBranch`; a name → `listBranches({name})`. If the name is missing and `create` is set → `registerBranch`. If the target equals the current branch → return with no change.
2. `closeSession(current)`. **If it throws**, return the error and keep `sessionId`, the claim-token map and the heartbeat. The call can be retried and nothing is lost locally (requirement: "keeping local claim state if the close fails").
3. On a confirmed close: `claims.clear()`, set `branchId`, then `openSession({ branch_id })`. If the open fails, `sessionId` stays undefined and tools report `AGENT_SESSION_NOT_FOUND` "Call select_branch again."
4. Return `{ branch, released_claim_task_ids }`. The server revoked those claims when the session closed.

**Checkout following** (project-scoped mode only):

- `BridgeOptions` (`:57-64`) gains `resolveCheckoutBranch?: () => Promise<{ name: string | null; defaultBranch: string | null }>`, supplied by the CLI (§7.3).
- At `start()` the bridge resolves the checkout, registers the branch, and opens the session on it.
- In `call()` (`:685-712`), before each tool runs, the bridge re-resolves the checkout. This is a cached file read, keyed by the mtime of the checkout's `HEAD` file (`<gitdir>/HEAD`, which for a worktree lives under the main repository's `.git/worktrees/<name>/`). If the checkout branch differs from the session's branch and the bridge is in follow mode:
  - **No active claim tokens:** switch as in `select_branch`, then append a notice `{ type: "branch_switched", from, to }`.
  - **Active claims:** don't switch. Append a notice `{ type: "branch_mismatch", checkout, session, active_claims }`.
- An explicit `select_branch` puts the bridge in manual mode until `select_branch({ follow_checkout: true })`.
- A detached HEAD keeps the current branch and adds a notice.
- **Pinned branch archived mid-session** (the archive closed the session, so calls fail with `AGENT_SESSION_CLOSED` or `BRANCH_ARCHIVED`): in follow mode the bridge re-resolves the checkout, and the register call's 409 moves it to the default branch with a `branch_archived` notice. In manual mode it returns the error with "This branch was archived; call select_branch." Claim tokens for the closed session are dropped, since the server already revoked them.
- When the checkout branch is archived (the register call returns 409): open on the default branch, then add a `branch_archived` notice to every tool result until `select_branch` is called. Open question Q5.
- `call()` captures `{ client, branchId, sessionId }` at the start of each call, so inbox notices and operations never straddle a switch (see the existing test at `packages/mcp/src/index.test.ts:591-698`).

**Other MCP changes:**

- `get_project` returns `{ …, branch: { id, name, is_default }, default_branch_id, follow_checkout }`.
- Global mode (`--global`) does no checkout detection. It starts on the default branch; `select_branch` works as normal.

### 7.3 CLI (`apps/cli`)

**New module `apps/cli/src/git.ts`** (file reads only, no `git` process):

- It uses file reads to avoid process spawns in hooks and the macOS `/usr/bin/git` Xcode prompt (`r_code_mcp_cli` §3).
- `detectCheckout(cwd, fs = nodeFs): { repoRoot, gitDir, commonDir, branch: string | null, defaultBranch: string | null, headSha: string | null }`:
  - `.git` as a directory or as a `gitdir:` file (worktrees and submodules);
  - `commondir`;
  - `HEAD` (`ref: refs/heads/<name>`, or a SHA when detached);
  - `<commondir>/refs/remotes/origin/HEAD` for the default branch. "origin" here is the Git remote name, not Cursor Origin.
- It never throws. Failure returns nulls, and the callers fall back to the default branch.

**Call sites:**

- `mcp` (project-scoped): `resolveInvocation` (`apps/cli/src/resolve.ts:21-50`) adds `checkout`. `main.ts` passes `resolveCheckoutBranch` to the bridge.
- `hook`:
  1. Detect the branch from `hookCwd(payload)` (`apps/cli/src/hooks.ts:14-31`).
  2. `registerBranch`.
  3. Set the header.
  4. `deterministicSessionId(integration, external, branchId)`, which adds the branch to the hash (`apps/cli/src/hook-types.ts:12-20`).
  
  If the register call fails (an old API, a network error), send no header and use the old session-ID formula.
- `document …` commands: send the checkout's branch header.

**New command `orchestrat branch`** (`parseArgs` is strict, `main.ts:87-102`, so only the new binary accepts these; managed harness entries are unchanged). Every subcommand takes `--integration <i>` like `document`, because credentials are per integration:

| Command | Behavior |
|---|---|
| `orchestrat branch` / `branch current` | Prints the checkout branch, the matching Orchestrat branch and the default. |
| `orchestrat branch list [--include-archived]` | Lists branches. |
| `orchestrat branch create <name>` | Registers the branch (`force_new`). |
| `orchestrat branch select <name> --integration <i>` | Writes a **per-checkout override** to `~/.orchestrat/branch-overrides.json` (keyed by realpath of the repo root). A new file, so `config.json` and its `version: 1` are untouched (`apps/cli/src/config.ts:71-77,138-143`). The next MCP start and hooks use the override instead of `HEAD`. |
| `orchestrat branch select --follow` | Removes the override. |

**Local Git never merges, archives or deletes anything.** The CLI only registers and selects. Deleting or merging a branch locally has no effect in Orchestrat; only provider events and owners/admins in the dashboard do that.

**Status and doctor:**
- `status` shows the checkout branch and the session's branch.
- `doctor` warns when the checkout branch is archived, when HEAD is detached, and when there is no `origin/HEAD`, suggesting `git remote set-head origin -a`.

**Rollout order:** the API deploys before any CLI that sends branch headers. A new CLI against an old API silently lands on the project, which is the default branch, except for the strict lifecycle schema. The branch rides in a header precisely so that doesn't break.

### 7.4 Session IDs

- MCP sessions: server-generated per open (unchanged).
- Hook sessions: `sha256("<integration>\0<external>\0<branchId>")` shaped as a UUIDv4 in new CLIs. The branch is in the session ID, so hook idempotency keys stay unique per branch.

---

## 8. Provider integration

### 8.1 Common architecture

```
provider ──HTTPS──▶ POST /api/v1/webhooks/<provider>[/:connectionId]
                       │ raw-body parser (encapsulated plugin, bodyLimit 10 MiB)
                       │ verify signature (constant time) + timestamp window
                       │ resolve connection (installation/project id match)
                       ▼
             INSERT repository_webhook_deliveries (ON CONFLICT DO NOTHING) ──▶ 202
                       │
     RepositorySyncWorker (in-process, single replica)
       tick every 2 s: claim pending rows in received order
         1. provider API reads (outside any DB transaction)
         2. one DB transaction: project lock → refs/branches/runs → mark applied
         3. failure → attempts+1, next_attempt_at = now + min(10s·2^n, 1h); after 10 → failed
       reconcile every 15 min per active connection (+ on connect, Sync now, reauth, unsuspend)
```

**Wiring and worker lifecycle:**

- New files: `apps/api/src/services/repository/{secrets,connection-service,webhook-ingress,sync-worker,reconcile,branch-sync,providers/github,providers/gitlab,providers/origin}.ts`, plus `apps/api/src/routes/{repository,webhooks}.ts`.
- `buildApp` gains `AppOptions.repositorySync?: { enabled: boolean; now?; fetch? }`. It defaults to `ORCHESTRAT_REPOSITORY_SYNC_ENABLED`, which is on when at least one provider is fully configured; tests pass `false` and drive `worker.tick()` directly.
- Every environment variable (the core repository variables and the per-provider app credentials) is listed with formats in [the setup guide §0.4](project-branches-provider-setup.md#04-full-variable-reference). They're parsed with Zod in `packages/config`, next to `apiConfigSchema`, never read raw from `process.env`.
- The worker starts in `onListen` with `setInterval(...).unref()` and stops in `preClose`, awaiting any in-flight tick. This runs before `pool.end()` (`r_code_api_core` §7).
- Claiming work:
  - a single-flight guard (one tick at a time);
  - an optimistic claim, `UPDATE … SET status='processing' WHERE id=$1 AND status='pending'`;
  - no `SKIP LOCKED`, which pg-mem lacks and which is unnecessary with one replica.
- On boot, `processing` rows older than 5 minutes return to `pending`.

**Response codes:**
- Valid signature, stored or duplicate → **202**.
- Valid signature but unknown installation or connection → **202** and the row stored as `ignored`. This avoids GitLab auto-disable and Origin retries.
- Bad signature or an expired timestamp → **401**.
- GitLab route with an unknown or disconnected `:connectionId` (e.g. the hook delete failed on disconnect) → **404**. There is no signing token to verify against, and repeated failures let GitLab auto-disable the orphaned hook, which is what we want.
- Database unavailable → **503**. Origin retries 5xx ([retries](https://cursor.com/docs/api/origin/reference/retries.md)). GitLab counts it toward auto-disable ([auto-disabled webhooks](https://docs.gitlab.com/user/project/integrations/webhooks/#auto-disabled-webhooks)). GitHub does not retry, and reconcile covers it.

**Rate limit:** a new `FixedWindowRateLimit` of 600/min per IP on the webhook routes (`apps/api/src/services/rate-limit.ts:10-59`).

**Provider calls:**
- All provider HTTP goes through an injected `fetch`, with a 10 s timeout, bounded retries on 429 and 5xx that honor `Retry-After`, and no logging of bodies or headers.
- Base URLs are constants (`https://api.github.com`, `https://gitlab.com`, `https://api.cursor.com/v1/origin`). Nothing user-supplied reaches a URL except path-encoded IDs, so there is no SSRF surface.

**Secrets** (`secrets.ts`):
- AES-256-GCM.
- Key from `ORCHESTRAT_REPOSITORY_SECRET_KEY` (32 bytes, base64), identified by `ORCHESTRAT_REPOSITORY_SECRET_KEY_ID`.
- Ciphertext format `v1.<key_id>.<iv_b64>.<ct+tag_b64>`, with AAD `"<table>:<row_id>:<purpose>"`, so a ciphertext copied between rows or purposes fails to decrypt.
- Rotation: previous keys in `ORCHESTRAT_REPOSITORY_PREVIOUS_SECRET_KEYS` (`id:base64,…`); reads accept any known key, writes use the current one.

### 8.2 Branch sync rules

Provider events are **hints**. Wherever the order of events matters, the worker checks the provider's current state through its API before writing.

| Signal | Effect (inside one transaction, under the project lock) |
|---|---|
| Branch created or pushed, name `N` | If an active ref exists: update `head_sha` and `last_seen_at`. Otherwise create a new ref generation, then **link or create** the Orchestrat branch: if an active branch named `N` exists and no active ref is linked to it (created by the CLI, the dashboard, or the default), link it. Otherwise create a branch (`created_via 'provider'`, `onboarding_state 'pending'`). |
| Branch deleted, name `N`, `before = S` when the provider sends it | If the active ref's `head_sha` or `first_seen_sha` equals `S`, or `S` is unknown: before archiving, call get-branch on the provider. If the branch exists, the event was stale or the branch was recreated. **If `S` matched**, end this generation and start a new one (archive the old branch, create a new one). **If `S` did not match**, ignore the event. If the branch is gone (404): mark the ref deleted, then archive the linked Orchestrat branch (`provider_deleted`), which closes its sessions (§6.2). **The default branch is never archived by a delete**: its ref is marked `deleted` and the branch shows a "missing on provider" warning. |
| Force push | Just a new `head_sha`, same generation. Orchestrat work doesn't depend on commits. |
| Tag refs (`refs/tags/*`) | Ignored. |
| Default branch changed on the provider | Update `provider_default_branch`. If the Orchestrat default still tracks the old provider default, move `is_default` to the branch tracking the new provider default, creating it if needed. Otherwise show a notice in settings. Open question Q6. |
| Branch renamed on the provider | Seen as a delete plus a create. The old branch is archived and a new blank branch is created; its data can be imported. Exception: when the renamed branch is the default, the Orchestrat default is renamed in place (`name_source 'provider'`). |
| Installation removed or access revoked | Connection → `needs_reauthorization` (or `disconnected` when the installation was deleted). Branches are kept, and nothing is archived. |
| Suspended / unsuspended | Connection → `suspended`; on unsuspend, back to `active` followed by a full reconcile. |
| PR/MR merged | See §8.6. |

**Residual ambiguity (documented, not solved).** If a delete *and* a recreate at a different head are both lost, reconcile sees the same name with a new head. That can't be told apart from a force push, so it is treated as the same generation. Archiving is non-destructive, so the worst case is work staying on a branch whose Git history was replaced.

### 8.3 GitHub App

Citations are in §8.9 [GH-*].

- **Permissions** (repository):
  - **Metadata: read**: repo, branches and the `repository` event.
  - **Contents: read**: `create`, `delete` and `push` events require it [GH-EV]. It is unavoidable for branch events.
  - **Pull requests: read**: `pull_request` events and listing merged PRs.
  - Nothing else. To limit what Contents allows, installation tokens are **minted per call** with `repository_ids: [repo]` and the narrowest `permissions` (`{metadata:"read"}` or `{pull_requests:"read"}`), so no minted token can read file contents [GH-IAT].
- **Events:** Create, Delete, Push, Pull request, Repository. `installation`, `installation_repositories` and `github_app_authorization` arrive without subscribing [GH-EV].
- **Connect flow** (anti-hijack):
  1. `POST …/authorizations {provider:"github"}` creates an attempt and returns a GitHub **user-authorization** URL (`https://github.com/login/oauth/authorize?client_id&redirect_uri&state&code_challenge&code_challenge_method=S256`) [GH-UAT].
  2. The callback checks `state`, exchanges the code with the `code_verifier` and client secret, calls `GET /user` (stable user ID) and `GET /user/installations`, and stores the user token encrypted on the attempt.
  3. The dashboard picker lists repositories via `GET /user/installations/{id}/repositories` for each installation.
     - When there are none, or the repo isn't listed, it shows **Install the GitHub App** (`https://github.com/apps/<slug>/installations/new?state=…`).
     - After installation, GitHub sends the user to the **Setup URL**, a dashboard route. The `installation_id` there is **untrusted** [GH-SETUP]. The dashboard posts it to `…/github-installation`, and the API only accepts it once it appears in `GET /user/installations` for this user's token.
  4. Connecting requires the chosen repo to be listed for the user under that installation. Then, with the app JWT: `GET /app/installations/{id}` (`suspended_at` null), then `GET /repos/{o}/{r}` for `id` and `default_branch`.
  5. The user token is wiped from the attempt.
- **Tokens:**
  - App JWT: RS256, `iat` = now−60 s, `exp` ≤ 10 min, `iss` = client ID [GH-JWT].
  - Installation tokens last 1 h. They are cached **in memory only**, up to 55 min, per `(installation, permission set)` [GH-IAT].
  - Tokens are not assumed to be 40 characters (`ghs_APPID_JWT` rollout) [GH-IAT].
- **Signature:**
  - `X-Hub-Signature-256` = `sha256=` + HMAC-SHA256(raw body, webhook secret), compared in constant time. Unit-tested with GitHub's documented test vector [GH-VALIDATE].
  - Dedupe on `X-GitHub-Delivery`, which is the same on redelivery [GH-BP].
  - Respond within 10 s [GH-BP].
  - Installation scoping: `payload.installation.id` must equal the connection's `installation_id`, and `payload.repository.id` its `provider_repository_id`. Anything else → `ignored`.
- **Branch signals:**
  - `push` with `created`/`deleted`/`forced`, plus `before` and `after`.
  - `create` and `delete` (`ref_type: "branch"`, no SHA) are treated as triggers to re-check that branch.
- **Merged:** `pull_request`, action `closed`, `pull_request.merged == true`, source `head.ref`/`head.sha`, target `base.ref`, number, `merged_at` [GH-EV-PR].
  - `merge_commit_sha` is recorded when present but never relied on: REST version 2026-03-10 removed it from PR responses [GH-BREAKING].
  - Fork PRs (`head.repo.id != base.repo.id`) are skipped.
- **Reconcile:**
  - `GET /repos/{o}/{r}/branches` (paged, `per_page=100`, following `Link`) [GH-BRANCHES].
  - `GET /repos/{o}/{r}/pulls?state=closed&sort=updated&direction=desc`, filtered to `merged_at >= watermark − 1 h`.
  - Every hour, `GET /app/hook/deliveries` since the stored cursor. Any GUID without a successful attempt is redelivered with `POST /app/hook/deliveries/{id}/attempts`, within GitHub's 3-day window [GH-REDELIVER], [GH-AUTO-REDELIVER].
- **API version header:** `X-GitHub-Api-Version: 2026-03-10`, since nothing depends on `merge_commit_sha` [GH-VERSIONS].

### 8.4 GitLab.com

Citations are in §8.9 [GL-*].

- **OAuth application:**
  - Group-owned (recommended) or user-owned, confidential, with redirect URI `${ORCHESTRAT_PUBLIC_API_URL}/api/v1/repository/callback/gitlab` [GL-OAUTH-PROVIDER].
  - Scope **`api`**: creating and deleting project hooks is a write API. The docs don't map endpoints to scopes, so this is *unverified*; see Q7 for a narrower `read_api` variant.
- **Connect flow:**
  1. The authorize URL is `https://gitlab.com/oauth/authorize?client_id&redirect_uri&response_type=code&state&scope=api&code_challenge&code_challenge_method=S256` [GL-OAUTH].
  2. The callback checks `state` and exchanges the code with `code_verifier`, sending `client_secret` as well because the app is confidential (*unverified* that it is required).
  3. Then `GET /oauth/token/info` (require `application.uid` = our client ID) and `GET /api/v4/user`.
  4. The picker uses `GET /projects?membership=true&min_access_level=40`.
  5. Connecting re-checks **Maintainer (≥ 40)** with `GET /projects/:id/members/all/:user_id` [GL-MEMBERS], then creates the hook [GL-HOOKS]:
     `POST /projects/:id/hooks { url: "${PUBLIC_API}/api/v1/webhooks/gitlab/<connection_id>", push_events: true, merge_requests_events: true, tag_push_events: false, branch_filter_strategy: "all_branches", enable_ssl_verification: true, signing_token: "whsec_<base64 of 32 random bytes>" }`
     Store `hook_id` and the encrypted signing token.
- **Tokens:**
  - Access tokens last 2 h. Refresh tokens **rotate**: a refresh invalidates the old pair [GL-OAUTH].
  - Refreshes are serialized with `SELECT … FOR UPDATE` on the connection row, and the new pair is persisted before use.
  - A refresh failure with `invalid_grant` sets `needs_reauthorization`.
  - Disconnect deletes the hook (best effort) and revokes both tokens with `POST /oauth/revoke`.
- **Signature (Standard Webhooks, GA since GitLab 19.1)** [GL-SIGN]:
  - Verify `webhook-signature` entries `v1,<base64>` against HMAC-SHA256(`<webhook-id>.<webhook-timestamp>.<raw body>`), with the key = base64-decode of the token without its `whsec_` prefix.
  - Reject timestamps more than 5 minutes off (the window is our choice).
  - Dedupe on `webhook-id`, falling back to `Idempotency-Key`.
  - Also require `X-Gitlab-Instance: https://gitlab.com` and payload `project.id` = the stored ID.
  - The legacy `X-Gitlab-Token` is not accepted.
- **Branch signals** from the `Push Hook`:
  - `before` of 40 zeros means created and `after` of 40 zeros means deleted. The docs only show this for tags, so it is *unverified* for branches; each case is also confirmed with `GET /projects/:id/repository/branches/:branch`.
  - There is no force flag, so a new head is a new head.
  - Pushes that change more than 3 refs send no hook at all [GL-PUSH-LIMIT], so reconcile is mandatory.
- **Merged:** `Merge Request Hook` with `object_attributes.action == "merge"`, fields `source_branch`, `target_branch`, `iid`, `merge_commit_sha` / `squash_commit_sha`, and `source_project_id == target_project_id` (otherwise a fork, skipped) [GL-EVENTS].
- **Default-branch change:** there is no webhook for it. Compare `project.default_branch` in every payload, and check in reconcile [GL-EVENTS].
- **Reconcile:**
  - `GET /projects/:id` (default branch, archived status, access);
  - `GET /projects/:id/repository/branches` (offset paging, `per_page=100`);
  - `GET /projects/:id/merge_requests?state=merged&merged_after=<watermark−1h>&order_by=merged_at&sort=asc` [GL-MRS].
- **Hook health:** each reconcile reads `GET /projects/:id/hooks/:hook_id` for `alert_status` and `disabled_until`, and shows it in settings. GitLab temporarily disables a hook after 4 consecutive failures and permanently after 40 [GL-AUTODISABLE]. The settings card offers **Re-enable**, which sends a test delivery via `POST /projects/:id/hooks/:hook_id/test/push_events` [GL-TEST].

### 8.5 Cursor Origin

Citations are in §8.9 [OR-*].

- **App:**
  - An Ed25519 public key is registered. The private key stays in `ORCHESTRAT_ORIGIN_APP_PRIVATE_KEY_BASE64` [OR-KEYGEN].
  - `webhookUrl` = `${PUBLIC_API}/api/v1/webhooks/origin`, and `installationRedirectUris` = [`${PUBLIC_API}/api/v1/repository/callback/origin`] [OR-CREATEAPP].
  - Events: `repository.pushed`, `pull_request.merged`, `repository.metadata.updated`, `repository.deleted`. `installation.*` events always arrive [OR-EVENTS].
  - There is no webhook secret; Origin signs with its own keys [OR-SIG].
- **Scopes:**
  - `repository:metadata:read` (added automatically);
  - `repository:contents:read`, which List Branches requires. Origin has no branch-only scope, so this is unavoidable [OR-SCOPES];
  - `repository:pull_requests:read`.
- **Connect flow:**
  1. The authorize URL is `https://cursor.com/codebase/apps/install?client_id=<app id>&scope=<scopes>&redirect_uri=<callback>&state=<state>` [OR-INSTALL].
  2. The callback receives `installation_receipt`, a JWT [OR-RECEIPT]. Verify it:
     - `alg: EdDSA`, `typ: origin-installation-receipt+jwt`;
     - the key comes from the JWKS at `https://api.cursor.com/v1/origin/keys` (cached 600 s, refreshed when no key verifies) [OR-JWKS];
     - `iss`, `aud` = app ID, `exp`;
     - `state` equals this attempt's state;
     - `jti` is unused (stored on the attempt; unique).
  3. With the app JWT, `GET /app/installations/{sub}`: `appId` is ours, `target.id == namespace_id`, no `suspendedAt`, and the scopes are sufficient [OR-GETINST].
  4. The picker uses `GET /installation/repos` with an installation token.
  5. On connect, `GET /repos/_/{repoId}` for `defaultBranch` and `mirror`.
  6. **GitHub-mirrored repos are rejected** (`mirror.source == "github"` and `status == "inbound"`): Origin does not send `repository.pushed` for them [OR-EVENTS], [OR-MIRR]. The user is told to connect the GitHub repository instead. Supporting mirrors is a non-goal.
- **Tokens:**
  - App JWT: header `{alg: EdDSA, kid: <app id>, typ: JWT}`, claims `iss` = app ID, `aud` = `origin-apps`, 5 min [OR-APPJWT]. The docs disagree about `kid` (app ID vs key thumbprint); try the app ID and test live.
  - `oit_` installation tokens last ≤ 15 min, have no refresh, and are minted per call with `repositoryIds: [repo]` and the narrowest `scopes` [OR-IAT]. Nothing is persisted.
- **Signature:**
  - `webhook-signature: v1ed,<base64>` is Ed25519 over the lowercase hex of SHA-256(`<webhook-id>.<webhook-timestamp>.<raw body>`), checked against **each** active JWKS key.
  - Timestamps must be within 300 s [OR-SIG].
  - Dedupe on `webhook-id` [OR-HEADERS].
  - The envelope's `installationId` must equal the connection's installation, and the payload repository ID must match.
- **Branch signals:** `repository.pushed` carries `refUpdates[]` with `ref`, `created`, `deleted`, `forced`, `before` and `after` (40 zeros on create/delete). It is capped at 100 entries: when `refUpdatesCount > refUpdates.length`, schedule a reconcile [OR-EV-PUSH].
- **Merged:** `pull_request.merged` with `head{ref, sha}`, `base{ref}`, `number` (a string), `mergedAt` and `mergeCommitSha`. Refs may be short or `refs/heads/…`, so normalize them [OR-EV-PR].
- **Default change:** `repository.metadata.updated` carries a full snapshot; diff `defaultBranch` [OR-EV-META].
- **Retries:** Origin retries 429, 5xx and transport errors 7 times over about 16 minutes. Other 4xx responses are terminal [OR-RETRY].
- **Reconcile:**
  - `GET /repos/_/{id}/branches?pageSize=100&pageToken=` [OR-BRANCHES];
  - `GET /repos/_/{id}/pulls?state=merged&sortBy=updated&direction=desc`. `since` filters on *creation* time, so page by `updatedAt` instead [OR-LISTPR];
  - `GET /app/webhook/deliveries?delivered=false`, then `POST /app/webhook/deliveries:batchRedeliver`, within a 7-day window [OR-RECOV].

### 8.6 PR/MR merged → automatic merge

1. Parse `{ number, head_ref, head_sha, base_ref, merge_sha?, merged_at }`. Skip forks.
2. **Dedupe key:** `"<provider>:<provider_repository_id>:merge:<number>:<merged_at>"`. The merge-run unique index makes retries and redeliveries no-ops.
3. **Find the source.**
   - First, the active ref named `head_ref`.
   - Otherwise, the newest `deleted` ref with that name whose `head_sha` or `first_seen_sha` equals `head_sha`, deleted at most 7 days ago. GitHub often deletes the head branch before the merge webhook arrives (`r_lessons` §c).
   - Otherwise, an active *untracked* Orchestrat branch with that name (never pushed through the connection, e.g. created by the CLI).
   - If nothing matches → a run with `skip_reason 'no_source_branch'`.
   - An archived source is fine, because the engine reads archived branches.
4. **Find the target:** the Orchestrat branch linked to the active ref `base_ref`, or created through the §8.2 link-or-create rule.
5. Run the engine (§9) with `kind 'merge'`, `trigger 'provider_merge'`, selection = everything, and no conflict choices. Conflicts become decisions and the target is kept.
6. Emit `merge.merge_applied` (target branch) and, when decisions were created, one `decision.opened` (target branch) with the count (§10).

### 8.7 Default-branch naming and linking

**Naming** follows the requirement: provider default, else the CLI-reported local default, else `main`.

- **Migration and new projects:** `main` with `name_source 'fallback'`.
- **CLI report** (`registerBranch.git_default_branch`, read from `refs/remotes/origin/HEAD`): if the project has **no** repository connection, the default branch's `name_source` is `fallback`, and no active branch already has that name → rename the default to the reported name and set `name_source 'cli'`. Emit `branch.renamed` (project-wide).

**Linking on connect.** This fixes the earlier attempt's "stranded default branch" bug. Let the provider default be `D`. The connect dialog computes one of four cases and shows it:

| Case | What the dialog proposes | Mode |
|---|---|---|
| The Orchestrat default is named `D` | "Link" | — |
| The Orchestrat default ≠ `D`, and no active branch named `D` exists | "Your default branch *main* will be renamed to *D* and track it. All existing work stays." (`name_source 'provider'`) | `rename_default` |
| The Orchestrat default ≠ `D`, and an active branch named `D` exists (e.g. registered by the CLI) | Radio choice: **(a)** keep the current default's work as *D* and archive the other *D* branch (`replaced_on_connect`; its data stays importable); or **(b)** make the existing *D* branch the default and leave *main* as an ordinary branch. The recommended default is (a) when the other *D* branch is empty, otherwise the user must choose. | `rename_default` / `use_existing` |
| Other existing provider branches | Not created, unless **"Also create Orchestrat branches for N existing provider branches"** is checked (default **off**; open question Q2). Existing refs are snapshotted into `repository_refs` (`created_signal 'connect_snapshot'`) without Orchestrat branches. The first push to any of them afterwards creates one. | — |

Orchestrat branches that don't exist on the provider (created by the CLI or the dashboard) are never archived by connect or reconcile. They were never observed on the provider.

**Later default changes on the provider:** see §8.2.

**Owners and admins can change the default manually at any time.** It affects UI defaults, import defaults and where legacy clients write. The confirm dialog says so.

### 8.8 Reconcile

For each active connection, every 15 min (±20% jitter, `ORCHESTRAT_REPOSITORY_RECONCILE_INTERVAL_SECONDS`), and also on connect, on Sync now, and after reauthorization or unsuspend:

1. Fetch the repository: default branch, rename or transfer (refresh `full_name`), access.
2. List all branches. Compare them with the active refs:
   - a branch missing from the refs, or a ref whose head moved since the last reconcile → the same path as a branch-pushed event;
   - an active ref missing from the list → the same path as a branch-deleted event, confirmed.
3. List merged PRs/MRs since `reconcile_state.merged_since − 1 h` (overlap on purpose; runs are deduped). Run §8.6 for each, then advance the watermark.
4. Provider-specific redelivery and hook health (§8.3–§8.5).
5. Record `last_reconciled_at`. Failures set `status 'error'` with a reason and are retried at the next interval.

Budgets: GitHub installations get 5,000+ requests per hour [GH-RATE], GitLab.com allows 2,000 authenticated requests per minute per user [GL-RATE], and Origin gives installation tokens 3,000 points per minute [OR-RATE]. Reconcile uses tens of requests per connection per run.

### 8.9 Citations (checked 2026-09-27)

**GitHub**
- [GH-REG] https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app
- [GH-SETUP] https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-setup-url
- [GH-UAT] https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app
- [GH-JWT] https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app
- [GH-IAT] https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app
- [GH-EV] / [GH-EV-PR] https://docs.github.com/en/webhooks/webhook-events-and-payloads (`#create`, `#delete`, `#push`, `#pull_request`, `#repository`, `#installation`)
- [GH-VALIDATE] https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries
- [GH-BP] https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks
- [GH-REDELIVER] https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/redelivering-webhooks
- [GH-AUTO-REDELIVER] https://docs.github.com/en/webhooks/using-webhooks/automatically-redelivering-failed-deliveries-for-a-github-app-webhook
- [GH-FAILED] https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries
- [GH-BRANCHES] https://docs.github.com/en/rest/branches/branches
- [GH-PULLS] https://docs.github.com/en/rest/pulls/pulls
- [GH-BREAKING] https://docs.github.com/en/rest/about-the-rest-api/breaking-changes
- [GH-VERSIONS] https://docs.github.com/en/rest/about-the-rest-api/api-versions
- [GH-RATE] https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
- [GH-PERMS] https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps

**GitLab**
- [GL-OAUTH] https://docs.gitlab.com/api/oauth2/
- [GL-OAUTH-PROVIDER] https://docs.gitlab.com/integration/oauth_provider/
- [GL-HOOKS] https://docs.gitlab.com/api/project_webhooks/
- [GL-SIGN] https://docs.gitlab.com/user/project/integrations/webhooks/#signing-tokens
- [GL-AUTODISABLE] https://docs.gitlab.com/user/project/integrations/webhooks/#auto-disabled-webhooks
- [GL-PUSH-LIMIT] https://docs.gitlab.com/user/project/integrations/webhooks/#push-event-limits
- [GL-TEST] https://docs.gitlab.com/user/project/integrations/webhooks/#test-a-webhook
- [GL-EVENTS] https://docs.gitlab.com/user/project/integrations/webhook_events/
- [GL-MEMBERS] https://docs.gitlab.com/api/project_members/
- [GL-MRS] https://docs.gitlab.com/api/merge_requests/
- [GL-RATE] https://docs.gitlab.com/user/gitlab_com/rate_limits/
- Release notes: https://docs.gitlab.com/releases/19/gitlab-19-1-released/

**Cursor Origin** (API "Early Beta", `v1alpha1`)
- [OR-INSTALL] https://cursor.com/docs/api/origin/reference/installation.md
- [OR-RECEIPT] …/reference/installation-receipt.md
- [OR-JWKS] …/reference/discovery-and-signing-keys.md
- [OR-APPJWT] …/reference/app-jwt.md
- [OR-IAT] …/reference/installation-access-token.md
- [OR-KEYGEN] …/reference/generate-an-app-signing-key.md
- [OR-CREATEAPP] …/reference/create-app.md
- [OR-SCOPES] …/reference/scopes.md
- [OR-EVENTS] …/reference/events.md
- [OR-EV-PUSH] …/reference/repository-push.md
- [OR-EV-PR] …/reference/pull-request-events.md
- [OR-EV-META] …/reference/repository-metadata-updated.md
- [OR-SIG] …/reference/signature-verification.md
- [OR-HEADERS] …/reference/headers.md
- [OR-RETRY] …/reference/retries.md
- [OR-RECOV] …/reference/recovery.md
- [OR-BRANCHES] …/reference/list-branches.md
- [OR-LISTPR] …/reference/list-pull-requests.md
- [OR-GETINST] …/reference/get-app-installation.md
- [OR-MIRR] …/reference/mirrored-repositories.md
- [OR-RATE] …/reference/rate-limits.md

`…` = `https://cursor.com/docs/api/origin`.

### 8.10 Unverified provider behavior (must be checked in live acceptance)

**GitHub**
- Whether the install `state` returns on the Setup URL. The design doesn't rely on it.
- The order of `pull_request.closed` versus the auto-delete `delete`/`push(deleted)` events. The design handles both orders.
- Which events a branch rename emits.
- Whether a branch created with no new commits emits `push`. The design also listens to `create`.

**GitLab**
- Branch create and delete shown as all-zero `before`/`after`.
- No automatic retries.
- Whether `api` is required for hook creation.
- Whether a confidential app must send `client_secret` alongside PKCE.
- Whether UI- or API-driven branch operations fire push hooks.
- Whether `signing_token` survives a hook URL change.

**Origin**
- **Whether a "private" app can be installed in another namespace. This blocks multi-tenant use; ask Cursor.** For testing, a personal Pro namespace can both publish and install.
- The JWT `kid` value.
- Whether `http://localhost` redirect URIs are accepted. The design uses HTTPS tunnels anyway.
- Whether auto-delete-on-merge sends a delete push.
- Whether each PR in a merged stack gets its own `pull_request.merged`.
- How `git/ref` paths handle branch names containing `/`. The design uses List Branches.

---

## 9. Merge, import and conflict algorithm

### 9.1 Scope of items

| Item | Identity across branches | Mutable fields compared | Copy rules |
|---|---|---|---|
| Task | lineage key; key and number follow lineage | `title`, `description`, `priority`, `status`* | Author, `created_*`, `started_at`, `completed_at`, `cancelled_at` preserved. `position` = end of its column in the target. `version` = 1 on a copy. |
| Task comment | lineage key | immutable | Author, `author_name`, `created_at` (ms precision) preserved; `imported_at` = now. Once attention lands (`task_comments.sequence`, `mentions`): copy `mentions` verbatim; keep `sequence` when the whole thread is copied into a task with no comments, otherwise renumber after the target's last sequence (attention plan §13). |
| Task dependency | pair of endpoint lineage keys | additive only | Added only when both endpoints exist in the target and no cycle results. |
| Document | lineage key, **or** path (natural key) | `path`, `body` (hash of current content, with attachment refs normalized), `archived` | All revisions copied (revision numbers, authors, `created_at` preserved). Content inline, with `content_size_bytes`/`content_sha256` NULL, which the check constraint allows (`schema.ts:725-777`). |
| Document revision | lineage key | immutable | New revisions carry `origin_id`. |
| Attachment | lineage key | immutable | New ID. The object is **server-side copied** to the new derived key before the transaction; counts toward the project quota. |
| Folder | path | none | Union of paths. |
| Chat | lineage key, **or** `direct_key` for DMs | `name` (groups) | New copy: participants and `has_human` **verbatim**, `creator_*`, messages with the same sequences, `last_read_sequence = last_sequence` for everyone. |
| Chat message | lineage key | immutable | Author, `author_name`, `mentions`, `created_at` preserved; `imported_at` = now; `document_refs` remapped to target document IDs by lineage when present. |
| Claims, sessions, lifecycle events, project events; attention's task watches, blocks, handoffs and acknowledgment positions | — | — | **Never copied.** They are per-agent runtime state, like claims. |

\* Status is normalized to `ready` when it is `claimed`, both for comparison and for writing. `claimed` must match an active claim (`r_code_api_domain` §3, invariant 4). Once attention lands, the same applies to every status its `resetsToReadyOnClaimEnd()` predicate treats as claim-derived: claims are never copied, so those statuses can't be either.

### 9.2 Matching

1. **By lineage key:** `coalesce(target.origin_id, target.id) = coalesce(source.origin_id, source.id)`.
2. **By natural key**, when there is no lineage match:
   - document `path` → the same logical document;
   - folder `path`;
   - DM `direct_key`.

   A natural-key match without a baseline is an **added-on-both** pair. If the fingerprints are equal, nothing happens and a baseline is recorded. Otherwise it is a conflict.
3. **No match:** the item is new to the target and gets copied, receiving `origin_id = source lineage key`.
4. **Path collision:** a document whose *path* changed on the source, where the new path is taken in the target by a different logical document → decision with reason `path_collision`. The target is kept.

### 9.3 Fingerprints and baselines

- **Fingerprint** = `{ field: sha256(canonical value) }` for the fields in §9.1.
- Document `body` is hashed after rewriting `orchestrat-attachment:<id>` refs (`apps/dashboard/src/routes/_authenticated.projects.$projectId.documents.tsx:59`) to their attachment **lineage keys**. Copying rewrites the IDs, and this keeps that from looking like a change.
- **Baselines** are keyed by the sorted branch pair, so they serve both directions. After every apply, each pair the engine touched is upserted to the agreed fingerprint:
  - the source fingerprint when the source was applied, or for `use_target` resolutions, so the same source state won't conflict again;
  - unchanged when the target is kept because only the target changed.
- **Inheritance for stacked branches.** When an item is copied from S to T, and S's current fingerprint equals S's baseline with some third branch X, also write the baseline (T, X) with the same fingerprint. So `main → feat1 → feat2` can merge `feat2 → main` without spurious conflicts.

### 9.4 Three-way rule per item

For each matched pair, with source fingerprint `s`, target fingerprint `t` and baseline `b` (possibly absent):

```
changed_s = { f : s[f] ≠ b[f] }   (all fields if b absent)
changed_t = { f : t[f] ≠ b[f] }   (all fields if b absent)
if s == t                          → nothing (upsert baseline := s)
elif b present and changed_t = ∅  → APPLY source values for changed_s
elif b present and changed_s = ∅  → KEEP target (nothing)
else                               → CONFLICT (fields = {f : s[f] ≠ t[f]}): keep target wholesale
```

Additional rules:

- **Tasks with an active claim in the target** are never modified. If the rule says APPLY, the item becomes a decision with reason `target_claimed`, and *use source* is refused until the claim ends (409 `TASK_ALREADY_CLAIMED`).
- **Status application:** a task whose status changes is moved to the end of the new status column. Timestamps follow `move` semantics (`task-service.ts:527-547`).
- **Documents:** APPLY of `body` appends **one** new revision to the target:
  - content = the source's current content, with attachment refs rewritten to target IDs;
  - author = the source's current revision author;
  - `origin_id` = that source revision's lineage key;
  - `created_at` = now, so target history stays monotonic.
  
  APPLY of `path` renames the document if the path is free. APPLY of `archived` archives or restores the document.
- **Deletion never propagates.** Items missing from the source are left alone. Dependency removals, attachment removals and chat participant removals are never applied.

### 9.5 Plan (preview)

`plan(source, target, kind, selection?)` reads without locks and returns:

```
Preview {
  fingerprint,                                 // sha256 over every involved (item, source version/hash, target version/hash) + baseline versions
  items: [{ item_type, lineage_key, source_id, target_id|null, outcome:
            "copy"|"apply"|"unchanged"|"keep_target"|"conflict"|"skipped",
            reason?, fields?, required_by?: lineage_key[], title/path/name, audience? }],
  required: { lineage_key: lineage_key[] },   // dependency closure for imports
  counts
}
```

- **Selection** (for `import`): `{ tasks: "all"|lineage_key[], documents: "all"|lineage_key[], chats: "all"|lineage_key[] }`.
- **Dependency closure:** selecting a task auto-selects its transitive blockers (`depends_on`) that are missing from the target. They are marked `required_by` and can't be unselected while the dependent stays selected ("keep required dependencies together").
- Selecting a document selects its revisions, its attachments and its folder path.
- Selecting a chat selects its messages.
- `kind: "merge"` always uses "all".
- In an **import**, a task whose target copy has an active claim shows as `skipped` with reason `target_claimed` (imports never create decisions); re-run the import after the claim ends.
- **Chat audience** (§9.6) shows as `skipped` with reason `audience_would_widen`.
- **Bounds:** at most 2,000 top-level items, 20,000 comments and messages, and 5 GiB of attachments per run. Beyond that → 400 `VALIDATION_ERROR`, `reason: "too_large"`, and the UI suggests splitting the selection.

### 9.6 Chat audience rule

The audience of a chat is its participant set, plus "all project humans" when `has_human = false` (observer mode: `apps/api/src/services/chat-service.ts:434-463`).

- **New chat in the target:** copy it exactly. The audience is equal, so it never widens.
- **Existing matched chat:** append the source messages missing from the target (by message lineage, in source sequence order, with new target sequences, `imported_at` set) **only if audience(target) ⊆ audience(source)**. Otherwise the whole chat is `skipped: audience_would_widen`.
  - DMs always pass, because their audiences are identical by `direct_key`.
- Participants are never added or removed by the engine. `has_human` is never recomputed. There is no `chat.member_added` or `chat.access_invalidated` event.
- **Unread and notifications:** `imported_at IS NOT NULL` messages are excluded from unread counts, mention counts, `unread_only` listing, the MCP notice and realtime chat notices. For a new chat copy, read positions are set to the last sequence anyway. The same flag on `task_comments` lets the attention feature skip imported comments.
- Order in an existing chat: imported messages appear after the existing ones. The UI shows a divider "Imported from *feat/x* · <date>", with the original timestamps on each message.

### 9.7 Apply

Pseudocode (one transaction):

```
apply(req):
  pre-tx:
    plan0 = plan(req.source, req.target, req.kind, req.selection)
    if req.kind == "import" and any conflict in plan0 lacks req.choices[lineage] → 400 VALIDATION_ERROR(missing_choice)
    copy attachment objects for every attachment the plan will copy (CopyObject to new derived keys) → copied[]
  tx:
    lock projects row FOR UPDATE                      // existing convention; serializes all branch writes
    lockBranch(target, write) → 409 BRANCH_ARCHIVED if archived; source may be archived (read-only is fine)
    idempotency reserve (dashboard) or dedupe_key insert ON CONFLICT DO NOTHING (provider) → replay/no-op
    plan1 = plan(...) re-read under lock
    if req.preview_fingerprint and plan1.fingerprint(restricted to selection) ≠ req.preview_fingerprint
       → rollback; 409 BRANCH_PREVIEW_STALE { preview: plan1 }     // UI keeps selections by lineage_key
    for items in dependency order (folders, docs, revisions, attachments, tasks, comments, deps, chats, messages):
       copy / apply / keep / conflict→decision(supersede older open decision) / skip
    cycle check for new dependency edges on the target graph (DFS as in task-service.ts:867-889) → skip edge + report
    upsert baselines; insert branch_merge_runs(result); if archive_source → archive(source) (§6.2); if complete_onboarding → mark target onboarding completed
    insertProjectEvent(merge.import_applied | merge.merge_applied, branchId = target, payload = counts)   // one summary event, no per-item events
    if decisions created: insertProjectEvent(decision.opened, branchId = target, payload = { run_id, count })
  post-tx:
    on failure: delete copied[] objects whose attachment rows do not exist (same pattern as document-service.ts:504-514)
```

- The lock order (project → target branch → entities) matches today's convention.
- Version checks: the fingerprint covers `tasks.version`, `documents.current_revision`, `chats.last_sequence` and baseline `updated_at` for both sides.
- **Lost response:** dashboard applies replay via `Idempotency-Key`; provider runs dedupe via `dedupe_key`.

### 9.8 Decisions

- **Created by:** automatic and manual merges (conflicts, `target_claimed`, `path_collision`). In an import, conflicts are resolved in the preview before apply, so imports never create decisions.
- **`use_target`:** mark resolved, and set the baseline to `source_snapshot`, so the same source state won't conflict again.
- **`use_source`:** under the project lock:
  - require the target's current fingerprint to equal `target_fingerprint`, otherwise 409 `BRANCH_DECISION_STALE`. The decision is recomputed (base = previous baseline, source = snapshot, target = current) and returned. If the target now equals the snapshot, the decision auto-resolves as `resolved_source`;
  - apply the snapshot values: document body from the referenced source revision, which is immutable, so the snapshot stays valid even after the source is archived;
  - update the baseline, and emit `task.updated`/`document.updated` with `branch_id = target` and `payload.decision_id`.
- **Superseded:** a newer merge conflict on the same item closes the older open decision.
- **Who resolves:** owners and admins, humans only. Agents and provider automation cannot resolve decisions.
- **Visibility:** open counts show on the branch object (`open_decision_count`), on Overview, and in the branch menu.

### 9.9 Manual merge

Owners and admins pick a source and a target (default: the default branch), see the preview, and confirm.

- The semantics match automatic merges: non-conflicting items apply, and conflicts become decisions with the target kept.
- A checkbox archives the source after merge; it is on by default when the source isn't tracked by the provider.
- It works whether or not a repository is connected.
- It does not touch Git.

---

## 10. Realtime and events

- **Envelope** (`apps/api/src/realtime/realtime.ts:49-87`, protocol `:779-805`) adds `branch_id: uuid | null`, optional, so old dashboards still parse it.
- **`entityTypes`** (`realtime.ts:19-29`) and `realtimeEntityTypeSchema` (`protocol :765-776`) add `branch`, `merge`, `decision` and `repository`. Without this they are silently dropped from sockets.
- **New event types:**

  | Event | Scope | Payload |
  |---|---|---|
  | `branch.created`, `branch.renamed`, `branch.archived`, `branch.default_changed`, `branch.onboarding_completed` | project-wide (`branch_id` NULL; `entity_id` = the branch) | |
  | `merge.import_applied`, `merge.merge_applied` | target branch | run ID and counts |
  | `decision.opened`, `decision.resolved` | target branch | |
  | `repository.connected`, `repository.disconnected`, `repository.status_changed` | project-wide | |

- **Sockets:** one per project (unchanged). The server does not filter by branch, since per-event authorization already costs a query per socket (`realtime.ts:320-352`). The dashboard invalidates only the matching branch's keys, plus project-wide ones.
- **Agents:** `GET /agent/events` is filtered by the resolved branch plus project-wide events.
- **Attention-feature interop:**
  - `insertProjectEvent(tx, { …, branchId })`. Task, comment, claim, chat and session events all carry `branch_id`, and attention filters its notices by the session's branch.
  - `imported_at` on `task_comments` and `chat_messages` marks history that must never notify.
  - The `merge.*` events are summary events and must be treated as non-notifying.
  - `wait_for_update` should wake only for events on the waiting session's branch plus project-wide events.

---

## 11. Dashboard

### 11.1 URL model

- The branch is the **search param** `?branch=<branch id>`, declared in `validateSearch` on the `$projectId` layout (`apps/dashboard/src/routes/_authenticated.projects.$projectId.tsx`) and kept by `retainSearchParams(['branch'])`. When it is omitted, the default branch is used, so every existing URL stays valid.
- The param uses the ID, not the name: names get reused across generations and the default branch can be renamed on connect. The breadcrumb shows the name.
- Fix `navigateToRoute` (`$projectId.tsx:256-259`), which builds a string path and drops search params, and every `navigate({ search })` that replaces the whole search object (tasks `:141,312,554`, documents `:484,601`, messages `:420,442,1079`).
- `beforeLoad` loads `branchesQueryOptions(api, projectId)` (stale 30 s; refetched on `branch.*` events) and returns `{ catalog, project, branches, branch }`.
  - Unknown ID → a **Branch unavailable** state (modeled on `ProjectAccessUnavailable`, `:154-193`) with "Go to default branch".
  - Archived → allowed, read-only (§11.5).
- **Entity deep links:** when `?task=` / `?document=` / `?chat=` point at an entity on another branch (the response carries `branch_id`), the page offers **Switch to *feat/x*** instead of today's "belongs to a different project" dead end (`tasks.tsx:580-587`).
- **Native notifications:** `NativeNotificationDestination` (`apps/dashboard/src/platform/contract.ts:28-49`) and its Rust mirror (`src-tauri/src/notifications.rs:37-56`, with UUID validation at `:90-109`) gain an optional `branchId`.

### 11.2 Breadcrumb branch selector

Insert a third `BreadcrumbItem` between the project item and the page `<h1>` in `apps/dashboard/src/components/app-shell/top-toolbar.tsx:269-342`. It copies the project selector exactly:

```tsx
<BreadcrumbSeparator className="hidden sm:block" />
<BreadcrumbItem className="hidden min-w-0 sm:inline-flex">
  <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <Button variant="ghost" size="sm" aria-label={"Branch: " + branch.name}
        className="w-max max-w-full min-w-0 px-1.5 font-normal text-muted-foreground hover:text-primary-text data-[state=open]:text-primary-text">
        <span className="truncate">{branch.name}</span>
        <ChevronDown className="size-3" />
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent className="w-64" align="start">
      <DropdownMenuLabel>Branches</DropdownMenuLabel>
      <DropdownMenuRadioGroup value={branch.id} onValueChange={onSelectBranch}>
        {/* default first, then most recently updated; max 12 items */}
        <DropdownMenuRadioItem value={b.id}>
          <span className="truncate">{b.name}</span>
          {b.is_default && <span className="ml-auto text-xs text-muted-foreground">Default</span>}
        </DropdownMenuRadioItem>
      </DropdownMenuRadioGroup>
      <DropdownMenuSeparator />
      {/* when > 12 active or any archived: */}
      <DropdownMenuItem onSelect={openAllBranches}><Search />All branches…</DropdownMenuItem>
      {openDecisions > 0 && <DropdownMenuItem onSelect={toDecisions}><Scale />Needs your decision ({openDecisions})</DropdownMenuItem>}
      <DropdownMenuItem onSelect={openCreateBranch}><Plus />New branch</DropdownMenuItem>
      <DropdownMenuItem onSelect={toBranchSettings}><Settings />Branch settings</DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
</BreadcrumbItem>
```

- **Styling** is identical to the organization and project selectors: orange text only while open or hovered (DESIGN.md "Brand orange"). The page name remains the only static orange text.
- **Unread dots:** branches with unread messages show a small `bg-primary` dot plus `aria-label` text, never colour alone. The data comes from `inbox?all_branches=true`.
- **All branches…** opens a `CommandDialog` (`apps/dashboard/src/components/ui/command.tsx`) with search, an **Active** group and an **Archived** group (archived rows muted with "Archived" text). This keeps archived branches hidden from the menu by default. No new Popover primitive is needed.
- **Keyboard:** Radix defaults (Enter/Space/ArrowDown to open, typeahead, Escape returns focus). The `aria-haspopup="menu"` trigger raises the e2e header-alignment count from **6 to 7** (`apps/dashboard/e2e/dashboard.spec.ts:1035-1046`).
- **Mobile (<640 px):** breadcrumb items hide as today (DESIGN.md:549). ⌘K gains a **Branches** group ("Switch to branch *x*", "New branch"). Update `commands.ts:6` and the exact-ID test at `commands.test.ts:40-60`.
- **DESIGN.md changes:**
  - the toolbar context becomes `Organization › Project › Branch › Page`, with the branch menu contents;
  - add "branch" to the content-style entity list (`:588`);
  - rename the document-history timeline wording at `:517`, which already uses "branch" for revision nodes, to "connector", to avoid confusion.

### 11.3 Branch scoping of pages

**Query keys**

Keys become `…(projectId, branchId)` for:
- `coordinationKeys.tasks`, `presence`, `events` and `eventsInfinite`, `documents` (`apps/dashboard/src/features/coordination/query-options.ts:38-67`);
- `messagingKeys.chats` and `inbox` (`apps/dashboard/src/features/messaging/query-options.ts:4-15`).

Entity keys stay the same. Prefix invalidation still covers every branch.

**Per page**

| Page | Branch behavior |
|---|---|
| Overview | Tasks, presence and events are branch-scoped (fixes the earlier attempt's gap). It adds a **Needs your decision** card when there are open decisions targeting this branch, and an onboarding card while `onboarding_state = pending`. |
| Tasks | The list and create are branch-scoped. The dependency picker is limited to the branch (it already uses the current list, `tasks.tsx:818-820`). |
| Documents | The tree, create and folders are branch-scoped. |
| Messages | Chats, the inbox and the document attach picker (`messages.tsx:1783-1827`) are branch-scoped. The workspace remount key (`:297`) includes the branch. |
| Agents | All project agents are listed. Presence shows "Online on this branch" or "Online on *feat/x*". |
| Activity | Branch events plus project-wide events; a toggle shows "All branches". |
| Sidebar messages badge | Current branch. |

### 11.4 Realtime (dashboard)

- `ProjectRealtimeController` stays one socket per project.
- Catch-up calls `listProjectEvents(projectId, { after, all_branches: true })`, keeping one monotonic `lastSequence` (`project-realtime.tsx:281-376`).
- `invalidateRealtimeEvent` (`query-options.ts:179-272`):
  - `branch_id` null → project-wide keys, plus `branches` on `branch.*` events;
  - otherwise only the keys for that `branch_id`;
  - `merge.*` events invalidate every branch-scoped key of the target branch.
- Chat notices for other branches show the branch name ("in *feat/x*"). Clicking navigates with `?branch=`. `currentChatIsVisible` (`:519-531`) also compares the branch.

### 11.5 Archived branches

- **Banner:** a shell-level `Alert role="status"` in `app-shell.tsx:224-240`: "**feat/x is archived.** It was deleted on GitHub on Sep 27 (or: archived by Arman). Its work is read-only. [Import into another branch]".
- **Read-only mode:** `readOnly = projectArchived || branchArchived`, computed once in the layout. Every write control is **hidden, not disabled** (no dead buttons):
  - Tasks: New task, move, edit, comments, dependencies.
  - Documents: create, rename, archive, editor → `readOnly`.
  - Messages: composer replaced by the read-only footer pattern (`messages.tsx:1865-1892`) reading "This branch is archived." Messages has no archived handling today.
  - Settings: branch actions show only Import.
- Branch names in the "All branches" dialog show an "Archived" label.

### 11.6 Branch creation, onboarding and import

- **New branch** dialog (from the menu, ⌘K, settings): a name field validated with `branchNameSchema`, and the helper text "Use the Git branch name. Agents on this Git branch will join it automatically."
- **First visit** to a branch with `onboarding_state = pending` renders an onboarding panel in the page area on any page, above the content. It is not a modal:
  - "**Set up *feat/x***". If agents already created work there: "3 tasks and 1 document already here will be kept."
  - Options (radio):
    - **Start blank**;
    - **Import everything from** [branch select, default = the default branch];
    - **Pick items…**
  - Continue.
  - For members, importing into the default branch isn't offered; that is owner/admin only.
- **Import dialog** (`Dialog`, large; `Sheet` on phone):
  - Tabs: Tasks / Documents / Chats. Each has search, "Select all" and a checkbox list.
    - Tasks show key, title, status and "Required by ORC-14" (locked while the dependent is checked).
    - Documents show path and attachment count.
    - Chats show name or participants and the audience line "Visible to Arman, codex". A chat that would widen is shown unselectable with the reason.
  - **Conflicts** section: each conflict row shows the fields that differ and **Use source** / **Use target** radios with **no preselection** ("conflicts are explicit"), plus bulk "Use target for all" / "Use source for all". *Apply* stays disabled until every conflict is chosen. A "Compare" disclosure shows both values; documents use the existing revision compare view.
  - **Stale preview:** a 409 `BRANCH_PREVIEW_STALE` re-renders with the returned preview, keeping selections and choices by `lineage_key` wherever the item still exists and its conflict fields are unchanged. The notice "Things changed while you were choosing. The preview is refreshed and your selections were kept." Changed conflicts are highlighted and cleared.
  - **Result:** counts, skipped items with reasons, and "Undo isn't available; nothing was deleted."
- After onboarding, the **Import…** action is always available: the branch menu → Branch settings → Import into this branch, and the archived banner.

### 11.7 Merge and decisions

- **Merge…** (owner/admin): opens from Branch settings, row menu → "Merge into…". It picks a target (default = the default branch), shows the preview (counts plus conflicts listed as "will need your decision"), has the checkbox "Archive *feat/x* after merging", and confirms.
- **Decisions page** `/projects/$projectId/decisions`:
  - A new route with the page name "Decisions".
  - A sidebar item in **Administration**, visible to everyone and read-only for members, with a count badge.
  - The list is filtered to the current branch as target, with a toggle for all branches. Each row shows item, source → target, reason, merge (PR #42 link) and time.
  - Clicking a row opens a right `Sheet` (DESIGN.md: sheets for detail) with source and target values side by side and **Use source** / **Use target** buttons.
  - A stale response refreshes the sheet with the notice "The target changed since this merge. Review again."
  - `target_claimed` rows explain "An agent is working on this task. You can choose once the claim ends."
- **Merge history:** Branch settings → merges tab lists runs (`GET /merges`).

### 11.8 Settings

`apps/dashboard/src/features/settings/project-settings-page.tsx` gains two sections.

**Branches**
- A table of name, source (Provider / CLI / Dashboard), status badge, last activity and a Default marker.
- A row menu:
  - **Set as default**: owner/admin, with a confirm explaining that legacy clients write there;
  - **Merge into…**: owner/admin;
  - **Import into this branch**: member, where allowed;
  - **Archive**: owner/admin; confirm dialog "Archive *feat/x*? It becomes read-only and hidden. Nothing is deleted. Active agent sessions on it will be closed." Archive is not offered for the default.
- A "Show archived" toggle.
- `StatusBadge` gains an `archived` mapping (secondary tone plus label).

**Repository**
- Before connecting: provider buttons "Connect GitHub", "Connect GitLab.com", "Connect Cursor Origin". Unconfigured providers are disabled with `unavailable_reason` text.
- **Wizard:**
  1. Provider redirect.
  2. Return to `settings?repository_authorization=<id>`.
  3. Repository picker (search, ineligible reasons).
  4. **Default branch mapping** step (§8.7 cases, plain language).
  5. Option "Also create branches for the N existing provider branches" (off).
  6. Connect.
- **GitHub Setup URL route** `/repository/github/setup` (authenticated): reads `installation_id`, finds the pending attempt in `sessionStorage['orchestrat.repository.attempt']`, validated with `/^ra_[A-Za-z0-9_-]{20,}$/` like the CLI-authorize pattern (`routes/cli.authorize.tsx:8-47`). It posts the installation to the API. On `next: "pick_repository"` it opens the picker; on `next: "authorize"` it follows the returned URL and comes back through the callback.
- **When connected:**
  - A card with repo full name and link, provider, status badge (Active / Needs reauthorization / Suspended / Error), last event, last sync, and the default branch mapping;
  - GitLab hook health;
  - "Failed deliveries (N)" → a list with Retry;
  - **Sync now**, **Reauthorize**, **Disconnect** (a confirm that says branches and work are kept).

### 11.9 Draft safety

Before switching branches (selector, ⌘K, deep link), the documents route flushes a pending autosave. If the flush fails or conflicts, a blocker (`useBlocker`) shows "You have unsaved changes in *path*" with **Keep editing** / **Discard and switch**. Chat drafts are keyed by chat ID and are safe (`messages.tsx:161-163`).

### 11.10 Files

**New**
- `src/features/branches/{query-options,branch-context,branch-selector,all-branches-dialog,create-branch-dialog,onboarding-panel,import-dialog,merge-dialog,archived-banner,branches-settings-section}.tsx`
- `src/features/decisions/{decisions-page,decision-sheet}.tsx`
- `src/features/repository/{repository-settings-section,connect-wizard,github-setup}.tsx`
- `src/routes/_authenticated.projects.$projectId.decisions.tsx`
- `src/routes/_authenticated.repository.github.setup.tsx`

**Changed**
- `top-toolbar.tsx`, `app-shell.tsx`, `context-sidebar.tsx` (the Decisions item), `$projectId.tsx`
- The tasks, documents, messages, agents, activity and overview routes and features
- `query-options.ts` (both), `lib/api/client.ts`, `project-realtime.tsx`
- `commands.ts`, `platform/contract.ts`, `src-tauri/src/notifications.rs`
- The test factories and handlers, and the e2e mocks

---

## 12. Security

1. **RLS** on every new table, and extend the RLS integration test (§5.5). Supabase grants `anon`/`authenticated` DML on new public tables by default.
2. **Branch isolation**:
   - every branch-scoped query filters by `branch_id`;
   - composite FKs make cross-branch child rows impossible;
   - adversarial tests forge cross-branch IDs for tasks, comments, dependencies, claims, sessions, documents, attachments, attachment download tickets, chats, messages, mentions and `document_ids` (modeled on `chats-adversarial.test.ts`).
3. **Pinned sessions:** an agent can't redirect a session to another branch. The header or entity mismatch returns 409 (§6.1), which fixes the earlier attempt's bug.
4. **Visibility:** imports and merges never add chat participants, never recompute `has_human`, and never append into a chat with a wider audience (§9.6). They emit no per-message events or notices.
5. **Provider auth:**
   - connection attempts are single-use, stored as a state hash, expire after 15 min, and are bound to the Orchestrat user and project;
   - PKCE (S256) for GitHub and GitLab;
   - provider-reported IDs are never trusted without a verifying call: GitHub `installation_id` against `/user/installations`; GitLab Maintainer check; Origin receipt signature plus `GET installation`;
   - Origin `jti` replay protection.
6. **Webhooks:**
   - signatures are verified on the raw body, in constant time;
   - timestamp windows (GitLab 5 min, Origin 300 s);
   - dedupe on the provider delivery ID;
   - installation and repository scoping;
   - payloads are stored only after verification, with a 10 MiB body limit and 600/min/IP;
   - no secret appears in `last_error` or logs.
7. **Secrets:**
   - AES-256-GCM with AAD row binding and key rotation;
   - GitLab tokens and signing tokens are the only persisted provider secrets;
   - GitHub and Origin tokens live in memory and are minted per call with the narrowest scope;
   - app private keys stay in environment secrets on Railway.
8. **Least privilege:**
   - GitHub Contents:read and Origin `contents:read` are unavoidable for branch events and listing. Minted tokens exclude contents wherever the call doesn't need it.
   - Orchestrat never writes to repositories.
   - The GitLab `api` scope is broad (Q7). The token is encrypted and revoked on disconnect.
9. **Authorization for automation:** provider-driven changes run as a "provider" actor. They may create, link and archive branches and run merges, but **cannot resolve decisions**.
10. **Input:** branch names are validated (§4.6), percent-encoded in headers, and always rendered as text.
11. **Abuse bounds:** merge-run size limits (§9.5), the attachment quota, and a 10-branches-per-minute registration rate limit per agent credential.

---

## 13. Test plan

### 13.1 pg-mem (default `pnpm test`)

**API** (`apps/api/src/routes/*.test.ts`, new `branches.test.ts`, `merges.test.ts`, `repository.test.ts`, `webhooks.test.ts`):
- Legacy requests land on the default branch for every existing route. Existing suites keep passing unchanged.
- Branch CRUD, archive (closes sessions, revokes claims) and set default, with the permission matrix (§6.6) as a table test.
- Resolution rules (§6.1): query, header, session pin, entity. `BRANCH_MISMATCH` only with explicit signals; compatible codes for old paths (§6.4).
- Isolation: the same path, DM pair and task key exist on two branches. Cross-branch refs are rejected. Presence lists all agents with `branch_id`.
- Idempotency: the same key on two branches creates two resources, and the legacy default fallback replays.
- Engine rules, one test per row of §9.1–§9.6:
  - copy, apply, keep and conflict;
  - natural-key add/add;
  - path collision;
  - claimed-status normalization and `target_claimed`;
  - dependency closure and cycle skip;
  - attachment-ref rewrite without spurious conflicts;
  - chat audience subset, DM append, `has_human` verbatim, `imported_at` excluded from unread and mentions;
  - baselines prevent re-conflict and stacked inheritance works;
  - decisions: use-source, use-target, stale, supersede.
- Webhook verification per provider:
  - GitHub's official test vector;
  - GitLab Standard Webhooks vectors generated in the test;
  - Origin with a test Ed25519 JWKS;
  - dedupe, ignored installations, and response codes.
- Branch sync state machine (§8.2) through a fake provider (below): create, push, link a CLI branch, delete, recreate, stale delete, default never archived, default rename, delete-before-merge, fork skip, tag ignore, installation removed.

**Protocol and SDK:** schemas parse old payloads without `branch_id`; exact header assertions (`packages/sdk/src/index.test.ts` style); new error codes in `error-schema.test.js`.

**MCP:**
- `select_branch` success;
- **close failure keeps the session, claim tokens and heartbeat**, then a retry succeeds;
- an open failure after close;
- follow mode switching when there are no claims, and a mismatch notice with claims;
- per-call binding across switches (extend `index.test.ts:591-698`);
- the tool list.

**CLI:**
- `git.ts` against fixture `.git` directories: a normal repo, a worktree (`gitdir:` + `commondir`), detached HEAD, missing `origin/HEAD`, and a name with `/`.
- The `branch` commands.
- The overrides file.
- Hook branch headers and session-ID derivation.
- Falling back when register fails.

**Dashboard (vitest + MSW):**
- Factories and handlers gain branches and `branch_id`.
- Selector rendering and `aria-checked`.
- Search-param retention across navigation.
- Archived read-only mode on every page.
- Onboarding panel.
- Import dialog selection and closure.
- Stale refresh keeps selections.
- Decisions sheet.
- Repository wizard steps.
- Draft blocker.

### 13.2 Real Postgres (`ORCHESTRAT_TEST_POSTGRES_URL`)

pg-mem can't prove rollback, isolation or locking (`r_code_tests_ops` §1.4), so these run only on Postgres:
1. **Migration and backfill with legacy rows** (§5.5), including the rollout shim.
2. **RLS** on every new table.
3. **Concurrency:**
   - two concurrent `POST /branches` with the same name → one wins, one gets `BRANCH_NAME_TAKEN`;
   - concurrent `register` from two agents → one branch;
   - claim races on the same task on two branches (independent) and on the same branch (one winner);
   - a session pinned during an archive → closed, claims revoked.
4. **Apply atomicity:**
   - a fault is injected after half the items → no partial rows, and copied attachment objects are cleaned up (with a fake storage);
   - concurrent applies with the same idempotency key → one run;
   - concurrent apply and target edit → one of them sees `BRANCH_PREVIEW_STALE` or `TASK_VERSION_CONFLICT`, never a lost update.
5. **Webhook inbox:** concurrent duplicate deliveries → one row, one effect. A worker crash mid-processing → the row resets and is applied once. A failed apply → backoff, then applied.
6. **GitLab refresh rotation:** two concurrent token users → one refresh, and both use the new token.
7. **Event ordering:** interleaved writes on two branches keep `project_events.id` in commit order, and catch-up misses nothing.

### 13.3 Simulated providers

`apps/api/src/services/repository/testing/`:
- `FakeGitHub`, `FakeGitLab`, `FakeOrigin` implement the REST calls the adapters use, behind the injected `fetch`, with mutable in-memory repos.
- Signed-payload builders:
  - HMAC with a test secret;
  - Standard Webhooks with `whsec_` test keys;
  - Ed25519 with a generated test key served as JWKS.
- A controllable clock.

Scenario scripts:
1. connect (each provider's anti-hijack failure cases: foreign `installation_id`, a non-Maintainer, a bad receipt signature, a replayed `jti`, a wrong `state`);
2. create → push → PR merged → head auto-deleted, in **both orders**;
3. delete and recreate the same name → a new branch, and the old one stays archived;
4. a stale delete after a recreate;
5. force push;
6. a default change on the provider;
7. the default renamed;
8. 5 branches in one GitLab push (no hook) → the reconcile creates them;
9. lost GitHub delivery → redelivery through `/app/hook/deliveries`;
10. an Origin `refUpdates` overflow → reconcile;
11. installation suspended and unsuspended;
12. GitLab hook auto-disabled → health shown → re-enabled;
13. disconnect (the hook deleted, tokens revoked, branches kept).

### 13.4 Playwright e2e and accessibility

Projects: `macos-default`, `macos-compact`, `phone-project` (`apps/dashboard/playwright.config.ts`). Extend `mockHierarchy` (`e2e/dashboard.spec.ts:70-392`) with branches, merges, decisions and repository routes. Add `e2e/branches.spec.ts`:
1. Switch branches from the breadcrumb. Every page follows, including Overview, and the URL keeps `?branch=` across sidebar navigation.
2. Create a branch → onboarding → pick items. A required dependency is auto-included. A conflict requires a choice. A stale preview (the mock returns 409 once) keeps the selections. Apply.
3. Archived branch: the banner, no write controls on any page, the Messages footer.
4. Owner merges with a decision → the Decisions page → Use source.
5. Settings: connect a repository through a mocked provider redirect, the mapping step, Sync now, disconnect.
6. A branch switch with an unsaved document draft is blocked.
7. ⌘K branch switching on phone.

**Axe:** `AxeBuilder.analyze()` with zero violations on:
- the open branch menu;
- the All branches dialog;
- the create dialog;
- the onboarding panel;
- the import dialog (every tab plus conflicts);
- the merge dialog;
- the Decisions page and sheet;
- the archived banner;
- both settings sections;
- in **light and dark** themes.

Update the header-alignment count (6 → 7). Keyboard-only runs for the selector, import dialog and decisions sheet. Run the import and decision specs with `--repeat-each=3`. The earlier attempt had a flaky phone import axe test.

### 13.5 Acceptance record and NOT RUN

Write a dated acceptance record. **NOT RUN** until real evidence exists:
- live GitHub, GitLab.com and Origin acceptance (task **Branches 25, ORC-44**);
- hosted migration and rollout;
- a screen-reader pass (VoiceOver) on the selector, import dialog and decisions sheet;
- R2 attachment copy against the real bucket (`ORCHESTRAT_TEST_R2=1`).

Environment placeholders are not evidence.

---

## 14. Hotspot change list

Changes to shared files are kept to these functions. Everything else lives in new modules:
- `apps/api/src/services/branches/*`, `…/merges/*`, `…/repository/*`
- `apps/api/src/routes/{branches,merges,repository,webhooks}.ts`
- `packages/protocol/src/{branches,repository,merges}.ts`
- `packages/sdk/src/branches.ts`
- `packages/db/src/schema-branches.ts`, re-exported from `schema.ts`
- `apps/cli/src/{git,branch-command,branch-overrides}.ts`

| File | Functions and what changes |
|---|---|
| `packages/db/src/schema.ts` | Add `branchId` (and `originId`/`importedAt` where listed) to the table definitions in §4.2, including `projectEvents`. Replace the re-scoped index definitions. Append `export * from "./schema-branches.js"` for the new tables. No other edits. |
| `packages/db/drizzle/meta/_journal.json` | Append the `idx 14` entry only. |
| `apps/api/src/app.ts` | `buildApp`: construct `BranchService`, `MergeService`, `RepositoryService` and `RepositorySyncWorker`; register the branch, merge and repository routes in the human and agent scopes and the webhook and callback routes in the public zone; add `AppOptions.repositorySync`; worker `onListen`/`preClose` hooks; boot default-branch repair. The error handler is unchanged. |
| `apps/api/src/realtime/realtime.ts` | `entityTypes` (+ `branch`, `merge`, `decision`, `repository`); `eventEnvelope` (+ `branch_id`). `RealtimeRegistry`, tickets and `publish` are unchanged. |
| `apps/api/src/services/agent-service.ts` | `insertProjectEvent` (+ `branchId` option). `openSession` (+ `branchId`, stored on the row). `ingestLifecycle` (`session.started` insert with `branch_id` plus the mismatch check; `session.ended` also closes siblings with the same `external_session_id`). `closeSessionInTransaction` (events carry `branchId`). `presenceForProject` (+ `branch_id` in output; optional branch view). `listEvents`/`listEventsHuman`/`listEventsAgent` (branch filter plus `all_branches`). `ownedSession` (returns `branchId`). `projectForAgent` (+ `default_branch_id`). **Unchanged:** `authenticate`, `heartbeat` (session-scoped already), `revokeAgents`, `activeProject`. |
| `apps/api/src/services/task-claim-service.ts` | `claim`: after locking the task, require `task.branchId === session.branchId` (else `TASK_NOT_CLAIMABLE` with `branch_mismatch`) and that the branch is active; `claim.created` carries `branchId`. The release/complete mutate path passes `branchId` to its events. `expireClaims` passes the task's `branchId` to `claim.expired`. `lockProject` and the session checks are unchanged. |
| `apps/api/src/services/task-service.ts` | `access`/`taskAccess`: resolve the branch (§6.1) and add archived-branch gates. `createAs`: branch-scoped position count, `branch_id` on insert, idempotency `resource_id = branchId` plus the legacy fallback. `listProject`/`listForAgent`/`getProject`: branch filter. `update`/`move`/`addDependency`/`removeDependency`: branch-archived gate and same-branch checks (the dependency graph load is filtered by branch). `createComment*`: `branch_id` from the task. All `insertProjectEvent` calls pass `branchId`. |
| `packages/protocol/src/index.ts` | Re-export `./branches.js`, `./repository.js` and `./merges.js`. Add optional `branch_id` to task, session, claim, presence, event, folder, document, chat, message and envelope schemas. Add `branch_id` to `openAgentSessionRequestSchema`. Join `branchErrorCodeSchema` into the error union. Extend `realtimeEntityTypeSchema`. Add `default_branch_id` to `projectSchema`. |
| `packages/sdk/src/index.ts` | `AgentApiClientOptions` (+ `branchId`, `sessionHeader`); `request()` header injection; `openSession` passes `branch_id`; re-export `./branches.js`. |
| `packages/mcp/src/index.ts` | `Client` pick (+ branch methods); `BridgeOptions` (+ `resolveCheckoutBranch`); `start()` (register and pin); two new tool registrations; `selectBranch()` (new method); `call()` (checkout follow plus per-call `{client, branchId, sessionId}` capture); `get_project` output. |
| Dashboard task views (`routes/_authenticated.projects.$projectId.tasks.tsx`) | Query and mutation calls pass `branchId`; `readOnly` generalization; the deep-link guard compares branches; `navigate({search})` keeps `branch`. |

Also touched, but not attention hotspots: `document-service.ts`, `attachment-service.ts`, `chat-service.ts`, `project-service.ts`, `permission-service.ts`, `routes/{v1,documents,agent-documents,chats,agents,agent-actions,realtime}.ts`, `apps/cli/src/{main,resolve,hooks,hook-types,diagnostics}.ts`, `apps/api/src/test/pg-mem-migrations.ts`.

---

## 15. Coordination with the attention feature

### 15.1 Contract

- **Migrations:** attention merged first with `0015` (`when` `1790600000000`); branches uses `0016` with a larger `when` (§5).
- **Events:** attention events carry `branch_id` through `insertProjectEvent({ branchId })`. Before branches merges, attention passes nothing; after, it filters on `project_events.branch_id` and the session's branch.
- **History markers:** attention must ignore `task_comments` and `chat_messages` with `imported_at IS NOT NULL`, and must treat `merge.*` summary events as non-notifying.
- **Agent task statuses:** attention's `set_task_status` (`in_progress`, `blocked`, `review` under a claim) and its `resetsToReadyOnClaimEnd()` predicate define which statuses are claim-derived. The merge engine normalizes exactly those (§9.1 footnote).
- **Shared function bodies:** both features edit the same functions (see attention plan §13 and §14 here). The only non-mechanical overlap is the MCP `call()`: attention replaces `readInbox` with `readAttention`, and branches adds checkout following and per-call capture. `readAttention` must run against the captured `{ client, branchId, sessionId }` so notices come from the branch the call ran on. Everything else is adjacent edits in `claim()`, `mutate()`, `expireClaims()`, `closeSessionInTransaction()`, `createAs()`, `move()`, `createCommentAs()` and the `task_comments` schema.
- **Comments:** attention's per-task comment `sequence` and `mentions` follow the import rule in §9.1. Imported comments (`imported_at` set) never count toward `TASK_COMMENTS_UNREAD`.
- **Handoffs:** attention only adds a `handoffs.branch_id` if direct chats stay unscoped. This spec scopes DMs per branch, so handoffs inherit their branch through the chat and no follow-up migration is needed.

### 15.2 Migration ordering hazard

`drizzle-kit migrate` (drizzle-orm 0.45) applies a migration only if its journal `when` is greater than the newest applied `created_at` (`drizzle-orm/pg-core/dialect.js:56-62`). It runs all pending migrations in one transaction and never re-verifies hashes. Consequences:

- If attention's `0015` is applied to **any** database (hosted or a shared local one) before a branches migration with a smaller `when`, a later `drizzle-kit migrate` **silently skips** it. This is why branches moved to `0016` with a larger `when`.
- Every test harness applies SQL files sorted by name and ignores the journal, so CI will not catch it.

Rules:
1. Hosted order is `0015` then `0016`, in one run or sequentially.
2. Resolved: attention merged first, so branches was renumbered to `0016` with a `when` greater than `0015`'s.
3. The rebase checkpoint (task **Branches 24, ORC-43**) adds a test that asserts journal `when` values strictly increase with `idx`.

### 15.3 Rebase checkpoint

Whichever feature merges second:
1. Rebases onto main and resolves the hotspot functions listed in §14.
2. Re-checks the migration journal (§15.2).
3. Runs the full suite: `pnpm build && pnpm lint && pnpm typecheck && pnpm test` and Playwright.
4. Runs the real-Postgres suite, including claim, session and heartbeat concurrency and the attention long-poll against branch-pinned sessions.
5. Records the result in the acceptance doc.

---

## 16. Rollout (later; each step needs Arman's approval)

1. Local gates pass (§13) and the acceptance record is written with its NOT RUN section.
2. Back up the hosted DB and test the restore. Supabase Free has no PITR.
3. **Migrate the hosted DB** (`railway run … pnpm --filter @orchestrat/db migrate`). The old API keeps working via the shim (§5.2). Postchecks: one default branch per project, no NULL `branch_id`, RLS on the new tables, row counts unchanged.
4. **Push `main`.** Railway deploys the API. Verify `/health`, `/ready` and legacy agent calls against the default branch.
5. **Check the dashboard deployment, then move the `app.orchestrat.dev` alias.**
6. **Release the CLI** (pack, `verify-cli-alpha.sh` with the new tool list, publish `--tag alpha`, hosted two-agent acceptance on two branches, promote).
7. Set provider env vars on Railway only when live providers are accepted.
8. Cleanup migration dropping the shim (§5.4).

---

## 17. Non-goals

- Code graph, graph scanner, indexing worker and graph MCP tools.
- Hand-editing conflicts (only *use source* / *use target*).
- PR review workflows beyond the automatic merge (no PR comments, statuses, checks or approvals).
- Self-hosted GitLab, GitHub Enterprise Server and other forges; forks and fork PRs; Origin GitHub-mirrored repositories.
- Writing to repositories (no branch creation, deletion or merging on the provider from Orchestrat).
- Multiple repositories per project; one repository backing several projects (Q3).
- Per-branch permissions or credentials.
- Restoring (unarchiving) archived branches (recover by importing, Q8); deleting branches or their data.
- Preserving identity across non-default provider branch renames.
- Propagating deletions or removals through merges.
- Scaling beyond one API replica (the worker and realtime are in-process).

---

## 18. Open questions

Each has a recommended default. The defaults are what this spec assumes.

| # | Question | Default |
|---|---|---|
| Q1 | Rollout window: keep the plpgsql fill shim in 0016 (§5.1), or take a ~5-minute write outage between migrating and deploying? | Shim |
| Q2 | When connecting a repo, create Orchestrat branches for **all** existing provider branches, or only the default plus branches pushed afterwards (with an opt-in checkbox)? | Only default + future pushes; checkbox off |
| Q3 | Can one repository back more than one Orchestrat project? | No, for now |
| Q4 | When the Git checkout switches branches mid-session, should the MCP follow automatically when the agent holds no claims? | Follow when no claims; notice otherwise |
| Q5 | An agent starts in a checkout whose branch was deleted on the provider (archived): open on the default branch with a warning on every tool result, or refuse until `select_branch`? | Open on default with warning |
| Q6 | When the provider's default branch changes later, move the Orchestrat default automatically if it still tracked the old provider default? | Yes, automatically in that case; otherwise a notice |
| Q7 | GitLab scope: keep a long-lived `api` token (simplest), or use `read_api` for sync and a one-time `api` grant just for hook create/delete? | `api` for v1 |
| Q8 | Unarchive: no restore in v1 (recover via import from the archived branch), OK? | No restore |
| Q9 | Cursor Origin: if Cursor confirms private apps can't be installed in other namespaces, ship GitHub + GitLab first and keep Origin single-tenant (your namespace) for now? | Yes |
| Q10 | Should members be allowed to resolve decisions on non-default target branches? | No, owners/admins only |

---

## 19. Implementation tasks

These are Orchestrat tasks in project `d96abcc8-47e6-47df-9002-ffd617fc455d`, all in `backlog`. Sizes: S ≤ ½ day, M 1–2 days, L 3–5 days.

The contract lane lands first. After ORC-25, the agent, merge-engine, provider and dashboard lanes run in parallel. The provider lane (ORC-32) can start as soon as ORC-22 lands, and the dashboard lane (ORC-37) can start against MSW mocks once ORC-20 lands.

| # | Key | Task | Size | Depends on |
|---|---|---|---|---|
| 01 | ORC-20 | Protocol contract for branches, merges and repository | M | — |
| 02 | ORC-21 | Migration 0016 (was 0014), Drizzle schema and backfill tests | L | — |
| 03 | ORC-22 | Branch core API, resolution rules and branch events | L | ORC-20, ORC-21 |
| 04 | ORC-23 | Scope tasks, claims, sessions, hooks, presence and events (attention hotspots) | L | ORC-22 |
| 05 | ORC-24 | Scope documents, attachments and chats | M | ORC-22 |
| 06 | ORC-25 | Branch isolation and concurrency suite (closes the contract) | M | ORC-23, ORC-24 |
| 07 | ORC-26 | SDK branch support | S | ORC-20, ORC-23 |
| 08 | ORC-27 | CLI Git detection, branch commands, hook branches | M | ORC-26 |
| 09 | ORC-28 | MCP list_branches, select_branch, checkout following | M | ORC-26, ORC-27 |
| 10 | ORC-29 | Merge engine core (lineage, baselines, plan/apply, tasks) | L | ORC-23, ORC-24 |
| 11 | ORC-30 | Merge engine for documents, attachments and chats | L | ORC-29 |
| 12 | ORC-31 | Import, merge and decision endpoints | M | ORC-30 |
| 13 | ORC-32 | Repository core (secrets, inbox, worker, reconcile, sync rules) | L | ORC-22 |
| 14 | ORC-33 | GitHub App adapter | M | ORC-32 |
| 15 | ORC-34 | GitLab.com adapter | M | ORC-32 |
| 16 | ORC-35 | Cursor Origin adapter | M | ORC-32 |
| 17 | ORC-36 | PR/MR merged → automatic merge; missed-merge reconcile | M | ORC-31, ORC-32 (+33–35) |
| 18 | ORC-37 | Dashboard branch context, selector, page scoping | L | ORC-20 (mocks); ORC-22–24 |
| 19 | ORC-38 | Dashboard branch management and manual merge | M | ORC-37, ORC-31 |
| 20 | ORC-39 | Dashboard onboarding, import dialog, Decisions page | L | ORC-37, ORC-31 |
| 21 | ORC-40 | Dashboard repository connection settings | M | ORC-37, ORC-32 |
| 22 | ORC-41 | Playwright e2e and accessibility suite | M | ORC-38, ORC-39, ORC-40 |
| 23 | ORC-42 | Docs and acceptance record | S | ORC-25, ORC-28, ORC-36, ORC-41 |
| 24 | ORC-43 | Rebase checkpoint with the attention feature | M | ORC-25, ORC-28 + attention |
| 25 | ORC-44 | Live provider acceptance (human-gated) | M | ORC-33–36, ORC-40 |
| 26 | ORC-45 | Hosted rollout (every step needs approval) | S | ORC-42, ORC-43 (+ORC-44) |
| 27 | ORC-46 | Cleanup migration dropping the rollout shim | S | ORC-45 |
