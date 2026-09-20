CREATE TABLE "document_folders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"path" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_folders_path_not_blank" CHECK (btrim("path") <> '')
);--> statement-breakpoint
ALTER TABLE "document_folders" ADD CONSTRAINT "document_folders_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "document_folders_project_path_unique" ON "document_folders" USING btree ("project_id", "path");
