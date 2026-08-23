CREATE TABLE "agent_lifecycle_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"event_id" integer,
	"session_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "agent_lifecycle_events" ADD CONSTRAINT "agent_lifecycle_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_lifecycle_events" ADD CONSTRAINT "agent_lifecycle_events_agent_project_fk" FOREIGN KEY ("project_id", "agent_id") REFERENCES "public"."agents"("project_id", "id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_lifecycle_events" ADD CONSTRAINT "agent_lifecycle_events_session_project_fk" FOREIGN KEY ("project_id", "session_id") REFERENCES "public"."agent_sessions"("project_id", "id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_lifecycle_events" ADD CONSTRAINT "agent_lifecycle_events_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."project_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_lifecycle_events" ADD CONSTRAINT "agent_lifecycle_events_idempotency_key_not_blank" CHECK (btrim("idempotency_key") <> '');--> statement-breakpoint
ALTER TABLE "agent_lifecycle_events" ADD CONSTRAINT "agent_lifecycle_events_request_hash_not_blank" CHECK (btrim("request_hash") <> '');--> statement-breakpoint
CREATE UNIQUE INDEX "agent_lifecycle_events_scope_unique" ON "agent_lifecycle_events" USING btree ("project_id", "agent_id", "idempotency_key");--> statement-breakpoint
CREATE INDEX "agent_lifecycle_events_project_idx" ON "agent_lifecycle_events" USING btree ("project_id");
