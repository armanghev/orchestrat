CREATE TYPE "public"."document_author_type" AS ENUM('human', 'agent');--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"path" text NOT NULL,
	"current_revision" integer DEFAULT 1 NOT NULL,
	"created_by_type" "document_author_type",
	"created_by_user_id" uuid,
	"created_by_agent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "documents_path_not_blank" CHECK (btrim("path") <> ''),
	CONSTRAINT "documents_current_revision_positive" CHECK ("current_revision" > 0),
	CONSTRAINT "documents_author_consistent" CHECK (("created_by_type" is null and "created_by_user_id" is null and "created_by_agent_id" is null) or ("created_by_type" = 'human' and "created_by_user_id" is not null and "created_by_agent_id" is null) or ("created_by_type" = 'agent' and "created_by_user_id" is null and "created_by_agent_id" is not null)),
	CONSTRAINT "documents_project_id_id_unique" UNIQUE("project_id", "id")
);--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_created_by_agent_project_fk" FOREIGN KEY ("project_id", "created_by_agent_id") REFERENCES "public"."agents"("project_id", "id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "documents_project_path_unique" ON "documents" USING btree ("project_id", "path");--> statement-breakpoint
CREATE INDEX "documents_project_updated_idx" ON "documents" USING btree ("project_id", "updated_at", "id");--> statement-breakpoint
CREATE TABLE "document_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"revision_number" integer NOT NULL,
	"content_markdown" text NOT NULL,
	"author_type" "document_author_type" NOT NULL,
	"author_user_id" uuid,
	"author_agent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_revisions_revision_number_positive" CHECK ("revision_number" > 0),
	CONSTRAINT "document_revisions_author_consistent" CHECK (("author_type" = 'human' and "author_user_id" is not null and "author_agent_id" is null) or ("author_type" = 'agent' and "author_user_id" is null and "author_agent_id" is not null))
);--> statement-breakpoint
ALTER TABLE "document_revisions" ADD CONSTRAINT "document_revisions_document_project_fk" FOREIGN KEY ("project_id", "document_id") REFERENCES "public"."documents"("project_id", "id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_revisions" ADD CONSTRAINT "document_revisions_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_revisions" ADD CONSTRAINT "document_revisions_author_agent_project_fk" FOREIGN KEY ("project_id", "author_agent_id") REFERENCES "public"."agents"("project_id", "id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "document_revisions_document_id_revision_unique" ON "document_revisions" USING btree ("document_id", "revision_number");--> statement-breakpoint
CREATE INDEX "document_revisions_document_created_idx" ON "document_revisions" USING btree ("document_id", "created_at", "id");
