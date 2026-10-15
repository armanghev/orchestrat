-- Organization Git integrations: a GitHub App installation or a GitLab
-- account connected once to an organization, the repositories it reaches,
-- and connection attempts that belong to an organization instead of a
-- project. Existing project connections are unchanged.
CREATE TABLE "organization_integrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_account_id" text NOT NULL,
	"account_name" text NOT NULL,
	"account_type" text,
	"installation_id" text,
	"repository_selection" text NOT NULL,
	"selected_repository_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"access_token_ciphertext" text,
	"refresh_token_ciphertext" text,
	"token_expires_at" timestamp with time zone,
	"status" text DEFAULT 'active' NOT NULL,
	"status_reason" text,
	"connected_by_user_id" uuid,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_integrations_account_unique" UNIQUE("organization_id","provider","provider_account_id"),
	CONSTRAINT "organization_integrations_provider_valid" CHECK ("provider" IN ('github', 'gitlab')),
	CONSTRAINT "organization_integrations_selection_valid" CHECK ("repository_selection" IN ('all', 'selected')),
	CONSTRAINT "organization_integrations_status_valid" CHECK ("status" IN ('active', 'needs_reauthorization', 'suspended'))
);
--> statement-breakpoint
CREATE TABLE "organization_repositories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"integration_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_repository_id" text NOT NULL,
	"full_name" text NOT NULL,
	"url" text,
	"default_branch" text,
	"pushed_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	"dismissed_at" timestamp with time zone,
	"dismissed_by_user_id" uuid,
	CONSTRAINT "organization_repositories_integration_repo_unique" UNIQUE("integration_id","provider_repository_id")
);
--> statement-breakpoint
ALTER TABLE "organization_integrations" ADD CONSTRAINT "organization_integrations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_integrations" ADD CONSTRAINT "organization_integrations_connected_by_user_id_users_id_fk" FOREIGN KEY ("connected_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_repositories" ADD CONSTRAINT "organization_repositories_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_repositories" ADD CONSTRAINT "organization_repositories_integration_id_organization_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."organization_integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_repositories" ADD CONSTRAINT "organization_repositories_dismissed_by_user_id_users_id_fk" FOREIGN KEY ("dismissed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "organization_integrations_installation_idx" ON "organization_integrations" USING btree ("provider","installation_id");--> statement-breakpoint
CREATE INDEX "organization_repositories_organization_idx" ON "organization_repositories" USING btree ("organization_id");--> statement-breakpoint
ALTER TABLE "repository_connections" ADD COLUMN "integration_id" uuid;--> statement-breakpoint
ALTER TABLE "repository_connections" ADD CONSTRAINT "repository_connections_integration_id_organization_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."organization_integrations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_connection_attempts" ALTER COLUMN "project_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "repository_connection_attempts" ADD COLUMN "organization_id" uuid;--> statement-breakpoint
ALTER TABLE "repository_connection_attempts" ADD CONSTRAINT "repository_connection_attempts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_connection_attempts" ADD CONSTRAINT "repository_connection_attempts_one_owner" CHECK (("project_id" IS NULL) <> ("organization_id" IS NULL));--> statement-breakpoint
ALTER TABLE "organization_integrations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "organization_repositories" ENABLE ROW LEVEL SECURITY;
