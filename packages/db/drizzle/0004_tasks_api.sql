CREATE TYPE "public"."task_priority" AS ENUM('urgent', 'high', 'medium', 'low', 'none');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('backlog', 'ready', 'claimed', 'in_progress', 'blocked', 'review', 'done', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."task_claim_status" AS ENUM('active', 'released', 'expired', 'completed', 'revoked');--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "task_key_prefix" text DEFAULT 'PRJ' NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "task_counter" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
UPDATE "projects"
SET "task_key_prefix" = CASE
  WHEN LENGTH(REGEXP_REPLACE(UPPER("slug"), '[^A-Z0-9]', '', 'g')) >= 2
    THEN LEFT(REGEXP_REPLACE(UPPER("slug"), '[^A-Z0-9]', '', 'g'), 3)
  ELSE 'PRJ'
END
WHERE "task_key_prefix" = 'PRJ';--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_task_key_prefix_format" CHECK ("task_key_prefix" ~ '^[A-Z0-9]{2,8}$');--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_task_counter_positive" CHECK ("task_counter" > 0);--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"task_key" text NOT NULL,
	"task_number" integer NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"priority" "task_priority" DEFAULT 'none' NOT NULL,
	"status" "task_status" DEFAULT 'backlog' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	CONSTRAINT "tasks_project_id_id_unique" UNIQUE("project_id", "id"),
	CONSTRAINT "tasks_task_number_positive" CHECK ("task_number" > 0),
	CONSTRAINT "tasks_position_non_negative" CHECK ("position" >= 0),
	CONSTRAINT "tasks_version_positive" CHECK ("version" > 0)
);--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_project_key_unique" ON "tasks" USING btree ("project_id", "task_key");--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_project_number_unique" ON "tasks" USING btree ("project_id", "task_number");--> statement-breakpoint
CREATE INDEX "tasks_project_board_order_idx" ON "tasks" USING btree ("project_id", "status", "position", "id");--> statement-breakpoint
CREATE INDEX "tasks_created_by_user_id_idx" ON "tasks" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE TABLE "task_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"author_user_id" uuid NOT NULL,
	"body_markdown" text NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_comments_body_not_blank" CHECK (btrim("body_markdown") <> '')
);--> statement-breakpoint
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_comments_task_created_idx" ON "task_comments" USING btree ("task_id", "created_at", "id");--> statement-breakpoint
CREATE TABLE "task_dependencies" (
	"project_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"depends_on_task_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_dependencies_task_id_depends_on_task_id_pk" PRIMARY KEY("task_id", "depends_on_task_id"),
	CONSTRAINT "task_dependencies_not_self" CHECK ("task_id" <> "depends_on_task_id")
);--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_task_project_fk" FOREIGN KEY ("project_id", "task_id") REFERENCES "public"."tasks"("project_id", "id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_blocker_project_fk" FOREIGN KEY ("project_id", "depends_on_task_id") REFERENCES "public"."tasks"("project_id", "id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_dependencies_project_task_idx" ON "task_dependencies" USING btree ("project_id", "task_id");--> statement-breakpoint
CREATE INDEX "task_dependencies_project_blocker_idx" ON "task_dependencies" USING btree ("project_id", "depends_on_task_id");--> statement-breakpoint
CREATE TABLE "task_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"status" "task_claim_status" DEFAULT 'active' NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_expires_at" timestamp with time zone NOT NULL,
	"released_at" timestamp with time zone,
	"release_reason" text
);--> statement-breakpoint
ALTER TABLE "task_claims" ADD CONSTRAINT "task_claims_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "task_claims_one_active_per_task" ON "task_claims" USING btree ("task_id") WHERE "status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "task_claims_token_hash_unique" ON "task_claims" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "task_claims_lease_expiry_idx" ON "task_claims" USING btree ("status", "lease_expires_at");--> statement-breakpoint
CREATE TABLE "api_idempotency_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"operation" text NOT NULL,
	"resource_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"response_status" integer NOT NULL,
	"response_body" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "api_idempotency_keys" ADD CONSTRAINT "api_idempotency_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_idempotency_scope_unique" ON "api_idempotency_keys" USING btree ("user_id", "operation", "resource_id", "idempotency_key");
