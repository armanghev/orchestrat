DROP INDEX "users_auth_subject_unique";--> statement-breakpoint
DROP INDEX "users_email_unique";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "auth_provider" text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "auth_provider" DROP DEFAULT;--> statement-breakpoint
CREATE UNIQUE INDEX "users_auth_provider_subject_unique" ON "users" USING btree ("auth_provider","auth_subject");--> statement-breakpoint
CREATE INDEX "users_email_idx" ON "users" USING btree ("email");