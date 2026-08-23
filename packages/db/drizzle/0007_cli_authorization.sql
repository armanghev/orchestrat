CREATE TABLE "cli_authorization_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"secret_hash" text NOT NULL,
	"status" text NOT NULL,
	"project_id" uuid,
	"approved_by_user_id" uuid,
	"credential_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"exchanged_at" timestamp with time zone,
	CONSTRAINT "cli_authorization_attempts_status_valid" CHECK ("status" in ('pending', 'approved', 'denied', 'expired', 'exchanged')),
	CONSTRAINT "cli_authorization_attempts_secret_hash_not_blank" CHECK (btrim("secret_hash") <> '')
);
ALTER TABLE "cli_authorization_attempts" ADD CONSTRAINT "cli_authorization_attempts_project_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade;
ALTER TABLE "cli_authorization_attempts" ADD CONSTRAINT "cli_authorization_attempts_user_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null;
CREATE INDEX "cli_authorization_attempts_expires_idx" ON "cli_authorization_attempts" USING btree ("expires_at");
CREATE TABLE "cli_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
ALTER TABLE "cli_credentials" ADD CONSTRAINT "cli_credentials_project_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade;
ALTER TABLE "cli_credentials" ADD CONSTRAINT "cli_credentials_user_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade;
CREATE UNIQUE INDEX "cli_credentials_token_hash_unique" ON "cli_credentials" USING btree ("token_hash");
CREATE INDEX "cli_credentials_project_idx" ON "cli_credentials" USING btree ("project_id");
