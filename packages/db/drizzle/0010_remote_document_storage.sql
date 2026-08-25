ALTER TABLE "documents" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "document_revisions" ADD COLUMN "content_size_bytes" bigint;--> statement-breakpoint
ALTER TABLE "document_revisions" ADD COLUMN "content_sha256" text;--> statement-breakpoint
ALTER TABLE "document_revisions" ADD CONSTRAINT "document_revisions_content_metadata_consistent" CHECK (("content_size_bytes" is null and "content_sha256" is null) or ("content_size_bytes" >= 0 and length("content_sha256") = 64 and regexp_replace("content_sha256", '[0-9a-f]', '', 'g') = ''));--> statement-breakpoint
CREATE TYPE "public"."document_upload_mode" AS ENUM('single', 'multipart');--> statement-breakpoint
CREATE TYPE "public"."document_upload_status" AS ENUM('pending', 'completed', 'aborted', 'expired');--> statement-breakpoint
CREATE TABLE "document_attachments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL,
  "document_id" uuid NOT NULL,
  "filename" text NOT NULL,
  "mime_type" text NOT NULL,
  "size_bytes" bigint NOT NULL,
  "added_by_type" "document_author_type" NOT NULL,
  "added_by_user_id" uuid,
  "added_by_agent_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "document_attachments_size_nonnegative" CHECK ("size_bytes" >= 0),
  CONSTRAINT "document_attachments_author_consistent" CHECK (("added_by_type" = 'human' and "added_by_user_id" is not null and "added_by_agent_id" is null) or ("added_by_type" = 'agent' and "added_by_user_id" is null and "added_by_agent_id" is not null))
);--> statement-breakpoint
ALTER TABLE "document_attachments" ADD CONSTRAINT "document_attachments_document_project_fk" FOREIGN KEY ("project_id", "document_id") REFERENCES "public"."documents"("project_id", "id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "document_attachments" ADD CONSTRAINT "document_attachments_added_by_user_fk" FOREIGN KEY ("added_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "document_attachments" ADD CONSTRAINT "document_attachments_added_by_agent_project_fk" FOREIGN KEY ("project_id", "added_by_agent_id") REFERENCES "public"."agents"("project_id", "id") ON DELETE no action;--> statement-breakpoint
CREATE INDEX "document_attachments_document_created_idx" ON "document_attachments" USING btree ("document_id", "created_at", "id");--> statement-breakpoint
CREATE TABLE "document_attachment_uploads" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL,
  "document_id" uuid NOT NULL,
  "filename" text NOT NULL,
  "mime_type" text NOT NULL,
  "reserved_bytes" bigint NOT NULL,
  "upload_mode" "document_upload_mode" NOT NULL,
  "provider_upload_id" text,
  "status" "document_upload_status" DEFAULT 'pending' NOT NULL,
  "actor_type" "document_author_type" NOT NULL,
  "actor_user_id" uuid,
  "actor_agent_id" uuid,
  "expires_at" timestamp with time zone NOT NULL,
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "document_attachment_uploads_reserved_nonnegative" CHECK ("reserved_bytes" >= 0),
  CONSTRAINT "document_attachment_uploads_actor_consistent" CHECK (("actor_type" = 'human' and "actor_user_id" is not null and "actor_agent_id" is null) or ("actor_type" = 'agent' and "actor_user_id" is null and "actor_agent_id" is not null)),
  CONSTRAINT "document_attachment_uploads_mode_provider_consistent" CHECK (("upload_mode" = 'single' and "provider_upload_id" is null) or ("upload_mode" = 'multipart' and "provider_upload_id" is not null))
);--> statement-breakpoint
ALTER TABLE "document_attachment_uploads" ADD CONSTRAINT "document_attachment_uploads_document_project_fk" FOREIGN KEY ("project_id", "document_id") REFERENCES "public"."documents"("project_id", "id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "document_attachment_uploads" ADD CONSTRAINT "document_attachment_uploads_actor_user_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "document_attachment_uploads" ADD CONSTRAINT "document_attachment_uploads_actor_agent_project_fk" FOREIGN KEY ("project_id", "actor_agent_id") REFERENCES "public"."agents"("project_id", "id") ON DELETE no action;--> statement-breakpoint
CREATE INDEX "document_attachment_uploads_project_status_idx" ON "document_attachment_uploads" USING btree ("project_id", "status", "expires_at");
