CREATE TABLE "project_branches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"name_source" text NOT NULL,
	"created_via" text NOT NULL,
	"created_by_type" "document_author_type",
	"created_by_user_id" uuid,
	"created_by_agent_id" uuid,
	"onboarding_state" text DEFAULT 'pending' NOT NULL,
	"onboarding_choice" text,
	"onboarding_completed_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"archived_reason" text,
	"archived_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_branches_project_id_id_unique" UNIQUE("project_id","id"),
	CONSTRAINT "project_branches_name_not_blank" CHECK (btrim("name") <> ''),
	CONSTRAINT "project_branches_default_active" CHECK (NOT "is_default" OR "archived_at" IS NULL),
	CONSTRAINT "project_branches_archive_consistent" CHECK (("archived_at" IS NULL) = ("archived_reason" IS NULL)),
	CONSTRAINT "project_branches_name_source_valid" CHECK ("name_source" IN ('fallback', 'cli', 'provider', 'user')),
	CONSTRAINT "project_branches_created_via_valid" CHECK ("created_via" IN ('migration', 'dashboard', 'cli', 'agent', 'provider')),
	CONSTRAINT "project_branches_onboarding_valid" CHECK ("onboarding_state" IN ('pending', 'completed') AND ("onboarding_choice" IS NULL OR "onboarding_choice" IN ('blank', 'import_all', 'selected'))),
	CONSTRAINT "project_branches_archived_reason_valid" CHECK ("archived_reason" IS NULL OR "archived_reason" IN ('provider_deleted', 'manual', 'replaced_on_connect')),
	CONSTRAINT "project_branches_created_by_consistent" CHECK (("created_by_type" IS NULL AND "created_by_user_id" IS NULL AND "created_by_agent_id" IS NULL) OR ("created_by_type" = 'human' AND "created_by_user_id" IS NOT NULL AND "created_by_agent_id" IS NULL) OR ("created_by_type" = 'agent' AND "created_by_user_id" IS NULL AND "created_by_agent_id" IS NOT NULL))
);--> statement-breakpoint
INSERT INTO "project_branches" ("id", "project_id", "name", "is_default", "name_source", "created_via", "onboarding_state", "onboarding_completed_at", "created_at", "updated_at")
SELECT gen_random_uuid(), "id", 'main', true, 'fallback', 'migration', 'completed', now(), "created_at", now()
FROM "projects";--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "branch_id" uuid;--> statement-breakpoint
UPDATE "tasks" SET "branch_id" = "b"."id" FROM "project_branches" AS "b" WHERE "b"."project_id" = "tasks"."project_id" AND "b"."is_default";--> statement-breakpoint
ALTER TABLE "tasks" ALTER COLUMN "branch_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "task_comments" ADD COLUMN "branch_id" uuid;--> statement-breakpoint
UPDATE "task_comments" SET "branch_id" = "b"."id" FROM "project_branches" AS "b" WHERE "b"."project_id" = "task_comments"."project_id" AND "b"."is_default";--> statement-breakpoint
ALTER TABLE "task_comments" ALTER COLUMN "branch_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD COLUMN "branch_id" uuid;--> statement-breakpoint
UPDATE "task_dependencies" SET "branch_id" = "b"."id" FROM "project_branches" AS "b" WHERE "b"."project_id" = "task_dependencies"."project_id" AND "b"."is_default";--> statement-breakpoint
ALTER TABLE "task_dependencies" ALTER COLUMN "branch_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "task_claims" ADD COLUMN "branch_id" uuid;--> statement-breakpoint
UPDATE "task_claims" SET "branch_id" = "b"."id" FROM "project_branches" AS "b" WHERE "b"."project_id" = "task_claims"."project_id" AND "b"."is_default";--> statement-breakpoint
ALTER TABLE "task_claims" ALTER COLUMN "branch_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "branch_id" uuid;--> statement-breakpoint
UPDATE "agent_sessions" SET "branch_id" = "b"."id" FROM "project_branches" AS "b" WHERE "b"."project_id" = "agent_sessions"."project_id" AND "b"."is_default";--> statement-breakpoint
ALTER TABLE "agent_sessions" ALTER COLUMN "branch_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "branch_id" uuid;--> statement-breakpoint
UPDATE "documents" SET "branch_id" = "b"."id" FROM "project_branches" AS "b" WHERE "b"."project_id" = "documents"."project_id" AND "b"."is_default";--> statement-breakpoint
ALTER TABLE "documents" ALTER COLUMN "branch_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "document_folders" ADD COLUMN "branch_id" uuid;--> statement-breakpoint
UPDATE "document_folders" SET "branch_id" = "b"."id" FROM "project_branches" AS "b" WHERE "b"."project_id" = "document_folders"."project_id" AND "b"."is_default";--> statement-breakpoint
ALTER TABLE "document_folders" ALTER COLUMN "branch_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "document_revisions" ADD COLUMN "branch_id" uuid;--> statement-breakpoint
UPDATE "document_revisions" SET "branch_id" = "b"."id" FROM "project_branches" AS "b" WHERE "b"."project_id" = "document_revisions"."project_id" AND "b"."is_default";--> statement-breakpoint
ALTER TABLE "document_revisions" ALTER COLUMN "branch_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "document_attachments" ADD COLUMN "branch_id" uuid;--> statement-breakpoint
UPDATE "document_attachments" SET "branch_id" = "b"."id" FROM "project_branches" AS "b" WHERE "b"."project_id" = "document_attachments"."project_id" AND "b"."is_default";--> statement-breakpoint
ALTER TABLE "document_attachments" ALTER COLUMN "branch_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "document_attachment_uploads" ADD COLUMN "branch_id" uuid;--> statement-breakpoint
UPDATE "document_attachment_uploads" SET "branch_id" = "b"."id" FROM "project_branches" AS "b" WHERE "b"."project_id" = "document_attachment_uploads"."project_id" AND "b"."is_default";--> statement-breakpoint
ALTER TABLE "document_attachment_uploads" ALTER COLUMN "branch_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "branch_id" uuid;--> statement-breakpoint
UPDATE "chats" SET "branch_id" = "b"."id" FROM "project_branches" AS "b" WHERE "b"."project_id" = "chats"."project_id" AND "b"."is_default";--> statement-breakpoint
ALTER TABLE "chats" ALTER COLUMN "branch_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_participants" ADD COLUMN "branch_id" uuid;--> statement-breakpoint
UPDATE "chat_participants" SET "branch_id" = "b"."id" FROM "project_branches" AS "b" WHERE "b"."project_id" = "chat_participants"."project_id" AND "b"."is_default";--> statement-breakpoint
ALTER TABLE "chat_participants" ALTER COLUMN "branch_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "branch_id" uuid;--> statement-breakpoint
UPDATE "chat_messages" SET "branch_id" = "b"."id" FROM "project_branches" AS "b" WHERE "b"."project_id" = "chat_messages"."project_id" AND "b"."is_default";--> statement-breakpoint
ALTER TABLE "chat_messages" ALTER COLUMN "branch_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "project_events" ADD COLUMN "branch_id" uuid;--> statement-breakpoint
UPDATE "project_events" SET "branch_id" = "b"."id" FROM "project_branches" AS "b" WHERE "b"."project_id" = "project_events"."project_id" AND "b"."is_default" AND "project_events"."type" NOT LIKE 'agent.%' AND "project_events"."type" NOT LIKE 'credential.%';--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "origin_id" uuid;--> statement-breakpoint
ALTER TABLE "task_comments" ADD COLUMN "origin_id" uuid;--> statement-breakpoint
ALTER TABLE "task_comments" ADD COLUMN "imported_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "origin_id" uuid;--> statement-breakpoint
ALTER TABLE "document_revisions" ADD COLUMN "origin_id" uuid;--> statement-breakpoint
ALTER TABLE "document_attachments" ADD COLUMN "origin_id" uuid;--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "origin_id" uuid;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "origin_id" uuid;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "imported_at" timestamp with time zone;--> statement-breakpoint
CREATE TABLE "branch_merge_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"source_branch_id" uuid NOT NULL,
	"target_branch_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"trigger" text NOT NULL,
	"status" text NOT NULL,
	"skip_reason" text,
	"dedupe_key" text,
	"provider" text,
	"provider_change_number" text,
	"provider_change_url" text,
	"provider_head_sha" text,
	"provider_merge_sha" text,
	"selection" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by_type" "document_author_type",
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_at" timestamp with time zone,
	CONSTRAINT "branch_merge_runs_kind_valid" CHECK ("kind" IN ('import', 'merge')),
	CONSTRAINT "branch_merge_runs_trigger_valid" CHECK ("trigger" IN ('dashboard', 'provider_merge')),
	CONSTRAINT "branch_merge_runs_status_valid" CHECK ("status" IN ('applied', 'applied_with_decisions', 'skipped', 'failed')),
	CONSTRAINT "branch_merge_runs_skip_reason_valid" CHECK ("skip_reason" IS NULL OR "skip_reason" IN ('no_source_branch', 'fork', 'same_branch', 'source_empty')),
	CONSTRAINT "branch_merge_runs_provider_valid" CHECK ("provider" IS NULL OR "provider" IN ('github', 'gitlab', 'origin')),
	CONSTRAINT "branch_merge_runs_creator_consistent" CHECK (("created_by_type" IS NULL AND "created_by_user_id" IS NULL) OR ("created_by_type" = 'human' AND "created_by_user_id" IS NOT NULL))
);--> statement-breakpoint
CREATE TABLE "branch_item_baselines" (
	"project_id" uuid NOT NULL,
	"branch_low_id" uuid NOT NULL,
	"branch_high_id" uuid NOT NULL,
	"item_type" text NOT NULL,
	"lineage_key" uuid NOT NULL,
	"fingerprint" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_run_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "branch_item_baselines_pk" PRIMARY KEY("branch_low_id","branch_high_id","item_type","lineage_key"),
	CONSTRAINT "branch_item_baselines_branch_order" CHECK ("branch_low_id" < "branch_high_id"),
	CONSTRAINT "branch_item_baselines_item_type_valid" CHECK ("item_type" IN ('task', 'document', 'chat'))
);--> statement-breakpoint
CREATE TABLE "branch_merge_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"source_branch_id" uuid NOT NULL,
	"target_branch_id" uuid NOT NULL,
	"item_type" text NOT NULL,
	"lineage_key" uuid NOT NULL,
	"source_item_id" uuid NOT NULL,
	"target_item_id" uuid NOT NULL,
	"label" text NOT NULL,
	"reason" text NOT NULL,
	"fields" text[] DEFAULT '{}' NOT NULL,
	"source_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"target_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"target_fingerprint" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"resolved_by_user_id" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "branch_merge_decisions_item_type_valid" CHECK ("item_type" IN ('task', 'document', 'chat')),
	CONSTRAINT "branch_merge_decisions_reason_valid" CHECK ("reason" IN ('changed_on_both', 'added_on_both', 'path_collision', 'target_claimed')),
	CONSTRAINT "branch_merge_decisions_status_valid" CHECK ("status" IN ('open', 'resolved_source', 'resolved_target', 'superseded')),
	CONSTRAINT "branch_merge_decisions_resolution_consistent" CHECK (("status" = 'open' AND "resolved_at" IS NULL AND "resolved_by_user_id" IS NULL) OR ("status" <> 'open' AND "resolved_at" IS NOT NULL))
);--> statement-breakpoint
CREATE TABLE "repository_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_repository_id" text NOT NULL,
	"repository_full_name" text NOT NULL,
	"repository_url" text,
	"provider_default_branch" text NOT NULL,
	"installation_id" text,
	"gitlab_hook_id" text,
	"access_token_ciphertext" text,
	"refresh_token_ciphertext" text,
	"token_expires_at" timestamp with time zone,
	"webhook_secret_ciphertext" text,
	"connected_by_user_id" uuid,
	"provider_account_id" text,
	"status" text DEFAULT 'active' NOT NULL,
	"status_reason" text,
	"hook_health" jsonb,
	"last_event_at" timestamp with time zone,
	"last_reconciled_at" timestamp with time zone,
	"reconcile_state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disconnected_at" timestamp with time zone,
	CONSTRAINT "repository_connections_provider_valid" CHECK ("provider" IN ('github', 'gitlab', 'origin')),
	CONSTRAINT "repository_connections_status_valid" CHECK ("status" IN ('active', 'needs_reauthorization', 'suspended', 'error', 'disconnected')),
	CONSTRAINT "repository_connections_disconnect_consistent" CHECK (("status" = 'disconnected') = ("disconnected_at" IS NOT NULL))
);--> statement-breakpoint
CREATE TABLE "repository_connection_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"state_hash" text NOT NULL,
	"pkce_verifier_ciphertext" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"provider_user_id" text,
	"installation_id" text,
	"user_token_ciphertext" text,
	"receipt_jti" text,
	"return_path" text,
	"error_code" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "repository_connection_attempts_state_hash_unique" UNIQUE("state_hash"),
	CONSTRAINT "repository_connection_attempts_provider_valid" CHECK ("provider" IN ('github', 'gitlab', 'origin')),
	CONSTRAINT "repository_connection_attempts_status_valid" CHECK ("status" IN ('pending', 'authorized', 'consumed', 'expired', 'failed'))
);--> statement-breakpoint
CREATE TABLE "repository_refs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"name" text NOT NULL,
	"head_sha" text,
	"first_seen_sha" text,
	"branch_id" uuid,
	"state" text DEFAULT 'active' NOT NULL,
	"created_signal" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_delivery_id" text,
	"deleted_delivery_id" text,
	CONSTRAINT "repository_refs_state_valid" CHECK ("state" IN ('active', 'deleted')),
	CONSTRAINT "repository_refs_delete_consistent" CHECK (("state" = 'deleted') = ("deleted_at" IS NOT NULL)),
	CONSTRAINT "repository_refs_created_signal_valid" CHECK ("created_signal" IN ('event', 'reconcile', 'connect_snapshot'))
);--> statement-breakpoint
CREATE TABLE "repository_webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"delivery_id" text NOT NULL,
	"connection_id" uuid,
	"event_type" text NOT NULL,
	"installation_id" text,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "repository_webhook_deliveries_delivery_unique" UNIQUE("provider","delivery_id"),
	CONSTRAINT "repository_webhook_deliveries_provider_valid" CHECK ("provider" IN ('github', 'gitlab', 'origin')),
	CONSTRAINT "repository_webhook_deliveries_status_valid" CHECK ("status" IN ('pending', 'processing', 'applied', 'ignored', 'failed')),
	CONSTRAINT "repository_webhook_deliveries_attempts_nonnegative" CHECK ("attempts" >= 0)
);--> statement-breakpoint
ALTER TABLE "project_branches" ADD CONSTRAINT "project_branches_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_branches" ADD CONSTRAINT "project_branches_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_branches" ADD CONSTRAINT "project_branches_created_by_agent_project_fk" FOREIGN KEY ("project_id","created_by_agent_id") REFERENCES "public"."agents"("project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_branches" ADD CONSTRAINT "project_branches_archived_by_user_id_users_id_fk" FOREIGN KEY ("archived_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_branch_id_id_unique" UNIQUE("branch_id","id");--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_branch_id_id_unique" UNIQUE("branch_id","id");--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_branch_id_id_unique" UNIQUE("branch_id","id");--> statement-breakpoint
ALTER TABLE "chats" ADD CONSTRAINT "chats_branch_id_id_unique" UNIQUE("branch_id","id");--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_branch_project_fk" FOREIGN KEY ("project_id","branch_id") REFERENCES "public"."project_branches"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_branch_project_fk" FOREIGN KEY ("project_id","branch_id") REFERENCES "public"."project_branches"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_task_branch_fk" FOREIGN KEY ("branch_id","task_id") REFERENCES "public"."tasks"("branch_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_branch_project_fk" FOREIGN KEY ("project_id","branch_id") REFERENCES "public"."project_branches"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_task_branch_fk" FOREIGN KEY ("branch_id","task_id") REFERENCES "public"."tasks"("branch_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_blocker_branch_fk" FOREIGN KEY ("branch_id","depends_on_task_id") REFERENCES "public"."tasks"("branch_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_claims" ADD CONSTRAINT "task_claims_branch_project_fk" FOREIGN KEY ("project_id","branch_id") REFERENCES "public"."project_branches"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_claims" ADD CONSTRAINT "task_claims_task_branch_fk" FOREIGN KEY ("branch_id","task_id") REFERENCES "public"."tasks"("branch_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_claims" ADD CONSTRAINT "task_claims_session_branch_fk" FOREIGN KEY ("branch_id","session_id") REFERENCES "public"."agent_sessions"("branch_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_branch_project_fk" FOREIGN KEY ("project_id","branch_id") REFERENCES "public"."project_branches"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_branch_project_fk" FOREIGN KEY ("project_id","branch_id") REFERENCES "public"."project_branches"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_folders" ADD CONSTRAINT "document_folders_branch_project_fk" FOREIGN KEY ("project_id","branch_id") REFERENCES "public"."project_branches"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_revisions" ADD CONSTRAINT "document_revisions_branch_project_fk" FOREIGN KEY ("project_id","branch_id") REFERENCES "public"."project_branches"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_revisions" ADD CONSTRAINT "document_revisions_document_branch_fk" FOREIGN KEY ("branch_id","document_id") REFERENCES "public"."documents"("branch_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_attachments" ADD CONSTRAINT "document_attachments_branch_project_fk" FOREIGN KEY ("project_id","branch_id") REFERENCES "public"."project_branches"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_attachments" ADD CONSTRAINT "document_attachments_document_branch_fk" FOREIGN KEY ("branch_id","document_id") REFERENCES "public"."documents"("branch_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_attachment_uploads" ADD CONSTRAINT "document_attachment_uploads_branch_project_fk" FOREIGN KEY ("project_id","branch_id") REFERENCES "public"."project_branches"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_attachment_uploads" ADD CONSTRAINT "document_attachment_uploads_document_branch_fk" FOREIGN KEY ("branch_id","document_id") REFERENCES "public"."documents"("branch_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chats" ADD CONSTRAINT "chats_branch_project_fk" FOREIGN KEY ("project_id","branch_id") REFERENCES "public"."project_branches"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_participants" ADD CONSTRAINT "chat_participants_branch_project_fk" FOREIGN KEY ("project_id","branch_id") REFERENCES "public"."project_branches"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_participants" ADD CONSTRAINT "chat_participants_chat_branch_fk" FOREIGN KEY ("branch_id","chat_id") REFERENCES "public"."chats"("branch_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_branch_project_fk" FOREIGN KEY ("project_id","branch_id") REFERENCES "public"."project_branches"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_chat_branch_fk" FOREIGN KEY ("branch_id","chat_id") REFERENCES "public"."chats"("branch_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_events" ADD CONSTRAINT "project_events_branch_project_fk" FOREIGN KEY ("project_id","branch_id") REFERENCES "public"."project_branches"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch_merge_runs" ADD CONSTRAINT "branch_merge_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch_merge_runs" ADD CONSTRAINT "branch_merge_runs_source_branch_fk" FOREIGN KEY ("project_id","source_branch_id") REFERENCES "public"."project_branches"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch_merge_runs" ADD CONSTRAINT "branch_merge_runs_target_branch_fk" FOREIGN KEY ("project_id","target_branch_id") REFERENCES "public"."project_branches"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch_merge_runs" ADD CONSTRAINT "branch_merge_runs_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch_item_baselines" ADD CONSTRAINT "branch_item_baselines_low_branch_fk" FOREIGN KEY ("project_id","branch_low_id") REFERENCES "public"."project_branches"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch_item_baselines" ADD CONSTRAINT "branch_item_baselines_high_branch_fk" FOREIGN KEY ("project_id","branch_high_id") REFERENCES "public"."project_branches"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch_item_baselines" ADD CONSTRAINT "branch_item_baselines_last_run_id_fk" FOREIGN KEY ("last_run_id") REFERENCES "public"."branch_merge_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch_merge_decisions" ADD CONSTRAINT "branch_merge_decisions_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."branch_merge_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch_merge_decisions" ADD CONSTRAINT "branch_merge_decisions_source_branch_fk" FOREIGN KEY ("project_id","source_branch_id") REFERENCES "public"."project_branches"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch_merge_decisions" ADD CONSTRAINT "branch_merge_decisions_target_branch_fk" FOREIGN KEY ("project_id","target_branch_id") REFERENCES "public"."project_branches"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch_merge_decisions" ADD CONSTRAINT "branch_merge_decisions_resolved_by_user_id_users_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_connections" ADD CONSTRAINT "repository_connections_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_connections" ADD CONSTRAINT "repository_connections_connected_by_user_id_users_id_fk" FOREIGN KEY ("connected_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_connection_attempts" ADD CONSTRAINT "repository_connection_attempts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_connection_attempts" ADD CONSTRAINT "repository_connection_attempts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_refs" ADD CONSTRAINT "repository_refs_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."repository_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_refs" ADD CONSTRAINT "repository_refs_branch_project_fk" FOREIGN KEY ("project_id","branch_id") REFERENCES "public"."project_branches"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_webhook_deliveries" ADD CONSTRAINT "repository_webhook_deliveries_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."repository_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
DROP INDEX "tasks_project_key_unique";--> statement-breakpoint
DROP INDEX "tasks_project_number_unique";--> statement-breakpoint
DROP INDEX "tasks_project_board_order_idx";--> statement-breakpoint
DROP INDEX "agent_sessions_project_agent_status_idx";--> statement-breakpoint
DROP INDEX "documents_project_path_unique";--> statement-breakpoint
DROP INDEX "documents_project_updated_idx";--> statement-breakpoint
DROP INDEX "document_folders_project_path_unique";--> statement-breakpoint
DROP INDEX "chats_direct_pair_unique";--> statement-breakpoint
DROP INDEX "chats_project_updated_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "project_branches_active_name_unique" ON "project_branches" USING btree ("project_id","name") WHERE "archived_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "project_branches_one_default" ON "project_branches" USING btree ("project_id") WHERE "is_default";--> statement-breakpoint
CREATE INDEX "project_branches_project_archived_idx" ON "project_branches" USING btree ("project_id","archived_at","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_branch_key_unique" ON "tasks" USING btree ("branch_id","task_key");--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_branch_number_unique" ON "tasks" USING btree ("branch_id","task_number");--> statement-breakpoint
CREATE INDEX "tasks_branch_board_order_idx" ON "tasks" USING btree ("branch_id","status","position","id");--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_branch_origin_unique" ON "tasks" USING btree ("branch_id","origin_id") WHERE "origin_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "task_comments_branch_origin_unique" ON "task_comments" USING btree ("branch_id","origin_id") WHERE "origin_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "task_dependencies_branch_task_idx" ON "task_dependencies" USING btree ("branch_id","task_id");--> statement-breakpoint
CREATE INDEX "agent_sessions_branch_agent_status_idx" ON "agent_sessions" USING btree ("branch_id","agent_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "documents_branch_path_unique" ON "documents" USING btree ("branch_id","path");--> statement-breakpoint
CREATE INDEX "documents_branch_updated_idx" ON "documents" USING btree ("branch_id","updated_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "documents_branch_origin_unique" ON "documents" USING btree ("branch_id","origin_id") WHERE "origin_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "document_folders_branch_path_unique" ON "document_folders" USING btree ("branch_id","path");--> statement-breakpoint
CREATE UNIQUE INDEX "document_revisions_branch_origin_unique" ON "document_revisions" USING btree ("branch_id","origin_id") WHERE "origin_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "document_attachments_branch_origin_unique" ON "document_attachments" USING btree ("branch_id","origin_id") WHERE "origin_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "chats_branch_direct_pair_unique" ON "chats" USING btree ("branch_id","direct_key");--> statement-breakpoint
CREATE INDEX "chats_branch_updated_idx" ON "chats" USING btree ("branch_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "chats_branch_origin_unique" ON "chats" USING btree ("branch_id","origin_id") WHERE "origin_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_messages_branch_origin_unique" ON "chat_messages" USING btree ("branch_id","origin_id") WHERE "origin_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "project_events_project_branch_id_idx" ON "project_events" USING btree ("project_id","branch_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "branch_merge_runs_dedupe_unique" ON "branch_merge_runs" USING btree ("project_id","dedupe_key") WHERE "dedupe_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "branch_merge_runs_target_created_idx" ON "branch_merge_runs" USING btree ("target_branch_id","created_at");--> statement-breakpoint
CREATE INDEX "branch_item_baselines_lineage_idx" ON "branch_item_baselines" USING btree ("project_id","item_type","lineage_key");--> statement-breakpoint
CREATE UNIQUE INDEX "branch_merge_decisions_open_unique" ON "branch_merge_decisions" USING btree ("target_branch_id","item_type","lineage_key") WHERE "status" = 'open';--> statement-breakpoint
CREATE INDEX "branch_merge_decisions_target_status_idx" ON "branch_merge_decisions" USING btree ("target_branch_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "repository_connections_one_active_per_project" ON "repository_connections" USING btree ("project_id") WHERE "disconnected_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "repository_connections_one_active_per_repo" ON "repository_connections" USING btree ("provider","provider_repository_id") WHERE "disconnected_at" IS NULL;--> statement-breakpoint
CREATE INDEX "repository_connections_installation_idx" ON "repository_connections" USING btree ("provider","installation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "repository_connection_attempts_receipt_jti_unique" ON "repository_connection_attempts" USING btree ("receipt_jti") WHERE "receipt_jti" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "repository_connection_attempts_expires_idx" ON "repository_connection_attempts" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "repository_refs_active_name_unique" ON "repository_refs" USING btree ("connection_id","name") WHERE "state" = 'active';--> statement-breakpoint
CREATE INDEX "repository_refs_connection_name_idx" ON "repository_refs" USING btree ("connection_id","name","deleted_at");--> statement-breakpoint
CREATE INDEX "repository_refs_branch_idx" ON "repository_refs" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "repository_webhook_deliveries_queue_idx" ON "repository_webhook_deliveries" USING btree ("status","next_attempt_at","received_at");--> statement-breakpoint
CREATE INDEX "repository_webhook_deliveries_connection_idx" ON "repository_webhook_deliveries" USING btree ("connection_id","received_at");--> statement-breakpoint
ALTER TABLE "project_branches" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "branch_merge_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "branch_item_baselines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "branch_merge_decisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "repository_connections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "repository_connection_attempts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "repository_refs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "repository_webhook_deliveries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- Rollout-window shim (spec §5.1 step 10): the API that is live while the
-- hosted database is migrated never sets branch_id. Fill it from the
-- project's default branch until the new API ships; a later migration drops
-- this (spec §5.4). pg-mem cannot run plpgsql, so these statements are
-- filtered there and covered by the real PostgreSQL acceptance test.
CREATE FUNCTION "orchestrat_fill_default_branch"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF NEW."branch_id" IS NULL THEN
		NEW."branch_id" := (SELECT "id" FROM "project_branches" WHERE "project_id" = NEW."project_id" AND "is_default");
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "orchestrat_fill_default_branch_tasks" BEFORE INSERT ON "tasks" FOR EACH ROW EXECUTE FUNCTION "orchestrat_fill_default_branch"();--> statement-breakpoint
CREATE TRIGGER "orchestrat_fill_default_branch_task_comments" BEFORE INSERT ON "task_comments" FOR EACH ROW EXECUTE FUNCTION "orchestrat_fill_default_branch"();--> statement-breakpoint
CREATE TRIGGER "orchestrat_fill_default_branch_task_dependencies" BEFORE INSERT ON "task_dependencies" FOR EACH ROW EXECUTE FUNCTION "orchestrat_fill_default_branch"();--> statement-breakpoint
CREATE TRIGGER "orchestrat_fill_default_branch_task_claims" BEFORE INSERT ON "task_claims" FOR EACH ROW EXECUTE FUNCTION "orchestrat_fill_default_branch"();--> statement-breakpoint
CREATE TRIGGER "orchestrat_fill_default_branch_agent_sessions" BEFORE INSERT ON "agent_sessions" FOR EACH ROW EXECUTE FUNCTION "orchestrat_fill_default_branch"();--> statement-breakpoint
CREATE TRIGGER "orchestrat_fill_default_branch_documents" BEFORE INSERT ON "documents" FOR EACH ROW EXECUTE FUNCTION "orchestrat_fill_default_branch"();--> statement-breakpoint
CREATE TRIGGER "orchestrat_fill_default_branch_document_folders" BEFORE INSERT ON "document_folders" FOR EACH ROW EXECUTE FUNCTION "orchestrat_fill_default_branch"();--> statement-breakpoint
CREATE TRIGGER "orchestrat_fill_default_branch_document_revisions" BEFORE INSERT ON "document_revisions" FOR EACH ROW EXECUTE FUNCTION "orchestrat_fill_default_branch"();--> statement-breakpoint
CREATE TRIGGER "orchestrat_fill_default_branch_document_attachments" BEFORE INSERT ON "document_attachments" FOR EACH ROW EXECUTE FUNCTION "orchestrat_fill_default_branch"();--> statement-breakpoint
CREATE TRIGGER "orchestrat_fill_default_branch_document_attachment_uploads" BEFORE INSERT ON "document_attachment_uploads" FOR EACH ROW EXECUTE FUNCTION "orchestrat_fill_default_branch"();--> statement-breakpoint
CREATE TRIGGER "orchestrat_fill_default_branch_chats" BEFORE INSERT ON "chats" FOR EACH ROW EXECUTE FUNCTION "orchestrat_fill_default_branch"();--> statement-breakpoint
CREATE TRIGGER "orchestrat_fill_default_branch_chat_participants" BEFORE INSERT ON "chat_participants" FOR EACH ROW EXECUTE FUNCTION "orchestrat_fill_default_branch"();--> statement-breakpoint
CREATE TRIGGER "orchestrat_fill_default_branch_chat_messages" BEFORE INSERT ON "chat_messages" FOR EACH ROW EXECUTE FUNCTION "orchestrat_fill_default_branch"();
