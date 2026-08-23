CREATE TYPE "public"."agent_status" AS ENUM('active', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."agent_session_status" AS ENUM('active', 'closed');--> statement-breakpoint
CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"status" "agent_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "agents_project_id_id_unique" UNIQUE("project_id", "id"),
	CONSTRAINT "agents_name_not_blank" CHECK (btrim("name") <> ''),
	CONSTRAINT "agents_revocation_state_consistent" CHECK (("status" = 'active' and "revoked_at" is null) or ("status" = 'revoked' and "revoked_at" is not null))
);--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agents_project_status_idx" ON "agents" USING btree ("project_id", "status");--> statement-breakpoint
CREATE TABLE "agent_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "agent_credentials_token_hash_not_blank" CHECK (btrim("token_hash") <> '')
);--> statement-breakpoint
ALTER TABLE "agent_credentials" ADD CONSTRAINT "agent_credentials_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_credentials" ADD CONSTRAINT "agent_credentials_agent_project_fk" FOREIGN KEY ("project_id", "agent_id") REFERENCES "public"."agents"("project_id", "id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_credentials_token_hash_unique" ON "agent_credentials" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "agent_credentials_project_agent_idx" ON "agent_credentials" USING btree ("project_id", "agent_id");--> statement-breakpoint
CREATE TABLE "agent_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"runtime" text NOT NULL,
	"integration" text NOT NULL,
	"external_session_id" text,
	"status" "agent_session_status" DEFAULT 'active' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"last_heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_sessions_project_id_id_unique" UNIQUE("project_id", "id"),
	CONSTRAINT "agent_sessions_project_agent_id_id_unique" UNIQUE("project_id", "agent_id", "id"),
	CONSTRAINT "agent_sessions_runtime_not_blank" CHECK (btrim("runtime") <> ''),
	CONSTRAINT "agent_sessions_integration_not_blank" CHECK (btrim("integration") <> ''),
	CONSTRAINT "agent_sessions_end_state_consistent" CHECK (("status" = 'active' and "ended_at" is null) or ("status" = 'closed' and "ended_at" is not null))
);--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_agent_project_fk" FOREIGN KEY ("project_id", "agent_id") REFERENCES "public"."agents"("project_id", "id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_sessions_project_agent_status_idx" ON "agent_sessions" USING btree ("project_id", "agent_id", "status");--> statement-breakpoint
CREATE TABLE "project_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"type" text NOT NULL,
	"actor_agent_id" uuid,
	"actor_user_id" uuid,
	"entity_id" uuid,
	"payload" jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_events_type_not_blank" CHECK (btrim("type") <> '')
);--> statement-breakpoint
ALTER TABLE "project_events" ADD CONSTRAINT "project_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_events" ADD CONSTRAINT "project_events_actor_agent_project_fk" FOREIGN KEY ("project_id", "actor_agent_id") REFERENCES "public"."agents"("project_id", "id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_events" ADD CONSTRAINT "project_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_events_project_id_id_idx" ON "project_events" USING btree ("project_id", "id");--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM "task_claims") THEN
		RAISE EXCEPTION '0005 coordination migration requires task_claims to be empty; archive or migrate legacy claims explicitly before retrying';
	END IF;
END $$;--> statement-breakpoint
ALTER TABLE "task_claims" DROP CONSTRAINT "task_claims_task_id_tasks_id_fk";--> statement-breakpoint
ALTER TABLE "task_claims" ADD COLUMN "project_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "task_claims" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "task_claims" ADD CONSTRAINT "task_claims_agent_project_fk" FOREIGN KEY ("project_id", "agent_id") REFERENCES "public"."agents"("project_id", "id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_claims" ADD CONSTRAINT "task_claims_session_project_fk" FOREIGN KEY ("project_id", "session_id") REFERENCES "public"."agent_sessions"("project_id", "id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_claims" ADD CONSTRAINT "task_claims_task_project_fk" FOREIGN KEY ("project_id", "task_id") REFERENCES "public"."tasks"("project_id", "id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_claims" ADD CONSTRAINT "task_claims_lifecycle_consistent" CHECK (("status" = 'active' and "released_at" is null and "release_reason" is null and "completed_at" is null) or ("status" = 'released' and "released_at" is not null and "release_reason" is not null and "completed_at" is null) or ("status" = 'expired' and "released_at" is not null and "release_reason" is null and "completed_at" is null) or ("status" = 'completed' and "released_at" is null and "release_reason" is null and "completed_at" is not null) or ("status" = 'revoked' and "released_at" is not null and "release_reason" is not null and "completed_at" is null));--> statement-breakpoint
ALTER TABLE "task_claims" ADD CONSTRAINT "task_claims_session_agent_project_fk" FOREIGN KEY ("project_id", "agent_id", "session_id") REFERENCES "public"."agent_sessions"("project_id", "agent_id", "id") ON DELETE cascade ON UPDATE no action;
