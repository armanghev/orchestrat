ALTER TABLE "projects" ADD COLUMN "organization_id" uuid;--> statement-breakpoint
UPDATE "projects" SET "organization_id" = "workspaces"."organization_id" FROM "workspaces" WHERE "projects"."workspace_id" = "workspaces"."id";--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
DROP INDEX "projects_workspace_slug_unique";--> statement-breakpoint
DROP INDEX "projects_workspace_status_idx";--> statement-breakpoint
ALTER TABLE "projects" DROP CONSTRAINT "projects_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN "workspace_id";--> statement-breakpoint
DROP TABLE "workspaces";--> statement-breakpoint
CREATE UNIQUE INDEX "projects_organization_slug_unique" ON "projects" USING btree ("organization_id","slug");--> statement-breakpoint
CREATE INDEX "projects_organization_status_idx" ON "projects" USING btree ("organization_id","status");
