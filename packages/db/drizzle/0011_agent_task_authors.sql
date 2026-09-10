ALTER TABLE "tasks" ADD COLUMN "created_by_type" "document_author_type";--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "created_by_agent_id" uuid;--> statement-breakpoint
UPDATE "tasks" SET "created_by_type" = 'human';--> statement-breakpoint
ALTER TABLE "tasks" ALTER COLUMN "created_by_type" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ALTER COLUMN "created_by_user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_created_by_agent_project_fk" FOREIGN KEY ("project_id", "created_by_agent_id") REFERENCES "public"."agents"("project_id", "id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_author_consistent" CHECK (("created_by_type" = 'human' and "created_by_user_id" is not null and "created_by_agent_id" is null) or ("created_by_type" = 'agent' and "created_by_user_id" is null and "created_by_agent_id" is not null));--> statement-breakpoint
CREATE INDEX "tasks_created_by_agent_id_idx" ON "tasks" USING btree ("created_by_agent_id");--> statement-breakpoint

ALTER TABLE "task_comments" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "task_comments" ADD COLUMN "author_type" "document_author_type";--> statement-breakpoint
ALTER TABLE "task_comments" ADD COLUMN "author_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "task_comments" ADD COLUMN "author_name" text;--> statement-breakpoint
UPDATE "task_comments"
SET "project_id" = task."project_id", "author_type" = 'human'
FROM "tasks" AS task
WHERE "task_comments"."task_id" = task."id";--> statement-breakpoint
UPDATE "task_comments"
SET "author_name" = account."name"
FROM "users" AS account
WHERE "task_comments"."author_user_id" = account."id";--> statement-breakpoint
ALTER TABLE "task_comments" ALTER COLUMN "project_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "task_comments" ALTER COLUMN "author_type" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "task_comments" ALTER COLUMN "author_name" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "task_comments" ALTER COLUMN "author_user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_author_agent_project_fk" FOREIGN KEY ("project_id", "author_agent_id") REFERENCES "public"."agents"("project_id", "id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_task_project_fk" FOREIGN KEY ("project_id", "task_id") REFERENCES "public"."tasks"("project_id", "id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_author_consistent" CHECK (("author_type" = 'human' and "author_user_id" is not null and "author_agent_id" is null) or ("author_type" = 'agent' and "author_user_id" is null and "author_agent_id" is not null));--> statement-breakpoint

DROP INDEX "api_idempotency_scope_unique";--> statement-breakpoint
ALTER TABLE "api_idempotency_keys" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "api_idempotency_keys" ADD COLUMN "agent_id" uuid;--> statement-breakpoint
ALTER TABLE "api_idempotency_keys" ADD CONSTRAINT "api_idempotency_keys_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_idempotency_keys" ADD CONSTRAINT "api_idempotency_principal_consistent" CHECK (("user_id" is not null and "agent_id" is null) or ("user_id" is null and "agent_id" is not null));--> statement-breakpoint
CREATE UNIQUE INDEX "api_idempotency_user_scope_unique" ON "api_idempotency_keys" USING btree ("user_id", "operation", "resource_id", "idempotency_key") WHERE "user_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "api_idempotency_agent_scope_unique" ON "api_idempotency_keys" USING btree ("agent_id", "operation", "resource_id", "idempotency_key") WHERE "agent_id" is not null;
