ALTER TABLE "task_comments" ADD COLUMN "sequence" integer;--> statement-breakpoint
ALTER TABLE "task_comments" ADD COLUMN "mentions" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
UPDATE "task_comments" SET "sequence" = "numbered"."rn"
FROM (
	SELECT "id", row_number() OVER (PARTITION BY "task_id" ORDER BY "created_at", "id") AS "rn"
	FROM "task_comments"
) AS "numbered"
WHERE "task_comments"."id" = "numbered"."id";--> statement-breakpoint
ALTER TABLE "task_comments" ALTER COLUMN "sequence" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_sequence_positive" CHECK ("sequence" > 0);--> statement-breakpoint
CREATE UNIQUE INDEX "task_comments_task_sequence_unique" ON "task_comments" USING btree ("task_id","sequence");--> statement-breakpoint
CREATE TABLE "task_watches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"user_id" uuid,
	"agent_id" uuid,
	"state" text DEFAULT 'watching' NOT NULL,
	"reason" text NOT NULL,
	"last_read_sequence" integer DEFAULT 0 NOT NULL,
	"claim_baseline_sequence" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_watches_user_unique" UNIQUE("task_id","user_id"),
	CONSTRAINT "task_watches_agent_unique" UNIQUE("task_id","agent_id"),
	CONSTRAINT "task_watches_actor_consistent" CHECK (("user_id" is not null and "agent_id" is null) or ("agent_id" is not null and "user_id" is null)),
	CONSTRAINT "task_watches_state_valid" CHECK ("state" in ('watching', 'muted')),
	CONSTRAINT "task_watches_read_nonnegative" CHECK ("last_read_sequence" >= 0)
);--> statement-breakpoint
CREATE TABLE "task_blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"created_by_type" "document_author_type" NOT NULL,
	"created_by_user_id" uuid,
	"created_by_agent_id" uuid,
	"claim_id" uuid,
	"reason" text NOT NULL,
	"blocking_task_id" uuid,
	"blocked_on_user_id" uuid,
	"blocked_on_agent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolution" text,
	"resolved_by_user_id" uuid,
	"resolved_by_agent_id" uuid,
	"resolution_seen_at" timestamp with time zone,
	CONSTRAINT "task_blocks_creator_consistent" CHECK (("created_by_type" = 'human' and "created_by_user_id" is not null and "created_by_agent_id" is null) or ("created_by_type" = 'agent' and "created_by_agent_id" is not null and "created_by_user_id" is null)),
	CONSTRAINT "task_blocks_reason_not_blank" CHECK (btrim("reason") <> ''),
	CONSTRAINT "task_blocks_not_self" CHECK ("blocking_task_id" is null or "blocking_task_id" <> "task_id"),
	CONSTRAINT "task_blocks_on_single" CHECK ("blocked_on_user_id" is null or "blocked_on_agent_id" is null),
	CONSTRAINT "task_blocks_resolved_by_single" CHECK ("resolved_by_user_id" is null or "resolved_by_agent_id" is null),
	CONSTRAINT "task_blocks_resolution_consistent" CHECK (("resolved_at" is null and "resolution" is null) or ("resolved_at" is not null and "resolution" is not null))
);--> statement-breakpoint
CREATE TABLE "handoffs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"chat_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"message_sequence" integer NOT NULL,
	"from_user_id" uuid,
	"from_agent_id" uuid,
	"to_user_id" uuid,
	"to_agent_id" uuid,
	"task_id" uuid,
	"chain_id" uuid NOT NULL,
	"hop" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "handoffs_message_unique" UNIQUE("message_id"),
	CONSTRAINT "handoffs_from_single" CHECK (("from_user_id" is null) <> ("from_agent_id" is null)),
	CONSTRAINT "handoffs_to_single" CHECK (("to_user_id" is null) <> ("to_agent_id" is null)),
	CONSTRAINT "handoffs_message_sequence_positive" CHECK ("message_sequence" > 0),
	CONSTRAINT "handoffs_hop_nonnegative" CHECK ("hop" >= 0)
);--> statement-breakpoint
ALTER TABLE "task_watches" ADD CONSTRAINT "task_watches_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_watches" ADD CONSTRAINT "task_watches_task_project_fk" FOREIGN KEY ("project_id","task_id") REFERENCES "public"."tasks"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_watches" ADD CONSTRAINT "task_watches_agent_project_fk" FOREIGN KEY ("project_id","agent_id") REFERENCES "public"."agents"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_watches" ADD CONSTRAINT "task_watches_user_project_fk" FOREIGN KEY ("project_id","user_id") REFERENCES "public"."project_members"("project_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_blocks" ADD CONSTRAINT "task_blocks_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_blocks" ADD CONSTRAINT "task_blocks_claim_id_task_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."task_claims"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_blocks" ADD CONSTRAINT "task_blocks_blocked_on_user_id_users_id_fk" FOREIGN KEY ("blocked_on_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_blocks" ADD CONSTRAINT "task_blocks_resolved_by_user_id_users_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_blocks" ADD CONSTRAINT "task_blocks_task_project_fk" FOREIGN KEY ("project_id","task_id") REFERENCES "public"."tasks"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_blocks" ADD CONSTRAINT "task_blocks_blocking_task_project_fk" FOREIGN KEY ("project_id","blocking_task_id") REFERENCES "public"."tasks"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_blocks" ADD CONSTRAINT "task_blocks_created_by_agent_project_fk" FOREIGN KEY ("project_id","created_by_agent_id") REFERENCES "public"."agents"("project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_blocks" ADD CONSTRAINT "task_blocks_blocked_on_agent_project_fk" FOREIGN KEY ("project_id","blocked_on_agent_id") REFERENCES "public"."agents"("project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_blocks" ADD CONSTRAINT "task_blocks_resolved_by_agent_project_fk" FOREIGN KEY ("project_id","resolved_by_agent_id") REFERENCES "public"."agents"("project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handoffs" ADD CONSTRAINT "handoffs_message_id_chat_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."chat_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handoffs" ADD CONSTRAINT "handoffs_from_user_id_users_id_fk" FOREIGN KEY ("from_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handoffs" ADD CONSTRAINT "handoffs_to_user_id_users_id_fk" FOREIGN KEY ("to_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handoffs" ADD CONSTRAINT "handoffs_chat_project_fk" FOREIGN KEY ("project_id","chat_id") REFERENCES "public"."chats"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handoffs" ADD CONSTRAINT "handoffs_task_project_fk" FOREIGN KEY ("project_id","task_id") REFERENCES "public"."tasks"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handoffs" ADD CONSTRAINT "handoffs_from_agent_project_fk" FOREIGN KEY ("project_id","from_agent_id") REFERENCES "public"."agents"("project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handoffs" ADD CONSTRAINT "handoffs_to_agent_project_fk" FOREIGN KEY ("project_id","to_agent_id") REFERENCES "public"."agents"("project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_watches_project_agent_idx" ON "task_watches" USING btree ("project_id","agent_id");--> statement-breakpoint
CREATE INDEX "task_watches_project_user_idx" ON "task_watches" USING btree ("project_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "task_blocks_one_open_per_task" ON "task_blocks" USING btree ("task_id") WHERE "task_blocks"."resolved_at" is null;--> statement-breakpoint
CREATE INDEX "task_blocks_open_blocking_task_idx" ON "task_blocks" USING btree ("project_id","blocking_task_id") WHERE "task_blocks"."resolved_at" is null;--> statement-breakpoint
CREATE INDEX "task_blocks_open_blocked_on_idx" ON "task_blocks" USING btree ("project_id","blocked_on_agent_id") WHERE "task_blocks"."resolved_at" is null;--> statement-breakpoint
CREATE INDEX "task_blocks_creator_idx" ON "task_blocks" USING btree ("project_id","created_by_agent_id");--> statement-breakpoint
CREATE INDEX "handoffs_project_to_agent_created_idx" ON "handoffs" USING btree ("project_id","to_agent_id","created_at");--> statement-breakpoint
CREATE INDEX "handoffs_project_to_user_created_idx" ON "handoffs" USING btree ("project_id","to_user_id","created_at");--> statement-breakpoint
CREATE INDEX "handoffs_project_from_agent_created_idx" ON "handoffs" USING btree ("project_id","from_agent_id","created_at");--> statement-breakpoint
CREATE INDEX "handoffs_chain_idx" ON "handoffs" USING btree ("chain_id");--> statement-breakpoint
INSERT INTO "task_watches" ("project_id", "task_id", "agent_id", "reason", "last_read_sequence", "claim_baseline_sequence")
SELECT "task_claims"."project_id", "task_claims"."task_id", "task_claims"."agent_id", 'claimed', coalesce("latest"."sequence", 0), coalesce("latest"."sequence", 0)
FROM "task_claims"
LEFT JOIN (
	SELECT "task_id", max("sequence") AS "sequence"
	FROM "task_comments"
	GROUP BY "task_id"
) AS "latest" ON "latest"."task_id" = "task_claims"."task_id"
WHERE "task_claims"."status" = 'active'
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "task_watches" ("project_id", "task_id", "user_id", "agent_id", "reason", "last_read_sequence")
SELECT "tasks"."project_id", "tasks"."id", "tasks"."created_by_user_id", "tasks"."created_by_agent_id", 'created', coalesce("latest"."sequence", 0)
FROM "tasks"
LEFT JOIN (
	SELECT "task_id", max("sequence") AS "sequence"
	FROM "task_comments"
	GROUP BY "task_id"
) AS "latest" ON "latest"."task_id" = "tasks"."id"
LEFT JOIN "project_members" ON "project_members"."project_id" = "tasks"."project_id" AND "project_members"."user_id" = "tasks"."created_by_user_id"
WHERE "tasks"."created_by_agent_id" is not null or "project_members"."user_id" is not null
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "task_watches" ("project_id", "task_id", "user_id", "agent_id", "reason", "last_read_sequence")
SELECT "commenters"."project_id", "commenters"."task_id", "commenters"."author_user_id", "commenters"."author_agent_id", 'commented', coalesce("latest"."sequence", 0)
FROM (
	SELECT DISTINCT "project_id", "task_id", "author_user_id", "author_agent_id"
	FROM "task_comments"
) AS "commenters"
LEFT JOIN (
	SELECT "task_id", max("sequence") AS "sequence"
	FROM "task_comments"
	GROUP BY "task_id"
) AS "latest" ON "latest"."task_id" = "commenters"."task_id"
LEFT JOIN "project_members" ON "project_members"."project_id" = "commenters"."project_id" AND "project_members"."user_id" = "commenters"."author_user_id"
WHERE "commenters"."author_agent_id" is not null or "project_members"."user_id" is not null
ON CONFLICT DO NOTHING;--> statement-breakpoint
ALTER TABLE "task_watches" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "task_blocks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "handoffs" ENABLE ROW LEVEL SECURITY;
